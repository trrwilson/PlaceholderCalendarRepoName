import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { speakerOut } from './speakerOut'
import { SPEAKER_RATE } from './speakerMix'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 0
  binaryType = ''
  bufferedAmount = 0
  url: string
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  status(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ t: 'status', ...frame }) })
  }

  drop() {
    this.readyState = 3
    this.onclose?.()
  }

  send = vi.fn((data: unknown) => this.sent.push(data))
  close = vi.fn(() => {
    this.readyState = 3
  })
}

const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
})

afterEach(() => {
  speakerOut.setRoute('screen', 'http://api.test')
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('speakerOut', () => {
  it('opens the speaker socket only when routed to the Invoke', () => {
    speakerOut.setRoute('screen', 'http://api.test')
    expect(FakeWebSocket.instances).toHaveLength(0)

    speakerOut.setRoute('invoke', 'http://api.test')
    expect(last().url).toBe('ws://api.test/api/voice/speaker')
    expect(last().binaryType).toBe('arraybuffer')
  })

  it('reports the link as carrying audio and mutes local playout once open', () => {
    const routed: boolean[] = []
    speakerOut.createTap('assistant').onRouted((r) => routed.push(r))

    speakerOut.setRoute('invoke', 'http://api.test')
    expect(speakerOut.status().connected).toBe(false)
    last().open()

    expect(speakerOut.status().connected).toBe(true)
    expect(routed).toEqual([false, true]) // initial, then open
  })

  it('streams mixed frames as binary once the socket is open', () => {
    const tap = speakerOut.createTap('assistant')
    speakerOut.setRoute('invoke', 'http://api.test')

    tap.pushFrames(new Float32Array(2400).fill(0.5), SPEAKER_RATE)
    expect(last().send).not.toHaveBeenCalled() // not open yet — nothing sent

    last().open()
    tap.pushFrames(new Float32Array(2400).fill(0.5), SPEAKER_RATE)
    expect(last().send).toHaveBeenCalledOnce()
    expect(last().sent[0]).toBeInstanceOf(ArrayBuffer)
  })

  it('surfaces backend status frames to subscribers', () => {
    const seen: string[] = []
    speakerOut.onStatusChange((s) => seen.push(`${s.link}/${s.reconnects}`))
    speakerOut.setRoute('invoke', 'http://api.test')
    last().open()
    last().status({ link: 'up', reconnects: 2, sheds: 1 })

    const status = speakerOut.status()
    expect(status.link).toBe('up')
    expect(status.reconnects).toBe(2)
    expect(status.sheds).toBe(1)
    expect(seen[seen.length - 1]).toBe('up/2')
  })

  it('reconnects with backoff while still routed to the Invoke', () => {
    vi.useFakeTimers()
    speakerOut.setRoute('invoke', 'http://api.test')
    last().open()
    expect(FakeWebSocket.instances).toHaveLength(1)

    last().drop()
    expect(speakerOut.status().connected).toBe(false)
    vi.advanceTimersByTime(600)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('stops reconnecting once routed back to the screen', () => {
    vi.useFakeTimers()
    speakerOut.setRoute('invoke', 'http://api.test')
    last().open()
    last().drop()
    speakerOut.setRoute('screen', 'http://api.test')
    vi.advanceTimersByTime(10_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
