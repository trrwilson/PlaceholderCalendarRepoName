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

/** 16 kHz mono, the rate Gemini Live expects for input audio. */
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

/** Float32 [-1, 1] samples to a base64-encoded little-endian PCM16 string. */
export function floatToPcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Average-decimate `samples` from `fromRate` to 16 kHz. This mirrors the
 * anti-aliasing downsample in `audio.ts` — plain decimation folds high
 * frequencies into the speech band and hurts keyword spotting just as it hurts
 * transcription.
 */
export function downsampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate <= WAKE_SAMPLE_RATE) return samples
  const ratio = fromRate / WAKE_SAMPLE_RATE
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += samples[j]
    out[i] = end > start ? sum / (end - start) : samples[start] ?? 0
  }
  return out
}

/**
 * Linearly resample 16 kHz pre-roll to `toRate` (24 kHz for the Azure relay
 * providers). The ring buffer holds 16 kHz — feeding those samples to a 24 kHz
 * input stream plays them ~1.5x fast and pitched up, which the model can't parse,
 * so the *start* of a wake-word command is effectively lost.
 */
export function resampleFrom16k(samples: Float32Array, toRate: number): Float32Array {
  if (toRate === WAKE_SAMPLE_RATE || samples.length === 0) return samples
  const ratio = WAKE_SAMPLE_RATE / toRate
  const out = new Float32Array(Math.round(samples.length / ratio))
  for (let i = 0; i < out.length; i += 1) {
    const src = i * ratio
    const lo = Math.floor(src)
    const hi = Math.min(samples.length - 1, lo + 1)
    const frac = src - lo
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac
  }
  return out
}
