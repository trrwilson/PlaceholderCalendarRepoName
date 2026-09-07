import { describe, expect, it } from 'vitest'

import {
  AudioRingBuffer,
  downsampleTo16k,
  floatToPcm16Base64,
  resampleFrom16k,
  WAKE_SAMPLE_RATE,
} from './ringBuffer'

describe('AudioRingBuffer', () => {
  it('retains only the most recent audio once full', () => {
    const buf = new AudioRingBuffer(1) // 16000 samples
    buf.write(new Float32Array(WAKE_SAMPLE_RATE).fill(0.125))
    buf.write(new Float32Array(WAKE_SAMPLE_RATE).fill(0.5))
    expect(buf.length).toBe(WAKE_SAMPLE_RATE)
    const last = buf.readLast(1)
    expect(last).toHaveLength(WAKE_SAMPLE_RATE)
    expect(last.every((s) => s === 0.5)).toBe(true)
  })

  it('returns everything when asked for more than it holds', () => {
    const buf = new AudioRingBuffer(3)
    buf.write(new Float32Array(800).fill(0.5))
    expect(buf.readLast(3)).toHaveLength(800)
  })

  it('clears', () => {
    const buf = new AudioRingBuffer(1)
    buf.write(new Float32Array(100).fill(1))
    buf.clear()
    expect(buf.length).toBe(0)
    expect(buf.readLast(1)).toHaveLength(0)
  })
})

describe('downsampleTo16k', () => {
  it('halves 32 kHz audio and averages pairs (anti-alias)', () => {
    const input = Float32Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 0 : 1))
    const out = downsampleTo16k(input, 32_000)
    expect(out).toHaveLength(4)
    expect(out.every((s) => Math.abs(s - 0.5) < 1e-6)).toBe(true)
  })

  it('passes 16 kHz audio through untouched', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(downsampleTo16k(input, WAKE_SAMPLE_RATE)).toBe(input)
  })
})

describe('resampleFrom16k', () => {
  it('stretches 16 kHz pre-roll to 24 kHz (3:2) so it is not played 1.5x fast', () => {
    const input = new Float32Array([0, 1, 0, 1, 0, 1])
    const out = resampleFrom16k(input, 24_000)
    expect(out).toHaveLength(9)
    // Endpoints preserved, interpolated points in between.
    expect(out[0]).toBe(0)
    expect(out[out.length - 1]).toBeCloseTo(1)
  })

  it('is a no-op at 16 kHz or for empty input', () => {
    const input = new Float32Array([0.1, 0.2])
    expect(resampleFrom16k(input, WAKE_SAMPLE_RATE)).toBe(input)
    expect(resampleFrom16k(new Float32Array(0), 24_000)).toHaveLength(0)
  })
})

describe('floatToPcm16Base64', () => {
  it('round-trips a known sample to little-endian PCM16', () => {
    const b64 = floatToPcm16Base64(new Float32Array([0, 1, -1]))
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    expect(view.getInt16(0, true)).toBe(0)
    expect(view.getInt16(2, true)).toBe(32767)
    expect(view.getInt16(4, true)).toBe(-32768)
  })
})
