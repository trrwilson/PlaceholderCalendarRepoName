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
  for (let i = 0; i < out.length; i += 1) out[i] = samples[Math.floor(i * ratio)]
  return out
}

function pcm16Base64ToFloat(data: string): Float32Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
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

  async start(onChunk: (base64: string) => void): Promise<void> {
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
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      onChunk(floatToPcm16Base64(downsample(event.data, rate, INPUT_RATE)))
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
  private cursor = 0
  private sources = new Set<AudioBufferSourceNode>()
  private readonly onDrained: () => void

  constructor(onDrained: () => void) {
    this.onDrained = onDrained
  }

  /**
   * Create and resume the context while handling the Ask tap. Creating it only
   * when response audio arrives is too late for browsers' user-gesture policy
   * and leaves the context suspended (and therefore silent).
   */
activate(): void {
  if (!this.context) {
    this.context = new AudioContext({ sampleRate: OUTPUT_RATE })

    console.debug('[voice] speaker context created', {
      state: this.context.state,
      sampleRate: this.context.sampleRate,
    })

    this.context.addEventListener('statechange', () => {
      console.debug('[voice] speaker context state:', this.context?.state)
    })
  }

  void this.context.resume().then(() => {
    console.debug('[voice] speaker context resumed', {
      state: this.context?.state,
      sampleRate: this.context?.sampleRate,
    })
  }).catch((error) => {
    console.warn('[voice] speaker audio context could not resume', error)
  })
}

  enqueue(base64: string): void {
    this.activate()
    const context = this.context
    if (!context) return
    const samples = pcm16Base64ToFloat(base64)
    if (!samples.length) return
    const buffer = context.createBuffer(1, samples.length, OUTPUT_RATE)
    buffer.copyToChannel(samples, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const startAt = Math.max(context.currentTime, this.cursor)
    source.start(startAt)
    this.cursor = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      if (!this.sources.size) this.onDrained()
    }
  }

  flush(): void {
    this.sources.forEach((source) => {
      try {
        source.stop()
      } catch {
        // already stopped
      }
    })
    this.sources.clear()
    this.cursor = 0
  }

  close(): void {
    this.flush()
    void this.context?.close()
    this.context = null
  }
}
