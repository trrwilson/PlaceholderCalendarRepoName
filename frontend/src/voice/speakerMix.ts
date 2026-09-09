// Sums the kiosk's output-bus taps into one mono 48 kHz stream for the Wi-Fi
// speaker socket (`speakerOut.ts`). Pure — no `AudioContext`, no socket — so the
// mixing/quantisation is unit-testable without a worklet.
//
// There are two output contexts on the appliance (the assistant `AudioSink` and
// the `AlarmChime`, each with its own `createEchoCancelledOutput` — see
// docs/audio-pipeline.md), and a timer routinely rings *while* the assistant is
// speaking. Each context's tap writes here under its own id; overlapping writes
// are summed sample-for-sample. Both contexts run on the same machine's audio
// clock, so their samples are already aligned — no per-tap resampling here.

import { floatToPcm16 } from './pcm'

/** The wire rate the Invoke speaker daemon's GStreamer caps demand. */
export const SPEAKER_RATE = 48_000

/**
 * A fixed-size ring accumulator. Each source advances its own write cursor;
 * `read()` emits everything every source has reached, quantised to PCM16, and
 * clears those slots. A source that falls behind `read()` (its reply ended and a
 * new sound starts later) resumes at the current read position rather than
 * writing into the past.
 */
export class SpeakerMixer {
  private readonly ring: Float32Array
  private readonly capacity: number
  private readAbs = 0
  private maxWrittenAbs = 0
  private readonly writeAbs = new Map<string, number>()

  /** `ringSeconds` bounds how far a fast source may run ahead of `read()`. */
  constructor(ringSeconds = 0.5) {
    this.capacity = Math.round(SPEAKER_RATE * ringSeconds)
    this.ring = new Float32Array(this.capacity)
  }

  /** Mix `samples` (mono, {@link SPEAKER_RATE}) from `sourceId` into the ring. */
  write(sourceId: string, samples: Float32Array): void {
    if (samples.length === 0) return
    // A source that fell silent resumes at the read cursor, not in the past.
    const start = Math.max(this.writeAbs.get(sourceId) ?? this.readAbs, this.readAbs)
    // Guard only: a real-time source never runs a whole ring ahead of `read()`.
    // If one does, keep the oldest and drop the newest overflow.
    const room = this.readAbs + this.capacity - start
    if (room <= 0) return
    const count = Math.min(samples.length, room)
    for (let i = 0; i < count; i += 1) {
      this.ring[(start + i) % this.capacity] += samples[i]
    }
    const end = start + count
    this.writeAbs.set(sourceId, end)
    if (end > this.maxWrittenAbs) this.maxWrittenAbs = end
  }

  /** Samples ready to send: what *every still-writing* source has reached, so a
   *  second tap that writes a beat later (the timer chime starting mid-reply) is
   *  mixed in rather than skipped past. A source that stops — its cursor is
   *  overtaken by `readAbs` — drops out of the frontier within one `read()`. */
  available(): number {
    let frontier = this.maxWrittenAbs
    for (const writeAbs of this.writeAbs.values()) {
      if (writeAbs > this.readAbs && writeAbs < frontier) frontier = writeAbs
    }
    return frontier - this.readAbs
  }

  /**
   * Take up to `maxSamples` of mixed audio as PCM16, clearing those ring slots.
   * `null` when nothing is ready.
   */
  read(maxSamples: number): Int16Array | null {
    const count = Math.min(this.available(), maxSamples)
    if (count <= 0) return null
    const out = new Float32Array(count)
    for (let i = 0; i < count; i += 1) {
      const slot = (this.readAbs + i) % this.capacity
      out[i] = this.ring[slot]
      this.ring[slot] = 0
    }
    this.readAbs += count
    return floatToPcm16(out)
  }

  /** Forget all cursors and zero the ring — used when the socket reconnects. */
  reset(): void {
    this.ring.fill(0)
    this.readAbs = 0
    this.maxWrittenAbs = 0
    this.writeAbs.clear()
  }
}
