// The timer expiry cue.
//
// The plan allows a bundled short chime OR a WebAudio-synthesised fallback; this
// is the fallback (no external asset is committed — see docs/credits.md). Two
// gentle partials with a short percussive envelope, repeated every ~2 s while a
// timer is in the `fired` state. After the first minute the interval tightens
// slightly so an ignored timer becomes more insistent without changing timbre.
//
// Browsers block audio without a prior user gesture. `unlock()` is wired to the
// first pointer interaction anywhere in the app (see useTimers) so the context
// is warm by the time a timer fires; if it still cannot play, the caller falls
// back to a visual-only alarm.

const FIRST_INTERVAL_MS = 2_000
const INSISTENT_INTERVAL_MS = 1_400
const INSISTENT_AFTER_MS = 60_000

type Ctor = typeof AudioContext

function audioContextCtor(): Ctor | null {
  if (typeof window === 'undefined') return null
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext ??
    null
  )
}

export class AlarmChime {
  private context: AudioContext | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private startedAt = 0
  private running = false

  /** Create/resume the context during a user gesture so playback is permitted later. */
  unlock(): void {
    const Ctor = audioContextCtor()
    if (!Ctor) return
    if (!this.context) {
      try {
        this.context = new Ctor()
      } catch {
        this.context = null
        return
      }
    }
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined)
  }

  /** True when the context is available and not blocked. */
  get available(): boolean {
    return !!this.context && this.context.state !== 'closed'
  }

  start(): void {
    if (this.running) return
    this.unlock()
    if (!this.context) return
    this.running = true
    this.startedAt = Date.now()
    this.ping()
    this.schedule()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    if (!this.running) return
    const elapsed = Date.now() - this.startedAt
    const gap = elapsed > INSISTENT_AFTER_MS ? INSISTENT_INTERVAL_MS : FIRST_INTERVAL_MS
    this.timer = setTimeout(() => {
      this.ping()
      this.schedule()
    }, gap)
  }

  private ping(): void {
    const context = this.context
    if (!context) return
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    const now = context.currentTime
    const out = context.createGain()
    out.gain.value = 0.9
    out.connect(context.destination)
    // Soft two-note bell: a fundamental plus a fifth above, quick attack, ~1.1 s decay.
    for (const [freq, level, delay] of [
      [660, 0.18, 0],
      [990, 0.09, 0.14],
    ] as const) {
      const osc = context.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      const g = context.createGain()
      g.gain.setValueAtTime(0.0001, now + delay)
      g.gain.exponentialRampToValueAtTime(level, now + delay + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.1)
      osc.connect(g).connect(out)
      osc.start(now + delay)
      osc.stop(now + delay + 1.2)
    }
  }
}
