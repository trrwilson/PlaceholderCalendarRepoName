// Local / Hybrid provider: on-device STT + intent interpretation on our own
// backend, cloud only for genuine reasoning. Like the Azure relay the kiosk
// never talks to a cloud service here — it opens `WS /api/voice/local` with the
// single-use ticket from its grant, streams 16 kHz mic audio up, and the backend
// (app/voice/local/) sends the shared `VoiceEvent` JSON down, plus `diagnostic`
// and `escalation` events. See docs/local-voice-plan.md.

import { VoiceTimeline } from '../instrument'
import {
  type ConversationalVoiceProvider,
  type EndpointingMode,
  type VoiceEvent,
  type VoiceGrant,
  VoiceSessionError,
} from './types'

/** Local wall-clock `YYYY-MM-DDTHH:mm:ss`, no offset — the interpreter's "now". */
function localIsoNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

export class LocalHybridVoiceProvider implements ConversationalVoiceProvider {
  // faster-whisper / sherpa-onnx want 16 kHz mono PCM16.
  readonly inputSampleRate = 16_000
  // Text-only today: the local pipeline sends no `audio` events. Declared for
  // the contract, and the rate a future local TTS would render at.
  readonly outputSampleRate = 24_000
  // The kiosk brackets the turn (`activity-end`) and its mic-RMS detector is the
  // endpointer. A streaming STT engine may still self-endpoint earlier by
  // emitting its final transcript mid-turn — an optimization within `client`.
  readonly endpointing: EndpointingMode
  private ws: WebSocket | null = null
  private firstAudioSent = true
  private firstPartial = true
  private firstFinal = true
  private readonly url: string
  private readonly onEvent: (event: VoiceEvent) => void
  readonly timeline: VoiceTimeline

  constructor(
    apiBaseUrl: string,
    grant: VoiceGrant,
    onEvent: (event: VoiceEvent) => void,
    timeline: VoiceTimeline = new VoiceTimeline(),
  ) {
    const base = apiBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '')
    const params = new URLSearchParams({ ticket: grant.token, client_time: localIsoNow() })
    this.url = `${base}/api/voice/local?${params.toString()}`
    this.onEvent = onEvent
    this.timeline = timeline
    this.endpointing = grant.endpointing ?? 'client'
  }

  connect(): Promise<void> {
    this.timeline.mark('local-connect')
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => {
        this.timeline.mark('local-open')
        settled = true
        resolve()
      }
      ws.onerror = () => {
        if (!settled) {
          settled = true
          reject(new VoiceSessionError('session', 'The local voice pipeline connection failed.'))
        }
      }
      ws.onclose = (event) => {
        this.timeline.mark('local-close', { code: event.code })
        if (!settled) {
          settled = true
          reject(
            new VoiceSessionError(
              'session',
              event.reason || `The local voice pipeline refused the connection (${event.code}).`,
            ),
          )
          return
        }
        if (event.code && event.code !== 1000 && event.code !== 1005) {
          this.onEvent({
            type: 'error',
            kind: 'session',
            error: new Error(event.reason || `Local voice pipeline closed (${event.code}).`),
          })
        } else {
          this.onEvent({ type: 'closing' })
        }
      }
      ws.onmessage = (message) => this.handle(message)
    })
  }

  private handle(message: MessageEvent): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(String(message.data))
    } catch {
      return
    }
    const type = frame.type
    if (type === 'open') this.timeline.mark('setup-complete')
    if (type === 'user-transcript') {
      if (frame.final && this.firstFinal) {
        this.firstFinal = false
        this.timeline.mark('input-transcript-first')
      } else if (!frame.final && this.firstPartial) {
        this.firstPartial = false
        this.timeline.mark('interim-transcript-first')
      }
    }
    if (type === 'tool-call') this.timeline.mark('tool-call', { name: String(frame.name ?? '') })
    if (type === 'generation-complete') this.timeline.mark('generation-complete')
    if (type === 'diagnostic') {
      this.timeline.mark('local-interpretation', {
        disposition: (frame.data as Record<string, unknown>)?.disposition,
        intent: (frame.data as Record<string, unknown>)?.intent,
      })
      try {
        ;(window as unknown as { __voiceLocal?: unknown }).__voiceLocal = frame.data
      } catch {
        // non-browser (tests)
      }
      console.info('[voice] local interpretation', frame.data)
    }
    if (type === 'escalation') {
      this.timeline.mark('cloud-escalation', { reason: String(frame.reason ?? ''), tier: frame.tier })
      console.info('[voice] local -> escalate', frame.reason, frame.payload)
    }
    // The backend already speaks our `VoiceEvent` shapes; forward as-is.
    this.onEvent(frame as unknown as VoiceEvent)
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  startActivity(): void {
    this.timeline.mark('activity-start')
    this.send({ type: 'activity-start' })
  }

  endActivity(): void {
    this.timeline.mark('activity-end')
    this.send({ type: 'activity-end' })
  }

  sendAudio(base64: string): void {
    if (this.firstAudioSent) {
      this.firstAudioSent = false
      this.timeline.mark('mic-first-chunk-sent')
    }
    this.send({ type: 'audio', data: base64 })
  }

  /** Dev / test bypass: interpret a typed utterance with no microphone. */
  sendText(text: string): void {
    this.send({ type: 'text', text })
  }

  respondTool(id: string, name: string, result: Record<string, unknown>): void {
    this.timeline.mark('tool-response', { name })
    // The local pipeline reads `output` as a JSON string (same as the realtime
    // relay contract) so a future local escalator can reuse tool results.
    const output =
      result && result.ok === false
        ? JSON.stringify({ error: String(result.error ?? 'tool failed') })
        : JSON.stringify(result)
    this.send({ type: 'tool-response', id, name, output })
  }

  close(): void {
    try {
      this.ws?.close()
    } catch {
      // best effort
    }
    this.ws = null
  }
}
