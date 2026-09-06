// Microphone capture and assistant-audio playback for the Gemini Live session.
// Gemini expects 16 kHz mono PCM16 input and streams 24 kHz mono PCM16 output.

const INPUT_RATE = 16_000
const OUTPUT_RATE = 24_000

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

/** Streams microphone audio as base64 PCM16 chunks until stopped. */
export class MicCapture {
  private context: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  active = false

  /** Create the capture context during the Ask tap, while autoplay permission is live. */
  activate(): void {
    if (!this.context) this.context = new AudioContext()
    void this.context.resume().catch(() => {
      console.warn('[voice] microphone audio context could not resume')
    })
  }

  async start(
    onChunk: (base64: string) => void,
    onLevel?: (rms: number) => void,
  ): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    this.activate()
    const context = this.context
    if (!context) throw new Error('Could not create the microphone audio context.')
    await context.audioWorklet.addModule(new URL('./pcm-capture-worklet.js', import.meta.url))
    const source = context.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(context, 'pcm-capture')
    const rate = context.sampleRate
    let chunks = 0
    console.info('[voice] mic capture context', { state: context.state, sampleRate: rate })
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      chunks += 1
      if (chunks === 1) console.info('[voice] first mic worklet batch', { nativeSamples: event.data.length })
      const down = downsample(event.data, rate, INPUT_RATE)
      onChunk(floatToPcm16Base64(down))
      if (onLevel) {
        let sum = 0
        for (let i = 0; i < down.length; i += 1) sum += down[i] * down[i]
        onLevel(Math.sqrt(sum / down.length))
      }
    }
    source.connect(this.node)
    // The processor emits no audio, so this is silent; connecting it keeps the
    // worklet in the browser's active rendering graph and avoids delayed chunks.
    this.node.connect(context.destination)
    this.active = true
  }

  stop(): void {
    this.active = false
    this.node?.port.close()
    this.node?.disconnect()
    this.stream?.getTracks().forEach((track) => track.stop())
    void this.context?.close()
    this.node = null
    this.stream = null
    this.context = null
  }
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

  /** True while buffers are still scheduled or playing. */
  pending(): boolean {
    return this.sources.size > 0
  }

  /**
   * Play a 0.4 s test tone through the same graph as response audio. Enabled
   * with `localStorage['voice.testtone'] = '1'`; lets us confirm the output
   * path independently of whether Gemini's audio is arriving/decoding.
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
    const t = context.currentTime + 0.05
    osc.start(t)
    osc.stop(t + 0.4)
    console.info('[voice] test tone scheduled', { state: context.state, at: t })
  }

  /** Returns true when a buffer was actually scheduled for playback. */
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
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)
    const now = context.currentTime
    if (this.cursor && this.cursor < now) {
      console.warn('[voice] playback underrun — audio arrived slower than real time', {
        behindMs: Math.round((now - this.cursor) * 1000),
      })
    }
    const startAt = Math.max(now + AudioSink.LEAD_SECONDS, this.cursor)
    source.start(startAt)
    this.cursor = startAt + buffer.duration
    this.decodedSeconds += buffer.duration
    this.sources.add(source)
    this.played += 1
    if (this.played === 1) {
      console.info('[voice] first response-audio buffer scheduled', {
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
      if (!this.sources.size) {
        console.info('[voice] audio sink drained', {
          chunks: this.played,
          decodedSec: Math.round(this.decodedSeconds * 10) / 10,
        })
        this.onDrained()
      }
    }
    return true
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
