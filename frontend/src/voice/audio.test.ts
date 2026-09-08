import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioSink, MicSource } from './audio'
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
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  }

  // Present so `createEchoCancelledOutput` can probe it; jsdom has no
  // `RTCPeerConnection`, so the sink falls back to `destination` regardless.
  createMediaStreamDestination() {
    return { stream: { getAudioTracks: () => [] }, connect: vi.fn(), disconnect: vi.fn() }
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

describe('AudioSink playback', () => {
  let context: FakeContext
  let drained: ReturnType<typeof vi.fn>
  let sink: AudioSink

  beforeEach(() => {
    context = new FakeContext()
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => context),
    )
    drained = vi.fn()
    sink = new AudioSink(drained)
    sink.activate()
  })

  it('schedules each chunk as it arrives, contiguously', () => {
    // No cushion: the first chunk reaches the graph immediately, and every
    // following chunk is scheduled back-to-back off the running cursor.
    sink.enqueue(chunk(200))
    expect(context.started).toHaveLength(1)
    expect(sink.pending()).toBe(true)

    sink.enqueue(chunk(200))
    sink.enqueue(chunk(200))
    expect(context.started).toHaveLength(3)
    const [first, second, third] = context.started
    expect(second.at).toBeCloseTo(first.at + first.duration, 5)
    expect(third.at).toBeCloseTo(second.at + second.duration, 5)
  })

  it('plays a short reply immediately; finalizeStream is a no-op', () => {
    sink.enqueue(chunk(150))
    expect(context.started).toHaveLength(1)
    expect(sink.pending()).toBe(true)

    sink.finalizeStream()
    expect(context.started).toHaveLength(1)
  })

  it('schedules a late chunk into a fresh slot and counts the underrun', () => {
    sink.enqueue(chunk(500))
    expect(context.started).toHaveLength(1)

    // The scheduled audio plays out entirely before the next chunk arrives —
    // the sub-real-time delivery the Live API warns about. There is an audible
    // gap, but the chunk is played, not held.
    context.advance(2)
    expect(drained).toHaveBeenCalledTimes(1)

    sink.enqueue(chunk(300))
    expect(context.started).toHaveLength(1)
    expect(sink.arrivalStats().underruns).toBe(1)
  })

  it('does not report drained while a later chunk is still playing', () => {
    // The truncation guard: a mid-reply drain must not look like end-of-turn, or
    // a `turnComplete` landing in that window cuts the rest of the reply off.
    sink.enqueue(chunk(500))
    sink.enqueue(chunk(500))
    context.advance(0.7)

    expect(sink.pending()).toBe(true)
    expect(drained).not.toHaveBeenCalled()
  })

  it('drops everything on flush', () => {
    sink.enqueue(chunk(200))
    sink.flush()
    expect(sink.pending()).toBe(false)
  })

  it('schedules reply audio at the rate the provider declared', () => {
    // 12 000 samples of PCM16: 0.5 s at 24 kHz, 0.75 s at 16 kHz. The sink must
    // take the rate from the connected provider, not from a baked-in constant.
    const half = chunk(500)
    sink.setOutputSampleRate(16_000)
    sink.enqueue(half)
    expect(context.started[0].duration).toBeCloseTo(0.75, 3)
  })

  it('plays out even when the echo-cancelled loopback is unavailable', () => {
    // jsdom has no `RTCPeerConnection`, so the sink wires straight to
    // `destination`. Playback must be unaffected.
    expect(() => sink.playTestTone()).not.toThrow()
    sink.enqueue(chunk(120))
    expect(context.started).toHaveLength(1)
  })
})

describe('MicSource input gain', () => {
  it('starts at the shared default gain', () => {
    const mic = new MicSource()
    expect(mic.inputGainDb).toBe(DEFAULT_INPUT_GAIN_DB)
    expect(mic.inputGainLinear).toBeCloseTo(dbToLinear(DEFAULT_INPUT_GAIN_DB), 6)
  })

  it('exposes the multiplier so level thresholds can be normalised to the reference', () => {
    const mic = new MicSource()
    mic.setInputGainDb(0)
    expect(mic.inputGainLinear).toBe(1)
    mic.setInputGainDb(26)
    expect(mic.inputGainLinear).toBeCloseTo(dbToLinear(26), 6)
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

describe('MicSource input device', () => {
  let getUserMedia: ReturnType<typeof vi.fn>

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    getUserMedia = vi.fn(async () => ({
      getAudioTracks: () => [
        {
          label: 'CABLE Output (VB-Audio Virtual Cable)',
          getSettings: () => ({ deviceId: 'cable-1' }),
          stop: vi.fn(),
        },
      ],
      getTracks: () => [{ stop: vi.fn() }],
    }))
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    vi.stubGlobal(
      'AudioContext',
      vi.fn(() => ({
        state: 'running',
        sampleRate: 48_000,
        destination: {},
        audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
        createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
        resume: () => Promise.resolve(),
        close: vi.fn(),
      })),
    )
    vi.stubGlobal(
      'AudioWorkletNode',
      vi.fn(() => ({ port: { onmessage: null, close: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() })),
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  it('requests the OS default until a device is chosen', async () => {
    const mic = new MicSource()
    const sub = await mic.subscribe(() => {})
    expect(getUserMedia).toHaveBeenCalledTimes(1)
    expect(getUserMedia.mock.calls[0][0].audio).not.toHaveProperty('deviceId')
    sub.unsubscribe()
  })

  it('uses an ideal deviceId constraint for a best-effort (auto) choice', async () => {
    const mic = new MicSource()
    mic.setInputDeviceId('cable-1', false)
    const sub = await mic.subscribe(() => {})
    expect(getUserMedia.mock.calls[0][0].audio.deviceId).toEqual({ ideal: 'cable-1' })
    sub.unsubscribe()
  })

  it('uses an exact constraint for an explicit choice and rebuilds a live stream', async () => {
    const mic = new MicSource()
    const sub = await mic.subscribe(() => {})
    mic.setInputDeviceId('cable-1', true)
    await settle()
    expect(getUserMedia).toHaveBeenCalledTimes(2)
    expect(getUserMedia.mock.calls[1][0].audio.deviceId).toEqual({ exact: 'cable-1' })
    expect(mic.boundInputLabel()).toBe('CABLE Output (VB-Audio Virtual Cable)')
    sub.unsubscribe()
  })

  it('does not touch getUserMedia when the device changes while idle', () => {
    const mic = new MicSource()
    mic.setInputDeviceId('cable-1', true)
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('notifies stream-change listeners on acquire and on teardown', async () => {
    const mic = new MicSource()
    const onChange = vi.fn()
    mic.onStreamChange(onChange)
    const sub = await mic.subscribe(() => {})
    expect(onChange).toHaveBeenCalled()
    onChange.mockClear()
    sub.unsubscribe()
    expect(onChange).toHaveBeenCalled()
  })
})
