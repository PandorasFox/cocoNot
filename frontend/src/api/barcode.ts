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

/** Load a File/Blob into an ImageBitmap for detection. */
async function fileToImageBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file)
}

/**
 * Detect product barcodes from a captured image file.
 * Returns the raw barcode string (SKU) or null if none found.
 */
export async function detectBarcode(file: File): Promise<string | null> {
  const bitmap = await fileToImageBitmap(file)
  try {
    const results = await getDetector().detect(bitmap)
    if (results.length === 0) return null
    // Return the first product barcode found
    return results[0].rawValue
  } finally {
    bitmap.close()
  }
}
