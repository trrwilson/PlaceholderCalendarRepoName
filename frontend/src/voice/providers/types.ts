// The application-level conversational-voice contract.
//
// `useVoiceSession` (the turn state machine, mic endpointing, jitter buffer,
// watchdog, wake-word wiring) depends only on this — never on a provider's wire
// protocol. Each bake-off contestant implements `ConversationalVoiceProvider`
// and translates its own protocol to/from the `VoiceEvent` union below. A future
// Local / Hybrid path implements the same interface without speaking any cloud
// protocol. See docs/voice-provider-bakeoff-plan.md.

import type { VoiceTimeline } from '../instrument'
import type { VoiceErrorKind } from '../types'

/** The canonical, provider-neutral events of one conversational turn. */
export type VoiceEvent =
  | { type: 'open' }
  | { type: 'user-transcript'; text: string; final: boolean }
  | { type: 'assistant-transcript'; text: string }
  | { type: 'audio'; data: string }
  | { type: 'tool-call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'turn-complete' }
  | { type: 'generation-complete' }
  | { type: 'waiting-for-input' }
  | { type: 'interrupted' }
  | { type: 'closing' }
  | { type: 'error'; kind: VoiceErrorKind; error: Error }

/**
 * The session grant from `POST /api/voice/token` (backend `VoiceToken`). `token`
 * is a Gemini ephemeral token for `provider: 'gemini'` and a single-use relay
 * ticket for the Azure providers; `provider` selects the client implementation.
 */
export interface VoiceGrant {
  provider: string
  token: string
  model: string
  expires_at: string
  /** Gemini: the API version the Live socket must open on. */
  api_version?: string
  /** True when the kiosk owns the turn boundary (activityStart/activityEnd). */
  manual_activity?: boolean
}

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

/**
 * One conversational voice provider for one kiosk turn.
 *
 * `connect()` obtains the session grant from `POST /api/voice/token` and opens
 * the provider's transport (direct to the provider, or to our relay), emitting
 * `{ type: 'open' }` when ready. `startActivity` / `endActivity` bracket the
 * user's turn where the provider needs it (a no-op where server VAD owns the
 * boundary). Everything the model produces arrives through the `onEvent`
 * callback passed at construction.
 */
export interface ConversationalVoiceProvider {
  readonly timeline: VoiceTimeline
  /** Sample rate the mic must downsample to for {@link sendAudio} (Hz). */
  readonly inputSampleRate: number
  connect(): Promise<void>
  startActivity(): void
  endActivity(): void
  sendAudio(base64Pcm16: string): void
  respondTool(id: string, name: string, response: Record<string, unknown>): void
  close(): void
}
