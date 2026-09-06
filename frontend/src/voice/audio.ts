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

  async start(onChunk: (base64: string) => void): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    this.context = new AudioContext()
    await this.context.audioWorklet.addModule(new URL('./pcm-capture-worklet.js', import.meta.url))
    const source = this.context.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.context, 'pcm-capture')
    const rate = this.context.sampleRate
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      onChunk(floatToPcm16Base64(downsample(event.data, rate, INPUT_RATE)))
    }
    source.connect(this.node)
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

  enqueue(base64: string): void {
    if (!this.context) this.context = new AudioContext({ sampleRate: OUTPUT_RATE })
    const samples = pcm16Base64ToFloat(base64)
    if (!samples.length) return
    const buffer = this.context.createBuffer(1, samples.length, OUTPUT_RATE)
    buffer.copyToChannel(samples, 0)
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.context.destination)
    const startAt = Math.max(this.context.currentTime, this.cursor)
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
