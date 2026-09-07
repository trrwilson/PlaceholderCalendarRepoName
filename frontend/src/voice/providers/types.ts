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

/**
 * Who detects end-of-speech for a turn (negotiated per provider, carried on the
 * grant). Drives how `useVoiceSession` runs its turn state machine — see the
 * header comment there and docs/voice-provider-bakeoff-plan.md.
 *
 * - `client`   the shared mic-RMS silence detector (+ `MAX_LISTEN_MS`, + Stop
 *              tap) is the whole endpointer; the client brackets the turn with
 *              explicit activity markers. The default / fallback.
 * - `hybrid`   the provider VAD runs (streaming ASR / echo canceller) and emits
 *              `speech-started` / `speech-stopped`; the client endpoints on
 *              `speech-stopped` with the mic-RMS check as a longer-hold backstop,
 *              and still sends a finalise marker.
 * - `provider` the provider owns end-of-speech *and* the response trigger; the
 *              client runs no mic-RMS endpointing (only the safety cap + tap) and
 *              sends no finalise marker.
 */
export type EndpointingMode = 'client' | 'hybrid' | 'provider'

/** The canonical, provider-neutral events of one conversational turn. */
export type VoiceEvent =
  | { type: 'open' }
  // The provider's own VAD heard the user start / stop speaking (`endpointing`
  // `hybrid` or `provider`). In `hybrid` mode `speech-stopped` is the primary
  // end-of-turn signal and the `useVoiceSession` mic-level check is the backstop;
  // in `client` mode these never arrive. See EndpointingMode.
  | { type: 'speech-started' }
  | { type: 'speech-stopped' }
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
  // Local / Hybrid pipeline only — additive, ignored by the cloud providers.
  // `diagnostic` carries the interpretation trace (STT text, intent scores,
  // entity candidates, timings); `escalation` marks a request the local layer
  // handed off (Tier 2 or unknown) with the structured context a cloud text
  // model would need. See providers/local.ts and docs/local-voice-plan.md.
  | { type: 'diagnostic'; stage: string; data: Record<string, unknown> }
  | { type: 'escalation'; reason: string; tier: number; payload: Record<string, unknown> }

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
  /** Who detects end-of-speech for a turn (see {@link EndpointingMode}).
   * Absent ⇒ `'client'` (the shared mic-RMS endpointer, kiosk brackets the turn). */
  endpointing?: EndpointingMode
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
 * user's turn according to {@link endpointing}: both fire in `'client'` mode;
 * `endActivity` alone finalises in `'hybrid'` mode; both are no-ops in
 * `'provider'` mode (the provider's VAD owns the boundary). Everything the model
 * produces arrives through the `onEvent` callback passed at construction.
 */
export interface ConversationalVoiceProvider {
  readonly timeline: VoiceTimeline
  /** Sample rate the mic must downsample to for {@link sendAudio} (Hz). */
  readonly inputSampleRate: number
  /** Who detects end-of-speech — drives the {@link useVoiceSession} turn state
   * machine. Read from the grant (`'client'` when the grant omits it). */
  readonly endpointing: EndpointingMode
  /**
   * Sample rate of the PCM16 in `{ type: 'audio' }` events (Hz). Playing a
   * stream at the wrong rate pitches and paces the reply wrongly, so this is a
   * property of the provider rather than a global constant in `AudioSink`.
   * Providers that never send audio (the local pipeline answers as text) still
   * declare one; it is simply unused.
   */
  readonly outputSampleRate: number
  connect(): Promise<void>
  startActivity(): void
  endActivity(): void
  sendAudio(base64Pcm16: string): void
  respondTool(id: string, name: string, response: Record<string, unknown>): void
  close(): void
}
