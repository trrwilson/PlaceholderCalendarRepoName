// Thin wrapper around a single Gemini Live API turn: fetch a constrained
// ephemeral token from our backend, open the session directly to Google, and
// surface a small set of typed events. The API key never reaches the browser.

import type { LiveServerMessage, Session } from '@google/genai'

import { VoiceTimeline } from './instrument'
import type { VoiceErrorKind } from './types'

export type VoiceEvent =
  | { type: 'open' }
  | { type: 'user-transcript'; text: string; final: boolean }
  | { type: 'assistant-transcript'; text: string }
  | { type: 'audio'; data: string }
  | { type: 'tool-call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'turn-complete' }
  | { type: 'interrupted' }
  | { type: 'closing' }
  | { type: 'error'; kind: VoiceErrorKind; error: Error }

/** Raised when the backend reports voice is switched off or misconfigured (HTTP 409). */
export class VoiceUnavailableError extends Error {}

/** A connect-time failure, tagged with where it broke. */
export class VoiceSessionError extends Error {
  readonly kind: VoiceErrorKind
  constructor(kind: VoiceErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

type TokenResponse = { token: string; model: string; expires_at: string }

/** Local wall-clock time as `YYYY-MM-DDTHH:mm:ss` with no timezone offset. */
function localIsoNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

export class GeminiVoiceSession {
  private session: Session | null = null
  private firstAudioChunk = true
  private firstAudioSent = true
  private firstInterim = true
  private firstFinalInput = true
  private firstOutputTranscript = true
  private audioChunks = 0
  private audioBytes = 0
  private readonly apiBaseUrl: string
  private readonly onEvent: (event: VoiceEvent) => void
  private readonly surface: string | null
  readonly timeline: VoiceTimeline

  constructor(
    apiBaseUrl: string,
    onEvent: (event: VoiceEvent) => void,
    surface: string | null = null,
    timeline: VoiceTimeline = new VoiceTimeline(),
  ) {
    this.apiBaseUrl = apiBaseUrl
    this.onEvent = onEvent
    this.surface = surface
    this.timeline = timeline
  }

  async connect(): Promise<void> {
    let response: Response
    this.timeline.mark('token-request')
    try {
      response = await fetch(`${this.apiBaseUrl}/api/voice/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          surface: this.surface,
          // The backend may run in UTC; the assistant's "today" must be the
          // kiosk's local day. Send local wall-clock time (no offset) plus the
          // zone name as a label.
          client_time: localIsoNow(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
    } catch {
      throw new VoiceSessionError('network', 'Could not reach the voice service.')
    }
    if (response.status === 409) {
      const detail = (await response.json().catch(() => ({}))).detail
      throw new VoiceUnavailableError(detail ?? 'voice support is unavailable')
    }
    if (!response.ok) {
      throw new VoiceSessionError('network', `Voice token request failed (${response.status}).`)
    }
    const { token, model }: TokenResponse = await response.json()
    this.timeline.mark('token-received', { model })

    let GoogleGenAI: typeof import('@google/genai').GoogleGenAI
    try {
      // Loaded on demand so the SDK stays out of the kiosk's initial bundle.
      ;({ GoogleGenAI } = await import('@google/genai'))
    } catch {
      throw new VoiceSessionError('network', 'Could not load the voice engine.')
    }
    this.timeline.mark('sdk-loaded')

    // Ephemeral tokens are only accepted on v1alpha (the SDK warns otherwise),
    // and this must match the version the backend minted the token with.
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } })
    try {
      this.session = await ai.live.connect({
        model,
        // Model, tools, voice, and transcription are locked into the token. The
        // ephemeral-token constraint appears to drop `realtimeInputConfig`, so
        // disable the service VAD here too — the kiosk drives the turn with
        // explicit activityStart / activityEnd.
        config: { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } },
        callbacks: {
          onopen: () => {
            this.timeline.mark('live-open')
            this.onEvent({ type: 'open' })
          },
          onmessage: (message) => this.handle(message),
          onerror: (event) =>
            this.onEvent({ type: 'error', kind: 'session', error: toError(event) }),
          onclose: (event) => {
            const code = (event as { code?: number })?.code
            const reason = (event as { reason?: string })?.reason
            this.timeline.mark('live-close', { reason, code })
            // 1000 (normal) and 1005 (no status) are clean end-of-turn closes.
            // Anything else — protocol error, policy violation — is a failure the
            // person should see, not a turn that silently vanishes.
            if (code && code !== 1000 && code !== 1005) {
              this.onEvent({
                type: 'error',
                kind: 'session',
                error: new Error(reason || `Voice session closed (${code}).`),
              })
            } else {
              this.onEvent({ type: 'closing' })
            }
          },
        },
      })
      this.timeline.mark('live-connected')
    } catch (cause) {
      throw new VoiceSessionError('session', toError(cause).message)
    }
  }

  private handle(message: LiveServerMessage): void {
    const content = message.serverContent

    // Full visibility into what the server actually sends. The "furnishes audio
    // but nothing plays / nothing comes back" reports need to be able to tell
    // "the model sent text", "the model sent nothing", and "the server errored"
    // apart, so log every message shape we do not otherwise act on.
    if (message.setupComplete) this.timeline.mark('setup-complete')
    if (message.usageMetadata) {
      this.timeline.mark('usage', {
        promptTokens: message.usageMetadata.promptTokenCount,
        responseTokens: message.usageMetadata.responseTokenCount,
        totalTokens: message.usageMetadata.totalTokenCount,
      })
    }
    if (message.toolCallCancellation) {
      this.timeline.mark('tool-call-cancelled', { ids: message.toolCallCancellation.ids })
    }
    if (content?.generationComplete) this.timeline.mark('generation-complete')
    if (content?.turnCompleteReason) {
      this.timeline.mark('turn-complete-reason', { reason: String(content.turnCompleteReason) })
    }
    const promptFeedback = (content as { promptFeedback?: unknown })?.promptFeedback
    if (promptFeedback) {
      this.timeline.mark('prompt-feedback', { promptFeedback: JSON.stringify(promptFeedback) })
    }
    // Gemini Live streams transcription as ordered fragments that already carry
    // their own whitespace (VERBATIM mode). They must be concatenated as-is —
    // trimming a fragment and re-guessing the separator is what turned
    // "What's tomorrow?" into "What 's to morrow?". The consumer just appends.
    if (content?.interimInputTranscription?.text) {
      if (this.firstInterim) {
        this.firstInterim = false
        this.timeline.mark('interim-transcript-first')
      }
      this.onEvent({ type: 'user-transcript', text: content.interimInputTranscription.text, final: false })
    }
    if (content?.inputTranscription?.text) {
      if (this.firstFinalInput) {
        this.firstFinalInput = false
        this.timeline.mark('input-transcript-first')
      }
      this.onEvent({ type: 'user-transcript', text: content.inputTranscription.text, final: true })
    }
    if (content?.outputTranscription?.text) {
      if (this.firstOutputTranscript) {
        this.firstOutputTranscript = false
        this.timeline.mark('output-transcript-first')
      }
      this.onEvent({ type: 'assistant-transcript', text: content.outputTranscription.text })
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) {
        this.audioChunks += 1
        this.audioBytes += part.inlineData.data.length
        if (this.firstAudioChunk) {
          this.firstAudioChunk = false
          this.timeline.mark('audio-first-chunk', { mimeType: part.inlineData.mimeType })
        }
        this.onEvent({ type: 'audio', data: part.inlineData.data })
      } else if (typeof part.text === 'string' && part.text) {
        // Text parts from a native-audio model are the model's thinking trace,
        // not the spoken reply — the reply is `outputTranscription`. Log the
        // size but do NOT show it (it was rendering pages of reasoning text).
        this.timeline.mark('model-text-part', { chars: part.text.length, thought: part.thought === true })
      } else {
        this.timeline.mark('model-other-part', { keys: Object.keys(part).join(',') })
      }
    }
    if (content?.interrupted) {
      this.timeline.mark('interrupted', { audioChunks: this.audioChunks })
      this.onEvent({ type: 'interrupted' })
    }
    if (content?.turnComplete) {
      this.timeline.mark('turn-complete', {
        audioChunks: this.audioChunks,
        audioKB: Math.round(this.audioBytes / 1024),
      })
      this.onEvent({ type: 'turn-complete' })
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      this.timeline.mark('tool-call', {
        name: call.name,
        id: call.id ?? '(none)',
        args: JSON.stringify(call.args ?? {}),
      })
      this.onEvent({
        type: 'tool-call',
        id: call.id ?? call.name ?? '',
        name: call.name ?? '',
        args: (call.args as Record<string, unknown>) ?? {},
      })
    }
    if (message.goAway) {
      this.timeline.mark('go-away', { timeLeft: message.goAway.timeLeft })
      this.onEvent({ type: 'closing' })
    }

    // Anything that reached here without touching a branch above is a message
    // shape we are not handling — log its top-level keys so we can see it.
    const handled =
      message.setupComplete ||
      message.usageMetadata ||
      message.toolCall ||
      message.toolCallCancellation ||
      message.goAway ||
      content?.modelTurn ||
      content?.inputTranscription ||
      content?.interimInputTranscription ||
      content?.outputTranscription ||
      content?.turnComplete ||
      content?.generationComplete ||
      content?.interrupted
    if (!handled) {
      this.timeline.mark('unhandled-message', {
        messageKeys: Object.keys(message).join(','),
        contentKeys: content ? Object.keys(content).join(',') : '(no serverContent)',
      })
    }
  }

  /**
   * Manual activity detection: the token disables the service VAD, so we bracket
   * the user's turn explicitly. `startActivity` before the first audio frame,
   * `endActivity` when our client-side silence detection fires. This is the
   * deterministic push-to-talk path — automatic VAD + a late `audioStreamEnd`
   * was leaving turns that never produced a transcript or a response.
   */
  startActivity(): void {
    this.timeline.mark('activity-start')
    this.session?.sendRealtimeInput({ activityStart: {} })
  }

  endActivity(): void {
    this.timeline.mark('activity-end')
    this.session?.sendRealtimeInput({ activityEnd: {} })
  }

  sendAudio(base64: string): void {
    if (this.firstAudioSent) {
      this.firstAudioSent = false
      this.timeline.mark('mic-first-chunk-sent')
    }
    this.session?.sendRealtimeInput({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } })
  }

  respondTool(id: string, name: string, response: Record<string, unknown>): void {
    this.timeline.mark('tool-response', { name })
    this.session?.sendToolResponse({ functionResponses: [{ id, name, response }] })
  }

  close(): void {
    try {
      this.session?.close()
    } catch {
      // best effort
    }
    this.session = null
  }
}

function toError(event: unknown): Error {
  if (event instanceof Error) return event
  const message = (event as { message?: string })?.message
  return new Error(message ?? 'The voice connection failed.')
}
