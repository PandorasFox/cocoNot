import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Tesseract from 'tesseract.js'
import { createCanvas } from 'canvas'
import fs from 'node:fs'
import path from 'node:path'
import { otsuThreshold, tagCoconutWords, type WordBox, flattenWords, deduplicateHits, type OcrHit } from '../ocr'

// ── Helpers ────────────────────────────────────────────────────

const TEST_IMAGES_DIR = path.resolve(__dirname, '../../../test-data/ocr-images')

/** List all image files in the test-data directory. */
function listTestImages(): string[] {
  if (!fs.existsSync(TEST_IMAGES_DIR)) return []
  return fs
    .readdirSync(TEST_IMAGES_DIR)
    .filter((f) => /\.(png|jpe?g|webp|bmp)$/i.test(f))
    .map((f) => path.join(TEST_IMAGES_DIR, f))
}

/** Create a synthetic PNG with known text rendered on it. */
function createTextImage(
  text: string,
  width = 800,
  height = 100,
): Buffer {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  // Black text, large and clear
  ctx.fillStyle = '#000000'
  ctx.font = 'bold 40px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 20, height / 2)

  return canvas.toBuffer('image/png')
}

function makeWord(text: string, x0 = 0, y0 = 0, x1 = 100, y1 = 20): WordBox {
  return { text, bbox: { x0, y0, x1, y1 } }
}

// ── Unit tests: otsuThreshold ──────────────────────────────────

describe('otsuThreshold', () => {
  it('returns 0 for a uniform black image', () => {
    const size = 100
    const data = new Uint8ClampedArray(size * 4)
    // All pixels black (R=G=B=0, A=255)
    for (let i = 0; i < size; i++) {
      data[i * 4 + 3] = 255
    }
    const t = otsuThreshold(data, size)
    expect(t).toBe(0)
  })

  it('finds threshold between two distinct intensity peaks', () => {
    const size = 200
    const data = new Uint8ClampedArray(size * 4)
    // Half pixels at 50, half at 200
    for (let i = 0; i < size; i++) {
      const v = i < size / 2 ? 50 : 200
      data[i * 4] = v
      data[i * 4 + 1] = v
      data[i * 4 + 2] = v
      data[i * 4 + 3] = 255
    }
    const t = otsuThreshold(data, size)
    // Should be somewhere between 50 and 200 (inclusive)
    expect(t).toBeGreaterThanOrEqual(50)
    expect(t).toBeLessThanOrEqual(200)
  })
})

// ── Unit tests: tagCoconutWords ────────────────────────────────

describe('tagCoconutWords', () => {
  it('returns empty array for empty input', () => {
    expect(tagCoconutWords([])).toEqual([])
  })

  it('tags "coconut" as isCoconut', () => {
    const words = [makeWord('water'), makeWord('coconut'), makeWord('sugar')]
    const hits = tagCoconutWords(words)
    expect(hits).toHaveLength(3)
    expect(hits[0].isCoconut).toBe(false)
    expect(hits[1].isCoconut).toBe(true)
    expect(hits[2].isCoconut).toBe(false)
  })

  it('tags "copra" as isCoconut (case-insensitive)', () => {
    const hits = tagCoconutWords([makeWord('COPRA')])
    expect(hits[0].isCoconut).toBe(true)
  })

  it('strips punctuation before matching', () => {
    const hits = tagCoconutWords([makeWord('coconut,')])
    expect(hits[0].isCoconut).toBe(true)
  })

  it('merges "cocos nucifera" into a single hit', () => {
    const words = [
      makeWord('cocos', 0, 0, 50, 20),
      makeWord('nucifera', 55, 0, 130, 20),
    ]
    const hits = tagCoconutWords(words)
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toBe('cocos nucifera')
    expect(hits[0].isCoconut).toBe(true)
    expect(hits[0].x).toBe(0)
    expect(hits[0].w).toBe(130) // max(x1) - min(x0)
  })

  it('does not merge "cocos" followed by unrelated word', () => {
    const words = [makeWord('cocos'), makeWord('water')]
    const hits = tagCoconutWords(words)
    expect(hits).toHaveLength(2)
    expect(hits[0].isCoconut).toBe(false)
    expect(hits[1].isCoconut).toBe(false)
  })

  it('handles mixed coconut keywords in a longer list', () => {
    const words = [
      makeWord('ingredients:'),
      makeWord('water,'),
      makeWord('Coconut'),
      makeWord('oil,'),
      makeWord('cocos'),
      makeWord('nucifera,'),
      makeWord('salt'),
    ]
    const hits = tagCoconutWords(words)
    const coconutHits = hits.filter((h) => h.isCoconut)
    expect(coconutHits).toHaveLength(2)
    expect(coconutHits[0].text).toBe('Coconut')
    expect(coconutHits[1].text).toBe('cocos nucifera,')
  })
})

// ── Unit tests: flattenWords ───────────────────────────────────

describe('flattenWords', () => {
  it('returns empty for undefined blocks', () => {
    expect(flattenWords(undefined)).toEqual([])
  })
})

// ── Unit tests: deduplicateHits ──────────────────────────────

function makeHit(text: string, x: number, y: number, w: number, h: number, isCoconut: boolean): OcrHit {
  return { text, x, y, w, h, isCoconut }
}

describe('deduplicateHits', () => {
  it('returns empty array for empty input', () => {
    expect(deduplicateHits([])).toEqual([])
  })

  it('keeps non-overlapping coconut hits', () => {
    const hits = [
      makeHit('coconut', 0, 0, 100, 20, true),
      makeHit('coconut', 500, 0, 100, 20, true),
    ]
    expect(deduplicateHits(hits)).toHaveLength(2)
  })

  it('deduplicates overlapping coconut hits from tile overlap', () => {
    const hits = [
      makeHit('coconut', 100, 50, 120, 25, true),
      makeHit('coconut', 102, 49, 118, 26, true), // nearly identical — from adjacent tile
    ]
    const result = deduplicateHits(hits)
    expect(result).toHaveLength(1)
    expect(result[0].text).toBe('coconut')
  })

  it('does not deduplicate non-coconut hits', () => {
    const hits = [
      makeHit('water', 100, 50, 80, 20, false),
      makeHit('water', 101, 50, 79, 20, false), // overlapping but not coconut
    ]
    expect(deduplicateHits(hits)).toHaveLength(2)
  })

  it('preserves mix of coconut and non-coconut hits', () => {
    const hits = [
      makeHit('water', 0, 0, 80, 20, false),
      makeHit('coconut', 100, 0, 120, 25, true),
      makeHit('coconut', 101, 1, 119, 24, true), // dupe
      makeHit('sugar', 300, 0, 80, 20, false),
    ]
    const result = deduplicateHits(hits)
    expect(result).toHaveLength(3)
    expect(result.filter(h => h.isCoconut)).toHaveLength(1)
  })
})

// ── Integration: Tesseract on synthetic image ──────────────────

describe('Tesseract.js direct recognition', () => {
  let worker: Tesseract.Worker

  beforeAll(async () => {
    worker = await Tesseract.createWorker('eng')
  }, 60_000) // worker init downloads ~15MB trained data on first run

  afterAll(async () => {
    await worker.terminate()
  })

  it('recognizes clear black text on white background', async () => {
    const png = createTextImage('INGREDIENTS WATER SUGAR SALT')
    const result = await worker.recognize(png, {}, { blocks: true })
    const text = result.data.text.toLowerCase()
    expect(text).toContain('ingredient')
    expect(text).toContain('water')
    expect(text).toContain('sugar')
    expect(text).toContain('salt')
  })

  it('detects "coconut" in synthetic image and tags it', async () => {
    const png = createTextImage('WATER COCONUT OIL SUGAR')
    const result = await worker.recognize(png, {}, { blocks: true })
    const words = flattenWords(result.data.blocks)
    expect(words.length).toBeGreaterThan(0)

    const hits = tagCoconutWords(words)
    const coconutHit = hits.find((h) => h.isCoconut)
    expect(coconutHit).toBeDefined()
    expect(coconutHit!.text.toLowerCase()).toContain('coconut')
  })
})

// ── Integration: real test images from test-data ───────────────

describe('Tesseract.js on real photos', () => {
  const images = listTestImages()

  // Skip this suite entirely if no test images are present
  if (images.length === 0) {
    it.skip('no test images in test-data/ocr-images/ — drop some photos there', () => {})
    return
  }

  let worker: Tesseract.Worker

  beforeAll(async () => {
    worker = await Tesseract.createWorker('eng')
  }, 60_000)

  afterAll(async () => {
    await worker.terminate()
  })

  for (const imagePath of images) {
    const name = path.basename(imagePath)

    it(`detects at least 1 word in ${name}`, async () => {
      const buf = fs.readFileSync(imagePath)
      const result = await worker.recognize(buf, {}, { blocks: true })
      const words = flattenWords(result.data.blocks)

      console.log(`[${name}] detected ${words.length} words:`)
      for (const w of words.slice(0, 20)) {
        console.log(`  "${w.text}" (confidence: ${w.confidence.toFixed(1)}%)`)
      }
      if (words.length > 20) console.log(`  ... and ${words.length - 20} more`)

      expect(words.length).toBeGreaterThan(0)
    })

    it(`produces OcrHit results for ${name}`, async () => {
      const buf = fs.readFileSync(imagePath)
      const result = await worker.recognize(buf, {}, { blocks: true })
      const words = flattenWords(result.data.blocks)
      const hits = tagCoconutWords(words)

      const coconutHits = hits.filter((h) => h.isCoconut)
      console.log(
        `[${name}] ${hits.length} hits total, ${coconutHits.length} coconut matches`,
      )
      for (const h of coconutHits) {
        console.log(`  COCONUT: "${h.text}" @ (${h.x},${h.y})`)
      }

      // Just verify we get valid OcrHit objects
      for (const h of hits) {
        expect(h.text).toBeTruthy()
        expect(typeof h.x).toBe('number')
        expect(typeof h.y).toBe('number')
        expect(typeof h.w).toBe('number')
        expect(typeof h.h).toBe('number')
        expect(typeof h.isCoconut).toBe('boolean')
      }
    })
  }
})
