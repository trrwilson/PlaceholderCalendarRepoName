// Thin wrapper around a single Gemini Live API turn: fetch a constrained
// ephemeral token from our backend, open the session directly to Google, and
// surface a small set of typed events. The API key never reaches the browser.

import type { LiveServerMessage, Session } from '@google/genai'

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

export class GeminiVoiceSession {
  private session: Session | null = null
  private readonly apiBaseUrl: string
  private readonly onEvent: (event: VoiceEvent) => void
  private readonly surface: string | null

  constructor(
    apiBaseUrl: string,
    onEvent: (event: VoiceEvent) => void,
    surface: string | null = null,
  ) {
    this.apiBaseUrl = apiBaseUrl
    this.onEvent = onEvent
    this.surface = surface
  }

  async connect(): Promise<void> {
    let response: Response
    try {
      response = await fetch(`${this.apiBaseUrl}/api/voice/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ surface: this.surface }),
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

    let GoogleGenAI: typeof import('@google/genai').GoogleGenAI
    try {
      // Loaded on demand so the SDK stays out of the kiosk's initial bundle.
      ;({ GoogleGenAI } = await import('@google/genai'))
    } catch {
      throw new VoiceSessionError('network', 'Could not load the voice engine.')
    }

    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } })
    try {
      this.session = await ai.live.connect({
        model,
        // Model, tools, voice, and transcription are locked into the token.
        config: {},
        callbacks: {
          onopen: () => this.onEvent({ type: 'open' }),
          onmessage: (message) => this.handle(message),
          onerror: (event) =>
            this.onEvent({ type: 'error', kind: 'session', error: toError(event) }),
          onclose: () => this.onEvent({ type: 'closing' }),
        },
      })
    } catch (cause) {
      throw new VoiceSessionError('session', toError(cause).message)
    }
  }

  private handle(message: LiveServerMessage): void {
    const content = message.serverContent
    if (content?.interimInputTranscription?.text) {
      this.onEvent({ type: 'user-transcript', text: content.interimInputTranscription.text, final: false })
    }
    if (content?.inputTranscription?.text) {
      this.onEvent({ type: 'user-transcript', text: content.inputTranscription.text, final: true })
    }
    if (content?.outputTranscription?.text) {
      this.onEvent({ type: 'assistant-transcript', text: content.outputTranscription.text })
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) this.onEvent({ type: 'audio', data: part.inlineData.data })
    }
    if (content?.interrupted) this.onEvent({ type: 'interrupted' })
    if (content?.turnComplete) this.onEvent({ type: 'turn-complete' })
    for (const call of message.toolCall?.functionCalls ?? []) {
      this.onEvent({
        type: 'tool-call',
        id: call.id ?? call.name ?? '',
        name: call.name ?? '',
        args: (call.args as Record<string, unknown>) ?? {},
      })
    }
    if (message.goAway) this.onEvent({ type: 'closing' })
  }

  startActivity(): void {
    this.session?.sendRealtimeInput({ activityStart: {} })
  }

  endActivity(): void {
    this.session?.sendRealtimeInput({ activityEnd: {} })
  }

  sendAudio(base64: string): void {
    this.session?.sendRealtimeInput({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } })
  }

  respondTool(id: string, name: string, response: Record<string, unknown>): void {
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
