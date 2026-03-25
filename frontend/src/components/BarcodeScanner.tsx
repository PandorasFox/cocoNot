import { useRef, useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProductByBarcode, skuLookup } from '../api/client'
import { detectBarcodeBurst, detectBarcodesWithBounds } from '../api/barcode'
import { getStatuses, putSKULookupResults, putProduct, putNotFound } from '../api/cache'
import { initOcr, recognizeWords, getOcrReadyState, onOcrReadyChange, type OcrReadyState, type ScanRegion } from '../api/ocr'
import {
  drawUnifiedHitboxes, videoCoverTransform,
  HITBOX_RETAIN_MS, HITBOX_PADDING,
  type HitboxEntry,
} from './hitbox'

type ViewfinderMode = 'barcode' | 'ocr' | 'ocr-fast'

type ScanState =
  | { status: 'idle' }
  | { status: 'viewfinder'; mode: ViewfinderMode }
  | { status: 'processing'; source: 'viewfinder'; mode: ViewfinderMode }
  | { status: 'error'; message: string; inViewfinder: boolean; mode?: ViewfinderMode }

export default function BarcodeScanner() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const inFlightRef = useRef(new Set<string>())
  const hitboxMapRef = useRef(new Map<string, HitboxEntry>())
  const [state, setState] = useState<ScanState>({ status: 'idle' })
  const [ocrReady, setOcrReady] = useState<OcrReadyState>(getOcrReadyState)
  const [ocrDebug, setOcrDebug] = useState<{
    frames: number; words: number; coconut: number
    totalMs: number; captureMs: number; recognizeMs: number; postMs: number
    queued: number
  }>({ frames: 0, words: 0, coconut: 0, totalMs: 0, captureMs: 0, recognizeMs: 0, postMs: 0, queued: 0 })

  // Subscribe to OCR readiness changes
  useEffect(() => onOcrReadyChange(setOcrReady), [])

  // Stop the camera stream
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
  }, [])

  // Clean up on unmount
  useEffect(() => stopStream, [stopStream])

  // Navigate after a successful scan
  const handleSKU = useCallback(
    async (sku: string) => {
      try {
        const product = await getProductByBarcode(sku)
        putProduct(product)
        stopStream()
        setState({ status: 'idle' })
        navigate(`/product/${product.id}`)
      } catch {
        putNotFound(sku)
        stopStream()
        setState({ status: 'idle' })
        navigate(`/?q=${encodeURIComponent(sku)}`)
      }
    },
    [navigate, stopStream],
  )

  // ── Viewfinder state helpers ─────────────────────────────────

  const viewfinderMode: ViewfinderMode | null =
    state.status === 'viewfinder' ? state.mode
    : state.status === 'processing' ? state.mode
    : state.status === 'error' && state.inViewfinder ? (state.mode ?? null)
    : null

  const isViewfinderOpen = viewfinderMode !== null
  const isOcrMode = viewfinderMode === 'ocr' || viewfinderMode === 'ocr-fast'

  // Attach stream to video element once the viewfinder mounts
  useEffect(() => {
    const video = videoRef.current
    const stream = streamRef.current
    if (!video || !stream || !isViewfinderOpen) return

    video.setAttribute('autoplay', '')
    video.setAttribute('playsinline', '')
    video.srcObject = stream

    const startPlayback = () => {
      video.play().catch(() => {})
    }

    if (video.readyState >= video.HAVE_METADATA) {
      startPlayback()
    } else {
      video.addEventListener('loadedmetadata', startPlayback, { once: true })
      return () => video.removeEventListener('loadedmetadata', startPlayback)
    }
  }, [isViewfinderOpen])

  // ── Detection loop (mode-branched) ──────────────────────────

  useEffect(() => {
    if (!viewfinderMode) return

    hitboxMapRef.current.clear()
    setOcrDebug({ frames: 0, words: 0, coconut: 0, totalMs: 0, captureMs: 0, recognizeMs: 0, postMs: 0, queued: 0 })
    let frameCount = 0
    let inFlight = 0
    const mode = viewfinderMode

    if (mode === 'ocr') initOcr('standard')
    else if (mode === 'ocr-fast') initOcr('fast')

    const id = setInterval(async () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA) return

      const dw = video.clientWidth
      const dh = video.clientHeight
      if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width = dw
        canvas.height = dh
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const now = Date.now()
      const transform = videoCoverTransform(video.videoWidth, video.videoHeight, dw, dh)

      // ── Barcode-only path ──
      if (mode === 'barcode') {
        const detections = await detectBarcodesWithBounds(video).catch(() => [] as { rawValue: string; boundingBox: DOMRectReadOnly }[])

        if (detections.length > 0 && transform) {
          const { scale, offsetX, offsetY } = transform
          const skus = detections.map((d) => d.rawValue)
          const cached = await getStatuses(skus)

          const misses = skus.filter(
            (sku) => !cached.has(sku) && !inFlightRef.current.has(sku),
          )
          if (misses.length > 0) {
            for (const sku of misses) inFlightRef.current.add(sku)
            skuLookup(misses)
              .then((res) => putSKULookupResults(res.results, misses))
              .catch(() => {})
              .finally(() => {
                for (const sku of misses) inFlightRef.current.delete(sku)
              })
          }

          for (const det of detections) {
            const entry = cached.get(det.rawValue)
            if (!entry) continue

            const bb = det.boundingBox
            const x = bb.x * scale + offsetX - HITBOX_PADDING
            const y = bb.y * scale + offsetY - HITBOX_PADDING
            const w = bb.width * scale + HITBOX_PADDING * 2
            const h = bb.height * scale + HITBOX_PADDING * 2

            hitboxMapRef.current.set(det.rawValue, {
              x, y, w, h,
              status: entry.status,
              name: entry.name,
              lastSeenAt: now,
            })
          }
        }
      }

      // ── OCR-only path (standard + fast) ──
      if (mode === 'ocr' || mode === 'ocr-fast') {
        const vw = video.videoWidth
        const vh = video.videoHeight
        const region: ScanRegion = {
          x: Math.round(vw * 0.25),
          y: Math.round(vh * 0.25),
          w: Math.round(vw * 0.5),
          h: Math.round(vh * 0.5),
        }

        inFlight++
        recognizeWords(video, region).then(ocrResult => {
          inFlight--
          if (!ocrResult) return

          frameCount++
          const { hits: ocrHits, totalMs, captureMs, recognizeMs, postMs } = ocrResult
          const resultTransform = videoCoverTransform(
            video.videoWidth, video.videoHeight,
            canvas.width, canvas.height,
          )
          if (ocrHits.length > 0 && resultTransform) {
            const { scale, offsetX, offsetY } = resultTransform
            const coconutHits = ocrHits.filter(h => h.isCoconut)
            for (const hit of coconutHits) {
              const x = hit.x * scale + offsetX - HITBOX_PADDING
              const y = hit.y * scale + offsetY - HITBOX_PADDING
              const w = hit.w * scale + HITBOX_PADDING * 2
              const h = hit.h * scale + HITBOX_PADDING * 2
              const bx = Math.round(x / 30)
              const by = Math.round(y / 30)
              hitboxMapRef.current.set(`ocr:${bx},${by}`, {
                x, y, w, h,
                status: 'coconut',
                name: hit.text,
                lastSeenAt: Date.now(),
              })
            }
          }

          let liveCoconut = 0
          for (const k of hitboxMapRef.current.keys()) {
            if (k.startsWith('ocr:')) liveCoconut++
          }
          setOcrDebug({
            frames: frameCount, words: ocrHits.length, coconut: liveCoconut,
            totalMs, captureMs, recognizeMs, postMs, queued: inFlight,
          })
        }).catch(() => { inFlight-- })
      }

      // Evict stale entries
      for (const [key, entry] of hitboxMapRef.current) {
        if (now - entry.lastSeenAt > HITBOX_RETAIN_MS) {
          hitboxMapRef.current.delete(key)
        }
      }

      drawUnifiedHitboxes(ctx, dw, dh, hitboxMapRef.current)
    }, 800)

    return () => clearInterval(id)
  }, [viewfinderMode])

  // ── Open / close viewfinder ──────────────────────────────────

  const openViewfinder = useCallback(async (mode: ViewfinderMode) => {
    if (mode === 'ocr') initOcr('standard')
    else if (mode === 'ocr-fast') initOcr('fast')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })
      streamRef.current = stream
      setState({ status: 'viewfinder', mode })
    } catch {
      setState({
        status: 'error',
        message: 'Camera not available.',
        inViewfinder: false,
      })
    }
  }, [])

  const closeViewfinder = useCallback(() => {
    stopStream()
    setState({ status: 'idle' })
  }, [stopStream])

  const handleTap = useCallback(async () => {
    if (viewfinderMode !== 'barcode') return
    const canScan =
      state.status === 'viewfinder' ||
      (state.status === 'error' && state.inViewfinder)
    if (!videoRef.current || !canScan) return

    setState({ status: 'processing', source: 'viewfinder', mode: 'barcode' })
    try {
      const sku = await detectBarcodeBurst(videoRef.current)
      if (!sku) {
        setState({
          status: 'error',
          message: 'No barcode found. Center the barcode and tap again.',
          inViewfinder: true,
          mode: 'barcode',
        })
        return
      }
      await handleSKU(sku)
    } catch {
      setState({
        status: 'error',
        message: 'Could not read barcode. Try again.',
        inViewfinder: true,
        mode: 'barcode',
      })
    }
  }, [viewfinderMode, state.status, handleSKU])

  // ── Shared ──────────────────────────────────────────────────

  const dismiss = useCallback(() => {
    if (state.status === 'error' && state.inViewfinder && state.mode) {
      setState({ status: 'viewfinder', mode: state.mode })
    } else {
      setState({ status: 'idle' })
    }
  }, [state])

  const busy = state.status === 'processing'

  return (
    <>
      {/* Viewfinder overlay */}
      {isViewfinderOpen && (
        <div className="fixed inset-0 z-50 bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            onClick={handleTap}
            className="h-full w-full object-cover"
          />

          {/* Canvas overlay for hitbox borders */}
          <canvas
            ref={canvasRef}
            className="pointer-events-none absolute inset-0 h-full w-full"
          />

          {/* Scan region overlay (OCR modes only) */}
          {isOcrMode && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div
                className="relative"
                style={{
                  width: '50%',
                  height: '50%',
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.5)',
                  border: ocrDebug.coconut > 0
                    ? '2px solid #ef4444'
                    : '2px solid white',
                }}
              />
            </div>
          )}

          <button
            onClick={closeViewfinder}
            className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-xl text-white backdrop-blur-sm"
          >
            &times;
          </button>

          {state.status === 'viewfinder' && (
            <div className="absolute bottom-8 left-0 right-0 text-center">
              <span className="rounded-full bg-black/50 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm">
                {viewfinderMode === 'barcode' ? 'Tap barcode to look up product' : 'Point at ingredient list'}
              </span>
            </div>
          )}

          {/* Debug status pill (OCR modes only) */}
          {isOcrMode && (
            <div className="absolute top-4 left-4 rounded-lg bg-black/60 px-3 py-2 font-mono text-xs text-white backdrop-blur-sm">
              <div>OCR: {ocrReady === 'ready' ? 'ready' : ocrReady} ({viewfinderMode === 'ocr-fast' ? 'fast' : 'std'})</div>
              <div>frames: {ocrDebug.frames} | queue: {ocrDebug.queued}</div>
              <div>{ocrDebug.totalMs}ms = {ocrDebug.captureMs}cap + {ocrDebug.recognizeMs}rec + {ocrDebug.postMs}post</div>
              <div>words: {ocrDebug.words}</div>
              {ocrDebug.coconut > 0 && (
                <div className="font-bold text-red-400">COCONUT: {ocrDebug.coconut}</div>
              )}
            </div>
          )}

          {state.status === 'processing' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30">
              <div className="rounded-lg bg-white px-6 py-4 text-sm font-medium text-gray-700 shadow-lg">
                Reading barcode...
              </div>
            </div>
          )}

          {state.status === 'error' && state.inViewfinder && (
            <div className="absolute bottom-20 left-1/2 w-[90vw] max-w-lg -translate-x-1/2">
              <div className="flex items-start gap-2 rounded-lg bg-red-600 px-4 py-3 text-sm text-white shadow-lg">
                <span className="flex-1">{state.message}</span>
                <button onClick={dismiss} className="font-bold hover:opacity-70">
                  &times;
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error toast (non-viewfinder errors) */}
      {state.status === 'error' && !state.inViewfinder && (
        <div className="fixed bottom-20 left-1/2 z-50 w-[90vw] max-w-lg -translate-x-1/2">
          <div className="flex items-start gap-2 rounded-lg bg-red-600 px-4 py-3 text-sm text-white shadow-lg">
            <span className="flex-1">{state.message}</span>
            <button onClick={dismiss} className="font-bold hover:opacity-70">
              &times;
            </button>
          </div>
        </div>
      )}

      {/* Sticky footer — three mode buttons */}
      <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-lg -translate-x-1/2 p-3">
        <div className="flex gap-2">
          {/* Barcode: pink */}
          <button
            onClick={() => openViewfinder('barcode')}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-3.5 text-sm font-semibold text-white shadow-lg transition-colors disabled:opacity-60"
            style={{ backgroundColor: '#f51c99' }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            Barcode
          </button>

          {/* OCR standard: blue */}
          <button
            onClick={() => openViewfinder('ocr')}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-2 py-3.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            OCR
          </button>

          {/* OCR fast: amber */}
          <button
            onClick={() => openViewfinder('ocr-fast')}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-500 px-2 py-3.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-amber-600 active:bg-amber-700 disabled:opacity-60"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            Quick
          </button>
        </div>
      </div>
    </>
  )
}
