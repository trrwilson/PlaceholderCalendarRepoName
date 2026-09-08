// Relay provider: for the Azure contestants the kiosk does not connect to the
// provider at all — it connects to our backend `WS /api/voice/live`, which holds
// the upstream socket and the credentials and translates both directions to the
// shared `VoiceEvent` protocol (backend `app/voice/relay.py`). So this provider
// is thin: a WebSocket that forwards our own event JSON.

import { VoiceTimeline } from '../instrument'
import {
  type ConversationalVoiceProvider,
  type EndpointingMode,
  type VoiceEvent,
  type VoiceGrant,
  VoiceSessionError,
} from './types'

export class RelayVoiceProvider implements ConversationalVoiceProvider {
  // Azure realtime speaks 24 kHz PCM16 in and out.
  readonly inputSampleRate = 24_000
  // The relay pins both Azure sessions to 24 kHz PCM in and out (voice/relay.py).
  readonly outputSampleRate = 24_000
  readonly endpointing: EndpointingMode
  private ws: WebSocket | null = null
  private firstAudioSent = true
  private firstUserTranscript = true
  private firstAudioChunk = true
  // The relay forwards the upstream transcription as incremental `final: false`
  // deltas and then one `final: true` frame with the whole utterance. Assemble
  // it here so the consumer always gets the full best-so-far string (deltas
  // accumulate; the final frame replaces).
  private userTranscript = ''
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
    this.url = `${base}/api/voice/live?ticket=${encodeURIComponent(grant.token)}`
    this.onEvent = onEvent
    this.timeline = timeline
    this.endpointing = grant.endpointing ?? 'client'
  }

  connect(): Promise<void> {
    this.timeline.mark('relay-connect')
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => {
        this.timeline.mark('relay-open')
        settled = true
        resolve()
      }
      ws.onerror = () => {
        if (!settled) {
          settled = true
          reject(new VoiceSessionError('session', 'The voice relay connection failed.'))
        }
      }
      ws.onclose = (event) => {
        this.timeline.mark('relay-close', { code: event.code })
        if (!settled) {
          // Closed before it ever opened — a rejected ticket (4401), the LAN gate
          // (4403), or the relay could not reach the provider.
          settled = true
          reject(
            new VoiceSessionError(
              'session',
              event.reason || `The voice relay refused the connection (${event.code}).`,
            ),
          )
          return
        }
        // 1000 / 1005 are a clean end of turn; anything else is an unexpected drop.
        if (event.code && event.code !== 1000 && event.code !== 1005) {
          this.onEvent({
            type: 'error',
            kind: 'session',
            error: new Error(event.reason || `Voice relay closed (${event.code}).`),
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
    if (type === 'error') {
      this.timeline.mark('relay-error')
      this.onEvent({
        type: 'error',
        kind: 'session',
        error: new Error(String(frame.message ?? 'voice provider error')),
      })
      return
    }
    if (type === 'open') this.timeline.mark('setup-complete')
    if (type === 'user-transcript') {
      if (this.firstUserTranscript) {
        this.firstUserTranscript = false
        this.timeline.mark('input-transcript-first')
      }
      const text = String(frame.text ?? '')
      if (frame.final) this.userTranscript = text
      else this.userTranscript += text
      this.onEvent({ type: 'user-transcript', text: this.userTranscript, final: frame.final === true })
      return
    }
    if (type === 'audio' && this.firstAudioChunk) {
      this.firstAudioChunk = false
      this.timeline.mark('audio-first-chunk')
    }
    if (type === 'tool-call') {
      this.timeline.mark('tool-call', { name: String(frame.name ?? '') })
    }
    if (type === 'generation-complete') this.timeline.mark('generation-complete')
    // The relay already emits our own `VoiceEvent` shapes; forward as-is.
    this.onEvent(frame as unknown as VoiceEvent)
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  startActivity(): void {
    if (this.endpointing === 'provider') return
    this.timeline.mark('activity-start')
    this.send({ type: 'activity-start' })
  }

  endActivity(): void {
    // `provider` mode: the upstream VAD commits and answers on its own endpoint,
    // so the kiosk sends no finalise marker.
    if (this.endpointing === 'provider') return
    this.timeline.mark('audio-stream-end')
    this.send({ type: 'activity-end' })
  }

  sendAudio(base64: string): void {
    if (this.firstAudioSent) {
      this.firstAudioSent = false
      this.timeline.mark('mic-first-chunk-sent')
    }
    this.send({ type: 'audio', data: base64 })
  }

  respondTool(id: string, name: string, result: Record<string, unknown>): void {
    this.timeline.mark('tool-response', { name })
    // The OpenAI/Azure realtime `function_call_output.output` is a plain string —
    // the tool result serialised, not wrapped in `{ output }` (that is Gemini's
    // contract). Double-wrapping it made the model retry the tool in a loop.
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
