import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioSink, MicSource, resetLearnedPrebuffer } from './audio'
import { DEFAULT_INPUT_GAIN_DB, dbToLinear } from './gain'

const OUTPUT_RATE = 24_000

/** Base64 PCM16 for `ms` of silence at the Live API's 24 kHz output rate. */
function chunk(ms: number): string {
  const bytes = new Uint8Array(Math.round((OUTPUT_RATE * ms) / 1000) * 2)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Just enough Web Audio to observe scheduling. `currentTime` is manual so a test
 * can say "real time moved on while nothing arrived" and produce an underrun
 * deterministically.
 */
class FakeContext {
  currentTime = 0
  state = 'running'
  sampleRate = 48_000
  destination = { channelCount: 2, maxChannelCount: 2 }
  readonly started: { at: number; duration: number; node: FakeSource }[] = []

  createGain() {
    return { gain: { value: 1 }, connect: vi.fn() }
  }

  createBuffer(_channels: number, length: number, rate: number) {
    return { duration: length / rate, copyToChannel: vi.fn() }
  }

  createBufferSource() {
    return new FakeSource(this)
  }

  createOscillator() {
    return { frequency: { value: 0 }, connect: () => ({ connect: vi.fn() }), start: vi.fn(), stop: vi.fn() }
  }

  addEventListener() {}
  close() {}

  /** Advance the clock and fire `onended` for everything that has finished. */
  advance(seconds: number): void {
    this.currentTime += seconds
    for (const entry of [...this.started]) {
      if (entry.at + entry.duration <= this.currentTime) {
        const index = this.started.indexOf(entry)
        if (index >= 0) this.started.splice(index, 1)
        entry.node.onended?.()
      }
    }
  }
}

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  private readonly context: FakeContext
  constructor(context: FakeContext) {
    this.context = context
  }
  connect() {}
  start(at: number) {
    this.context.started.push({ at, duration: this.buffer?.duration ?? 0, node: this })
  }
  stop() {}
}

describe('AudioSink jitter buffer', () => {
  let context: FakeContext
  let drained: ReturnType<typeof vi.fn>
  let sink: AudioSink

  beforeEach(() => {
    resetLearnedPrebuffer()
    context = new FakeContext()
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => context),
    )
    drained = vi.fn()
    sink = new AudioSink(drained)
    sink.activate()
  })

  it('holds the first chunks back until it has a cushion', () => {
    // 200 ms is under the 450 ms prebuffer: nothing should reach the graph yet,
    // but the turn is not idle either — the sink is holding audio.
    sink.enqueue(chunk(200))
    expect(context.started).toHaveLength(0)
    expect(sink.pending()).toBe(true)

    sink.enqueue(chunk(200))
    sink.enqueue(chunk(200))
    // Cushion full — everything queued is scheduled contiguously, no seams.
    expect(context.started).toHaveLength(3)
    const [first, second, third] = context.started
    expect(second.at).toBeCloseTo(first.at + first.duration, 5)
    expect(third.at).toBeCloseTo(second.at + second.duration, 5)
  })

  it('plays a reply shorter than the cushion once the turn is finalised', () => {
    sink.enqueue(chunk(150))
    expect(context.started).toHaveLength(0)

    sink.finalizeStream()

    expect(context.started).toHaveLength(1)
    expect(sink.pending()).toBe(true)
  })

  it('re-buffers after an underrun instead of scheduling into the gap', () => {
    sink.enqueue(chunk(500))
    expect(context.started).toHaveLength(1)

    // The scheduled audio plays out entirely before the next chunk arrives —
    // the sub-real-time delivery the Live API warns about.
    context.advance(2)
    expect(drained).toHaveBeenCalledTimes(1)

    // A lone late chunk must not be dropped straight into the silence; it waits
    // for a fresh cushion — and that cushion is now *deeper* than the 450 ms
    // that just failed, because resuming on a depth the stream has already
    // outrun only stalls again (one reply stuttered eight times that way).
    sink.enqueue(chunk(200))
    sink.enqueue(chunk(300))
    expect(context.started).toHaveLength(0)

    // 900 ms — doubled — is the new bar.
    sink.enqueue(chunk(400))
    expect(context.started).toHaveLength(3)
    expect(sink.arrivalStats().prebufferMs).toBe(900)
  })

  it('does not report drained while chunks are still buffered', () => {
    // The truncation bug: a mid-reply drain used to look like end-of-turn, so a
    // `turnComplete` landing in that window cut the rest of the reply off.
    sink.enqueue(chunk(500))
    sink.enqueue(chunk(100))
    context.advance(0.7)

    expect(sink.pending()).toBe(true)
    expect(drained).not.toHaveBeenCalled()
  })

  it('drops everything on flush', () => {
    sink.enqueue(chunk(200))
    sink.flush()
    expect(sink.pending()).toBe(false)
  })
})

describe('MicSource input gain', () => {
  it('starts at the +12 dB default', () => {
    expect(new MicSource().inputGainDb).toBe(DEFAULT_INPUT_GAIN_DB)
  })

  it('accepts a new gain in dB and ignores non-finite values', () => {
    const mic = new MicSource()
    mic.setInputGainDb(0)
    expect(mic.inputGainDb).toBe(0)
    mic.setInputGainDb(Number.NaN)
    expect(mic.inputGainDb).toBe(0)
    mic.setInputGainDb(-6)
    expect(mic.inputGainDb).toBe(-6)
  })

  it('reports zero-valued diagnostics carrying the current gain before any audio', () => {
    const mic = new MicSource()
    mic.setInputGainDb(9)
    const stats = mic.inputGainStats()
    expect(stats).toMatchObject({ db: 9, frames: 0, samples: 0, peak: 0, rms: 0, clipped: 0 })
    expect(stats.linear).toBeCloseTo(dbToLinear(9), 6)
  })
})
