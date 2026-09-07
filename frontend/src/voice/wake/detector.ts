// The wake-word detector seam.
//
// A detector answers exactly one question — "did someone just say the wake
// phrase?" — and nothing about what they want. It never talks to Gemini, never
// dispatches a tool, never touches the transcript. On detection it calls back;
// `useVoiceSession` decides what to do (open a turn, exactly as the Ask button
// does).
//
// The only real implementation today is `OpenWakeWordDetector` (local ONNX
// keyword spotting in the browser). A fake implementation drives tests and the
// on-screen "simulate wake" developer control. Everything here is mockable the
// same way `./session` and `./audio` are.

import type { MicSource } from '../audio'
import { OpenWakeWordDetector } from './openWakeWord'
import { FakeWakeDetector } from './fakeDetector'

export interface WakeDetectorConfig {
  /** Frontend-served URL of the trained wake model (e.g. `/models/wake/mission_control.onnx`). */
  modelPath: string
  /** Base URL for the shared openWakeWord feature models (melspectrogram, embedding). */
  modelsBaseUrl: string
  /** Score in [0, 1] above which a frame counts as the wake phrase. */
  threshold: number
  /** Ignore further detections for this long after one fires. */
  cooldownMs: number
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
  /** Resume after `suspend()`. */
  resume(): void
  /**
   * The run-up to and start of the command around the last wake event, as base64
   * PCM16 chunks at `targetRate` Hz (the provider's input rate — 16 kHz Gemini,
   * 24 kHz the Azure relay), to flush into the session so the start of the
   * command is not lost. Empties the retained buffer.
   */
  takeRetainedAudio(targetRate?: number): string[]
  /** Fully tear down: release the microphone, drop the model. */
  dispose(): void
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
 * Build the configured detector. `VITE_WAKE_FAKE=1` swaps in a mic-free fake that
 * exposes `window.__missionControlWake.fireWake()` — used by the Playwright wake
 * test and handy for manual UI work without a trained model.
 */
export function createWakeDetector(
  config: WakeDetectorConfig,
  micSource: MicSource,
): WakeDetector {
  if (import.meta.env.VITE_WAKE_FAKE === '1') {
    return new FakeWakeDetector(config)
  }
  return new OpenWakeWordDetector(config, micSource)
}
