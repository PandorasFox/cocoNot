import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCanvas } from 'canvas'
import {
  drawUnifiedHitboxes,
  videoCoverTransform,
  relativeLuminance,
  HITBOX_COLORS,
  STATUS_LABELS,
  type HitboxEntry,
} from '../hitbox'

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

  it('draws multiple hitboxes', () => {
    const map = new Map<string, HitboxEntry>()
    map.set('sku1', makeEntry({ status: 'clean', name: 'Ice Cream A' }))
    map.set('sku2', makeEntry({ status: 'coconut', name: 'Bad Ice Cream' }))

    const strokeSpy = vi.spyOn(ctx, 'stroke')
    const fillTextSpy = vi.spyOn(ctx, 'fillText')

    drawUnifiedHitboxes(ctx, 400, 800, map)

    // 2 rounded rects + 2 chip backgrounds
    expect(strokeSpy).toHaveBeenCalledTimes(2)
    // 2 chip labels
    expect(fillTextSpy).toHaveBeenCalledTimes(2)
  })
})
