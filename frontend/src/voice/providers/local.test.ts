import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VoiceEvent } from './types'
import { LocalHybridVoiceProvider } from './local'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static OPEN = 1
  readyState = 0
  url: string
  sent: string[] = []
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
    this.sent.push(data)
  })

  close = vi.fn()
}

const grant = { provider: 'local', token: 'ticket-123', model: 'faster-whisper/small.en', expires_at: '' }

function setup() {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const events: VoiceEvent[] = []
  const provider = new LocalHybridVoiceProvider('http://api.test', grant, (e) => events.push(e))
  return { provider, events, ws: () => FakeWebSocket.instances[0] }
}

afterEach(() => vi.unstubAllGlobals())

describe('LocalHybridVoiceProvider', () => {
  it('opens a ws to /api/voice/local with the ticket and a client_time', async () => {
    const { provider, ws } = setup()
    const connected = provider.connect()
    expect(ws().url).toMatch(/^ws:\/\/api\.test\/api\/voice\/local\?ticket=ticket-123&client_time=/)
    ws().open()
    await expect(connected).resolves.toBeUndefined()
  })

  it('streams 16 kHz audio (STT sample rate)', () => {
    const { provider } = setup()
    expect(provider.inputSampleRate).toBe(16_000)
  })

  it('forwards shared VoiceEvents, and diagnostic/escalation, straight through', async () => {
    const { provider, events, ws } = setup()
    const connected = provider.connect()
    ws().open()
    await connected

    ws().emit({ type: 'open' })
    ws().emit({ type: 'user-transcript', text: 'show me tomorrow', final: true })
    ws().emit({
      type: 'diagnostic',
      stage: 'interpretation',
      data: { disposition: 'handled_locally', intent: 'calendar.show_view' },
    })
    ws().emit({ type: 'tool-call', id: 'local-1', name: 'show_view', args: { view: 'week' } })
    ws().emit({ type: 'generation-complete' })
    ws().emit({ type: 'turn-complete' })

    expect(events.map((e) => e.type)).toEqual([
      'open',
      'user-transcript',
      'diagnostic',
      'tool-call',
      'generation-complete',
      'turn-complete',
    ])
    expect((window as unknown as { __voiceLocal?: { intent?: string } }).__voiceLocal?.intent).toBe(
      'calendar.show_view',
    )
  })

  it('emits an escalation event with its structured payload', async () => {
    const { provider, events, ws } = setup()
    const connected = provider.connect()
    ws().open()
    await connected

    ws().emit({
      type: 'escalation',
      reason: 'planning question',
      tier: 2,
      payload: { transcript: 'which day is least busy', events_in_scope: [] },
    })
    expect(events[0]).toMatchObject({ type: 'escalation', tier: 2 })
  })

  it('sends turn boundaries, audio, text bypass and JSON-string tool results', async () => {
    const { provider, ws } = setup()
    const connected = provider.connect()
    ws().open()
    await connected

    provider.startActivity()
    provider.sendAudio('QQ==')
    provider.endActivity()
    provider.sendText('open the dentist appointment')
    provider.respondTool('local-1', 'get_timer', { running: true, remaining_minutes: 4 })
    provider.respondTool('local-2', 'x', { ok: false, error: 'nope' })

    expect(ws().sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'activity-start' },
      { type: 'audio', data: 'QQ==' },
      { type: 'activity-end' },
      { type: 'text', text: 'open the dentist appointment' },
      { type: 'tool-response', id: 'local-1', name: 'get_timer', output: '{"running":true,"remaining_minutes":4}' },
      { type: 'tool-response', id: 'local-2', name: 'x', output: '{"error":"nope"}' },
    ])
  })

  it('rejects connect when the pipeline closes before opening (bad ticket / LAN gate)', async () => {
    const { provider, ws } = setup()
    const connected = provider.connect()
    ws().onclose?.({ code: 4401, reason: 'bad ticket' })
    await expect(connected).rejects.toMatchObject({ kind: 'session' })
  })
})
