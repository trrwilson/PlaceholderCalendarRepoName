// The wake-word detector seam.
//
// A detector answers exactly one question — "did someone just say the wake
// phrase?" — and nothing about what they want. It never talks to Gemini, never
// dispatches a tool, never touches the transcript. On detection it calls back;
// `useVoiceSession` decides what to do (open a turn, exactly as the Ask button
// does).
//
// Two real back ends spot the phrase: `OpenWakeWordDetector` (local ONNX in the
// browser) and `AzureKeywordDetector` (backend `.table`). Independent of that
// choice, the on-device **Invoke gate** can be layered *in front*: when it is
// enabled, `createWakeDetector` wraps whichever base detector is selected in a
// `GatedWakeDetector` that only lets it fire during a gate-open window. A fake
// implementation drives tests and the on-screen "simulate wake" developer
// control. Everything here is mockable the same way `./session` and `./audio`
// are.

import type { MicSource } from '../audio'
import { AzureKeywordDetector } from './azureKeyword'
import { FakeWakeDetector } from './fakeDetector'
import { GatedWakeDetector } from './gatedDetector'
import { OpenWakeWordDetector } from './openWakeWord'

/** Which detection back end spots the phrase (backend `WakeProviderId`). */
export type WakeProviderId = 'openwakeword' | 'azure'

/** One selectable detection back end, mirrors the backend `WakeProviderInfo`. */
export interface WakeProviderInfo {
  id: WakeProviderId
  label: string
  implemented: boolean
  configured: boolean
}

export interface WakeDetectorConfig {
  /** Which detection back end to build. */
  provider: WakeProviderId
  /** API base URL — `azure` and the Invoke-gate bridge need it to open a backend socket. */
  apiBaseUrl: string
  /** Frontend-served URL of the trained wake model (e.g. `/models/wake/mission_control.onnx`). */
  modelPath: string
  /** Base URL for the shared openWakeWord feature models (melspectrogram, embedding). */
  modelsBaseUrl: string
  /** Score in [0, 1] above which a frame counts as the wake phrase. */
  threshold: number
  /** Ignore further detections for this long after one fires. */
  cooldownMs: number
  /**
   * Layer the on-device Invoke gate in front of the selected detector: the
   * Invoke gates its audio egress and this end only activates when the gate
   * window *and* the base detector both accept. Default off.
   */
  invokeGateEnabled?: boolean
}

export interface WakeEvent {
  /** The detector score that crossed the threshold. */
  score: number
  /** `performance.now()` at detection — the zero point for activation latency. */
  at: number
}

export interface WakeDetector {
  /**
   * Load the model, acquire the shared microphone, and begin listening.
   * Rejects with `WakeUnavailableError` if the model, the runtime, or the
   * microphone is not available — the caller then leaves wake word off and
   * push-to-talk entirely unaffected.
   */
  start(handlers: {
    onWake: (event: WakeEvent) => void
    onScore?: (score: number) => void
    onError?: (error: Error) => void
  }): Promise<void>
  /** Pause detection (a voice turn is running / the assistant is speaking) but keep the model warm. */
  suspend(): void
  /**
   * Resume after `suspend()`. `resetCooldown: false` (used by the gate wrapper
   * on each OPEN edge) keeps the existing post-fire cooldown instead of
   * restarting it — the gate has already de-bounced the candidate.
   */
  resume(opts?: { resetCooldown?: boolean }): void
  /**
   * The run-up to and start of the command around the last wake event, as base64
   * PCM16 chunks at `targetRate` Hz (the provider's input rate — 16 kHz Gemini,
   * 24 kHz the Azure relay), to flush into the session so the start of the
   * command is not lost. Empties the retained buffer.
   */
  takeRetainedAudio(targetRate?: number): string[]
  /** Fully tear down: release the microphone, drop the model. */
  dispose(): void
  /**
   * An activated turn has ended (completed, abandoned, or failed). No-op unless
   * the Invoke gate is layered on, in which case it tells the gate the turn is
   * over (`{cmd:"done"}`) so the Invoke returns to OFF.
   */
  endActivation?(): void
  /**
   * Forward a raw control command to the Invoke gate. Used by the Ask button for
   * push-to-talk (`ptt_start` / `ptt_stop`) and for a `hold` lease while the
   * assistant is speaking. No-op unless the gate is layered on.
   */
  sendControl?(cmd: string, fields?: Record<string, unknown>): void
  readonly running: boolean
  readonly suspended: boolean
}

/** The detector cannot run (no model, no ONNX runtime, no microphone, decode failure). */
export class WakeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WakeUnavailableError'
  }
}

/**
 * Build the detector for the current config. `VITE_WAKE_FAKE=1` swaps in a
 * mic-free fake that exposes `window.__missionControlWake.fireWake()` — used by
 * the Playwright wake test and handy for manual UI work without a trained model.
 *
 * `openwakeword` runs local ONNX keyword spotting entirely in this browser;
 * `azure` streams mic audio to `WS /api/voice/wake/azure`, where the backend
 * spots an Azure custom-keyword `.table` offline. When `invokeGateEnabled` is
 * set, the chosen base detector is wrapped in a `GatedWakeDetector` driven by
 * `WS /api/voice/wake/invoke` (see `gatedDetector.ts` and
 * `backend/app/voice/wake_invoke.py`).
 */
export function createWakeDetector(
  config: WakeDetectorConfig,
  micSource: MicSource,
): WakeDetector {
  if (import.meta.env.VITE_WAKE_FAKE === '1') {
    return new FakeWakeDetector(config)
  }
  const base: WakeDetector =
    config.provider === 'azure'
      ? new AzureKeywordDetector(config, micSource)
      : new OpenWakeWordDetector(config, micSource)
  if (config.invokeGateEnabled) {
    return new GatedWakeDetector(config, base)
  }
  return base
}
