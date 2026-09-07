// Configurable input gain for the shared microphone capture pipeline.
//
// Kiosk microphones are usually far-field and cheap, and a long USB run drops a
// few more dB on top; speech often arrives 10–15 dB quieter than a headset would
// deliver. Rather than push a device-specific fix into `getUserMedia` constraints
// (which vary by browser and mic and cannot be tuned without a rebuild) or into a
// particular microphone driver, we apply a plain amplitude multiplier to the
// captured PCM once, at the point every consumer shares — see `MicSource` in
// `./audio`, where both wake-word detection and the conversational provider read
// the same frames.
//
// The gain is expressed in decibels because that is how microphone level is
// reasoned about; it converts to a linear multiplier as 10^(dB/20). 0 dB is
// unity and disables the stage. Peak / RMS / clip diagnostics are accumulated so
// the value can be set from measurements on real hardware instead of guessed.

/** Default boost, in dB, for the kiosk's far-field USB microphone. */
export const DEFAULT_INPUT_GAIN_DB = 12

/** Decibels to a linear amplitude multiplier: 10^(dB/20). */
export function dbToLinear(db: number): number {
  return 10 ** (db / 20)
}

export interface InputGainStats {
  /** Configured gain, in dB (0 = stage disabled). */
  db: number
  /** Linear multiplier applied to each sample (1 when disabled). */
  linear: number
  /** Audio frames measured in this window. */
  frames: number
  /** Samples measured in this window. */
  samples: number
  /**
   * Largest sample magnitude seen *after* the multiplier but *before*
   * saturation. Above 1 means the signal is being clipped and the gain is too
   * high for this room; a comfortable speech peak is roughly 0.3–0.7.
   */
  peak: number
  /** RMS of the emitted (post-saturation) signal in this window. */
  rms: number
  /** Samples that saturated (|value| ≥ 1 after the multiplier) in this window. */
  clipped: number
}

const ZERO_STATS: Omit<InputGainStats, 'db' | 'linear'> = {
  frames: 0,
  samples: 0,
  peak: 0,
  rms: 0,
  clipped: 0,
}

/**
 * Applies a dB-denominated amplitude gain to mono Float32 PCM in place, clamping
 * to [-1, 1] so a hot sample saturates instead of wrapping when it is later
 * packed to PCM16. Independent of any particular microphone or capture backend:
 * it only ever sees sample buffers.
 */
export class InputGain {
  private multiplier = 1
  private gainDb = 0
  // Accumulators, cleared by `readStats()`.
  private frames = 0
  private samples = 0
  private peak = 0
  private sumSquares = 0
  private clipped = 0

  constructor(db: number = DEFAULT_INPUT_GAIN_DB) {
    this.setDb(db)
  }

  /** Set the gain in dB. Non-finite values are ignored; 0 disables the stage. */
  setDb(db: number): void {
    if (!Number.isFinite(db)) return
    this.gainDb = db
    this.multiplier = db === 0 ? 1 : dbToLinear(db)
  }

  /** Configured gain, in dB. */
  get db(): number {
    return this.gainDb
  }

  /** Linear multiplier currently applied per sample (1 when disabled). */
  get linear(): number {
    return this.multiplier
  }

  /** True when the stage is actually changing samples. */
  get active(): boolean {
    return this.multiplier !== 1
  }

  /**
   * Multiply every sample by the configured gain, saturating at ±1, and fold the
   * result into the running diagnostics. Returns the same array (mutated when the
   * stage is active) so the caller can hand one buffer to every listener.
   *
   * When the stage is disabled (0 dB) the samples are left untouched, but peak /
   * RMS / clip are still measured — running at 0 dB and reading the console is
   * exactly how the right non-zero value is found.
   */
  apply(frame: Float32Array): Float32Array {
    const active = this.multiplier !== 1
    this.frames += 1
    this.samples += frame.length
    for (let i = 0; i < frame.length; i += 1) {
      let s = active ? frame[i] * this.multiplier : frame[i]
      const mag = s < 0 ? -s : s
      if (mag > this.peak) this.peak = mag
      if (mag >= 1) {
        this.clipped += 1
        if (active) s = s < 0 ? -1 : 1
      }
      if (active) frame[i] = s
      this.sumSquares += s * s
    }
    return frame
  }

  /** Diagnostics for the samples seen since the last call, then reset them. */
  readStats(): InputGainStats {
    const stats: InputGainStats = {
      db: this.gainDb,
      linear: this.multiplier,
      frames: this.frames,
      samples: this.samples,
      peak: this.peak,
      rms: this.samples ? Math.sqrt(this.sumSquares / this.samples) : 0,
      clipped: this.clipped,
    }
    this.frames = 0
    this.samples = 0
    this.peak = 0
    this.sumSquares = 0
    this.clipped = 0
    return stats
  }

  /** A zero-valued stats snapshot carrying the current gain — before any audio. */
  emptyStats(): InputGainStats {
    return { db: this.gainDb, linear: this.multiplier, ...ZERO_STATS }
  }
}
