// Local wake-word detection with openWakeWord's ONNX models, running in the
// kiosk browser. No audio leaves the machine for wake detection — only the voice
// turn that the wake phrase opens reaches Gemini.
//
// Pipeline (openWakeWord, https://github.com/dscripka/openWakeWord, Apache-2.0):
//
//   16 kHz mono audio
//     → melspectrogram.onnx   (shared)   80 ms hop → mel frames [.,32]
//     → embedding_model.onnx  (shared)   76 mel frames → speech embedding [96]
//     → <phrase>.onnx         (trained)  last 16 embeddings → score [0,1]
//
// The two shared feature models are the same for every phrase; only the small
// final model is trained per phrase (see docs/wake-word-model-training.md for
// how the "Mission Control" model is produced and its licensing/provenance).
//
// ── Status ────────────────────────────────────────────────────────────────
// The audio plumbing (shared-mic subscription, anti-aliased downsample, framing,
// pre-roll retention, cooldown, suspend/resume) is complete and unit-tested via
// the detector seam. `onnxruntime-web` is now a dependency and the model assets
// are provisioned (see docs/wake-word-model-training-notes.md), so `start()`
// loads for real. The ONNX feature maths below is implemented to openWakeWord's
// documented tensor shapes but has NOT been validated end-to-end against the real
// models on hardware — the frame lookback and mel windowing (`OWW` constants) in
// particular are expected to need tuning during on-device bring-up. Watch the
// throttled `[wake] peak score` console line while speaking the phrase to calibrate
// `MISSION_CONTROL_WAKE_WORD_THRESHOLD`. If any asset is missing `start()` rejects
// with `WakeUnavailableError` and the kiosk falls back to push-to-talk cleanly.

import type { MicSource, MicSubscription } from '../audio'
import type { WakeDetector, WakeDetectorConfig, WakeEvent } from './detector'
import { WakeUnavailableError } from './detector'
import {
  AudioRingBuffer,
  downsampleTo16k,
  floatToPcm16Base64,
  resampleFrom16k,
  WAKE_SAMPLE_RATE,
} from './ringBuffer'

/** openWakeWord model geometry — see the project's `AudioFeatures` implementation. */
const OWW = {
  /** Detector step: 80 ms of 16 kHz audio. */
  frameSamples: 1280,
  /** Mel bands per frame. */
  melBins: 32,
  /** Mel frames the embedding model consumes. */
  melWindow: 76,
  /** Mel frames produced per 80 ms step (≈ 8). */
  melPerStep: 8,
  /** Speech-embedding dimensionality. */
  embeddingDim: 96,
  /** Embeddings the wake model consumes. */
  wakeWindow: 16,
  /** Audio lookback fed to the melspectrogram each step, in 80 ms frames. */
  melLookbackFrames: 4,
} as const

/** Seconds of audio retained for pre-roll around an activation. */
const PREROLL_SECONDS = 4

// A deliberately small structural view of the onnxruntime-web surface we use, so
// this file type-checks without the optional dependency installed.
interface OrtTensor {
  data: Float32Array
  dims: readonly number[]
}
interface OrtSession {
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
  inputNames: string[]
  outputNames: string[]
}
interface OrtRuntime {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>
  }
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => OrtTensor
  env: {
    wasm: {
      wasmPaths?: string | Record<string, string>
      numThreads?: number
      proxy?: boolean
    }
  }
}

async function loadOrt(): Promise<OrtRuntime> {
  // `/wasm` is the wasm-only backend (no WebGL/WebGPU we don't use). It is kept
  // out of Vite's dep pre-bundle (`optimizeDeps.exclude` in vite.config) so that
  // onnxruntime-web resolves its own sibling `.wasm` / `.mjs` via `import.meta.url`
  // — served same-origin from node_modules in dev, fingerprinted into the build.
  // No CDN, so CSP + offline hold. `numThreads = 1` avoids the cross-origin
  // isolation (COOP/COEP) a threaded pool would require.
  try {
    const mod = (await import('onnxruntime-web/wasm')) as unknown as
      | OrtRuntime
      | { default: OrtRuntime }
    const ort = 'InferenceSession' in mod ? mod : mod.default
    ort.env.wasm.numThreads = 1
    return ort
  } catch (cause) {
    console.error('[wake] failed to load onnxruntime-web:', cause)
    throw new WakeUnavailableError(`onnxruntime-web failed to load (${String(cause)})`)
  }
}

async function createSession(ort: OrtRuntime, url: string): Promise<OrtSession> {
  try {
    const head = await fetch(url, { method: 'HEAD' })
    if (!head.ok) throw new Error(`HTTP ${head.status}`)
  } catch (cause) {
    throw new WakeUnavailableError(`wake model asset ${url} is missing (${String(cause)})`)
  }
  try {
    return await ort.InferenceSession.create(url, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  } catch (cause) {
    throw new WakeUnavailableError(`could not load ${url}: ${String(cause)}`)
  }
}

export class OpenWakeWordDetector implements WakeDetector {
  running = false
  suspended = false

  private ort: OrtRuntime | null = null
  private melModel: OrtSession | null = null
  private embModel: OrtSession | null = null
  private wakeModel: OrtSession | null = null

  private sub: MicSubscription | null = null
  private handlers: Parameters<WakeDetector['start']>[0] | null = null

  private pending = new Float32Array(0)
  private audioWindow: number[] = []
  private melBuffer: number[] = [] // flattened [frames * melBins]
  private embBuffer: number[] = [] // flattened [n * embeddingDim]
  private lastFireAt = 0
  private fireAt = 0
  private debugPeak = 0
  private lastDebugAt = 0

  /** Rolling capture of recent mic audio, so a wake fire can flush the start of
   * the command (which the person often speaks *through* the wake phrase). */
  private preroll = new AudioRingBuffer(PREROLL_SECONDS)
  private retaining = false

  private readonly config: WakeDetectorConfig
  private readonly micSource: MicSource

  constructor(config: WakeDetectorConfig, micSource: MicSource) {
    this.config = config
    this.micSource = micSource
  }

  async start(handlers: Parameters<WakeDetector['start']>[0]): Promise<void> {
    this.handlers = handlers
    // loadOrt() also pins the wasm artifact URL (Vite-fingerprinted, same-origin).
    this.ort = await loadOrt()

    const base = this.config.modelsBaseUrl.replace(/\/$/, '')
    ;[this.melModel, this.embModel, this.wakeModel] = await Promise.all([
      createSession(this.ort, `${base}/melspectrogram.onnx`),
      createSession(this.ort, `${base}/embedding_model.onnx`),
      createSession(this.ort, this.config.modelPath),
    ])

    try {
      this.sub = await this.micSource.subscribe((frame, sampleRate) => {
        this.onAudio(frame, sampleRate)
      })
    } catch (cause) {
      this.dispose()
      throw new WakeUnavailableError(`microphone unavailable for wake word: ${String(cause)}`)
    }
    this.running = true
    this.retaining = true // capture continuously while armed
  }

  suspend(): void {
    // Stop running detection inference, but KEEP retaining the pre-roll. A turn
    // opens on `connecting` (which suspends us) several seconds before the live
    // mic starts streaming to the provider; the command spoken in that gap —
    // "Mission Control, what's on today" said as one phrase — is only in this
    // ring buffer, and `takeRetainedAudio` is what flushes it into the session.
    this.suspended = true
  }

  resume(): void {
    this.suspended = false
    this.retaining = true
    this.preroll.clear()
    this.pending = new Float32Array(0)
    // Clear the whole feature pipeline: otherwise the wake phrase that opened the
    // *previous* turn is still inside the mel/embedding windows and re-fires the
    // instant we resume, starting a spurious second turn (which the model then
    // answers from thin air).
    this.audioWindow = []
    this.melBuffer = []
    this.embBuffer = []
    this.debugPeak = 0
    // ...and force a fresh cooldown after every turn — the assistant's tail audio
    // can still be echoing in the room.
    this.lastFireAt = performance.now()
  }

  takeRetainedAudio(targetRate: number = WAKE_SAMPLE_RATE): string[] {
    // Read back from a bit before the fire through now: covers the wake phrase
    // itself, detection latency, and the person starting the command early.
    const sinceFire = this.fireAt ? (performance.now() - this.fireAt) / 1000 : 0
    const seconds = Math.min(PREROLL_SECONDS, sinceFire + 1.2)
    let samples = this.preroll.readLast(seconds)
    this.preroll.clear()
    // The turn owns the mic from here; stop filling the ring until `resume()`
    // re-arms us (it clears the ring and sets `retaining` again).
    this.retaining = false
    if (!samples.length) return []
    samples = resampleFrom16k(samples, targetRate)
    // One chunk per ~250 ms keeps each payload small.
    const chunkSize = Math.round(targetRate / 4)
    const out: string[] = []
    for (let i = 0; i < samples.length; i += chunkSize) {
      out.push(floatToPcm16Base64(samples.subarray(i, i + chunkSize)))
    }
    return out
  }

  dispose(): void {
    this.running = false
    this.suspended = false
    this.retaining = false
    this.sub?.unsubscribe()
    this.sub = null
    this.melModel = this.embModel = this.wakeModel = null
    this.ort = null
    this.handlers = null
    this.preroll.clear()
  }

  private onAudio(frame: Float32Array, sampleRate: number): void {
    if (!this.running) return
    const down = downsampleTo16k(frame, sampleRate)
    if (this.retaining) this.preroll.write(down)
    if (this.suspended) return

    // Append to the pending buffer and consume whole 80 ms frames.
    const merged = new Float32Array(this.pending.length + down.length)
    merged.set(this.pending)
    merged.set(down, this.pending.length)
    let offset = 0
    while (merged.length - offset >= OWW.frameSamples) {
      const frameSlice = merged.subarray(offset, offset + OWW.frameSamples)
      offset += OWW.frameSamples
      void this.processFrame(frameSlice)
    }
    this.pending = merged.slice(offset)
  }

  private async processFrame(frame: Float32Array): Promise<void> {
    if (!this.ort || !this.melModel || !this.embModel || !this.wakeModel) return
    try {
      // Keep a short rolling audio window for the melspectrogram.
      for (let i = 0; i < frame.length; i += 1) this.audioWindow.push(frame[i])
      const maxWindow = OWW.frameSamples * OWW.melLookbackFrames
      if (this.audioWindow.length > maxWindow) {
        this.audioWindow.splice(0, this.audioWindow.length - maxWindow)
      }

      const { Tensor } = this.ort
      const audio = Float32Array.from(this.audioWindow)
      const mel = await this.melModel.run({
        [this.melModel.inputNames[0]]: new Tensor('float32', audio, [1, audio.length]),
      })
      const melOut = mel[this.melModel.outputNames[0]]
      // openWakeWord's documented transform on raw mel output.
      const melFrames = melOut.data.length / OWW.melBins
      for (let f = 0; f < melFrames; f += 1) {
        for (let b = 0; b < OWW.melBins; b += 1) {
          this.melBuffer.push(melOut.data[f * OWW.melBins + b] / 10 + 2)
        }
      }
      // Only the newest step's worth of mel frames is genuinely new; trim.
      const keepMel = (OWW.melWindow + OWW.melPerStep) * OWW.melBins
      if (this.melBuffer.length > keepMel) {
        this.melBuffer.splice(0, this.melBuffer.length - keepMel)
      }
      if (this.melBuffer.length < OWW.melWindow * OWW.melBins) return

      const embIn = Float32Array.from(
        this.melBuffer.slice(this.melBuffer.length - OWW.melWindow * OWW.melBins),
      )
      const emb = await this.embModel.run({
        [this.embModel.inputNames[0]]: new Tensor('float32', embIn, [1, OWW.melWindow, OWW.melBins, 1]),
      })
      const embOut = emb[this.embModel.outputNames[0]]
      for (let i = 0; i < OWW.embeddingDim; i += 1) this.embBuffer.push(embOut.data[i] ?? 0)
      const keepEmb = OWW.wakeWindow * OWW.embeddingDim
      if (this.embBuffer.length > keepEmb) {
        this.embBuffer.splice(0, this.embBuffer.length - keepEmb)
      }
      if (this.embBuffer.length < keepEmb) return

      const wakeIn = Float32Array.from(this.embBuffer)
      const result = await this.wakeModel.run({
        [this.wakeModel.inputNames[0]]: new Tensor('float32', wakeIn, [1, OWW.wakeWindow, OWW.embeddingDim]),
      })
      const score = result[this.wakeModel.outputNames[0]].data[0] ?? 0
      this.handlers?.onScore?.(score)

      const now = performance.now()
      // On-device threshold tuning aid: throttled peak-score log. Disable with
      // localStorage['wake.debug'] = 'off'.
      if (score > this.debugPeak) this.debugPeak = score
      if (now - this.lastDebugAt > 1000) {
        this.lastDebugAt = now
        try {
          if (localStorage.getItem('wake.debug') !== 'off') {
            console.debug(
              `[wake] peak score ${this.debugPeak.toFixed(3)} (fires ≥ ${this.config.threshold})`,
            )
          }
        } catch {
          /* localStorage unavailable */
        }
        this.debugPeak = 0
      }

      if (score >= this.config.threshold && now - this.lastFireAt >= this.config.cooldownMs) {
        this.lastFireAt = now
        this.fireAt = now
        // Keep the rolling buffer — it already holds the run-up to the phrase and
        // the start of the command; `takeRetainedAudio` reads it back with a lead.
        const event: WakeEvent = { score, at: now }
        this.handlers?.onWake(event)
      }
    } catch (cause) {
      // A single bad inference must not kill the detector; a persistent failure
      // surfaces through onError so the UI can show "wake word: error".
      this.handlers?.onError?.(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }
}
