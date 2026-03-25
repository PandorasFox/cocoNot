import Tesseract from 'tesseract.js'

// ── Types ──────────────────────────────────────────────────────

export interface OcrHit {
  text: string
  x: number
  y: number
  w: number
  h: number
}

export type OcrReadyState = 'loading' | 'ready' | 'error'

// ── Singleton state ────────────────────────────────────────────

let worker: Tesseract.Worker | null = null
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

/** Eagerly initialize the Tesseract worker. Safe to call multiple times. */
export function initOcr(): void {
  if (initPromise) return
  initPromise = (async () => {
    try {
      setReadyState('loading')
      worker = await Tesseract.createWorker('eng')
      setReadyState('ready')
    } catch {
      setReadyState('error')
      worker = null
      initPromise = null
    }
  })()
}

/** Tear down the worker (crash recovery). Next initOcr() recreates it. */
export function terminateOcr(): void {
  if (worker) {
    worker.terminate().catch(() => {})
    worker = null
  }
  initPromise = null
  setReadyState('loading')
}

// ── Preprocessing ──────────────────────────────────────────────

/**
 * Otsu's threshold: find the optimal threshold to split a grayscale
 * histogram into foreground / background with minimal intra-class variance.
 */
function otsuThreshold(data: Uint8ClampedArray, pixelCount: number): number {
  // Build grayscale histogram (pixel data is already R=G=B after grayscale pass)
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

/** Capture video frame, convert to binary B/W via grayscale + Otsu. */
function preprocessFrame(
  video: HTMLVideoElement,
): { canvas: OffscreenCanvas; width: number; height: number } | null {
  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return null

  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0, w, h)

  const imageData = ctx.getImageData(0, 0, w, h)
  const { data } = imageData
  const pixelCount = w * h

  // Grayscale in-place
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4
    const gray = 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2]
    data[off] = data[off + 1] = data[off + 2] = gray
  }

  // Otsu threshold → binary
  const thresh = otsuThreshold(data, pixelCount)
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 4
    const v = data[off] > thresh ? 255 : 0
    data[off] = data[off + 1] = data[off + 2] = v
  }

  ctx.putImageData(imageData, 0, 0)
  return { canvas, width: w, height: h }
}

// ── Coconut keyword matching ───────────────────────────────────

const SINGLE_WORD_RE = /^(coconut|copra)$/i

/**
 * Run OCR on a video frame and return bounding boxes for coconut-related words.
 * Returns null if worker not ready.
 */
export async function recognizeCoconutHits(
  video: HTMLVideoElement,
): Promise<OcrHit[] | null> {
  if (!worker || readyState !== 'ready') return null

  const frame = preprocessFrame(video)
  if (!frame) return null

  let result: Tesseract.RecognizeResult
  try {
    result = await worker.recognize(frame.canvas)
  } catch {
    // Worker crashed (tab backgrounded, memory pressure, etc.)
    terminateOcr()
    return null
  }

  // Flatten blocks → paragraphs → lines → words
  const words: Tesseract.Word[] = []
  if (result.data.blocks) {
    for (const block of result.data.blocks) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          words.push(...line.words)
        }
      }
    }
  }
  if (words.length === 0) return null

  const hits: OcrHit[] = []

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const text = w.text.replace(/[^a-zA-Z]/g, '') // strip punctuation

    // Single-word match
    if (SINGLE_WORD_RE.test(text)) {
      const bb = w.bbox
      hits.push({
        text: w.text,
        x: bb.x0,
        y: bb.y0,
        w: bb.x1 - bb.x0,
        h: bb.y1 - bb.y0,
      })
      continue
    }

    // Two-word match: "cocos nucifera"
    if (/^cocos$/i.test(text) && i + 1 < words.length) {
      const next = words[i + 1]
      const nextText = next.text.replace(/[^a-zA-Z]/g, '')
      if (/^nucifera$/i.test(nextText)) {
        const bb1 = w.bbox
        const bb2 = next.bbox
        const x = Math.min(bb1.x0, bb2.x0)
        const y = Math.min(bb1.y0, bb2.y0)
        hits.push({
          text: `${w.text} ${next.text}`,
          x,
          y,
          w: Math.max(bb1.x1, bb2.x1) - x,
          h: Math.max(bb1.y1, bb2.y1) - y,
        })
        i++ // skip next word
        continue
      }
    }
  }

  return hits
}
