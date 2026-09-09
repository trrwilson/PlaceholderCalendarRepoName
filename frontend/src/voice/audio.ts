// Microphone capture and assistant-audio playback: the device end of the kiosk's
// audio pipeline. `MicSource` owns the one input device and the one gain stage;
// `AudioSink` owns the one output bus. Sample rates are provider properties
// (`ConversationalVoiceProvider.inputSampleRate` / `outputSampleRate`) and are
// passed in — the constants below are only the defaults for a caller that has no
// provider yet. Format/rate conversion lives in `./pcm`, gain in `./gain`,
// echo-cancelled playout in `./aecPlayback`. See docs/audio-pipeline.md.

import { createEchoCancelledOutput, type EchoCancelledOutput } from './aecPlayback'
import { DEFAULT_INPUT_GAIN_DB, InputGain, atReferenceGain, type InputGainStats } from './gain'
import { downsampleTo, floatToPcm16Base64, pcm16Base64ToFloat } from './pcm'
import { speakerOut } from './speakerOut'

/** Default capture rate: Gemini Live's input rate, and the local pipeline's. */
const INPUT_RATE = 16_000
/** Default playback rate: what every provider that sends audio streams today. */
const OUTPUT_RATE = 24_000

/** How often `MicSource` prints its throttled input-level diagnostics. */
const GAIN_LOG_INTERVAL_MS = 2_000

/** Shared with the voice timeline trace: silence both with `voice.trace = 'off'`. */
function traceEnabled(): boolean {
  try {
    return localStorage.getItem('voice.trace') !== 'off'
  } catch {
    return true
  }
}

function round(value: number, places = 3): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** A raw native-rate mono frame from the shared microphone. */
export type MicFrameListener = (frame: Float32Array, sampleRate: number) => void

export interface MicSubscription {
  unsubscribe(): void
}

/**
 * The single owner of the microphone.
 *
 * Push-to-talk and wake-word detection both need the mic, and two independent
 * `getUserMedia` + `AudioContext` stacks on one device is exactly the
 * unreliability the wake-word plan warns about. Instead there is one stream, one
 * `AudioContext`, one capture worklet, and any number of listeners that each get
 * the same native-rate frames and do their own downsampling.
 *
 * Reference-counted: the stream and context come up on the first `subscribe()`
 * and are torn down when the last listener leaves. With wake word off this is
 * per-turn and behaves exactly like the old `MicCapture`; with wake word on the
 * detector holds a long-lived subscription and a turn adds a second one.
 */
export class MicSource {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private starting: Promise<void> | null = null
  private readonly listeners = new Set<MicFrameListener>()

  // Input gain, applied to every native-rate frame before it is handed to any
  // listener — so wake-word detection and the conversational provider both see
  // the adjusted audio, and neither has to know it happened. Kept here (the one
  // owner of the mic) rather than in a listener so it is genuinely independent
  // of any microphone-specific implementation.
  private readonly inputGain = new InputGain(DEFAULT_INPUT_GAIN_DB)
  private gainLoggedAt = 0
  private lastGainStats: InputGainStats | null = null

  // Which input device `getUserMedia` asks for. `null` means "let the OS pick".
  // Resolved from the per-browser microphone choice by `useAudioInput`; see
  // `./audioInput` and docs/audio-pipeline.md. `deviceStrict` picks `{exact}`
  // (fail loudly if absent) over `{ideal}` (best effort).
  private inputDeviceId: string | null = null
  private inputDeviceStrict = false

  // Fired after the shared stream is (re)acquired or torn down. Device labels
  // only become readable once the page has held a grant, so `useAudioInput`
  // re-enumerates on this signal.
  private readonly streamListeners = new Set<() => void>()

  /**
   * Create/resume the `AudioContext` synchronously inside a user gesture, so a
   * later turn's response audio is allowed to play. Safe to call repeatedly.
   */
  activateContext(): void {
    if (!this.context) this.context = new AudioContext()
    void this.context.resume().catch(() => {
      console.warn('[voice] microphone audio context could not resume')
    })
  }

  /** Current context state, for diagnostics. */
  state(): string {
    return this.context?.state ?? 'closed'
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 0
  }

  /**
   * Set the capture input gain, in dB, applied to every frame before the
   * wake-word detector or the voice provider sees it. 0 disables the stage.
   * Non-finite values are ignored. Safe to call before or during capture — the
   * next frame picks it up.
   */
  setInputGainDb(db: number): void {
    const before = this.inputGain.db
    this.inputGain.setDb(db)
    if (this.inputGain.db !== before) {
      console.info('[voice] mic input gain set', {
        db: this.inputGain.db,
        linear: round(this.inputGain.linear),
      })
    }
  }

  /** Configured capture gain, in dB. */
  get inputGainDb(): number {
    return this.inputGain.db
  }

  /**
   * Choose the input device for the shared stream. `null` restores the OS
   * default. `strict` requests it as `{exact}` — a missing device then fails the
   * capture instead of quietly falling back to another microphone. Safe to call
   * before or during capture: an active stream is torn down and rebuilt under the
   * same listeners.
   */
  setInputDeviceId(deviceId: string | null, strict = false): void {
    const next = deviceId || null
    if (next === this.inputDeviceId && strict === this.inputDeviceStrict) return
    this.inputDeviceId = next
    this.inputDeviceStrict = strict
    console.info('[voice] mic input device', { deviceId: next ?? '(system default)', strict })
    void this.reacquire()
  }

  /** The input device the current stream is bound to (label needs a live grant). */
  boundInputLabel(): string | null {
    return this.stream?.getAudioTracks()[0]?.label || null
  }

  /**
   * Subscribe to stream (re)acquisition / teardown. Returns an unsubscribe
   * function. Used by `useAudioInput` to re-read device labels once a grant
   * exists.
   */
  onStreamChange(listener: () => void): () => void {
    this.streamListeners.add(listener)
    return () => {
      this.streamListeners.delete(listener)
    }
  }

  private notifyStreamChange(): void {
    for (const listener of this.streamListeners) {
      try {
        listener()
      } catch {
        // a diagnostics listener must never break capture
      }
    }
  }

  /** Rebuild the stream for the current input device, keeping every listener. */
  private async reacquire(): Promise<void> {
    if (!this.node && !this.starting) return // not capturing; the next subscribe() picks it up
    try {
      await this.starting?.catch(() => {})
    } catch {
      // ignore a failed in-flight start; we tear it down next anyway
    }
    const hadListeners = this.listeners.size > 0
    this.node?.port.close()
    this.node?.disconnect()
    this.sourceNode?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.node = null
    this.sourceNode = null
    this.stream = null
    this.context = null
    this.notifyStreamChange()
    if (!hadListeners) return
    try {
      await this.ensureRunning()
    } catch (cause) {
      console.warn('[voice] could not re-acquire the microphone after a device change', cause)
    }
  }

  /**
   * The linear multiplier that gain is currently applying (1 when disabled).
   * Callers that measure a level off gained audio and then compare it to a
   * threshold must first normalise with `atReferenceGain(rms, this value)` — see
   * `gain.ts`, rule 3.
   */
  get inputGainLinear(): number {
    return this.inputGain.linear
  }

  /**
   * Most recent input-level diagnostics (peak / RMS / clip counts since the
   * previous throttled sample), for tuning {@link setInputGainDb}. Zero-valued
   * until the mic has produced a frame.
   */
  inputGainStats(): InputGainStats {
    return this.lastGainStats ?? this.inputGain.emptyStats()
  }

  private maybeLogInputLevel(): void {
    const now = performance.now()
    if (now - this.gainLoggedAt < GAIN_LOG_INTERVAL_MS) return
    this.gainLoggedAt = now
    const stats = this.inputGain.readStats()
    this.lastGainStats = stats
    if (!traceEnabled()) return
    console.info('[voice] mic input level', {
      gainDb: stats.db,
      peak: round(stats.peak),
      rms: round(stats.rms),
      clipped: stats.clipped,
      clipPct: stats.samples ? round((stats.clipped / stats.samples) * 100, 2) : 0,
    })
  }

  async subscribe(listener: MicFrameListener): Promise<MicSubscription> {
    this.listeners.add(listener)
    try {
      await this.ensureRunning()
    } catch (cause) {
      this.listeners.delete(listener)
      this.teardownIfIdle()
      throw cause
    }
    return {
      unsubscribe: () => {
        this.listeners.delete(listener)
        this.teardownIfIdle()
      },
    }
  }

  private ensureRunning(): Promise<void> {
    if (this.node) return Promise.resolve()
    if (!this.starting) {
      this.starting = (async () => {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            // The kiosk playout is routed through a loopback peer connection
            // (see aecPlayback.ts) specifically so this flag has a reference
            // signal to work against.
            echoCancellation: true,
            // Off: echo is handled by the loopback AEC above, and noise
            // suppression was only gating the quiet tail of a sentence below the
            // endpoint threshold (docs/voice-support-plan.md, tenth run). AGC
            // fights our own dB gain stage (gain.ts) for the level.
            noiseSuppression: false,
            autoGainControl: false,
            // Device chosen by `useAudioInput` (default: OS pick, or VB-CABLE
            // when present). See ./audioInput and docs/audio-pipeline.md.
            ...(this.inputDeviceId
              ? { deviceId: this.inputDeviceStrict ? { exact: this.inputDeviceId } : { ideal: this.inputDeviceId } }
              : {}),
          },
        })
        const track = this.stream.getAudioTracks()[0]
        console.info('[voice] mic stream acquired', {
          requestedDeviceId: this.inputDeviceId ?? '(system default)',
          strict: this.inputDeviceStrict,
          boundLabel: track?.label || '(unknown)',
          boundDeviceId: track?.getSettings?.().deviceId ?? '(unknown)',
        })
        this.notifyStreamChange()
        this.activateContext()
        const context = this.context
        if (!context) throw new Error('Could not create the microphone audio context.')
        await context.audioWorklet.addModule(new URL('./pcm-capture-worklet.js', import.meta.url))
        this.sourceNode = context.createMediaStreamSource(this.stream)
        this.node = new AudioWorkletNode(context, 'pcm-capture')
        const rate = context.sampleRate
        let batches = 0
        console.info('[voice] shared mic context', { state: context.state, sampleRate: rate })
        this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
          batches += 1
          // Gain the frame in place before fan-out: every listener gets the same
          // adjusted, saturated buffer.
          const frame = this.inputGain.apply(event.data)
          if (batches === 1) {
            console.info('[voice] first mic worklet batch', {
              nativeSamples: frame.length,
              gainDb: this.inputGain.db,
            })
          }
          this.maybeLogInputLevel()
          for (const l of this.listeners) l(frame, rate)
        }
        this.sourceNode.connect(this.node)
        // Silent (the processor emits nothing) but keeps the worklet in the
        // active rendering graph so frames are not delayed.
        this.node.connect(context.destination)
      })().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  private teardownIfIdle(): void {
    if (this.listeners.size > 0 || this.starting) return
    this.node?.port.close()
    this.node?.disconnect()
    this.sourceNode?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.node = null
    this.sourceNode = null
    this.stream = null
    this.context = null
    this.notifyStreamChange()
  }
}

/** Process-wide shared microphone. */
export const micSource = new MicSource()

/**
 * Streams microphone audio to one voice provider as base64 PCM16 chunks at that
 * provider's input rate, for one turn. A thin adapter over the shared
 * {@link micSource}: subscribe on `start`, downsample each native frame,
 * unsubscribe on `stop`.
 *
 * The `onLevel` RMS it reports is normalised to `LEVEL_REFERENCE_GAIN_DB`, so
 * the end-of-speech thresholds in `useVoiceSession` mean the same thing at every
 * setting of `MISSION_CONTROL_MIC_INPUT_GAIN_DB`.
 */
export class MicCapture {
  private sub: MicSubscription | null = null
  active = false

  /** Create the capture context during the Ask tap, while autoplay permission is live. */
  activate(): void {
    micSource.activateContext()
  }

  async start(
    onChunk: (base64: string) => void,
    onLevel?: (rms: number) => void,
    targetRate: number = INPUT_RATE,
  ): Promise<void> {
    let chunks = 0
    this.sub = await micSource.subscribe((frame, rate) => {
      chunks += 1
      if (chunks === 1) {
        console.info('[voice] mic capture first chunk', { sampleRate: rate, targetRate })
      }
      const down = downsampleTo(frame, rate, targetRate)
      onChunk(floatToPcm16Base64(down))
      if (onLevel) {
        let sum = 0
        for (let i = 0; i < down.length; i += 1) sum += down[i] * down[i]
        const rms = Math.sqrt(sum / down.length)
        onLevel(atReferenceGain(rms, micSource.inputGainLinear))
      }
    })
    this.active = true
  }

  stop(): void {
    this.active = false
    this.sub?.unsubscribe()
    this.sub = null
  }
}

/**
 * Plays base64 PCM16 chunks back-to-back as they arrive; can be flushed on
 * interruption.
 *
 * There used to be an adaptive jitter buffer here — it held a learned cushion
 * before starting and, on underrun, reset the playback cursor and re-buffered
 * mid-reply. It was added for the Gemini Live path, whose audio the API
 * documents as "generated as quickly as possible, and not in real time", but the
 * mid-stream stop/restart it caused was a likely source of audible clicks, so it
 * was removed. Each chunk is now scheduled the moment it decodes, contiguously
 * off {@link cursor}. If the stream arrives slower than real time the audio has
 * a gap where playback caught up (see {@link underruns}); it is never chopped.
 */
export class AudioSink {
  private context: AudioContext | null = null
  // The rate the current provider streams reply audio at. Defaulted rather than
  // fixed: it is a property of the provider, like `inputSampleRate` is for
  // capture, and `useVoiceSession` sets it from the connected session.
  private outputRate = OUTPUT_RATE
  private gain: GainNode | null = null
  private output: EchoCancelledOutput | null = null
  private cursor = 0
  private sources = new Set<AudioBufferSourceNode>()
  private played = 0
  private decodedSeconds = 0
  private readonly onDrained: () => void
  // Count of times a chunk arrived after everything scheduled had already played
  // out — i.e. the stream fell behind real time. Diagnostic only now; nothing
  // acts on it.
  private underruns = 0
  // Arrival accounting, to tell "the server is slow" from "we are slow".
  private firstArrivalAt = 0
  private lastArrivalAt = 0
  private maxGapMs = 0
  // A small lead so the first buffer is not scheduled at exactly currentTime
  // (which some browsers drop or click on).
  private static readonly LEAD_SECONDS = 0.12

  constructor(onDrained: () => void) {
    this.onDrained = onDrained
  }

  /**
   * Create and resume the context while handling the Ask tap. Creating it only
   * when response audio arrives is too late for browsers' user-gesture policy
   * and leaves the context suspended (and therefore silent).
   *
   * The context runs at the hardware rate (no `sampleRate` hint): passing an
   * explicit rate throws on some browsers, and the 24 kHz output buffers are
   * resampled to the device rate on playback anyway.
   */
  activate(): void {
    if (!this.context) {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.context = new Ctor()
      this.gain = this.context.createGain()
      this.gain.gain.value = 1
      // Play out through a loopback peer connection so Chromium folds it into the
      // microphone's echo-cancellation reference (aecPlayback.ts). Both the reply
      // audio and the listening cue route through `this.gain`, so both are
      // cancelled from the capture side. The tap also forks this bus to the
      // Wi-Fi speaker path when Settings routes output to the Invoke.
      this.output = createEchoCancelledOutput(this.context, speakerOut.createTap('assistant'))
      this.gain.connect(this.output.node)
      console.info('[voice] speaker context created', {
        state: this.context.state,
        sampleRate: this.context.sampleRate,
        echoCancelledOutput: this.output.active,
        destinationChannels: this.context.destination.channelCount,
        maxChannels: this.context.destination.maxChannelCount,
      })
      this.context.addEventListener('statechange', () => {
        console.info('[voice] speaker context state ->', this.context?.state)
      })
    }
    if (this.context.state === 'suspended') {
      void this.context
        .resume()
        .then(() => console.info('[voice] speaker context resumed ->', this.context?.state))
        .catch((error) => console.warn('[voice] speaker context could not resume', error))
    }
  }

  /**
   * Tell the sink what rate the connected provider streams reply audio at. Call
   * it once per turn, after `connect()` and before any `enqueue`. Buffers are
   * resampled to the device rate by the browser on playback, so this only has to
   * be honest, not to match the hardware.
   */
  setOutputSampleRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0 || rate === this.outputRate) return
    this.outputRate = rate
    console.info('[voice] response-audio rate', { sampleRate: rate })
  }

  /** Current AudioContext state, for instrumentation. `'closed'` when there is none. */
  state(): string {
    return this.context?.state ?? 'closed'
  }

  /**
   * True while any audio for this turn is still scheduled or playing. A
   * `turnComplete` / `closing` arriving while this is true must let the sink
   * drain rather than tearing the session down mid-reply.
   */
  pending(): boolean {
    return this.sources.size > 0
  }

  private static readonly TONE_LEAD_SECONDS = 0.05
  private static readonly TONE_SECONDS = 0.4

  /**
   * Play a 0.4 s tone through the same graph as response audio — the "I'm
   * listening" cue, and a way to confirm the output path independently of
   * whether the provider's audio is arriving.
   *
   * The cue routes through `this.gain` and therefore through the echo-cancelled
   * output, so the open microphone no longer hears it as the user speaking (it
   * used to land at ~0.06 RMS, six times the speech threshold — see
   * docs/voice-support-plan.md, eighth run).
   */
  playTestTone(): void {
    this.activate()
    const context = this.context
    if (!context || !this.gain) return
    const osc = context.createOscillator()
    osc.frequency.value = 440
    const g = context.createGain()
    g.gain.value = 0.15
    osc.connect(g).connect(this.gain)
    const t = context.currentTime + AudioSink.TONE_LEAD_SECONDS
    osc.start(t)
    osc.stop(t + AudioSink.TONE_SECONDS)
    console.info('[voice] test tone scheduled', { state: context.state, at: t })
  }

  /** Returns true when the chunk decoded and was scheduled for playback. */
  enqueue(base64: string): boolean {
    this.activate()
    const context = this.context
    if (!context || !this.gain) return false
    let samples: Float32Array
    try {
      samples = pcm16Base64ToFloat(base64)
    } catch (error) {
      console.warn('[voice] could not decode a response-audio chunk', error)
      return false
    }
    if (!samples.length) return false
    const arrivedAt = performance.now()
    if (!this.firstArrivalAt) this.firstArrivalAt = arrivedAt
    else this.maxGapMs = Math.max(this.maxGapMs, arrivedAt - this.lastArrivalAt)
    this.lastArrivalAt = arrivedAt
    this.schedule(samples, context.currentTime)
    return true
  }

  /**
   * How the stream actually arrived. `realtimeRatio` below 1 means the server
   * delivered slower than the audio plays, which is the underrun in one number;
   * `maxGapMs` is the longest silence between chunks.
   */
  arrivalStats(): Record<string, number> {
    const wallMs = this.lastArrivalAt - this.firstArrivalAt
    return {
      chunks: this.played,
      audioSec: Math.round(this.decodedSeconds * 100) / 100,
      wallSec: Math.round(wallMs) / 1000,
      realtimeRatio: wallMs > 0 ? Math.round((this.decodedSeconds * 1000 * 100) / wallMs) / 100 : 0,
      maxGapMs: Math.round(this.maxGapMs),
      underruns: this.underruns,
    }
  }

  /**
   * No-op retained for API compatibility. Audio now plays as it arrives, so
   * there is nothing held back to release when the turn ends.
   */
  finalizeStream(): void {}

  private schedule(samples: Float32Array, now: number): void {
    const context = this.context
    if (!context || !this.gain) return
    // Everything scheduled has already played out — the stream fell behind real
    // time and there is an audible gap before this chunk. Recorded for the
    // timeline; nothing tries to paper over it any more.
    const underran = this.played > 0 && this.cursor > 0 && this.cursor < now
    if (underran) {
      this.underruns += 1
      console.warn('[voice] playback underrun — audio arrived slower than real time', {
        behindMs: Math.round((now - this.cursor) * 1000),
        underruns: this.underruns,
      })
    }
    const buffer = context.createBuffer(1, samples.length, this.outputRate)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    const startAt = Math.max(now + AudioSink.LEAD_SECONDS, this.cursor)
    source.start(startAt)
    this.cursor = startAt + buffer.duration
    this.decodedSeconds += buffer.duration
    this.sources.add(source)
    this.played += 1
    if (this.played === 1 || underran) {
      console.info('[voice] response-audio buffer scheduled', {
        chunk: this.played,
        state: context.state,
        gain: this.gain.gain.value,
        startInMs: Math.round((startAt - now) * 1000),
        chunkMs: Math.round(buffer.duration * 1000),
      })
    }
    if (this.played % 25 === 0) {
      console.info('[voice] audio still playing', {
        chunks: this.played,
        decodedSec: Math.round(this.decodedSeconds * 10) / 10,
        aheadMs: Math.round((this.cursor - now) * 1000),
        state: context.state,
      })
    }
    source.onended = () => {
      this.sources.delete(source)
      if (this.pending()) return
      console.info('[voice] audio sink drained', this.arrivalStats())
      this.onDrained()
    }
  }

  flush(): void {
    if (this.sources.size) {
      console.info('[voice] audio sink flushed', { stillScheduled: this.sources.size })
    }
    this.sources.forEach((source) => {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    })
    this.sources.clear()
    this.underruns = 0
    this.firstArrivalAt = 0
    this.lastArrivalAt = 0
    this.maxGapMs = 0
    this.cursor = 0
    this.played = 0
    this.decodedSeconds = 0
  }

  close(): void {
    this.flush()
    this.output?.dispose()
    this.output = null
    void this.context?.close()
    this.context = null
    this.gain = null
  }
}
