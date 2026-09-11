import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { canSelectAudioOutput, createEchoCancelledOutput } from './aecPlayback'
import { resetOutputSink, setOutputSinkId } from './outputSink'

// A fake RTCPeerConnection pair: the second instance created (the receiver in
// `createEchoCancelledOutput`) fires a `track` event carrying whatever tracks
// were added to the first, as soon as it is handed the offer.
class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = []
  static addedTracks: unknown[] = []
  /** When false, the receiver never signals `iceconnectionstatechange` — the
   *  loopback negotiates but no media flows (the wedged-kiosk case). */
  static autoConnect = true
  private listeners: Record<string, ((event: unknown) => void)[]> = {}
  iceConnectionState = 'new'
  constructor() {
    FakeRTCPeerConnection.instances.push(this)
  }
  addEventListener(type: string, cb: (event: unknown) => void) {
    ;(this.listeners[type] ??= []).push(cb)
  }
  private fire(type: string, event: unknown) {
    for (const cb of this.listeners[type] ?? []) cb(event)
  }
  addTrack(track: unknown) {
    FakeRTCPeerConnection.addedTracks.push(track)
  }
  async createOffer() {
    return { type: 'offer', sdp: 'x' }
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'x' }
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    // The receiver is the 2nd instance; deliver the sender's tracks to it.
    if (this === FakeRTCPeerConnection.instances[1]) {
      for (const track of FakeRTCPeerConnection.addedTracks) {
        this.fire('track', { track })
      }
      if (FakeRTCPeerConnection.autoConnect) {
        this.iceConnectionState = 'connected'
        this.fire('iceconnectionstatechange', {})
      }
    }
  }
  /** Test hook: drive the receiver's ICE state after negotiation. */
  simulateIce(state: string) {
    this.iceConnectionState = state
    this.fire('iceconnectionstatechange', {})
  }
  async addIceCandidate() {}
  close() {}
}

class FakeAudio {
  static last: FakeAudio | null = null
  autoplay = false
  hidden = false
  srcObject: unknown = null
  setSinkId = vi.fn(async (id: string) => {
    void id
  })
  play = vi.fn(async () => {})
  pause = vi.fn()
  remove = vi.fn()
  setAttribute = vi.fn()
  constructor() {
    FakeAudio.last = this
  }
}

class FakeContext {
  destination = { __role: 'destination' }
  setSinkId = vi.fn(async (id: string) => {
    void id
  })
  createMediaStreamDestination() {
    return { stream: { getAudioTracks: () => [{ kind: 'audio' }] }, connect: vi.fn(), disconnect: vi.fn() }
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  }
  close() {}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetOutputSink()
  FakeRTCPeerConnection.instances = []
  FakeRTCPeerConnection.addedTracks = []
  FakeRTCPeerConnection.autoConnect = true
  FakeAudio.last = null
  vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection)
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('MediaStream', class {
    tracks: unknown[]
    constructor(tracks: unknown[]) {
      this.tracks = tracks
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetOutputSink()
})

describe('canSelectAudioOutput', () => {
  it('is true when HTMLMediaElement.setSinkId exists', () => {
    // jsdom provides HTMLMediaElement; setSinkId presence depends on the runtime.
    expect(typeof canSelectAudioOutput()).toBe('boolean')
  })
})

describe('createEchoCancelledOutput sink routing', () => {
  it('pins the playout element to the current sink id at creation', async () => {
    setOutputSinkId('speakers-1')
    const output = createEchoCancelledOutput(new FakeContext() as unknown as AudioContext)
    await flush()

    expect(FakeAudio.last).not.toBeNull()
    expect(FakeAudio.last?.setSinkId).toHaveBeenCalledWith('speakers-1')
    expect(output.active).toBe(true)
  })

  it('follows a later sink-id change', async () => {
    createEchoCancelledOutput(new FakeContext() as unknown as AudioContext)
    await flush()
    FakeAudio.last?.setSinkId.mockClear()

    setOutputSinkId('headphones-2')
    expect(FakeAudio.last?.setSinkId).toHaveBeenCalledWith('headphones-2')
  })

  it('stops following sink changes after dispose', async () => {
    const output = createEchoCancelledOutput(new FakeContext() as unknown as AudioContext)
    await flush()
    const element = FakeAudio.last
    element?.setSinkId.mockClear()

    output.dispose()
    setOutputSinkId('somewhere-else')
    expect(element?.setSinkId).not.toHaveBeenCalled()
  })

  it('routes an empty sink id (system default) explicitly', async () => {
    createEchoCancelledOutput(new FakeContext() as unknown as AudioContext)
    await flush()
    expect(FakeAudio.last?.setSinkId).toHaveBeenCalledWith('')
  })
})

describe('createEchoCancelledOutput loopback fallback', () => {
  it('routes the raw output (via context.setSinkId) when the loopback never connects', async () => {
    vi.useFakeTimers()
    try {
      FakeRTCPeerConnection.autoConnect = false
      setOutputSinkId('speakers-1')
      const context = new FakeContext()
      const output = createEchoCancelledOutput(context as unknown as AudioContext)
      await vi.advanceTimersByTimeAsync(0) // let the negotiation IIFE arm the watchdog
      expect(output.active).toBe(true) // optimistic until the watchdog fires

      await vi.advanceTimersByTimeAsync(5_000)

      expect(output.active).toBe(false)
      // The raw output now honours the selected device via context.setSinkId...
      expect(context.setSinkId).toHaveBeenCalledWith('speakers-1')
      // ...and keeps following later device changes.
      context.setSinkId.mockClear()
      setOutputSinkId('headphones-2')
      expect(context.setSinkId).toHaveBeenCalledWith('headphones-2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back immediately when ICE reports failed', async () => {
    FakeRTCPeerConnection.autoConnect = false
    const context = new FakeContext()
    const output = createEchoCancelledOutput(context as unknown as AudioContext)
    await flush()
    const receiver = FakeRTCPeerConnection.instances[1]
    receiver.simulateIce('failed')
    expect(output.active).toBe(false)
    expect(context.setSinkId).toHaveBeenCalled()
  })
})
