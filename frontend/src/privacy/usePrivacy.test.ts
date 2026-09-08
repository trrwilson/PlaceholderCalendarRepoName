import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appSocket } from '../realtime/appSocket'
import type { PrivacyState } from './types'
import { usePrivacy } from './usePrivacy'

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

const state = (over: Partial<PrivacyState> = {}): PrivacyState => ({
  locked: false,
  since: null,
  available: true,
  ...over,
})

const options = 'http://api.test'

beforeEach(() => {
  appSocket.__resetForTests()
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => state() }))
})

afterEach(() => vi.unstubAllGlobals())

describe('usePrivacy', () => {
  it('reconciles from GET /api/privacy on mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => state({ locked: true, since: 'x' }) }),
    )
    const { result } = renderHook(() => usePrivacy(options))
    await waitFor(() => expect(result.current.locked).toBe(true))
    expect(result.current.available).toBe(true)
  })

  it('applies a privacy push from the shared socket', async () => {
    const { result } = renderHook(() => usePrivacy(options))
    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull())

    act(() => {
      FakeWebSocket.last!.message({
        type: 'privacy-locked',
        message: 'Privacy mode on',
        privacy: state({ locked: true }),
      })
    })
    expect(result.current.locked).toBe(true)

    act(() => {
      FakeWebSocket.last!.message({
        type: 'privacy-unlocked',
        message: 'off',
        privacy: state({ locked: false }),
      })
    })
    expect(result.current.locked).toBe(false)
  })

  it('ignores a non-privacy frame', async () => {
    const { result } = renderHook(() => usePrivacy(options))
    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull())
    act(() => {
      FakeWebSocket.last!.message({ type: 'timer-started', message: 'x', timers: [] })
    })
    expect(result.current.locked).toBe(false)
  })

  it('lock() posts and unlock() sends the PIN', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => state() }) // mount GET
      .mockResolvedValueOnce({ ok: true, json: async () => state({ locked: true }) }) // lock
      .mockResolvedValueOnce({ ok: true, json: async () => state({ locked: false }) }) // unlock
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => usePrivacy(options))
    await act(async () => {
      expect(await result.current.lock()).toBe(true)
    })
    expect(result.current.locked).toBe(true)

    await act(async () => {
      expect(await result.current.unlock('8426')).toBe('ok')
    })
    const unlockCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/privacy/unlock'))
    expect(JSON.parse((unlockCall?.[1] as { body: string }).body)).toEqual({ pin: '8426' })
    expect(result.current.locked).toBe(false)
  })

  it('unlock() surfaces a 429 cooldown with the Retry-After', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => state() })
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === 'retry-after' ? '30' : null) },
        json: async () => ({}),
      })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => usePrivacy(options))
    await act(async () => {
      expect(await result.current.unlock('0000')).toBe('locked-out')
    })
    await waitFor(() => expect(result.current.cooldownMs).toBeGreaterThan(0))
    expect(result.current.cooldownMs).toBeLessThanOrEqual(30_000)
  })

  it('unlock() maps a wrong PIN to bad-pin', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => state() })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => usePrivacy(options))
    await act(async () => {
      expect(await result.current.unlock('0000')).toBe('bad-pin')
    })
  })
})
