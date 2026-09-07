// Microphone capture and assistant-audio playback for the Gemini Live session.
// Gemini expects 16 kHz mono PCM16 input and streams 24 kHz mono PCM16 output.

import { DEFAULT_INPUT_GAIN_DB, InputGain, type InputGainStats } from './gain'

const INPUT_RATE = 16_000
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

function floatToPcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate) return samples
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.floor(samples.length / ratio))
  // Average every source sample that maps to an output sample rather than
  // picking one. This is a cheap low-pass: plain decimation aliases high
  // frequencies down into the speech band, which degrades both the transcript
  // and the server-side voice-activity detector.
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += samples[j]
    out[i] = end > start ? sum / (end - start) : samples[start] ?? 0
  }
  return out
}

function pcm16Base64ToFloat(data: string): Float32Array {
  const binary = atob(data)
  // Drop a trailing odd byte rather than letting `new Int16Array` throw a
  // RangeError on a chunk boundary — one lost sample is inaudible.
  const usableBytes = binary.length - (binary.length % 2)
  const bytes = new Uint8Array(usableBytes)
  for (let i = 0; i < usableBytes; i += 1) bytes[i] = binary.charCodeAt(i)
  const pcm = new Int16Array(bytes.buffer)
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 0x8000
  return out
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
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        })
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
  }
}

/** Process-wide shared microphone. */
export const micSource = new MicSource()

/**
 * Streams microphone audio as base64 PCM16 16 kHz chunks for one voice turn.
 * A thin adapter over the shared {@link micSource}: subscribe on `start`,
 * downsample each native frame, unsubscribe on `stop`.
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
      const down = downsample(frame, rate, targetRate)
      onChunk(floatToPcm16Base64(down))
      if (onLevel) {
        let sum = 0
        for (let i = 0; i < down.length; i += 1) sum += down[i] * down[i]
        onLevel(Math.sqrt(sum / down.length))
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
 * Jitter-buffer depth carried between turns. Underruns push it up, clean turns
 * ease it back down, so the second reply of a session already starts with a
 * cushion sized for this kiosk's actual link instead of relearning from scratch.
 */
let learnedPrebufferSeconds = 0.45

/** Test seam: drop what previous turns learned so a suite is order-independent. */
export function resetLearnedPrebuffer(): void {
  learnedPrebufferSeconds = 0.45
}

/** Plays a queue of base64 PCM16 chunks gaplessly; can be flushed on interruption. */
export class AudioSink {
  private context: AudioContext | null = null
  private gain: GainNode | null = null
  private cursor = 0
  private sources = new Set<AudioBufferSourceNode>()
  private played = 0
  private decodedSeconds = 0
  private readonly onDrained: () => void
  private queue: Float32Array[] = []
  private buffering = true
  private starving = false
  private underruns = 0
  /**
   * Jitter buffer depth, in seconds — adaptive, because a fixed one cannot work.
   *
   * The Live API does not stream at real time ("Content is generated as quickly
   * as possible, and not in real time. Clients may choose to buffer and play it
   * out in real time"), and measured turns have run at 0.46x and then 0.26x:
   * 5.4 s of speech delivered over 20.5 s. Against a source that slow, *no*
   * fixed cushion helps — 450 ms of audio buys 450 ms of playback and the next
   * burst is two seconds away. The only way to play a sub-real-time stream
   * without seams is to hold more of it before starting.
   *
   * So the depth is learned: every underrun doubles it (up to
   * {@link PREBUFFER_MAX_SECONDS}), a clean turn relaxes it, and the value
   * carries across turns in {@link learnedPrebufferSeconds}. A kiosk on a slow
   * link settles at "wait for most of the reply, then play it perfectly", which
   * is the right trade for a short spoken answer; a fast link stays responsive.
   */
  private static readonly PREBUFFER_MIN_SECONDS = 0.45
  private static readonly PREBUFFER_MAX_SECONDS = 3
  private prebufferSeconds = learnedPrebufferSeconds
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
      this.gain.connect(this.context.destination)
      console.info('[voice] speaker context created', {
        state: this.context.state,
        sampleRate: this.context.sampleRate,
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

  /** Current AudioContext state, for instrumentation. `'closed'` when there is none. */
  state(): string {
    return this.context?.state ?? 'closed'
  }

  /**
   * True while any audio for this turn is still unplayed — scheduled, playing,
   * or waiting in the jitter buffer. The queue has to count: without it, the
   * repeated mid-reply drains an underrun causes look like "the turn is over",
   * and a `turnComplete` / `closing` landing in that window truncates the reply.
   */
  pending(): boolean {
    return this.sources.size > 0 || this.queue.length > 0
  }

  private static readonly TONE_LEAD_SECONDS = 0.05
  private static readonly TONE_SECONDS = 0.4

  /**
   * Play a 0.4 s tone through the same graph as response audio — the "I'm
   * listening" cue, and a way to confirm the output path independently of
   * whether Gemini's audio is arriving.
   *
   * Returns how many milliseconds from now the tone stops. The caller needs
   * this: the tone plays out of the kiosk speakers while the microphone is
   * already open, and browser echo cancellation does not reliably cover
   * WebAudio output (the speaker and mic run on separate `AudioContext`s), so
   * the level detector hears it at ~0.06 RMS — six times the speech threshold.
   * Left uncorrected that counts as the user speaking, and the silence timer
   * then ends the turn before they have said anything.
   */
  playTestTone(): number {
    this.activate()
    const context = this.context
    if (!context || !this.gain) return 0
    const osc = context.createOscillator()
    osc.frequency.value = 440
    const g = context.createGain()
    g.gain.value = 0.15
    osc.connect(g).connect(this.gain)
    const t = context.currentTime + AudioSink.TONE_LEAD_SECONDS
    osc.start(t)
    osc.stop(t + AudioSink.TONE_SECONDS)
    console.info('[voice] test tone scheduled', { state: context.state, at: t })
    return (AudioSink.TONE_LEAD_SECONDS + AudioSink.TONE_SECONDS) * 1000
  }

  /** Returns true when the chunk was accepted (queued, and scheduled if ready). */
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
    this.queue.push(samples)
    this.drainQueue()
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
      chunks: this.played + this.queue.length,
      audioSec: Math.round(this.decodedSeconds * 100) / 100,
      wallSec: Math.round(wallMs) / 1000,
      realtimeRatio: wallMs > 0 ? Math.round((this.decodedSeconds * 1000 * 100) / wallMs) / 100 : 0,
      maxGapMs: Math.round(this.maxGapMs),
      underruns: this.underruns,
      prebufferMs: Math.round(this.prebufferSeconds * 1000),
    }
  }

  /**
   * No more audio is coming for this turn — play out the cushion instead of
   * waiting for it to fill. Without this, a reply whose whole audio is shorter
   * than {@link PREBUFFER_SECONDS} would sit in the buffer and never play.
   */
  finalizeStream(): void {
    if (!this.queue.length) return
    this.buffering = false
    this.drainQueue()
  }

  /** Seconds of audio sitting in the jitter buffer, not yet scheduled. */
  private queuedSeconds(): number {
    let total = 0
    for (const chunk of this.queue) total += chunk.length / OUTPUT_RATE
    return total
  }

  /**
   * Move whatever the jitter buffer holds onto the graph, contiguously.
   *
   * While `buffering`, nothing is scheduled — we are filling the cushion. Once
   * it is full (or {@link finalizeStream} says no more is coming) every queued
   * chunk is scheduled back-to-back off `cursor`, so a burst that arrives all at
   * once still plays out at real time with no seams.
   */
  private drainQueue(): void {
    const context = this.context
    if (!context || !this.gain) return
    if (this.buffering) {
      if (this.queuedSeconds() < this.prebufferSeconds) return
      this.buffering = false
    }
    const now = context.currentTime
    // A stall: everything scheduled has already played out. Dropping the next
    // chunk in at `now` just repeats the stutter, so take the cushion again.
    if (this.played && this.cursor && this.cursor < now) {
      this.underruns += 1
      console.warn('[voice] playback underrun — audio arrived slower than real time', {
        behindMs: Math.round((now - this.cursor) * 1000),
        underruns: this.underruns,
      })
      this.cursor = 0
      this.starving = true
      this.buffering = true
      // Ask for more cushion next time. The stream is demonstrably arriving
      // slower than it plays, so resuming on the same depth just stalls again —
      // which is exactly what the eight underruns in one reply looked like.
      this.prebufferSeconds = Math.min(
        this.prebufferSeconds * 2,
        AudioSink.PREBUFFER_MAX_SECONDS,
      )
      learnedPrebufferSeconds = this.prebufferSeconds
      if (this.queuedSeconds() < this.prebufferSeconds) return
      this.buffering = false
    }
    for (const samples of this.queue) this.schedule(samples, now)
    this.queue = []
  }

  private schedule(samples: Float32Array, now: number): void {
    const context = this.context
    if (!context || !this.gain) return
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE)
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
    if (this.played === 1 || this.starving) {
      this.starving = false
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
      if (!this.underruns) {
        // Played through without a stall — ease the cushion back toward the
        // floor so a one-off slow turn does not permanently add latency.
        learnedPrebufferSeconds = Math.max(
          AudioSink.PREBUFFER_MIN_SECONDS,
          learnedPrebufferSeconds * 0.75,
        )
      }
      console.info('[voice] audio sink drained', this.arrivalStats())
      this.onDrained()
    }
  }

  flush(): void {
    if (this.sources.size || this.queue.length) {
      console.info('[voice] audio sink flushed', {
        stillScheduled: this.sources.size,
        stillQueued: this.queue.length,
      })
    }
    this.sources.forEach((source) => {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    })
    this.sources.clear()
    this.queue = []
    this.buffering = true
    this.starving = false
    this.underruns = 0
    this.prebufferSeconds = learnedPrebufferSeconds
    this.firstArrivalAt = 0
    this.lastArrivalAt = 0
    this.maxGapMs = 0
    this.cursor = 0
    this.played = 0
    this.decodedSeconds = 0
  }

  close(): void {
    this.flush()
    void this.context?.close()
    this.context = null
    this.gain = null
  }
}
