import { useRef, useState, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProductByBarcode, skuLookup } from '../api/client'
import { detectBarcode, detectBarcodeBurst, detectBarcodesWithBounds } from '../api/barcode'
import { getStatuses, putSKULookupResults, putProduct, putNotFound, type CachedSKU } from '../api/cache'

type ScanState =
  | { status: 'idle' }
  | { status: 'viewfinder' }
  | { status: 'processing'; source: 'file' | 'viewfinder' }
  | { status: 'error'; message: string; inViewfinder: boolean }

// Colors for hitbox borders
const HITBOX_COLORS: Record<CachedSKU['status'], string> = {
  coconut: '#ef4444',   // red
  clean: '#eab308',     // yellow
  not_found: '#3b82f6', // blue
}

// Status fallback labels when no product name is cached
const STATUS_LABELS: Record<CachedSKU['status'], string> = {
  coconut: 'COCONUT',
  clean: 'CLEAN',
  not_found: 'UNKNOWN',
}

// WCAG relative luminance for a hex color
function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Persistent hitbox entry
interface HitboxEntry {
  x: number
  y: number
  w: number
  h: number
  status: CachedSKU['status']
  name?: string
  lastSeenAt: number
}

const HITBOX_RETAIN_MS = 2000
const HITBOX_PADDING = 16

/**
 * Compute the mapping from video natural coordinates to display coordinates.
 * The video uses object-cover, so it scales up and crops to fill the container.
 */
function videoCoverTransform(video: HTMLVideoElement) {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const dw = video.clientWidth
  const dh = video.clientHeight
  if (!vw || !vh || !dw || !dh) return null

  const videoAspect = vw / vh
  const displayAspect = dw / dh

  let scale: number
  let offsetX: number
  let offsetY: number

  if (videoAspect > displayAspect) {
    // Video is wider — cropped horizontally
    scale = dh / vh
    offsetX = (dw - vw * scale) / 2
    offsetY = 0
  } else {
    // Video is taller — cropped vertically
    scale = dw / vw
    offsetX = 0
    offsetY = (dh - vh * scale) / 2
  }

  return { scale, offsetX, offsetY }
}

export default function BarcodeScanner() {
  const navigate = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
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

  // ── File picker scan (blue button) ──────────────────────────

  const openFilePicker = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file) return

      setState({ status: 'processing', source: 'file' })
      try {
        const sku = await detectBarcode(file)
        if (!sku) {
          setState({
            status: 'error',
            message: 'No barcode found. Try again with the barcode centered in frame.',
            inViewfinder: false,
          })
          return
        }
        await handleSKU(sku)
      } catch {
        setState({
          status: 'error',
          message: 'Could not read barcode. Try a clearer photo.',
          inViewfinder: false,
        })
      } finally {
        if (inputRef.current) inputRef.current.value = ''
      }
    },
    [handleSKU],
  )

  // ── Live viewfinder (pink button) ───────────────────────────

  const isViewfinderOpen =
    state.status === 'viewfinder' ||
    (state.status === 'processing' && state.source === 'viewfinder') ||
    (state.status === 'error' && state.inViewfinder)

  // Attach stream to video element once the viewfinder mounts
  useEffect(() => {
    const video = videoRef.current
    const stream = streamRef.current
    if (!video || !stream || !isViewfinderOpen) return

    // Firefox mobile needs srcObject set and play() called explicitly.
    // Setting attributes directly for maximum compatibility.
    video.setAttribute('autoplay', '')
    video.setAttribute('playsinline', '')
    video.srcObject = stream

    const startPlayback = () => {
      video.play().catch(() => {
        // play() can reject if the user switches away quickly — harmless
      })
    }

    // If the video already has data, play immediately; otherwise wait
    if (video.readyState >= video.HAVE_METADATA) {
      startPlayback()
    } else {
      video.addEventListener('loadedmetadata', startPlayback, { once: true })
      return () => video.removeEventListener('loadedmetadata', startPlayback)
    }
  }, [isViewfinderOpen])

  // ── Continuous detection loop for hitbox overlays ──────────

  useEffect(() => {
    if (!isViewfinderOpen) return

    // Clear hitbox map when viewfinder opens
    hitboxMapRef.current.clear()

    const id = setInterval(async () => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas || video.readyState < video.HAVE_CURRENT_DATA) return

      // Size canvas to match video display size
      const dw = video.clientWidth
      const dh = video.clientHeight
      if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width = dw
        canvas.height = dh
      }

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const now = Date.now()
      const transform = videoCoverTransform(video)

      // Detect barcodes with bounding boxes
      let detections: { rawValue: string; boundingBox: DOMRectReadOnly }[]
      try {
        detections = await detectBarcodesWithBounds(video)
      } catch {
        detections = []
      }

      if (detections.length > 0 && transform) {
        const { scale, offsetX, offsetY } = transform

        // Look up all detected SKUs in cache
        const skus = detections.map((d) => d.rawValue)
        const cached = await getStatuses(skus)

        // Fire batch lookup for cache misses
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

        // Merge detections into persistent hitbox map
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
      for (const [sku, entry] of hitboxMapRef.current) {
        if (now - entry.lastSeenAt > HITBOX_RETAIN_MS) {
          hitboxMapRef.current.delete(sku)
        }
      }

      // Redraw from the persistent map
      ctx.clearRect(0, 0, dw, dh)

      const lineWidth = 3
      const chipFontSize = 11
      const chipPadX = 4
      const chipPadY = 2
      const chipRadius = 3

      for (const [, entry] of hitboxMapRef.current) {
        const { x, y, w, h, status, name } = entry
        const color = HITBOX_COLORS[status]

        // Draw rounded rect border
        ctx.strokeStyle = color
        ctx.lineWidth = lineWidth
        ctx.lineJoin = 'round'

        const r = 6
        ctx.beginPath()
        ctx.moveTo(x + r, y)
        ctx.lineTo(x + w - r, y)
        ctx.quadraticCurveTo(x + w, y, x + w, y + r)
        ctx.lineTo(x + w, y + h - r)
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
        ctx.lineTo(x + r, y + h)
        ctx.quadraticCurveTo(x, y + h, x, y + h - r)
        ctx.lineTo(x, y + r)
        ctx.quadraticCurveTo(x, y, x + r, y)
        ctx.closePath()
        ctx.stroke()

        // Draw text label chip above the bounding box
        const label = name
          ? (name.length > 25 ? name.slice(0, 24) + '\u2026' : name)
          : STATUS_LABELS[status]

        ctx.font = `bold ${chipFontSize}px sans-serif`
        const textWidth = ctx.measureText(label).width
        const chipW = textWidth + chipPadX * 2
        const chipH = chipFontSize + chipPadY * 2
        const chipX = x
        const chipY = y - chipH - 2

        // Chip background
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.moveTo(chipX + chipRadius, chipY)
        ctx.lineTo(chipX + chipW - chipRadius, chipY)
        ctx.quadraticCurveTo(chipX + chipW, chipY, chipX + chipW, chipY + chipRadius)
        ctx.lineTo(chipX + chipW, chipY + chipH - chipRadius)
        ctx.quadraticCurveTo(chipX + chipW, chipY + chipH, chipX + chipW - chipRadius, chipY + chipH)
        ctx.lineTo(chipX + chipRadius, chipY + chipH)
        ctx.quadraticCurveTo(chipX, chipY + chipH, chipX, chipY + chipH - chipRadius)
        ctx.lineTo(chipX, chipY + chipRadius)
        ctx.quadraticCurveTo(chipX, chipY, chipX + chipRadius, chipY)
        ctx.closePath()
        ctx.fill()

        // Chip text — WCAG contrast
        const lum = relativeLuminance(color)
        ctx.fillStyle = lum > 0.5 ? '#000000' : '#ffffff'
        ctx.textBaseline = 'top'
        ctx.fillText(label, chipX + chipPadX, chipY + chipPadY)
      }
    }, 1000)

    return () => clearInterval(id)
  }, [isViewfinderOpen])

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
        message: 'Camera not available. Use the barcode scan button instead.',
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
      await handleSKU(sku)
    } catch {
      setState({
        status: 'error',
        message: 'Could not read barcode. Try again.',
        inViewfinder: true,
      })
    }
  }, [state.status, handleSKU])

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
                Tap to scan barcode
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

      {/* Error toast (file picker errors) */}
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

      {/* Processing overlay (file picker) */}
      {state.status === 'processing' && state.source === 'file' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="rounded-lg bg-white px-6 py-4 text-sm font-medium text-gray-700 shadow-lg">
            Reading barcode...
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="hidden"
      />

      {/* Sticky footer — two buttons */}
      <div className="fixed bottom-0 left-1/2 z-40 w-full max-w-lg -translate-x-1/2 p-3">
        <div className="flex gap-2">
          {/* Blue: file picker barcode scan */}
          <button
            onClick={openFilePicker}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-3.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-blue-700 active:bg-blue-800 disabled:opacity-60"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <line x1="6" y1="8" x2="6" y2="16" />
              <line x1="8.5" y1="8" x2="8.5" y2="16" />
              <line x1="11" y1="8" x2="11" y2="16" />
              <line x1="14" y1="8" x2="14" y2="16" />
              <line x1="16.5" y1="8" x2="16.5" y2="16" />
              <line x1="18" y1="8" x2="18" y2="16" />
            </svg>
            Scan Barcode
          </button>

          {/* Pink: live viewfinder */}
          <button
            onClick={openViewfinder}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3.5 text-sm font-semibold text-white shadow-lg transition-colors disabled:opacity-60"
            style={{ backgroundColor: '#f15c99' }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              {/* Camera/viewfinder icon */}
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            bARcode Glance
          </button>
        </div>
      </div>
    </>
  )
}
