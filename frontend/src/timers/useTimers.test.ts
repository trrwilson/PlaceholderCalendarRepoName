import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appSocket } from '../realtime/appSocket'
import type { Timer } from './types'
import { useTimers } from './useTimers'

class FakeWebSocket {
  static last: FakeWebSocket | null = null
  listeners: Record<string, ((event: unknown) => void)[]> = {}
  url: string
  constructor(url: string) {
    this.url = url
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

const runningTimer = (firesInMs: number, overrides: Partial<Timer> = {}): Timer => {
  const now = Date.now()
  return {
    id: 't1',
    label: 'pasta',
    created_at: new Date(now).toISOString(),
    fires_at: new Date(now + firesInMs).toISOString(),
    duration_seconds: Math.round(firesInMs / 1000),
    state: 'running',
    ...overrides,
  }
}

const options = { apiBaseUrl: 'http://api.test' }

beforeEach(() => {
  appSocket.__resetForTests()
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useTimers', () => {
  it('adopts a timer from a WS push and counts it down', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTimers(options))

    act(() => {
      FakeWebSocket.last!.message({ type: 'timer-started', message: 'x', timers: [runningTimer(60_000)] })
    })
    expect(result.current.hasActiveTimer).toBe(true)
    expect(result.current.remainingMs).toBeGreaterThan(58_000)

    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current.remainingMs).toBeLessThanOrEqual(55_000)
    expect(result.current.alarm).toBe(false)
  })

  it('enters the alarm state from the local clock even with no fire push', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTimers(options))
    act(() => {
      FakeWebSocket.last!.message({ type: 'timer-started', message: 'x', timers: [runningTimer(3_000)] })
    })
    expect(result.current.alarm).toBe(false)

    act(() => vi.advanceTimersByTime(4_000))
    expect(result.current.alarm).toBe(true)
  })

  it('applies a fired push and then clears on a dismiss push', () => {
    const { result } = renderHook(() => useTimers(options))
    const timer = runningTimer(1_000)

    act(() => {
      FakeWebSocket.last!.message({
        type: 'timer-fired',
        message: 'Timer finished',
        timer: { ...timer, state: 'fired' },
        timers: [{ ...timer, state: 'fired' }],
      })
    })
    expect(result.current.alarm).toBe(true)

    act(() => {
      FakeWebSocket.last!.message({ type: 'timer-dismissed', message: 'x', timers: [] })
    })
    expect(result.current.hasActiveTimer).toBe(false)
    expect(result.current.alarm).toBe(false)
  })

  it('reconciles against GET /api/timers when the socket (re)opens', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [runningTimer(120_000)] })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTimers(options))
    act(() => FakeWebSocket.last!.emit('open'))

    await waitFor(() => expect(result.current.hasActiveTimer).toBe(true))
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/timers')
  })

  it('start() posts the duration and reports a replaced timer', async () => {
    const replaced = runningTimer(60_000, { id: 'old', label: 'tea' })
    const created = runningTimer(300_000, { id: 'new', label: 'rice' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ timer: created, replaced }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const onStarted = vi.fn()

    const { result } = renderHook(() => useTimers({ ...options, onStarted }))
    await act(async () => {
      await result.current.start(300, 'rice')
    })

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
    expect(JSON.parse(lastCall[1].body)).toEqual({ duration_seconds: 300, label: 'rice' })
    expect(result.current.timer?.id).toBe('new')
    expect(onStarted).toHaveBeenCalledWith(created, replaced)
  })

  it('holds a paused timer at its frozen remaining time without ticking', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTimers(options))
    const paused: Timer = {
      ...runningTimer(60_000),
      state: 'paused',
      remaining_seconds: 42,
    }
    act(() => {
      FakeWebSocket.last!.message({ type: 'timer-paused', message: 'x', timers: [paused] })
    })
    expect(result.current.hasActiveTimer).toBe(true)
    expect(result.current.alarm).toBe(false)
    expect(result.current.remainingMs).toBe(42_000)

    act(() => vi.advanceTimersByTime(10_000))
    expect(result.current.remainingMs).toBe(42_000)
  })

  it('pause() posts to the pause sub-resource and adopts the result', async () => {
    const running = runningTimer(120_000)
    const fetchMock = vi.fn((...args: Parameters<typeof fetch>) =>
      Promise.resolve(
        String(args[0]).endsWith('/pause')
          ? { ok: true, json: async () => ({ ...running, state: 'paused', remaining_seconds: 90 }) }
          : { ok: true, json: async () => [running] },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useTimers(options))
    await waitFor(() => expect(result.current.hasActiveTimer).toBe(true))

    await act(async () => {
      await result.current.pause()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/pause'))!
    expect(call).toBeTruthy()
    expect(call[1]).toMatchObject({ method: 'POST' })
    expect(result.current.timer?.state).toBe('paused')
  })

  it('throws the backend message when a start is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ detail: 'Timers can be at most six hours.' }),
      }),
    )
    const { result } = renderHook(() => useTimers(options))
    await expect(result.current.start(30_000)).rejects.toThrow('at most six hours')
  })
})
