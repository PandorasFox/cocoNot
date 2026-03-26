import { useRef, useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProductByBarcode, skuLookup } from '../api/client'
import { detectBarcodeBurst, detectBarcodesWithBounds } from '../api/barcode'
import { getStatuses, putSKULookupResults, putProduct, putNotFound } from '../api/cache'
import { initOcr, recognizeBurst, getOcrReadyState, onOcrReadyChange, getInFlightCount, type OcrReadyState, type ScanRegion } from '../api/ocr'
import {
  drawUnifiedHitboxes, videoCoverTransform,
  HITBOX_RETAIN_MS, HITBOX_PADDING,
  type HitboxEntry,
} from './hitbox'

type ViewfinderMode = 'barcode' | 'ocr'

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
    inFlight: number; cropW: number; cropH: number; burstTotal: number
  }>({ frames: 0, words: 0, coconut: 0, totalMs: 0, captureMs: 0, recognizeMs: 0, postMs: 0, inFlight: 0, cropW: 0, cropH: 0, burstTotal: 0 })

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
  const isOcrMode = viewfinderMode === 'ocr'

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
    setOcrDebug({ frames: 0, words: 0, coconut: 0, totalMs: 0, captureMs: 0, recognizeMs: 0, postMs: 0, inFlight: 0, cropW: 0, cropH: 0, burstTotal: 0 })
    const mode = viewfinderMode

    if (mode === 'ocr') initOcr('standard')

    // OCR modes: tap-to-burst, no continuous loop
    if (mode !== 'barcode') return

    // ── Barcode continuous detection loop ──
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

      // Evict stale entries
      for (const [key, entry] of hitboxMapRef.current) {
        if (now - entry.lastSeenAt > HITBOX_RETAIN_MS) {
          hitboxMapRef.current.delete(key)
        }
      }

      drawUnifiedHitboxes(ctx, dw, dh, hitboxMapRef.current)
    }, 1333)

    return () => clearInterval(id)
  }, [viewfinderMode])

  // ── Open / close viewfinder ──────────────────────────────────

  const openViewfinder = useCallback(async (mode: ViewfinderMode) => {
    if (mode === 'ocr') initOcr('standard')

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

  const burstActiveRef = useRef(false)

  const handleTap = useCallback(async () => {
    // ── OCR burst on tap ──
    if (viewfinderMode === 'ocr') {
      if (burstActiveRef.current) return
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA) return

      burstActiveRef.current = true
      hitboxMapRef.current.clear()

      // Re-bind to non-null for closures (TS can't narrow refs across awaits)
      const vid = video
      const cvs = canvas
      const dw = vid.clientWidth
      const dh = vid.clientHeight
      cvs.width = dw
      cvs.height = dh

      // Save 1080p preview dimensions for coordinate mapping later
      const previewW = vid.videoWidth
      const previewH = vid.videoHeight

      // Switch to 4K for burst capture
      const track = streamRef.current?.getVideoTracks()[0]
      let switched4k = false
      if (track) {
        try {
          await track.applyConstraints({ width: { ideal: 3840 }, height: { ideal: 2160 } })
          // Wait for the resolution change to take effect (first new frame)
          await new Promise<void>((resolve) => { vid.requestVideoFrameCallback(() => resolve()) })
          switched4k = vid.videoWidth > previewW
        } catch {}
      }

      // Capture dimensions (4K if switch succeeded, else 1080p)
      const captureW = vid.videoWidth
      const captureH = vid.videoHeight

      // Compute crop region using CAPTURE dimensions + display viewport
      const captureTransform = videoCoverTransform(captureW, captureH, dw, dh)

      let region: ScanRegion
      if (captureTransform) {
        const { scale, offsetX, offsetY } = captureTransform
        const visX = -offsetX / scale
        const visY = -offsetY / scale
        const visW = dw / scale
        const visH = dh / scale
        const rx = Math.max(0, Math.round(visX + visW / 4))
        const ry = Math.max(0, Math.round(visY + visH / 4))
        const rx2 = Math.min(captureW, Math.round(visX + visW * 3 / 4))
        const ry2 = Math.min(captureH, Math.round(visY + visH * 3 / 4))
        region = { x: rx, y: ry, w: rx2 - rx, h: ry2 - ry }
      } else {
        region = {
          x: Math.round(captureW / 4), y: Math.round(captureH / 4),
          w: Math.round(captureW / 2), h: Math.round(captureH / 2),
        }
      }

      const BURST_FRAMES = 5

      // Capture each frame cropped to region, downscaled 2× for faster OCR
      const halfW = Math.round(region.w / 2)
      const halfH = Math.round(region.h / 2)
      const frames: OffscreenCanvas[] = []
      await new Promise<void>((resolve) => {
        function grab() {
          const frame = new OffscreenCanvas(halfW, halfH)
          frame.getContext('2d')!.drawImage(
            vid, region.x, region.y, region.w, region.h,
            0, 0, halfW, halfH,
          )
          frames.push(frame)
          if (frames.length >= BURST_FRAMES) { resolve(); return }
          vid.requestVideoFrameCallback(grab)
        }
        vid.requestVideoFrameCallback(grab)
      })

      // Switch back to 1080p for preview
      if (track && switched4k) {
        try { await track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } }) } catch {}
      }

      // Hits from Tesseract are in downscaled (half) coords.
      // Pipeline: half-coords ×2 → capture coords → ×(preview/capture) → preview coords → display
      const captureToPreview = previewW / captureW  // e.g. 0.5 if 4K→1080p
      const hitScale = 2 * captureToPreview          // half→capture→preview in one multiply

      setOcrDebug(prev => ({ ...prev, burstTotal: BURST_FRAMES, cropW: halfW, cropH: halfH }))

      // Process burst through worker pool
      const displayTransform = videoCoverTransform(previewW, previewH, dw, dh)
      let frameCount = 0
      await recognizeBurst(frames, { x: 0, y: 0 }, (ocrResult, _fi) => {
        frameCount++
        const { hits: ocrHits, totalMs, captureMs, recognizeMs, postMs } = ocrResult
        if (ocrHits.length > 0 && displayTransform) {
          const { scale, offsetX, offsetY } = displayTransform
          const coconutHits = ocrHits.filter(h => h.isCoconut)
          for (const hit of coconutHits) {
            // half-size → preview coords (add region offset in preview space)
            const previewHitX = hit.x * hitScale + region.x * captureToPreview
            const previewHitY = hit.y * hitScale + region.y * captureToPreview
            const previewHitW = hit.w * hitScale
            const previewHitH = hit.h * hitScale
            // preview coords → display coords
            const hx = previewHitX * scale + offsetX - HITBOX_PADDING
            const hy = previewHitY * scale + offsetY - HITBOX_PADDING
            const hw = previewHitW * scale + HITBOX_PADDING * 2
            const hh = previewHitH * scale + HITBOX_PADDING * 2

            // Find overlapping existing OCR hitbox and merge
            let merged = false
            for (const [key, existing] of hitboxMapRef.current) {
              if (!key.startsWith('ocr:')) continue
              const ex2 = existing.x + existing.w
              const ey2 = existing.y + existing.h
              const hx2 = hx + hw
              const hy2 = hy + hh
              if (hx < ex2 && hx2 > existing.x && hy < ey2 && hy2 > existing.y) {
                const nx = Math.min(existing.x, hx)
                const ny = Math.min(existing.y, hy)
                existing.x = nx
                existing.y = ny
                existing.w = Math.max(ex2, hx2) - nx
                existing.h = Math.max(ey2, hy2) - ny
                existing.lastSeenAt = Date.now()
                merged = true
                break
              }
            }
            if (!merged) {
              const id = `ocr:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
              hitboxMapRef.current.set(id, {
                x: hx, y: hy, w: hw, h: hh,
                status: 'coconut',
                name: hit.text,
                lastSeenAt: Date.now(),
              })
            }
          }
        }

        let liveCoconut = 0
        for (const k of hitboxMapRef.current.keys()) {
          if (k.startsWith('ocr:')) liveCoconut++
        }

        const ctx = cvs.getContext('2d')
        if (ctx) drawUnifiedHitboxes(ctx, dw, dh, hitboxMapRef.current)

        setOcrDebug({
          frames: frameCount, words: ocrHits.length, coconut: liveCoconut,
          totalMs, captureMs, recognizeMs, postMs, inFlight: getInFlightCount(),
          cropW: region.w, cropH: region.h, burstTotal: BURST_FRAMES,
        })
      })

      burstActiveRef.current = false
      return
    }

    // ── Barcode tap ──
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
                {viewfinderMode === 'barcode' ? 'Tap barcode to look up product' : 'Tap to scan ingredients'}
              </span>
            </div>
          )}

          {/* Debug status pill (OCR modes only) */}
          {isOcrMode && (
            <div className="absolute top-4 left-4 rounded-lg bg-black/60 px-3 py-2 font-mono text-xs text-white backdrop-blur-sm">
              <div>OCR: {ocrReady === 'ready' ? 'ready' : ocrReady}</div>
              <div>burst: {ocrDebug.frames}/{ocrDebug.burstTotal} | fly: {ocrDebug.inFlight}</div>
              <div>{ocrDebug.totalMs}ms = {ocrDebug.captureMs}cap + {ocrDebug.recognizeMs}rec + {ocrDebug.postMs}post</div>
              <div>crop: {ocrDebug.cropW}x{ocrDebug.cropH} | words: {ocrDebug.words}</div>
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

        </div>
      </div>
    </>
  )
}
