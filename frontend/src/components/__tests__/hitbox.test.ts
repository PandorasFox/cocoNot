import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { createCanvas, loadImage } from 'canvas'
import fs from 'node:fs'
import path from 'node:path'
import Tesseract from 'tesseract.js'
import {
  drawUnifiedHitboxes,
  videoCoverTransform,
  relativeLuminance,
  HITBOX_COLORS,
  HITBOX_PADDING,
  STATUS_LABELS,
  type HitboxEntry,
} from '../hitbox'
import { flattenWords, tagCoconutWords } from '../../api/ocr'

// ── Helpers ────────────────────────────────────────────────────

function makeEntry(overrides: Partial<HitboxEntry> & Pick<HitboxEntry, 'status'>): HitboxEntry {
  return {
    x: 100, y: 100, w: 200, h: 50,
    lastSeenAt: Date.now(),
    ...overrides,
  }
}

function makeCtx(width = 400, height = 800) {
  const canvas = createCanvas(width, height)
  return canvas.getContext('2d') as unknown as CanvasRenderingContext2D
}

// ── videoCoverTransform ────────────────────────────────────────

describe('videoCoverTransform', () => {
  it('returns null when any dimension is zero', () => {
    expect(videoCoverTransform(0, 480, 400, 800)).toBeNull()
    expect(videoCoverTransform(640, 0, 400, 800)).toBeNull()
    expect(videoCoverTransform(640, 480, 0, 800)).toBeNull()
    expect(videoCoverTransform(640, 480, 400, 0)).toBeNull()
  })

  it('computes correct transform when video is wider than display', () => {
    // 1920x1080 video in 400x800 display (video wider → letterboxed top/bottom)
    const t = videoCoverTransform(1920, 1080, 400, 800)
    expect(t).not.toBeNull()
    // object-cover scales to fill, so scale = displayH / videoH
    expect(t!.scale).toBeCloseTo(800 / 1080)
    expect(t!.offsetY).toBe(0)
    // offsetX is negative (cropped on sides)
    expect(t!.offsetX).toBeLessThan(0)
  })

  it('computes correct transform when video is taller than display', () => {
    // 480x640 video in 400x300 display — videoAspect(0.75) > displayAspect(1.33) is false
    // so scale = dw/vw = 400/480
    const t = videoCoverTransform(480, 640, 400, 300)
    expect(t).not.toBeNull()
    expect(t!.scale).toBeCloseTo(400 / 480)
    expect(t!.offsetX).toBe(0)
    // video height scaled = 640 * (400/480) = 533, display = 300, offset = (300-533)/2 < 0
    expect(t!.offsetY).toBeLessThan(0)
  })

  it('returns zero offsets when aspect ratios match', () => {
    const t = videoCoverTransform(800, 600, 400, 300)
    expect(t).not.toBeNull()
    expect(t!.scale).toBeCloseTo(0.5)
    expect(t!.offsetX).toBeCloseTo(0)
    expect(t!.offsetY).toBeCloseTo(0)
  })
})

// ── relativeLuminance ──────────────────────────────────────────

describe('relativeLuminance', () => {
  it('returns ~0 for black', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0)
  })

  it('returns ~1 for white', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 1)
  })

  it('returns intermediate value for red', () => {
    const lum = relativeLuminance('#ef4444')
    expect(lum).toBeGreaterThan(0)
    expect(lum).toBeLessThan(1)
  })
})

// ── drawUnifiedHitboxes ────────────────────────────────────────

describe('drawUnifiedHitboxes', () => {
  let ctx: CanvasRenderingContext2D

  beforeEach(() => {
    ctx = makeCtx()
  })

  it('clears the canvas even with empty hitbox map', () => {
    const spy = vi.spyOn(ctx, 'clearRect')
    drawUnifiedHitboxes(ctx, 400, 800, new Map())
    expect(spy).toHaveBeenCalledWith(0, 0, 400, 800)
  })

  it('does not draw anything for empty hitbox map', () => {
    const strokeSpy = vi.spyOn(ctx, 'stroke')
    const fillSpy = vi.spyOn(ctx, 'fill')
    drawUnifiedHitboxes(ctx, 400, 800, new Map())
    expect(strokeSpy).not.toHaveBeenCalled()
    expect(fillSpy).not.toHaveBeenCalled()
  })

  it('draws a border and chip for a barcode hitbox', () => {
    const map = new Map<string, HitboxEntry>()
    map.set('0123456789012', makeEntry({ status: 'coconut', name: 'Bad Product' }))

    const strokeSpy = vi.spyOn(ctx, 'stroke')
    const fillSpy = vi.spyOn(ctx, 'fill')
    const fillTextSpy = vi.spyOn(ctx, 'fillText')

    drawUnifiedHitboxes(ctx, 400, 800, map)

    // Should draw rounded rect border
    expect(strokeSpy).toHaveBeenCalledTimes(1)
    // Should draw chip background
    expect(fillSpy).toHaveBeenCalledTimes(1)
    // Should draw chip text with product name
    expect(fillTextSpy).toHaveBeenCalledTimes(1)
    expect(fillTextSpy.mock.calls[0][0]).toBe('Bad Product')
  })

  it('draws a border and chip for an OCR coconut hitbox', () => {
    const map = new Map<string, HitboxEntry>()
    map.set('ocr:0', makeEntry({ status: 'coconut', name: 'coconut' }))

    const fillTextSpy = vi.spyOn(ctx, 'fillText')
    drawUnifiedHitboxes(ctx, 400, 800, map)

    expect(fillTextSpy).toHaveBeenCalledTimes(1)
    expect(fillTextSpy.mock.calls[0][0]).toBe('coconut')
  })

  it('uses red color for OCR entries', () => {
    const map = new Map<string, HitboxEntry>()
    map.set('ocr:0', makeEntry({ status: 'coconut', name: 'coconut' }))

    drawUnifiedHitboxes(ctx, 400, 800, map)

    // strokeStyle should be coconut_ocr color (red)
    expect(ctx.strokeStyle).toBe(HITBOX_COLORS.coconut_ocr)
  })

  it('uses status-based color for barcode entries', () => {
    const map = new Map<string, HitboxEntry>()
    map.set('sku1', makeEntry({ status: 'clean', name: 'Safe Product' }))

    drawUnifiedHitboxes(ctx, 400, 800, map)

    expect(ctx.strokeStyle).toBe(HITBOX_COLORS.clean)
  })

  it('uses STATUS_LABELS fallback when barcode entry has no name', () => {
    const map = new Map<string, HitboxEntry>()
    map.set('sku1', makeEntry({ status: 'not_found' }))

    const fillTextSpy = vi.spyOn(ctx, 'fillText')
    drawUnifiedHitboxes(ctx, 400, 800, map)

    expect(fillTextSpy.mock.calls[0][0]).toBe(STATUS_LABELS.not_found)
  })

  it('falls back to "COCONUT" when OCR entry has no name', () => {
    const map = new Map<string, HitboxEntry>()
    map.set('ocr:0', makeEntry({ status: 'coconut' }))

    const fillTextSpy = vi.spyOn(ctx, 'fillText')
    drawUnifiedHitboxes(ctx, 400, 800, map)

    expect(fillTextSpy.mock.calls[0][0]).toBe('COCONUT')
  })

  it('truncates long barcode product names at 25 chars', () => {
    const longName = 'A'.repeat(30)
    const map = new Map<string, HitboxEntry>()
    map.set('sku1', makeEntry({ status: 'coconut', name: longName }))

    const fillTextSpy = vi.spyOn(ctx, 'fillText')
    drawUnifiedHitboxes(ctx, 400, 800, map)

    const label = fillTextSpy.mock.calls[0][0] as string
    expect(label.length).toBeLessThanOrEqual(25)
    expect(label.endsWith('\u2026')).toBe(true)
  })

  it('truncates long OCR names at 20 chars', () => {
    const longName = 'B'.repeat(25)
    const map = new Map<string, HitboxEntry>()
    map.set('ocr:0', makeEntry({ status: 'coconut', name: longName }))

    const fillTextSpy = vi.spyOn(ctx, 'fillText')
    drawUnifiedHitboxes(ctx, 400, 800, map)

    const label = fillTextSpy.mock.calls[0][0] as string
    expect(label.length).toBeLessThanOrEqual(20)
    expect(label.endsWith('\u2026')).toBe(true)
  })

  it('draws multiple hitboxes from mixed sources', () => {
    const map = new Map<string, HitboxEntry>()
    map.set('sku1', makeEntry({ status: 'clean', name: 'Ice Cream A' }))
    map.set('sku2', makeEntry({ status: 'coconut', name: 'Bad Ice Cream' }))
    map.set('ocr:0', makeEntry({ status: 'coconut', name: 'coconut' }))

    const strokeSpy = vi.spyOn(ctx, 'stroke')
    const fillTextSpy = vi.spyOn(ctx, 'fillText')

    drawUnifiedHitboxes(ctx, 400, 800, map)

    // 3 rounded rects + 3 chip backgrounds
    expect(strokeSpy).toHaveBeenCalledTimes(3)
    // 3 chip labels
    expect(fillTextSpy).toHaveBeenCalledTimes(3)
  })
})

// ── Visual hitbox output (OCR → hitboxes → annotated images) ─────

const imagesDir = path.resolve(__dirname, '../../../test-data/ocr-images')
const outputDir = path.resolve(__dirname, '../../../test-data/ocr-output')

const testImages = fs.existsSync(imagesDir)
  ? fs.readdirSync(imagesDir).filter(f => /\.jpe?g$/i.test(f)).sort()
  : []

describe('visual hitbox output', () => {
  let worker: Tesseract.Worker

  beforeAll(async () => {
    fs.mkdirSync(outputDir, { recursive: true })
    worker = await Tesseract.createWorker('eng')
  }, 60_000)

  afterAll(async () => {
    if (worker) await worker.terminate()
  })

  it.skipIf(testImages.length === 0)('test images exist', () => {
    expect(testImages.length).toBeGreaterThan(0)
  })

  for (const filename of testImages) {
    it(`generates hitbox overlay for ${filename}`, async () => {
      const imgPath = path.join(imagesDir, filename)
      const img = await loadImage(imgPath)
      const { width, height } = img

      // Run OCR on the raw image
      const result = await worker.recognize(imgPath, {}, { blocks: true })
      const words = flattenWords(result.data.blocks)
      const hits = tagCoconutWords(words)
      const coconutHits = hits.filter(h => h.isCoconut)

      // Build hitbox map from coconut matches
      const hitboxMap = new Map<string, HitboxEntry>()
      for (let i = 0; i < coconutHits.length; i++) {
        const hit = coconutHits[i]
        hitboxMap.set(`ocr:${i}`, {
          x: hit.x - HITBOX_PADDING,
          y: hit.y - HITBOX_PADDING,
          w: hit.w + HITBOX_PADDING * 2,
          h: hit.h + HITBOX_PADDING * 2,
          status: 'coconut',
          name: hit.text,
          lastSeenAt: Date.now(),
        })
      }

      // Draw source image on main canvas
      const canvas = createCanvas(width, height)
      const mainCtx = canvas.getContext('2d')
      mainCtx.drawImage(img as unknown as CanvasImageSource, 0, 0)

      // Draw hitboxes on a transparent overlay, then composite
      const overlay = createCanvas(width, height)
      const overlayCtx = overlay.getContext('2d') as unknown as CanvasRenderingContext2D
      drawUnifiedHitboxes(overlayCtx, width, height, hitboxMap)
      mainCtx.drawImage(overlay as unknown as CanvasImageSource, 0, 0)

      // Save annotated output
      const outName = filename.replace(/\.jpe?g$/i, '.png')
      const outPath = path.join(outputDir, outName)
      const buffer = canvas.toBuffer('image/png')
      fs.writeFileSync(outPath, buffer)

      expect(fs.existsSync(outPath)).toBe(true)
      expect(buffer.length).toBeGreaterThan(0)

      // Log summary for visual inspection
      console.log(
        `  ${filename}: ${words.length} words, ${coconutHits.length} coconut hits → ${outName}`,
      )
    }, 30_000)
  }
})
