import { describe, expect, it } from 'vitest'

import { SPEAKER_RATE, SpeakerMixer } from './speakerMix'

const flat = (n: number, value: number) => new Float32Array(n).fill(value)

describe('SpeakerMixer', () => {
  it('emits what a single source wrote, quantised to PCM16, then clears it', () => {
    const mixer = new SpeakerMixer()
    mixer.write('a', flat(4, 1))
    const first = mixer.read(10)
    expect(first).not.toBeNull()
    expect(Array.from(first as Int16Array)).toEqual([32767, 32767, 32767, 32767])
    // slots were cleared and the cursor advanced
    expect(mixer.read(10)).toBeNull()
  })

  it('sums overlapping writes from two sources sample-for-sample', () => {
    const mixer = new SpeakerMixer()
    mixer.write('assistant', flat(3, 0.5))
    mixer.write('chime', flat(3, 0.25))
    const mixed = mixer.read(10) as Int16Array
    // 0.75 * 32767 ≈ 24575
    expect(Array.from(mixed).every((s) => Math.abs(s - 24575) <= 1)).toBe(true)
  })

  it('reports only what every source has reached as available', () => {
    const mixer = new SpeakerMixer()
    mixer.write('a', flat(100, 0.1))
    expect(mixer.available()).toBe(100)
    mixer.read(60)
    expect(mixer.available()).toBe(40)
  })

  it('resumes a lagging source at the read cursor rather than writing into the past', () => {
    const mixer = new SpeakerMixer()
    mixer.write('a', flat(50, 0.5))
    mixer.read(50) // drain everything a wrote
    mixer.write('a', flat(10, 1)) // a fell silent, now speaks again
    const out = mixer.read(50) as Int16Array
    expect(out.length).toBe(10) // exactly the new audio, no backfill
    expect(out[0]).toBe(32767)
  })

  it('drops the oldest audio when a source runs past the ring capacity', () => {
    const mixer = new SpeakerMixer(0.01) // 480-sample ring
    mixer.write('a', flat(800, 0.5))
    expect(mixer.available()).toBeLessThanOrEqual(480)
  })

  it('reset forgets every cursor', () => {
    const mixer = new SpeakerMixer()
    mixer.write('a', flat(SPEAKER_RATE, 0.5))
    mixer.reset()
    expect(mixer.available()).toBe(0)
    expect(mixer.read(10)).toBeNull()
  })
})
