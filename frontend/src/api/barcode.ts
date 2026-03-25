import {
  BarcodeDetector,
  type BarcodeFormat,
} from 'barcode-detector/ponyfill'

const PRODUCT_FORMATS: BarcodeFormat[] = [
  'ean_13',
  'upc_a',
  'ean_8',
  'upc_e',
]

let detector: BarcodeDetector | null = null

function getDetector(): BarcodeDetector {
  if (!detector) {
    detector = new BarcodeDetector({ formats: PRODUCT_FORMATS })
  }
  return detector
}

/** Rotate an ImageBitmap by the given degrees using OffscreenCanvas. */
function rotateBitmap(src: ImageBitmap, degrees: number): ImageBitmap {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const w = Math.ceil(src.width * cos + src.height * sin)
  const h = Math.ceil(src.width * sin + src.height * cos)
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.translate(w / 2, h / 2)
  ctx.rotate(rad)
  ctx.drawImage(src, -src.width / 2, -src.height / 2)
  return canvas.transferToImageBitmap()
}

/** Try detecting a barcode at 0°, 45°, and 90° rotations. */
async function detectWithRotations(
  bitmap: ImageBitmap,
): Promise<string | null> {
  const det = getDetector()

  // Try original orientation first
  const results = await det.detect(bitmap)
  if (results.length > 0) return results[0].rawValue

  // Try 45° and 90° rotations
  for (const deg of [45, 90]) {
    const rotated = rotateBitmap(bitmap, deg)
    try {
      const r = await det.detect(rotated)
      if (r.length > 0) return r[0].rawValue
    } finally {
      rotated.close()
    }
  }

  return null
}

/**
 * Detect product barcodes from a captured image file.
 * Returns the raw barcode string (SKU) or null if none found.
 */
export async function detectBarcode(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  try {
    return await detectWithRotations(bitmap)
  } finally {
    bitmap.close()
  }
}

/** Detect a barcode from a single video frame. */
export async function detectBarcodeFromVideo(
  video: HTMLVideoElement,
): Promise<string | null> {
  const bitmap = await createImageBitmap(video)
  try {
    return await detectWithRotations(bitmap)
  } finally {
    bitmap.close()
  }
}

/**
 * Detect all barcodes in a video frame, returning full DetectedBarcode objects
 * with bounding boxes and corner points for overlay drawing.
 */
export async function detectBarcodesWithBounds(
  video: HTMLVideoElement,
): Promise<{ rawValue: string; boundingBox: DOMRectReadOnly }[]> {
  const det = getDetector()
  const bitmap = await createImageBitmap(video)
  try {
    const results = await det.detect(bitmap)
    return results.map((r) => ({
      rawValue: r.rawValue,
      boundingBox: r.boundingBox,
    }))
  } finally {
    bitmap.close()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Capture multiple frames from a video and return the most common barcode.
 * Helps with motion blur, poor focus, and exposure variation.
 */
export async function detectBarcodeBurst(
  video: HTMLVideoElement,
  frames = 5,
  intervalMs = 60,
): Promise<string | null> {
  // Grab frames at intervals
  const bitmaps: ImageBitmap[] = []
  for (let i = 0; i < frames; i++) {
    bitmaps.push(await createImageBitmap(video))
    if (i < frames - 1) await sleep(intervalMs)
  }

  // Decode all frames in parallel, trying rotations on each
  const results = await Promise.all(
    bitmaps.map(async (bmp) => {
      try {
        return await detectWithRotations(bmp)
      } finally {
        bmp.close()
      }
    }),
  )

  // Majority vote: pick the most common non-null result
  const counts = new Map<string, number>()
  for (const r of results) {
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  if (counts.size === 0) return null

  let best = ''
  let bestCount = 0
  for (const [code, n] of counts) {
    if (n > bestCount) {
      best = code
      bestCount = n
    }
  }
  return best
}
