import Tesseract from 'tesseract.js'

// ── Types ──────────────────────────────────────────────────────

export interface OcrHit {
  text: string
  x: number
  y: number
  w: number
  h: number
  isCoconut: boolean
}

export type OcrReadyState = 'loading' | 'ready' | 'error'

export interface Tile {
  canvas: OffscreenCanvas
  offsetX: number
  offsetY: number
}

// ── Constants ─────────────────────────────────────────────────

export const POOL_SIZE = 4
export const TILE_SIZE = 1600
export const TILE_OVERLAP = 200

// ── Worker pool state ─────────────────────────────────────────

let workers: Tesseract.Worker[] = []
let readyState: OcrReadyState = 'loading'
const listeners = new Set<(s: OcrReadyState) => void>()

function setReadyState(s: OcrReadyState) {
  readyState = s
  for (const fn of listeners) fn(s)
}

export function getOcrReadyState(): OcrReadyState {
  return readyState
}

export function onOcrReadyChange(fn: (s: OcrReadyState) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// ── Worker lifecycle ───────────────────────────────────────────

let initPromise: Promise<void> | null = null

/** Eagerly initialize the Tesseract worker pool. Safe to call multiple times. */
export function initOcr(): void {
  if (initPromise) return
  initPromise = (async () => {
    try {
      setReadyState('loading')
      workers = await Promise.all(
        Array.from({ length: POOL_SIZE }, () => Tesseract.createWorker('eng')),
      )
      setReadyState('ready')
    } catch {
      setReadyState('error')
      for (const w of workers) w.terminate().catch(() => {})
      workers = []
      initPromise = null
    }
  })()
}

/** Tear down all workers (crash recovery). Next initOcr() recreates the pool. */
export function terminateOcr(): void {
  for (const w of workers) w.terminate().catch(() => {})
  workers = []
  initPromise = null
  setReadyState('loading')
}

// ── Preprocessing ──────────────────────────────────────────────

/**
 * Otsu's threshold: find the optimal threshold to split a grayscale
 * histogram into foreground / background with minimal intra-class variance.
 */
export function otsuThreshold(data: Uint8ClampedArray, pixelCount: number): number {
  const histogram = new Int32Array(256)
  for (let i = 0; i < pixelCount; i++) {
    histogram[data[i * 4]]++
  }

  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * histogram[i]

  let sumB = 0
  let wB = 0
  let wF: number
  let maxVariance = 0
  let threshold = 0

  for (let t = 0; t < 256; t++) {
    wB += histogram[t]
    if (wB === 0) continue
    wF = pixelCount - wB
    if (wF === 0) break

    sumB += t * histogram[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const variance = wB * wF * (mB - mF) * (mB - mF)

    if (variance > maxVariance) {
      maxVariance = variance
      threshold = t
    }
  }

  return threshold
}

/** Apply grayscale + Otsu binary threshold to an OffscreenCanvas in place. */
export function preprocessCanvas(canvas: OffscreenCanvas): void {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.getImageData(0, 0, w, h)
  const { data } = imageData
  const pixelCount = w * h

  // Grayscale in-place
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4
    const gray = 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2]
    data[off] = data[off + 1] = data[off + 2] = gray
  }

  // Otsu threshold -> binary
  const thresh = otsuThreshold(data, pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4
    const v = data[off] > thresh ? 255 : 0
    data[off] = data[off + 1] = data[off + 2] = v
  }

  ctx.putImageData(imageData, 0, 0)
}

// ── Tiling ────────────────────────────────────────────────────

/** Compute tile positions along a single axis. */
function tilePositions(total: number, tileSize: number, overlap: number): number[] {
  if (total <= tileSize) return [0]
  const stride = tileSize - overlap
  const positions: number[] = []
  for (let p = 0; p + tileSize <= total; p += stride) {
    positions.push(p)
  }
  // Flush: ensure the last tile covers the edge
  if (positions.length === 0 || positions[positions.length - 1] + tileSize < total) {
    positions.push(Math.max(0, total - tileSize))
  }
  return positions
}

/**
 * Split a source canvas into overlapping tiles for parallel OCR.
 * Each tile is preprocessed (grayscale + Otsu) individually.
 */
export function createTiles(
  source: OffscreenCanvas,
  width: number,
  height: number,
  tileSize = TILE_SIZE,
  overlap = TILE_OVERLAP,
): Tile[] {
  // Small enough for a single tile — preprocess and return as-is
  if (width <= tileSize && height <= tileSize) {
    preprocessCanvas(source)
    return [{ canvas: source, offsetX: 0, offsetY: 0 }]
  }

  const xs = tilePositions(width, tileSize, overlap)
  const ys = tilePositions(height, tileSize, overlap)

  const tiles: Tile[] = []
  for (const ty of ys) {
    for (const tx of xs) {
      const tw = Math.min(tileSize, width - tx)
      const th = Math.min(tileSize, height - ty)
      const tile = new OffscreenCanvas(tw, th)
      tile.getContext('2d')!.drawImage(source, tx, ty, tw, th, 0, 0, tw, th)
      preprocessCanvas(tile)
      tiles.push({ canvas: tile, offsetX: tx, offsetY: ty })
    }
  }
  return tiles
}

// ── Deduplication ─────────────────────────────────────────────

/** Deduplicate coconut hits from overlapping tiles using IoU. */
export function deduplicateHits(hits: OcrHit[]): OcrHit[] {
  const result: OcrHit[] = []
  for (const hit of hits) {
    if (!hit.isCoconut) {
      result.push(hit)
      continue
    }
    let isDupe = false
    for (const existing of result) {
      if (!existing.isCoconut) continue
      const x1 = Math.max(hit.x, existing.x)
      const y1 = Math.max(hit.y, existing.y)
      const x2 = Math.min(hit.x + hit.w, existing.x + existing.w)
      const y2 = Math.min(hit.y + hit.h, existing.y + existing.h)
      const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
      const area = hit.w * hit.h
      // If >30% of this hit overlaps an existing one, skip it
      if (area > 0 && intersection / area > 0.3) {
        isDupe = true
        break
      }
    }
    if (!isDupe) result.push(hit)
  }
  return result
}

// ── Coconut keyword matching ───────────────────────────────────

const SINGLE_WORD_RE = /^(coconut|copra)$/i

/** Minimal word shape needed by tagCoconutWords (subset of Tesseract.Word). */
export interface WordBox {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

/**
 * Pure function: tag words with isCoconut and merge "cocos nucifera" pairs.
 * Operates on any array of WordBox objects — no Tesseract dependency.
 */
export function tagCoconutWords(words: WordBox[]): OcrHit[] {
  if (words.length === 0) return []

  const hits: OcrHit[] = []
  const coconutIndices = new Set<number>()

  // First pass: identify coconut matches and mark indices
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text.replace(/[^a-zA-Z]/g, '')

    if (SINGLE_WORD_RE.test(text)) {
      coconutIndices.add(i)
    } else if (/^cocos$/i.test(text) && i + 1 < words.length) {
      const nextText = words[i + 1].text.replace(/[^a-zA-Z]/g, '')
      if (/^nucifera$/i.test(nextText)) {
        coconutIndices.add(i)
        coconutIndices.add(i + 1)
      }
    }
  }

  // Second pass: emit all words, merging "cocos nucifera" pairs
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const bb = w.bbox
    const isCoconut = coconutIndices.has(i)

    // Merge "cocos nucifera" into one hit
    if (isCoconut && /^cocos$/i.test(w.text.replace(/[^a-zA-Z]/g, '')) && coconutIndices.has(i + 1)) {
      const next = words[i + 1]
      const bb2 = next.bbox
      const x = Math.min(bb.x0, bb2.x0)
      const y = Math.min(bb.y0, bb2.y0)
      hits.push({
        text: `${w.text} ${next.text}`,
        x,
        y,
        w: Math.max(bb.x1, bb2.x1) - x,
        h: Math.max(bb.y1, bb2.y1) - y,
        isCoconut: true,
      })
      i++ // skip next word
      continue
    }

    // Skip the "nucifera" half if already merged
    if (isCoconut && /^nucifera$/i.test(w.text.replace(/[^a-zA-Z]/g, ''))) continue

    hits.push({
      text: w.text,
      x: bb.x0,
      y: bb.y0,
      w: bb.x1 - bb.x0,
      h: bb.y1 - bb.y0,
      isCoconut,
    })
  }

  return hits
}

/** Flatten Tesseract result hierarchy into a flat word array. */
export function flattenWords(blocks: Tesseract.Block[] | null | undefined): Tesseract.Word[] {
  const words: Tesseract.Word[] = []
  if (!blocks) return words
  for (const block of blocks) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        words.push(...line.words)
      }
    }
  }
  return words
}

// ── Recognition ───────────────────────────────────────────────

/**
 * Run tiled parallel OCR on a video frame at native resolution.
 * Splits the frame into overlapping tiles, OCRs each on a separate worker,
 * then coalesces and deduplicates the results.
 * Returns null if workers not ready.
 */
export async function recognizeWords(
  video: HTMLVideoElement,
): Promise<OcrHit[] | null> {
  if (workers.length === 0 || readyState !== 'ready') return null

  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return null

  // Capture full-resolution frame
  const frame = new OffscreenCanvas(w, h)
  frame.getContext('2d')!.drawImage(video, 0, 0, w, h)

  // Split into preprocessed tiles
  const tiles = createTiles(frame, w, h)

  // Work-stealing: each worker grabs the next available tile
  let nextIdx = 0
  const tileResults: OcrHit[][] = new Array(tiles.length)
  let crashCount = 0

  async function work(worker: Tesseract.Worker) {
    while (true) {
      const idx = nextIdx++
      if (idx >= tiles.length) return
      try {
        const result = await worker.recognize(tiles[idx].canvas, {}, { blocks: true })
        const words = flattenWords(result.data.blocks)
        const hits = tagCoconutWords(words)
        // Map tile-local coordinates to frame-global
        const tile = tiles[idx]
        tileResults[idx] = hits.map(hit => ({
          ...hit,
          x: hit.x + tile.offsetX,
          y: hit.y + tile.offsetY,
        }))
      } catch {
        tileResults[idx] = []
        crashCount++
      }
    }
  }

  await Promise.all(workers.map(w => work(w)))

  // If all workers crashed, tear down and recreate
  if (crashCount >= tiles.length) {
    terminateOcr()
    return null
  }

  const allHits = tileResults.flat()
  if (allHits.length === 0) return null

  const deduplicated = deduplicateHits(allHits)
  return deduplicated.length > 0 ? deduplicated : null
}

/**
 * Run OCR on any Tesseract-compatible source (file path, Buffer, Blob, etc.).
 * Bypasses video/canvas preprocessing — useful for testing & debugging.
 * Requires the worker pool to be initialized via initOcr().
 */
export async function recognizeImageSource(
  source: Tesseract.ImageLike,
): Promise<{ words: Tesseract.Word[]; hits: OcrHit[] } | null> {
  if (workers.length === 0 || readyState !== 'ready') return null

  let result: Tesseract.RecognizeResult
  try {
    result = await workers[0].recognize(source, {}, { blocks: true })
  } catch {
    terminateOcr()
    return null
  }

  const words = flattenWords(result.data.blocks)
  const hits = tagCoconutWords(words)
  return { words, hits }
}
