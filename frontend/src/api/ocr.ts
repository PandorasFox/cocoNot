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

export interface OcrResult {
  hits: OcrHit[]
  totalMs: number
  captureMs: number    // canvas drawImage from video
  recognizeMs: number  // worker.recognize()
  postMs: number       // flattenWords + tagCoconutWords + remap
}

export interface ScanRegion {
  x: number
  y: number
  w: number
  h: number
}

export type OcrMode = 'standard'

// ── Constants ─────────────────────────────────────────────────

export const POOL_SIZE = 2

const CHAR_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,():.-/%'

// ── Worker pool state ─────────────────────────────────────────

let workers: Tesseract.Worker[] = []
let workerBusy: boolean[] = []
let readyState: OcrReadyState = 'loading'
let currentMode: OcrMode | null = null
let generation = 0
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

export function getOcrMode(): OcrMode | null {
  return currentMode
}

// ── Worker lifecycle ───────────────────────────────────────────

let initPromise: Promise<void> | null = null

/** Initialize the Tesseract worker pool in the given mode. Safe to call multiple times. */
export function initOcr(mode: OcrMode = 'standard'): void {
  if (initPromise && mode === currentMode) return
  if (initPromise) terminateOcr()

  currentMode = mode
  const thisGen = ++generation
  initPromise = (async () => {
    try {
      setReadyState('loading')
      const pool = await Promise.all(
        Array.from({ length: POOL_SIZE }, () =>
          Tesseract.createWorker('eng'),
        ),
      )
      if (thisGen !== generation) {
        for (const w of pool) w.terminate().catch(() => {})
        return
      }
      workers = pool
      await Promise.all(
        workers.map(w => w.setParameters({ tessedit_char_whitelist: CHAR_WHITELIST })),
      )
      if (thisGen !== generation) return
      workerBusy = new Array(workers.length).fill(false)
      setReadyState('ready')
    } catch {
      if (thisGen !== generation) return
      setReadyState('error')
      for (const w of workers) w.terminate().catch(() => {})
      workers = []
      initPromise = null
      currentMode = null
    }
  })()
}

/** Tear down all workers. Next initOcr() recreates the pool. */
export function terminateOcr(): void {
  for (const w of workers) w.terminate().catch(() => {})
  workers = []
  workerBusy = []
  initPromise = null
  currentMode = null
  setReadyState('loading')
}

/** Number of workers currently processing a frame. */
export function getInFlightCount(): number {
  return workerBusy.filter(Boolean).length
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
 * Run OCR on a video frame, optionally cropped to a scan region.
 * Claims an idle worker from the pool. Returns null immediately if
 * all workers are busy (frame drop) or pool not ready.
 */
export async function recognizeWords(
  video: HTMLVideoElement,
  region?: ScanRegion,
): Promise<OcrResult | null> {
  if (readyState !== 'ready') return null

  // Claim an idle worker — drop frame if all busy
  const wi = workerBusy.indexOf(false)
  if (wi === -1) return null
  workerBusy[wi] = true

  try {
    const t0 = performance.now()

    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return null

    const rx = region?.x ?? 0
    const ry = region?.y ?? 0
    const rw = region?.w ?? vw
    const rh = region?.h ?? vh

    const frame = new OffscreenCanvas(rw, rh)
    frame.getContext('2d')!.drawImage(video, rx, ry, rw, rh, 0, 0, rw, rh)

    const tCapture = performance.now()

    const result = await workers[wi].recognize(frame, {}, { blocks: true })

    const tRecognize = performance.now()

    const words = flattenWords(result.data.blocks)
    let hits = tagCoconutWords(words)
    if (region) {
      hits = hits.map(hit => ({
        ...hit,
        x: hit.x + rx,
        y: hit.y + ry,
      }))
    }

    const tPost = performance.now()

    return {
      hits,
      captureMs: Math.round(tCapture - t0),
      recognizeMs: Math.round(tRecognize - tCapture),
      postMs: Math.round(tPost - tRecognize),
      totalMs: Math.round(tPost - t0),
    }
  } finally {
    workerBusy[wi] = false
  }
}

/**
 * Process pre-captured frames through the worker pool (work-stealing).
 * Calls onResult for each completed frame. Returns when all frames are done.
 */
export async function recognizeBurst(
  frames: OffscreenCanvas[],
  regionOffset: { x: number; y: number },
  onResult: (result: OcrResult, frameIndex: number) => void,
): Promise<void> {
  if (readyState !== 'ready' || workers.length === 0) return

  let nextFrame = 0

  async function processNext(wi: number): Promise<void> {
    while (nextFrame < frames.length) {
      const fi = nextFrame++
      workerBusy[wi] = true
      try {
        const t0 = performance.now()
        const result = await workers[wi].recognize(frames[fi], {}, { blocks: true })
        const tRecognize = performance.now()
        const words = flattenWords(result.data.blocks)
        let hits = tagCoconutWords(words)
        if (regionOffset.x || regionOffset.y) {
          hits = hits.map(hit => ({
            ...hit,
            x: hit.x + regionOffset.x,
            y: hit.y + regionOffset.y,
          }))
        }
        const tPost = performance.now()
        onResult({
          hits,
          captureMs: 0,
          recognizeMs: Math.round(tRecognize - t0),
          postMs: Math.round(tPost - tRecognize),
          totalMs: Math.round(tPost - t0),
        }, fi)
      } finally {
        workerBusy[wi] = false
      }
    }
  }

  await Promise.all(workers.map((_, wi) => processNext(wi)))
}

/**
 * Run OCR on any Tesseract-compatible source (file path, Buffer, Blob, etc.).
 * Bypasses video/canvas preprocessing — useful for testing & debugging.
 * Requires the worker pool to be initialized via initOcr().
 */
export async function recognizeImageSource(
  source: Tesseract.ImageLike,
): Promise<{ words: Tesseract.Word[]; hits: OcrHit[] } | null> {
  if (readyState !== 'ready') return null

  const wi = workerBusy.indexOf(false)
  if (wi === -1) return null
  workerBusy[wi] = true

  try {
    const result = await workers[wi].recognize(source, {}, { blocks: true })
    const words = flattenWords(result.data.blocks)
    const hits = tagCoconutWords(words)
    return { words, hits }
  } finally {
    workerBusy[wi] = false
  }
}
