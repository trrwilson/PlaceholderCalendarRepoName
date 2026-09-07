// Lightweight, always-on timing instrumentation for a voice turn.
//
// The push-to-talk path crosses several systems (our token endpoint, Google's
// auth-token API, the lazy SDK chunk, the Live WebSocket, the mic worklet, tool
// round-trips through our calendar provider, then model audio). When a turn feels
// slow it is rarely obvious which hop cost the time. `VoiceTimeline` stamps each
// milestone relative to the start of the turn and logs it, so a kiosk session's
// console is enough to see where the seconds went.

type Detail = Record<string, unknown> | undefined

export interface TimelineEntry {
  label: string
  atMs: number
  detail: Detail
}

const enabled = (): boolean => {
  try {
    // Opt out with localStorage.setItem('voice.trace', 'off') if it ever gets noisy.
    return localStorage.getItem('voice.trace') !== 'off'
  } catch {
    return true
  }
}

export class VoiceTimeline {
  private readonly start = performance.now()
  private last = this.start
  readonly entries: TimelineEntry[] = []

  mark(label: string, detail?: Detail): void {
    const now = performance.now()
    const atMs = Math.round(now - this.start)
    const sinceLast = Math.round(now - this.last)
    this.last = now
    this.entries.push({ label, atMs, detail })
    if (enabled()) {
      const head = `[voice] t+${String(atMs).padStart(5)}ms (+${sinceLast}ms) ${label}`
      if (detail) console.info(head, detail)
      else console.info(head)
    }
  }

  /** Milliseconds since the turn started. */
  elapsed(): number {
    return Math.round(performance.now() - this.start)
  }

  /** One-line summary of the whole turn, handy to copy out of the console. */
  summary(): string {
    return this.entries.map((e) => `${e.label}=${e.atMs}ms`).join('  ')
  }

  /**
   * Structured milestones for a {@link VoiceTurnReport}. Last occurrence wins per
   * label (a turn may e.g. call two tools); `provider` / `model` are lifted from
   * the `token-received` mark so the bake-off can group by contestant.
   */
  toReport(): Pick<VoiceTurnReport, 'provider' | 'model' | 'milestones'> {
    const milestones: Record<string, number> = {}
    let provider: string | undefined
    let model: string | undefined
    for (const entry of this.entries) {
      milestones[entry.label] = entry.atMs
      if (entry.label === 'token-received' && entry.detail) {
        provider = (entry.detail.provider as string) ?? provider
        model = (entry.detail.model as string) ?? model
      }
    }
    return { provider, model, milestones }
  }
}

/**
 * One turn's measurements, for the provider bake-off. Describes the whole
 * user-perceived interaction (activation → transcript → tool → first audio →
 * done), not just model timing — the milestone seams a future local/hybrid path
 * reuses (see AGENTS.md → "Voice assistant → Provider architecture").
 */
export interface VoiceTurnReport {
  ok: boolean
  provider?: string
  model?: string
  failureKind?: string
  /** milestone label → ms from the start of the turn */
  milestones: Record<string, number>
  /** `AudioSink.arrivalStats()` — realtime ratio, underruns, jitter depth */
  audio?: Record<string, number>
  /** `MainThreadLagProbe.summary()` — was the render path starving the socket? */
  lag?: Record<string, number>
}

const TURN_LOG: VoiceTurnReport[] = []

/**
 * Log one turn report and keep the last 20 on `window.__voiceTurns` so a
 * bake-off session can be pulled out of the console without a datastore.
 */
export function recordVoiceTurn(report: VoiceTurnReport): void {
  TURN_LOG.push(report)
  if (TURN_LOG.length > 20) TURN_LOG.shift()
  try {
    ;(window as unknown as { __voiceTurns?: VoiceTurnReport[] }).__voiceTurns = TURN_LOG
  } catch {
    // non-browser context (tests) — the console line below is enough
  }
  console.info('[voice] turn-report', report)
}

/**
 * Samples how late a fixed-interval timer actually fires — i.e. how blocked the
 * main thread is.
 *
 * This exists to settle one question: response audio arriving at a fraction of
 * real time can mean the server is generating slowly, or it can mean *we* are
 * too busy to drain the socket, in which case TCP backpressure throttles the
 * sender and the slowness is self-inflicted. The two look identical from the
 * arrival timestamps alone. If `maxLagMs` stays near zero while audio crawls,
 * the server is the bottleneck and no client change will fix the underruns; if
 * it spikes into the hundreds, the render path is starving the socket.
 */
export class MainThreadLagProbe {
  private timer: ReturnType<typeof setInterval> | null = null
  private expected = 0
  private readonly intervalMs: number
  maxLagMs = 0
  totalLagMs = 0
  samples = 0

  constructor(intervalMs = 100) {
    this.intervalMs = intervalMs
  }

  start(): void {
    if (this.timer) return
    this.expected = performance.now() + this.intervalMs
    this.timer = setInterval(() => {
      const now = performance.now()
      const lag = Math.max(0, now - this.expected)
      this.expected = now + this.intervalMs
      this.maxLagMs = Math.max(this.maxLagMs, lag)
      this.totalLagMs += lag
      this.samples += 1
    }, this.intervalMs)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  summary(): Record<string, number> {
    return {
      maxLagMs: Math.round(this.maxLagMs),
      meanLagMs: this.samples ? Math.round(this.totalLagMs / this.samples) : 0,
      samples: this.samples,
    }
  }
}

/**
 * Fetch the lazy `@google/genai` chunk and the mic worklet module ahead of the
 * first tap so their download does not land on the turn's critical path. Safe to
 * call repeatedly; the browser and bundler cache both.
 */
let warmed: Promise<void> | null = null
export function prewarmVoice(): Promise<void> {
  if (!warmed) {
    warmed = (async () => {
      try {
        await import('@google/genai')
      } catch {
        // The turn will surface this failure properly; nothing to do here.
      }
      try {
        await fetch(new URL('./pcm-capture-worklet.js', import.meta.url))
      } catch {
        // Non-fatal: addModule will fetch it on demand.
      }
    })()
  }
  return warmed
}
