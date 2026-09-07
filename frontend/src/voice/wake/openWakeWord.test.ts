// The pre-roll retention state machine — the part of `OpenWakeWordDetector` that
// does not need the ONNX models. The keyword-spotting maths is validated on
// hardware (see the file header and docs/wake-word-model-training-notes.md).

import { describe, expect, it } from 'vitest'

import { OpenWakeWordDetector } from './openWakeWord'
import { WAKE_SAMPLE_RATE } from './ringBuffer'

/** Reach the members `start()` would normally set up, without loading a model. */
interface Internals {
  running: boolean
  retaining: boolean
  fireAt: number
  onAudio(frame: Float32Array, sampleRate: number): void
}

function makeDetector(): { detector: OpenWakeWordDetector; internals: Internals } {
  const detector = new OpenWakeWordDetector(
    { modelPath: '/wake.onnx', modelsBaseUrl: '/models', threshold: 0.5, cooldownMs: 2_000 },
    {} as never,
  )
  const internals = detector as unknown as Internals
  internals.running = true
  internals.retaining = true
  return { detector, internals }
}

/** `seconds` of constant-value mono 16 kHz audio. */
function tone(seconds: number, value = 0.3): Float32Array {
  return new Float32Array(Math.round(seconds * WAKE_SAMPLE_RATE)).fill(value)
}

/** PCM16 sample count carried by a base64 chunk. */
function sampleCount(base64: string): number {
  return atob(base64).length / 2
}

describe('OpenWakeWordDetector pre-roll retention', () => {
  it('keeps retaining while suspended, so the command spoken during connect survives', () => {
    const { detector, internals } = makeDetector()
    // Fired 2 s ago: `takeRetainedAudio` reads back up to sinceFire + 1.2 s.
    internals.fireAt = performance.now() - 2_000

    internals.onAudio(tone(1, 0.3), WAKE_SAMPLE_RATE) // run-up to the phrase
    detector.suspend() // a turn opened — inference stops
    internals.onAudio(tone(1, 0.6), WAKE_SAMPLE_RATE) // "...what's on today" during setup

    const chunks = detector.takeRetainedAudio(WAKE_SAMPLE_RATE)
    const total = chunks.reduce((n, c) => n + sampleCount(c), 0)
    // Both writes are present (~2 s) — not just the ~1 s before suspend.
    expect(total).toBeGreaterThan(WAKE_SAMPLE_RATE * 1.5)
  })

  it('stops retaining once the pre-roll is taken, until resume re-arms it', () => {
    const { detector, internals } = makeDetector()
    internals.fireAt = performance.now() - 2_000
    internals.onAudio(tone(1), WAKE_SAMPLE_RATE)
    detector.suspend()

    detector.takeRetainedAudio(WAKE_SAMPLE_RATE)
    expect(internals.retaining).toBe(false)

    internals.onAudio(tone(1), WAKE_SAMPLE_RATE)
    expect(detector.takeRetainedAudio(WAKE_SAMPLE_RATE)).toEqual([])

    detector.resume()
    expect(internals.retaining).toBe(true)
  })
})
