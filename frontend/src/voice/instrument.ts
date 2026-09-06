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
