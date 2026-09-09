// The on-device Invoke gate, layered in front of a base wake detector.
//
// The `invoke-gate` daemon on the Harman Kardon Invoke (ReInvoke2026
// `wakeword/`) runs a deliberately loose first-stage KWS and only streams real
// room audio once it has a candidate (or a push-to-talk). That gated audio
// reaches the kiosk over VB-CABLE exactly as today — `GatedWakeDetector` does
// NOT open a second capture path. What it adds:
//
//   * it opens `WS /api/voice/wake/invoke`, which the backend bridges to the
//     daemon's LAN control socket (`backend/app/voice/wake_invoke.py`);
//   * it wraps whichever base detector is selected (openWakeWord or Azure) and
//     runs it ONLY during a gate-open window: on `state:open` / `preroll` it
//     re-arms the base detector over a clean window (`resume`), forwards its
//     `onWake` only while verifying, and drops the window on `state:off` before
//     the base detector confirms (a gate false accept — the gate is loose by
//     design, resolution 3 in `FIRST_STAGE_WAKEWORD_INVESTIGATION.md`);
//   * it drives the gate back: `endActivation()` sends `{cmd:"done"}` at turn
//     end, `sendControl()` carries push-to-talk (`ptt_start` / `ptt_stop`) and
//     the barge-in `hold` lease.
//
// A refused socket rejects with `WakeUnavailableError`, exactly like
// `AzureKeywordDetector`, so push-to-talk is unaffected.

import type { WakeDetector, WakeDetectorConfig, WakeEvent } from './detector'
import { WakeUnavailableError } from './detector'

/** How long to wait for the backend bridge socket to open before giving up. */
const CONNECT_TIMEOUT_MS = 5_000

/** Commands the kiosk may send to the gate (mirrors the backend allow-list). */
const ALLOWED_CMDS = new Set([
  'ptt_start',
  'ptt_stop',
  'hold',
  'done',
  'set',
  'gate_enabled',
  'keepalive',
])

interface GateFrame {
  t?: string
  state?: string
  open?: boolean
  reason?: string
  score?: number
  message?: string
}

export class GatedWakeDetector implements WakeDetector {
  running = false
  suspended = false

  private ws: WebSocket | null = null
  private handlers: Parameters<WakeDetector['start']>[0] | null = null
  /** True between a gate open and either the base detector firing or the gate closing. */
  private verifying = false

  private readonly base: WakeDetector
  private readonly url: string

  constructor(config: WakeDetectorConfig, base: WakeDetector) {
    this.base = base
    const wsBase = config.apiBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '')
    this.url = `${wsBase}/api/voice/wake/invoke`
  }

  async start(handlers: Parameters<WakeDetector['start']>[0]): Promise<void> {
    this.handlers = handlers

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          ws.close()
          reject(new WakeUnavailableError('invoke gate socket did not open'))
        }
      }, CONNECT_TIMEOUT_MS)

      ws.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      ws.onclose = (event) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          // Closed before it opened — the LAN gate (4403), wake/voice off or the
          // Invoke host unset (4404). Fall back to push-to-talk.
          reject(
            new WakeUnavailableError(
              event.reason || `invoke gate socket refused the connection (${event.code})`,
            ),
          )
          return
        }
        this.handlers?.onError?.(new Error(`invoke gate socket closed (${event.code})`))
      }
      ws.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new WakeUnavailableError('invoke gate socket failed'))
        }
      }
      ws.onmessage = (event) => this.onGateMessage(event)
    })

    // The base detector runs only while the gate is open; it starts suspended
    // (the gate is OFF on connect) and every `state:open` re-arms it.
    await this.base.start({
      onWake: (wake) => this.onBaseWake(wake),
      onScore: handlers.onScore,
      onError: handlers.onError,
    })
    this.base.suspend()
    this.running = true

    // The feature is on ⇒ ask the Invoke to actually gate its egress.
    this.send({ cmd: 'gate_enabled', on: true })
  }

  suspend(): void {
    // A turn is running / the assistant is speaking. Stop the base detector so
    // the reply cannot self-trigger; keep the bridge socket open.
    this.suspended = true
    this.verifying = false
    this.base.suspend()
  }

  resume(): void {
    // Re-arm, but wait for the next gate open — while the gate is OFF the mic is
    // synthesised silence, so there is nothing to run inference on.
    this.suspended = false
    this.verifying = false
    this.base.suspend()
  }

  takeRetainedAudio(targetRate?: number): string[] {
    // The gate's preroll burst was played into VB-CABLE during the open window,
    // so the base detector's ring captured it.
    return this.base.takeRetainedAudio(targetRate)
  }

  dispose(): void {
    // Leave the device streaming continuously for whatever detector selection
    // comes next.
    this.send({ cmd: 'gate_enabled', on: false })
    this.running = false
    this.suspended = false
    this.verifying = false
    this.base.dispose()
    this.handlers = null
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      try {
        this.ws.close()
      } catch {
        /* already closing */
      }
      this.ws = null
    }
  }

  endActivation(): void {
    this.send({ cmd: 'done' })
  }

  sendControl(cmd: string, fields?: Record<string, unknown>): void {
    if (!ALLOWED_CMDS.has(cmd)) return
    this.send({ cmd, ...(fields ?? {}) })
  }

  private onGateMessage(event: MessageEvent): void {
    let frame: GateFrame
    try {
      frame = JSON.parse(String(event.data)) as GateFrame
    } catch {
      return
    }
    switch (frame.t) {
      case 'hello':
        if (frame.state === 'open') this.openWindow()
        break
      case 'state':
        if (frame.open || frame.state === 'open') this.openWindow()
        else this.closeWindow()
        break
      case 'preroll':
        this.openWindow()
        break
      case 'closing':
        this.closeWindow()
        break
      case 'error':
        this.handlers?.onError?.(new Error(frame.message || 'invoke gate link error'))
        break
      // `wake` is the gate's loose candidate — never acted on directly; the base
      // detector's confirmation (driven by `state:open`) is the gate.
      default:
        break
    }
  }

  /** Gate opened (or preroll incoming): start a clean base-detector listening window. */
  private openWindow(): void {
    if (this.suspended) return
    this.verifying = true
    this.base.resume({ resetCooldown: false })
  }

  /** Gate closed. If the base detector never confirmed, it was a gate false accept. */
  private closeWindow(): void {
    if (this.verifying) {
      this.verifying = false
      this.base.suspend()
    }
  }

  private onBaseWake(wake: WakeEvent): void {
    if (!this.verifying || this.suspended) return
    this.verifying = false
    this.handlers?.onWake(wake)
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }
}
