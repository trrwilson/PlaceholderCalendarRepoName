// `GatedWakeDetector` — the on-device Invoke gate layered in front of a base
// wake detector. The daemon + its protocol are tested in the ReInvoke2026 repo;
// this covers the browser side: the bridge socket, the compose-and-re-verify
// contract (a bare gate `wake` is never enough), the gate-false-accept drop, and
// the control commands driven back to the gate.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WakeDetector, WakeDetectorConfig, WakeEvent } from './detector'
import { WakeUnavailableError } from './detector'
import { GatedWakeDetector } from './gatedDetector'

/** A stand-in for the base detector (openWakeWord / Azure). */
class FakeBase implements WakeDetector {
  running = false
  suspended = false
  onWake: ((e: WakeEvent) => void) | null = null
  resumeCalls: Array<{ resetCooldown?: boolean } | undefined> = []
  start = vi.fn(async (h: { onWake: (e: WakeEvent) => void }) => {
    this.onWake = h.onWake
    this.running = true
  })
  suspend = vi.fn(() => {
    this.suspended = true
  })
  resume = vi.fn((opts?: { resetCooldown?: boolean }) => {
    this.suspended = false
    this.resumeCalls.push(opts)
  })
  takeRetainedAudio = vi.fn(() => ['base-chunk'])
  dispose = vi.fn()
}

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
  provider: 'openwakeword',
  apiBaseUrl: 'http://api.test',
  modelPath: '/models/wake/mission_control.onnx',
  modelsBaseUrl: '/models/wake',
  threshold: 0.5,
  cooldownMs: 2_000,
  invokeGateEnabled: true,
}

async function armed(config: WakeDetectorConfig = CONFIG) {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  FakeWebSocket.instances = []
  const base = new FakeBase()
  const onWake = vi.fn()
  const detector = new GatedWakeDetector(config, base)
  const started = detector.start({ onWake })
  const ws = FakeWebSocket.instances[0]
  ws.open()
  await started
  return { detector, onWake, ws, base }
}

afterEach(() => vi.unstubAllGlobals())

describe('GatedWakeDetector', () => {
  it('opens the bridge socket, starts the base detector suspended, and gates the device', async () => {
    const { ws, base } = await armed()
    expect(ws.url).toBe('ws://api.test/api/voice/wake/invoke')
    expect(base.start).toHaveBeenCalledTimes(1)
    expect(base.suspend).toHaveBeenCalled()
    expect(ws.sent).toContainEqual({ cmd: 'gate_enabled', on: true })
  })

  it('does not fire onWake on a bare gate `wake` — the base detector must confirm', async () => {
    const { ws, onWake, base } = await armed()
    ws.emit({ t: 'wake', score: 1, reason: 'kws' })
    expect(onWake).not.toHaveBeenCalled()
    expect(base.resume).not.toHaveBeenCalled()
  })

  it('re-arms the base detector on gate open (no cooldown reset) and forwards its wake', async () => {
    const { ws, onWake, base } = await armed()
    ws.emit({ t: 'state', state: 'open', open: true, reason: 'kws' })
    expect(base.resume).toHaveBeenCalledWith({ resetCooldown: false })

    const event = { score: 0.9, at: performance.now() }
    base.onWake?.(event)
    expect(onWake).toHaveBeenCalledTimes(1)
    expect(onWake).toHaveBeenCalledWith(event)
  })

  it('drops a gate open that closes before the base detector confirms (gate false accept)', async () => {
    const { ws, onWake, base } = await armed()
    ws.emit({ t: 'state', state: 'open', open: true, reason: 'kws' })
    base.suspend.mockClear()
    ws.emit({ t: 'state', state: 'off', open: false, reason: 'no_speech' })
    expect(base.suspend).toHaveBeenCalled()
    base.onWake?.({ score: 0.9, at: performance.now() })
    expect(onWake).not.toHaveBeenCalled()
  })

  it('endActivation() sends {cmd:"done"} to the gate', async () => {
    const { ws, detector } = await armed()
    detector.endActivation()
    expect(ws.sent).toContainEqual({ cmd: 'done' })
  })

  it('sendControl forwards allow-listed commands and drops others', async () => {
    const { ws, detector } = await armed()
    detector.sendControl('ptt_start')
    detector.sendControl('hold', { seconds: 30 })
    detector.sendControl('rm-rf')
    expect(ws.sent).toContainEqual({ cmd: 'ptt_start' })
    expect(ws.sent).toContainEqual({ cmd: 'hold', seconds: 30 })
    expect(ws.sent.some((m) => m.cmd === 'rm-rf')).toBe(false)
  })

  it('takeRetainedAudio delegates to the base detector', async () => {
    const { detector, base } = await armed()
    expect(detector.takeRetainedAudio(16_000)).toEqual(['base-chunk'])
    expect(base.takeRetainedAudio).toHaveBeenCalledWith(16_000)
  })

  it('dispose tells the gate to stream continuously, disposes the base detector, and closes the socket', async () => {
    const { detector, ws, base } = await armed()
    ws.sent.length = 0
    detector.dispose()
    expect(ws.sent).toContainEqual({ cmd: 'gate_enabled', on: false })
    expect(base.dispose).toHaveBeenCalled()
    expect(ws.close).toHaveBeenCalled()
    expect(detector.running).toBe(false)
  })

  it('rejects with WakeUnavailableError when the bridge socket is refused (→ push-to-talk)', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    const detector = new GatedWakeDetector(CONFIG, new FakeBase())
    const started = detector.start({ onWake: vi.fn() })
    FakeWebSocket.instances[0].onclose?.({ code: 4404, reason: 'invoke gate host unset' })
    await expect(started).rejects.toBeInstanceOf(WakeUnavailableError)
  })
})
