// `AzureKeywordDetector` — the backend-relayed wake detector. The keyword
// spotting itself is the backend's job (native Speech SDK, tested there); this
// covers the browser side: the socket, the mic → `{type:'audio'}` stream, the
// `{type:'wake'}` → `onWake` path with cooldown, suspend/resume, and the
// fall-back-to-push-to-talk contract when the socket is refused.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MicFrameListener, MicSource } from '../audio'
import { AzureKeywordDetector } from './azureKeyword'
import { WakeUnavailableError } from './detector'
import type { WakeDetectorConfig } from './detector'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  url: string
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data))
  })

  close = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code: 1000 })
  })
}

const CONFIG: WakeDetectorConfig = {
  provider: 'azure',
  apiBaseUrl: 'http://api.test',
  modelPath: '/models/wake/mission_control.onnx',
  modelsBaseUrl: '/models/wake',
  threshold: 0.5,
  cooldownMs: 2_000,
}

function fakeMic() {
  let listener: MicFrameListener | null = null
  const unsubscribe = vi.fn()
  const micSource = {
    subscribe: vi.fn(async (fn: MicFrameListener) => {
      listener = fn
      return { unsubscribe }
    }),
  } as unknown as MicSource
  return { micSource, unsubscribe, frame: (samples = 480) => listener?.(new Float32Array(samples).fill(0.2), 24_000) }
}

afterEach(() => vi.unstubAllGlobals())

describe('AzureKeywordDetector', () => {
  it('opens the backend socket and starts streaming mic audio once open', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    const { micSource, frame } = fakeMic()
    const detector = new AzureKeywordDetector(CONFIG, micSource)

    const started = detector.start({ onWake: vi.fn() })
    const ws = FakeWebSocket.instances[0]
    expect(ws.url).toBe('ws://api.test/api/voice/wake/azure')
    ws.open()
    await started

    frame()
    expect(ws.sent.some((m) => m.type === 'audio' && typeof m.pcm === 'string')).toBe(true)
  })

  it('fires onWake on a server wake frame, once per cooldown', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    const { micSource } = fakeMic()
    const onWake = vi.fn()
    const detector = new AzureKeywordDetector(CONFIG, micSource)
    const started = detector.start({ onWake })
    FakeWebSocket.instances[0].open()
    await started

    FakeWebSocket.instances[0].emit({ type: 'wake', score: 1 })
    FakeWebSocket.instances[0].emit({ type: 'wake', score: 1 })
    expect(onWake).toHaveBeenCalledTimes(1)
    expect(onWake.mock.calls[0][0]).toMatchObject({ score: 1 })
  })

  it('suspend/resume send control frames and gate the audio stream', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    const { micSource, frame } = fakeMic()
    const detector = new AzureKeywordDetector(CONFIG, micSource)
    const started = detector.start({ onWake: vi.fn() })
    const ws = FakeWebSocket.instances[0]
    ws.open()
    await started

    detector.suspend()
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'suspend' })
    ws.send.mockClear()
    ws.sent.length = 0
    frame()
    expect(ws.sent.some((m) => m.type === 'audio')).toBe(false)

    detector.resume()
    expect(ws.sent.some((m) => m.type === 'resume')).toBe(true)
  })

  it('rejects with WakeUnavailableError when the socket is refused (→ push-to-talk)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    const { micSource } = fakeMic()
    const detector = new AzureKeywordDetector(CONFIG, micSource)
    const started = detector.start({ onWake: vi.fn() })
    FakeWebSocket.instances[0].onclose?.({ code: 4404, reason: 'wake not configured' })
    await expect(started).rejects.toBeInstanceOf(WakeUnavailableError)
  })

  it('dispose closes the socket and releases the mic', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    const { micSource, unsubscribe } = fakeMic()
    const detector = new AzureKeywordDetector(CONFIG, micSource)
    const started = detector.start({ onWake: vi.fn() })
    FakeWebSocket.instances[0].open()
    await started

    detector.dispose()
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalled()
    expect(detector.running).toBe(false)
  })
})
