import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VoiceEvent } from './types'
import { RelayVoiceProvider } from './relay'

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

const grant = { provider: 'azure_openai_realtime', token: 'tick et/1', model: 'gpt-realtime-2.1', expires_at: '' }

function setup() {
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  const events: VoiceEvent[] = []
  const provider = new RelayVoiceProvider('http://api.test', grant, (e) => events.push(e))
  return { provider, events, ws: () => FakeWebSocket.instances[0] }
}

afterEach(() => vi.unstubAllGlobals())

describe('RelayVoiceProvider', () => {
  it('opens a ws to our relay with the ticket and resolves connect on open', async () => {
    const { provider, ws } = setup()
    const connected = provider.connect()
    expect(ws().url).toBe('ws://api.test/api/voice/live?ticket=tick%20et%2F1')
    ws().open()
    await expect(connected).resolves.toBeUndefined()
  })

  it('forwards relay event frames straight through as VoiceEvents', async () => {
    const { provider, events, ws } = setup()
    const connected = provider.connect()
    ws().open()
    await connected

    ws().emit({ type: 'open' })
    ws().emit({ type: 'user-transcript', text: 'whats up', final: true })
    ws().emit({ type: 'audio', data: 'AQID' })
    ws().emit({ type: 'tool-call', id: 'c1', name: 'get_agenda', args: { date: '2026-09-06' } })
    ws().emit({ type: 'generation-complete' })

    expect(events).toEqual([
      { type: 'open' },
      { type: 'user-transcript', text: 'whats up', final: true },
      { type: 'audio', data: 'AQID' },
      { type: 'tool-call', id: 'c1', name: 'get_agenda', args: { date: '2026-09-06' } },
      { type: 'generation-complete' },
    ])
  })

  it('assembles the user transcript: deltas accumulate, the final frame replaces', async () => {
    const { provider, events, ws } = setup()
    const connected = provider.connect()
    ws().open()
    await connected

    ws().emit({ type: 'user-transcript', text: "when's", final: false })
    ws().emit({ type: 'user-transcript', text: ' the', final: false })
    ws().emit({ type: 'user-transcript', text: ' dentist', final: false })
    ws().emit({ type: 'user-transcript', text: "when's the dentist appointment", final: true })

    expect(events.map((e) => (e as { text: string }).text)).toEqual([
      "when's",
      "when's the",
      "when's the dentist",
      "when's the dentist appointment",
    ])
    expect(events.at(-1)).toEqual({
      type: 'user-transcript',
      text: "when's the dentist appointment",
      final: true,
    })
  })

  it('translates an error frame to a session error', async () => {
    const { provider, events, ws } = setup()
    const connected = provider.connect()
    ws().open()
    await connected
    ws().emit({ type: 'error', message: 'rate limited' })
    expect(events[0]).toMatchObject({ type: 'error', kind: 'session' })
    expect((events[0] as { error: Error }).error.message).toBe('rate limited')
  })

  it('sends mic audio, turn boundaries and tool responses as relay frames', async () => {
    const { provider, ws } = setup()
    const connected = provider.connect()
    ws().open()
    await connected

    provider.startActivity()
    provider.sendAudio('QQ==')
    provider.endActivity()
    provider.respondTool('c1', 'get_agenda', { events: [] })
    // A failing dispatch result is serialised as an { error } string.
    provider.respondTool('c2', 'x', { ok: false, error: 'boom' })

    expect(ws().sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'activity-start' },
      { type: 'audio', data: 'QQ==' },
      { type: 'activity-end' },
      // `output` is a JSON *string* — the realtime function_call_output contract.
      { type: 'tool-response', id: 'c1', name: 'get_agenda', output: '{"events":[]}' },
      { type: 'tool-response', id: 'c2', name: 'x', output: '{"error":"boom"}' },
    ])
  })

  it('reports an unclean close as an error and a clean one as closing', async () => {
    const { provider, events, ws } = setup()
    const connected = provider.connect()
    ws().open()
    await connected

    ws().onclose?.({ code: 1011, reason: 'boom' })
    expect(events[events.length - 1]).toMatchObject({ type: 'error', kind: 'session' })

    ws().onclose?.({ code: 1000 })
    expect(events[events.length - 1]).toEqual({ type: 'closing' })
  })

  it('rejects connect when the relay closes before opening (bad ticket / LAN gate)', async () => {
    const { provider, ws } = setup()
    const connected = provider.connect()
    ws().onclose?.({ code: 4401, reason: 'bad ticket' })
    await expect(connected).rejects.toMatchObject({ kind: 'session' })
  })

  it('input sample rate matches the Azure realtime protocol', () => {
    const { provider } = setup()
    expect(provider.inputSampleRate).toBe(24_000)
  })

  it('defaults endpointing to `client` and brackets the turn', () => {
    const { provider } = setup()
    expect(provider.endpointing).toBe('client')
  })

  it('provider endpointing: sends no activity markers — the upstream VAD owns the turn', async () => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const provider = new RelayVoiceProvider(
      'http://api.test',
      { ...grant, endpointing: 'provider' },
      () => {},
    )
    const connected = provider.connect()
    FakeWebSocket.instances[0].open()
    await connected

    provider.startActivity()
    provider.sendAudio('QQ==')
    provider.endActivity()

    expect(provider.endpointing).toBe('provider')
    expect(FakeWebSocket.instances[0].sent.map((s) => JSON.parse(s))).toEqual([
      { type: 'audio', data: 'QQ==' },
    ])
  })
})
