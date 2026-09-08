// `WakePreroll` — the shared retention buffer used by `AzureKeywordDetector`
// (and mirrored inline in `OpenWakeWordDetector`). `AudioRingBuffer` itself is
// covered by `ringBuffer.test.ts`; this checks the arm/retain/take lifecycle.

import { describe, expect, it } from 'vitest'

import { WakePreroll } from './preroll'
import { WAKE_SAMPLE_RATE } from './ringBuffer'

const tone = (seconds: number) => new Float32Array(Math.round(seconds * WAKE_SAMPLE_RATE)).fill(0.3)
const pcm16Samples = (base64: string) => atob(base64).length / 2

describe('WakePreroll', () => {
  it('retains only while armed, and take() drains + stops retaining', () => {
    const preroll = new WakePreroll()
    preroll.write(tone(1)) // dropped — not armed yet
    expect(preroll.retainingAudio).toBe(false)

    preroll.arm()
    expect(preroll.retainingAudio).toBe(true)
    preroll.write(tone(1))
    preroll.markFired(performance.now())

    const chunks = preroll.take(WAKE_SAMPLE_RATE)
    expect(chunks.length).toBeGreaterThan(0)
    expect(preroll.retainingAudio).toBe(false)
    // Second take is empty — the buffer was drained.
    expect(preroll.take()).toEqual([])
  })

  it('resamples the read-back to the requested provider rate', () => {
    const preroll = new WakePreroll()
    preroll.arm()
    preroll.write(tone(2))
    preroll.markFired(performance.now())

    const total = preroll.take(24_000).reduce((n, c) => n + pcm16Samples(c), 0)
    // ~1.2 s lead is read back (sinceFire ≈ 0) at 24 kHz.
    expect(total).toBeGreaterThan(24_000)
    expect(total).toBeLessThan(24_000 * 2)
  })

  it('clear() drops audio without reading it back', () => {
    const preroll = new WakePreroll()
    preroll.arm()
    preroll.write(tone(1))
    preroll.clear()
    expect(preroll.retainingAudio).toBe(false)
    expect(preroll.take()).toEqual([])
  })
})
