import type { CachedSKU } from '../api/cache'

// Colors for hitbox borders
export const HITBOX_COLORS: Record<CachedSKU['status'] | 'coconut_ocr', string> = {
  coconut: '#ef4444',   // red
  clean: '#eab308',     // yellow
  not_found: '#3b82f6', // blue
  coconut_ocr: '#ef4444', // red (same as coconut)
}

// Status fallback labels when no product name is cached
export const STATUS_LABELS: Record<CachedSKU['status'], string> = {
  coconut: 'COCONUT',
  clean: 'CLEAN',
  not_found: 'UNKNOWN',
}

// WCAG relative luminance for a hex color
export function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Persistent hitbox entry
export interface HitboxEntry {
  x: number
  y: number
  w: number
  h: number
  status: CachedSKU['status']
  name?: string
  lastSeenAt: number
}

export const HITBOX_RETAIN_MS = 3000
export const HITBOX_PADDING = 16

/**
 * Compute the mapping from video natural coordinates to display coordinates.
 * The video uses object-cover, so it scales up and crops to fill the container.
 */
export function videoCoverTransform(
  vw: number, vh: number, dw: number, dh: number,
): { scale: number; offsetX: number; offsetY: number } | null {
  if (!vw || !vh || !dw || !dh) return null

  const videoAspect = vw / vh
  const displayAspect = dw / dh

  let scale: number
  let offsetX: number
  let offsetY: number

  if (videoAspect > displayAspect) {
    scale = dh / vh
    offsetX = (dw - vw * scale) / 2
    offsetY = 0
  } else {
    scale = dw / vw
    offsetX = 0
    offsetY = (dh - vh * scale) / 2
  }

  return { scale, offsetX, offsetY }
}

/** Draw unified hitboxes (barcode + OCR coconut matches) onto the canvas. */
export function drawUnifiedHitboxes(
  ctx: CanvasRenderingContext2D,
  dw: number,
  dh: number,
  hitboxMap: Map<string, HitboxEntry>,
) {
  ctx.clearRect(0, 0, dw, dh)

  const chipFontSize = 11
  const chipPadX = 4
  const chipPadY = 2
  const chipRadius = 3

  for (const [key, entry] of hitboxMap) {
    const { x, y, w, h, status, name } = entry
    const isOcr = key.startsWith('ocr:')
    const color = isOcr ? HITBOX_COLORS.coconut_ocr : (HITBOX_COLORS[status] ?? '#ef4444')

    // OCR hitboxes: thicker border, grown outward so it doesn't cover text
    const lineWidth = isOcr ? 5 : 3
    const outset = isOcr ? lineWidth / 2 : 0
    const rx = x - outset
    const ry = y - outset
    const rw = w + outset * 2
    const rh = h + outset * 2

    // Draw rounded rect border
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.lineJoin = 'round'

    const r = 6
    ctx.beginPath()
    ctx.moveTo(rx + r, ry)
    ctx.lineTo(rx + rw - r, ry)
    ctx.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r)
    ctx.lineTo(rx + rw, ry + rh - r)
    ctx.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh)
    ctx.lineTo(rx + r, ry + rh)
    ctx.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r)
    ctx.lineTo(rx, ry + r)
    ctx.quadraticCurveTo(rx, ry, rx + r, ry)
    ctx.closePath()
    ctx.stroke()

    // Label chip above the bounding box
    const label = isOcr
      ? (name && name.length > 20 ? name.slice(0, 19) + '\u2026' : name ?? 'COCONUT')
      : (name
          ? (name.length > 25 ? name.slice(0, 24) + '\u2026' : name)
          : STATUS_LABELS[status] ?? status.toUpperCase())

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
}
