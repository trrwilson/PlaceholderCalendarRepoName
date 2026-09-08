import { describe, expect, it } from 'vitest'

import {
  atReferenceGain,
  dbToLinear,
  DEFAULT_INPUT_GAIN_DB,
  InputGain,
  LEVEL_REFERENCE_GAIN_DB,
} from './gain'

describe('dbToLinear', () => {
  it('maps 0 dB to unity', () => {
    expect(dbToLinear(0)).toBe(1)
  })

  it('maps +6 dB to ~2x and +12 dB to ~4x amplitude', () => {
    expect(dbToLinear(6)).toBeCloseTo(1.995, 3)
    expect(dbToLinear(12)).toBeCloseTo(3.981, 3)
  })

  it('maps -6 dB to ~0.5x', () => {
    expect(dbToLinear(-6)).toBeCloseTo(0.501, 3)
  })
})

describe('InputGain', () => {
  it('defaults to the shared default gain', () => {
    const gain = new InputGain()
    expect(gain.db).toBe(DEFAULT_INPUT_GAIN_DB)
    expect(gain.linear).toBeCloseTo(dbToLinear(DEFAULT_INPUT_GAIN_DB), 6)
    // The shipped default is 0 dB (stage disabled); an install can still opt in.
    expect(gain.active).toBe(DEFAULT_INPUT_GAIN_DB !== 0)
  })

  it('amplifies samples by the linear multiplier', () => {
    const gain = new InputGain(6)
    const frame = Float32Array.from([0.1, -0.2, 0.05])
    const out = gain.apply(frame)
    expect(out).toBe(frame) // mutated in place
    expect(out[0]).toBeCloseTo(0.1 * dbToLinear(6), 5)
    expect(out[1]).toBeCloseTo(-0.2 * dbToLinear(6), 5)
  })

  it('saturates hot samples at ±1 instead of overflowing, and counts clips', () => {
    const gain = new InputGain(20) // 10x
    const frame = Float32Array.from([0.5, -0.5, 0.05, -0.2])
    gain.apply(frame)
    expect(frame[0]).toBe(1)
    expect(frame[1]).toBe(-1)
    expect(frame[2]).toBeCloseTo(0.5, 5)
    expect(frame[3]).toBe(-1)
    const stats = gain.readStats()
    expect(stats.clipped).toBe(3)
    expect(stats.peak).toBeGreaterThan(1) // pre-saturation magnitude is reported
    expect(stats.rms).toBeGreaterThan(0)
    expect(stats.rms).toBeLessThanOrEqual(1)
  })

  it('leaves samples untouched at 0 dB but still measures peak / RMS', () => {
    const gain = new InputGain(0)
    expect(gain.active).toBe(false)
    const frame = Float32Array.from([0.3, -0.4, 0.5])
    const original = Float32Array.from(frame)
    gain.apply(frame)
    expect(Array.from(frame)).toEqual(Array.from(original))
    const stats = gain.readStats()
    expect(stats.db).toBe(0)
    expect(stats.linear).toBe(1)
    expect(stats.clipped).toBe(0)
    expect(stats.peak).toBeCloseTo(0.5, 5)
    expect(stats.rms).toBeCloseTo(Math.sqrt((0.09 + 0.16 + 0.25) / 3), 5)
  })

  it('still flags clipping at 0 dB when the mic itself delivers a hot sample', () => {
    const gain = new InputGain(0)
    const frame = Float32Array.from([1.2, 0.1])
    gain.apply(frame)
    expect(frame[0]).toBeCloseTo(1.2, 5) // not our doing — left for the PCM packer to clamp
    expect(gain.readStats().clipped).toBe(1)
  })

  it('ignores non-finite dB values', () => {
    const gain = new InputGain(9)
    gain.setDb(Number.NaN)
    gain.setDb(Number.POSITIVE_INFINITY)
    expect(gain.db).toBe(9)
  })

  it('resets accumulators after readStats', () => {
    const gain = new InputGain(6)
    gain.apply(Float32Array.from([0.5, 0.5]))
    gain.readStats()
    const second = gain.readStats()
    expect(second.frames).toBe(0)
    expect(second.samples).toBe(0)
    expect(second.peak).toBe(0)
    expect(second.rms).toBe(0)
    expect(second.clipped).toBe(0)
  })

  it('tracks frame and sample counts across calls', () => {
    const gain = new InputGain(3)
    gain.apply(new Float32Array(4))
    gain.apply(new Float32Array(6))
    const stats = gain.readStats()
    expect(stats.frames).toBe(2)
    expect(stats.samples).toBe(10)
  })
})

describe('atReferenceGain', () => {
  it('is a no-op at the reference gain', () => {
    const linear = dbToLinear(LEVEL_REFERENCE_GAIN_DB)
    expect(atReferenceGain(0.05, linear)).toBeCloseTo(0.05, 6)
  })

  it('restates a level captured at a different gain, so thresholds do not move', () => {
    // The same acoustic input, captured 6 dB hotter, must compare identically.
    const quiet = dbToLinear(LEVEL_REFERENCE_GAIN_DB)
    const loud = dbToLinear(LEVEL_REFERENCE_GAIN_DB + 6)
    const acoustic = 0.004
    expect(atReferenceGain(acoustic * quiet, quiet)).toBeCloseTo(
      atReferenceGain(acoustic * loud, loud),
      6,
    )
  })

  it('halves a level captured at +6 dB over the reference', () => {
    const linear = dbToLinear(LEVEL_REFERENCE_GAIN_DB + 6)
    expect(atReferenceGain(0.1, linear)).toBeCloseTo(0.1 / dbToLinear(6), 5)
  })

  it('passes the level through when there is no gain stage yet', () => {
    expect(atReferenceGain(0.02, 0)).toBe(0.02)
    expect(atReferenceGain(0.02, Number.NaN)).toBe(0.02)
  })
})
