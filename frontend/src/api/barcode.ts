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

/**
 * Detect product barcodes from a captured image file.
 * Returns the raw barcode string (SKU) or null if none found.
 */
export async function detectBarcode(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const results = await getDetector().detect(bitmap)
    if (results.length === 0) return null
    return results[0].rawValue
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
    const results = await getDetector().detect(bitmap)
    if (results.length === 0) return null
    return results[0].rawValue
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

  // Decode all frames in parallel
  const det = getDetector()
  const results = await Promise.all(
    bitmaps.map(async (bmp) => {
      try {
        const found = await det.detect(bmp)
        return found.length > 0 ? found[0].rawValue : null
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
