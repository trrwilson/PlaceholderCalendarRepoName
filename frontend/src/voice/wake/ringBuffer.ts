// A fixed-capacity ring buffer of mono 16 kHz Float32 audio, used to retain the
// speech that arrives around a wake-word activation.
//
// Why this exists: after the detector fires, opening the Gemini Live session
// takes a few seconds (token fetch + lazy SDK + WebSocket). Audio only reaches
// the model once that session is live, but the person is already talking
// ("Mission Control, what's on tomorrow?"). Without a buffer the first second or
// two of the command is simply lost. The detector keeps writing here across the
// whole activation; `useVoiceSession` drains it into the session right after it
// connects, then hands over to the live microphone.

import { downsampleTo, resampleLinear } from '../pcm'

/**
 * 16 kHz mono — fixed by the openWakeWord feature models, and coincidentally
 * also Gemini Live's input rate. The ring buffer always holds audio at this
 * rate; `resampleFrom16k` moves it onto whatever rate the turn's provider wants.
 */
export const WAKE_SAMPLE_RATE = 16_000

export class AudioRingBuffer {
  private readonly data: Float32Array
  private readonly capacity: number
  private writePos = 0
  private filled = 0

  /** @param seconds how much audio to keep at most. */
  constructor(seconds: number) {
    this.capacity = Math.max(1, Math.round(seconds * WAKE_SAMPLE_RATE))
    this.data = new Float32Array(this.capacity)
  }

  /** Append samples, overwriting the oldest audio once full. */
  write(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i += 1) {
      this.data[this.writePos] = samples[i]
      this.writePos = (this.writePos + 1) % this.capacity
    }
    this.filled = Math.min(this.capacity, this.filled + samples.length)
  }

  /** Copy out the most recent `seconds` of audio (or everything, if less). */
  readLast(seconds: number): Float32Array {
    const want = Math.min(this.filled, Math.round(seconds * WAKE_SAMPLE_RATE))
    const out = new Float32Array(want)
    let pos = (this.writePos - want + this.capacity) % this.capacity
    for (let i = 0; i < want; i += 1) {
      out[i] = this.data[pos]
      pos = (pos + 1) % this.capacity
    }
    return out
  }

  /** Number of samples currently retained. */
  get length(): number {
    return this.filled
  }

  clear(): void {
    this.writePos = 0
    this.filled = 0
  }
}

/**
 * Rate/format conversion for the pre-roll. Both are thin, named wrappers over
 * the shared primitives in `../pcm` — the ring buffer's rate is fixed by the
 * wake model, so it is worth naming, but the maths must not be a second copy.
 */

/** Float32 [-1, 1] samples to a base64-encoded little-endian PCM16 string. */
export { floatToPcm16Base64 } from '../pcm'

/**
 * Anti-aliasing downsample of native-rate mic audio to the wake model's 16 kHz.
 * Plain decimation folds high frequencies into the speech band and hurts keyword
 * spotting just as it hurts transcription.
 */
export function downsampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
  return downsampleTo(samples, fromRate, WAKE_SAMPLE_RATE)
}

/**
 * Resample 16 kHz pre-roll to `toRate` (24 kHz for the Azure relay providers).
 * The ring buffer holds 16 kHz — feeding those samples to a 24 kHz input stream
 * plays them ~1.5x fast and pitched up, which the model can't parse, so the
 * *start* of a wake-word command is effectively lost.
 */
export function resampleFrom16k(samples: Float32Array, toRate: number): Float32Array {
  return resampleLinear(samples, WAKE_SAMPLE_RATE, toRate)
}
