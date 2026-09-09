import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appSocket } from '../realtime/appSocket'
import type { DisplayState } from './types'
import { useDisplay } from './useDisplay'

class FakeWebSocket {
  static last: FakeWebSocket | null = null
  listeners: Record<string, ((event: unknown) => void)[]> = {}
  constructor() {
    FakeWebSocket.last = this
  }
  addEventListener(type: string, cb: (event: unknown) => void) {
    ;(this.listeners[type] ??= []).push(cb)
  }
  removeEventListener() {}
  close() {}
  emit(type: string, event?: unknown) {
    ;(this.listeners[type] ?? []).forEach((cb) => cb(event))
  }
  message(payload: unknown) {
    this.emit('message', { data: JSON.stringify(payload) })
  }
}

const state = (over: Partial<DisplayState> = {}): DisplayState => ({
  brightness: 100,
  reference_brightness: 100,
  night_mode: false,
  mechanism: 'none',
  colocated: false,
  available: false,
  last_error: null,
  ...over,
})

const url = 'http://api.test'

beforeEach(() => {
  appSocket.__resetForTests()
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => state() }))
})

afterEach(() => vi.unstubAllGlobals())

describe('useDisplay', () => {
  it('reconciles from GET /api/display on mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => state({ brightness: 10, night_mode: true, mechanism: 'wmi' }),
      }),
    )
    const { result } = renderHook(() => useDisplay(url))
    await waitFor(() => expect(result.current.nightMode).toBe(true))
    expect(result.current.brightness).toBe(10)
    expect(result.current.mechanism).toBe('wmi')
  })

  it('applies a display push from the shared socket', async () => {
    const { result } = renderHook(() => useDisplay(url))
    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull())
    act(() => {
      FakeWebSocket.last!.message({
        type: 'display-night-mode',
        message: 'x',
        display: state({ night_mode: true, brightness: 8, reference_brightness: 80 }),
      })
    })
    expect(result.current.nightMode).toBe(true)
    expect(result.current.reference).toBe(80)
  })

  it('setNightMode PUTs to /api/display', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => state({ night_mode: true, brightness: 10 }) })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useDisplay(url))
    await act(async () => {
      await result.current.setNightMode(true)
    })
    const call = fetchMock.mock.calls.find(
      ([u, init]) => String(u).endsWith('/api/display') && (init as { method?: string })?.method === 'PUT',
    )
    expect(call).toBeDefined()
    expect(JSON.parse((call?.[1] as { body: string }).body)).toEqual({ night_mode: true })
    expect(result.current.nightMode).toBe(true)
  })
})
