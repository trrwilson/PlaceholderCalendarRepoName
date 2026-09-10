// Shared pre-roll buffer for the wake-word detectors.
//
// After a detector fires, opening the voice session takes a few seconds (token
// fetch, lazy SDK, socket). Audio only reaches the provider once that session is
// live, but the person is usually already talking ("Mission Control, what's on
// tomorrow?"). Each detector keeps writing recent 16 kHz mic audio here while
// armed; `useVoiceSession` drains it into the session right after connect, then
// hands over to the live microphone.
//
// `OpenWakeWordDetector` keeps its own inline copy of this logic (entangled with
// its ONNX feature pipeline); `AzureKeywordDetector` uses this class. Behaviour —
// the read-back lead, the resample to the provider rate, the ~250 ms chunking —
// is identical to `openWakeWord.ts`.

import {
  AudioRingBuffer,
  floatToPcm16Base64,
  resampleFrom16k,
  WAKE_PREROLL_LEAD_MS,
  WAKE_SAMPLE_RATE,
} from './ringBuffer'

/** Seconds of audio retained around an activation. Matches `openWakeWord.ts`. */
const PREROLL_SECONDS = 4

export class WakePreroll {
  private buffer = new AudioRingBuffer(PREROLL_SECONDS)
  private retaining = false
  private firedAt = 0

  /** Start (or restart) capturing. Clears whatever was held. */
  arm(): void {
    this.buffer.clear()
    this.firedAt = 0
    this.retaining = true
  }

  /** True while frames written with {@link write} are being kept. */
  get retainingAudio(): boolean {
    return this.retaining
  }

  /** Feed one already-downsampled 16 kHz mono frame. */
  write(down16k: Float32Array): void {
    if (this.retaining) this.buffer.write(down16k)
  }

  /** Record the `performance.now()` of the wake fire, for the read-back lead. */
  markFired(at: number): void {
    this.firedAt = at
  }

  /**
   * The run-up to and start of the command, as base64 PCM16 chunks at
   * `targetRate` Hz (the provider's input rate). Empties the buffer and stops
   * retaining until the next {@link arm}.
   */
  take(targetRate: number = WAKE_SAMPLE_RATE): string[] {
    const sinceFire = this.firedAt ? (performance.now() - this.firedAt) / 1000 : 0
    const seconds = Math.min(PREROLL_SECONDS, sinceFire + WAKE_PREROLL_LEAD_MS / 1000)
    let samples = this.buffer.readLast(seconds)
    this.buffer.clear()
    this.retaining = false
    if (!samples.length) return []
    samples = resampleFrom16k(samples, targetRate)
    const chunkSize = Math.round(targetRate / 4)
    const out: string[] = []
    for (let i = 0; i < samples.length; i += chunkSize) {
      out.push(floatToPcm16Base64(samples.subarray(i, i + chunkSize)))
    }
    return out
  }

  /** Drop everything without reading it back. */
  clear(): void {
    this.buffer.clear()
    this.retaining = false
    this.firedAt = 0
  }
}
