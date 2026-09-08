// Gemini Live provider: open the Live session directly to Google with the
// backend-minted ephemeral token in the grant, and translate `LiveServerMessage`s
// to the neutral `VoiceEvent` union. The Gemini API key never reaches the
// browser. The on-kiosk debugging record for this path is in
// docs/voice-support-plan.md.

import type { LiveServerMessage, Session } from '@google/genai'

import { VoiceTimeline } from '../instrument'
import {
  type ConversationalVoiceProvider,
  type EndpointingMode,
  type VoiceEvent,
  type VoiceGrant,
  VoiceSessionError,
} from './types'

export class GeminiVoiceProvider implements ConversationalVoiceProvider {
  readonly inputSampleRate = 16_000
  // Gemini Live streams 24 kHz mono PCM16 back.
  readonly outputSampleRate = 24_000
  readonly endpointing: EndpointingMode
  private session: Session | null = null
  private firstAudioChunk = true
  private firstAudioSent = true
  private firstInterim = true
  private firstFinalInput = true
  private firstOutputTranscript = true
  // The user transcript is assembled here, not in `useVoiceSession`, so the
  // consumer only ever sees the whole best-so-far string (each `user-transcript`
  // event carries the full text, not a fragment). Gemini Live streams
  // `inputTranscription` as ordered VERBATIM fragments that already carry their
  // own whitespace, so settled text is a plain concatenation; the unstable
  // `interimInputTranscription` preview (rare on the conversational models) is
  // shown appended until the first settled fragment lands, then dropped.
  private userFinal = ''
  private userInterim = ''
  private audioChunks = 0
  private audioBytes = 0
  private readonly grant: VoiceGrant
  private readonly onEvent: (event: VoiceEvent) => void
  readonly timeline: VoiceTimeline

  constructor(
    grant: VoiceGrant,
    onEvent: (event: VoiceEvent) => void,
    timeline: VoiceTimeline = new VoiceTimeline(),
  ) {
    this.grant = grant
    this.onEvent = onEvent
    this.timeline = timeline
    this.endpointing = grant.endpointing ?? 'client'
  }

  /** `client` end-of-speech: the service VAD is off and the kiosk brackets the
   * turn with activityStart/activityEnd. `hybrid`: the service VAD runs and the
   * kiosk sends `audioStreamEnd` on its own silence detection. `provider`: the
   * service VAD owns the whole boundary; the kiosk sends neither. */
  private get manualActivity(): boolean {
    return this.endpointing === 'client'
  }

  async connect(): Promise<void> {
    const token = this.grant.token
    const model = this.grant.model
    const apiVersion = this.grant.api_version ?? 'v1beta'

    let GoogleGenAI: typeof import('@google/genai').GoogleGenAI
    try {
      // Loaded on demand so the SDK stays out of the kiosk's initial bundle.
      ;({ GoogleGenAI } = await import('@google/genai'))
    } catch {
      throw new VoiceSessionError('network', 'Could not load the voice engine.')
    }
    this.timeline.mark('sdk-loaded')

    // This MUST match the version the backend minted the token with — a mismatch
    // surfaces as `code 1008 "... not found for API version ..."` — so it comes
    // back on the token response rather than being hard-coded here.
    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion } })
    try {
      this.session = await ai.live.connect({
        model,
        // Model, tools, voice, transcription and VAD are all locked into the
        // token. The ephemeral-token constraint appeared to drop
        // `realtimeInputConfig`, so `client` end-of-speech repeats the "VAD off"
        // here; `hybrid` / `provider` send nothing and let the token's
        // service-VAD settings stand.
        config: this.manualActivity
          ? { realtimeInputConfig: { automaticActivityDetection: { disabled: true } } }
          : {},
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
    // "The model is done generating." Distinct from `turnComplete`, which the
    // server holds back until it believes playback has finished — and which, on
    // a reply delivered at a quarter of real time, may never arrive before our
    // watchdog gives up. This is the reliable end-of-audio signal.
    if (content?.generationComplete) {
      this.timeline.mark('generation-complete')
      this.onEvent({ type: 'generation-complete' })
    }
    // The server is telling us it has nothing to answer and expects more audio —
    // an empty turn, typically because the service VAD heard no speech in it.
    // Left unhandled this is indistinguishable from a stalled model and burns
    // the whole response watchdog before failing.
    if (content?.waitingForInput) {
      this.timeline.mark('waiting-for-input')
      this.onEvent({ type: 'waiting-for-input' })
    }
    // Not something we act on yet, but it is a normal keep-alive on a healthy
    // session — logging it as "unhandled" made a working session look broken.
    if (message.voiceActivity) {
      this.timeline.mark('voice-activity', {
        type: String(message.voiceActivity.voiceActivityType ?? ''),
      })
    }
    if (message.sessionResumptionUpdate) {
      this.timeline.mark('session-resumption-update', {
        resumable: message.sessionResumptionUpdate.resumable === true,
      })
    }
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
      // Preview only, and only until settled text starts arriving.
      if (!this.userFinal) {
        this.userInterim += content.interimInputTranscription.text
        this.onEvent({ type: 'user-transcript', text: this.userInterim, final: false })
      }
    }
    if (content?.inputTranscription?.text) {
      if (this.firstFinalInput) {
        this.firstFinalInput = false
        this.timeline.mark('input-transcript-first')
      }
      this.userFinal += content.inputTranscription.text
      this.userInterim = ''
      this.onEvent({ type: 'user-transcript', text: this.userFinal, final: true })
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
      message.sessionResumptionUpdate ||
      message.voiceActivity ||
      content?.waitingForInput ||
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
   * Open the user's turn — see {@link endpointing}.
   *
   * `client`: the token has the service VAD switched off and we bracket the turn
   * ourselves with activityStart/activityEnd. Deterministic, but it also stops
   * the service transcribing incrementally — it buffers the whole utterance and
   * only runs ASR once `activityEnd` lands, which is where the multi-second
   * post-utterance stall came from.
   *
   * `hybrid` (the default): the service VAD is on and already has a streaming
   * recogniser running under the audio, so there is nothing to open —
   * `startActivity` is a no-op and {@link endActivity} sends `audioStreamEnd`,
   * which flushes cached audio and finalises the turn immediately rather than
   * waiting out the server's silence timer.
   *
   * `provider`: the service VAD owns the whole boundary; both are no-ops.
   */
  startActivity(): void {
    if (this.endpointing !== 'client') return
    this.timeline.mark('activity-start')
    this.session?.sendRealtimeInput({ activityStart: {} })
  }

  endActivity(): void {
    if (this.endpointing === 'provider') return
    if (this.endpointing === 'client') {
      this.timeline.mark('activity-end')
      this.session?.sendRealtimeInput({ activityEnd: {} })
      return
    }
    this.timeline.mark('audio-stream-end')
    this.session?.sendRealtimeInput({ audioStreamEnd: true })
  }

  sendAudio(base64: string): void {
    if (this.firstAudioSent) {
      this.firstAudioSent = false
      this.timeline.mark('mic-first-chunk-sent')
    }
    this.session?.sendRealtimeInput({ audio: { data: base64, mimeType: 'audio/pcm;rate=16000' } })
  }

  respondTool(id: string, name: string, result: Record<string, unknown>): void {
    this.timeline.mark('tool-response', { name })
    // Gemini's FunctionResponse contract: `{ output }` for a result, `{ error }`
    // for a failure (a dispatch result carrying `ok: false`).
    const response =
      result && result.ok === false
        ? { error: String(result.error ?? 'tool failed') }
        : { output: result }
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
