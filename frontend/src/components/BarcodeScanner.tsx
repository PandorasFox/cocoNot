import { useRef, useState, useCallback, useEffect } from 'react'
import { skuLookup } from '../api/client'
import { detectBarcodeBurst, detectBarcodesWithBounds } from '../api/barcode'
import { getStatuses, putSKULookupResults } from '../api/cache'
import {
  drawUnifiedHitboxes, videoCoverTransform,
  HITBOX_RETAIN_MS, HITBOX_PADDING,
  type HitboxEntry,
} from './hitbox'

type ScanState =
  | { status: 'idle' }
  | { status: 'viewfinder' }
  | { status: 'processing'; source: 'viewfinder' }
  | { status: 'error'; message: string; inViewfinder: boolean }

export default function BarcodeScanner() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const inFlightRef = useRef(new Set<string>())
  const hitboxMapRef = useRef(new Map<string, HitboxEntry>())
  const [state, setState] = useState<ScanState>({ status: 'idle' })

  // Stop the camera stream
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop()
      streamRef.current = null
    }
  }, [])

  // Clean up on unmount
  useEffect(() => stopStream, [stopStream])


  // ── Viewfinder state helpers ─────────────────────────────────

  const isViewfinderOpen =
    state.status === 'viewfinder' ||
    state.status === 'processing' ||
    (state.status === 'error' && state.inViewfinder)

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

  // ── Detection loop ──────────────────────────────────────────

  useEffect(() => {
    if (!isViewfinderOpen) return

    hitboxMapRef.current.clear()

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
  }, [isViewfinderOpen])

  // ── Open / close viewfinder ──────────────────────────────────

  const openViewfinder = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      })
      streamRef.current = stream
      setState({ status: 'viewfinder' })
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
    const canScan =
      state.status === 'viewfinder' ||
      (state.status === 'error' && state.inViewfinder)
    if (!videoRef.current || !canScan) return

    setState({ status: 'processing', source: 'viewfinder' })
    try {
      const sku = await detectBarcodeBurst(videoRef.current)
      if (!sku) {
        setState({
          status: 'error',
          message: 'No barcode found. Center the barcode and tap again.',
          inViewfinder: true,
        })
        return
      }
      // Look up and cache — the viewfinder loop will draw the hitbox
      await skuLookup([sku])
        .then((res) => putSKULookupResults(res.results, [sku]))
        .catch(() => {})
      setState({ status: 'viewfinder' })
    } catch {
      setState({
        status: 'error',
        message: 'Could not read barcode. Try again.',
        inViewfinder: true,
      })
    }
  }, [state.status])

  // ── Shared ──────────────────────────────────────────────────

  const dismiss = useCallback(() => {
    if (state.status === 'error' && state.inViewfinder) {
      setState({ status: 'viewfinder' })
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

          <button
            onClick={closeViewfinder}
            className="absolute top-4 right-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-xl text-white backdrop-blur-sm"
          >
            &times;
          </button>

          {state.status === 'viewfinder' && (
            <div className="absolute bottom-8 left-0 right-0 text-center">
              <span className="rounded-full bg-black/50 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm">
                Tap barcode to look up product
              </span>
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

      {/* Sticky footer */}
      <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-lg -translate-x-1/2 p-3">
        <div className="flex gap-2">
          <button
            onClick={() => openViewfinder()}
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
        </div>
      </div>
    </>
  )
}
