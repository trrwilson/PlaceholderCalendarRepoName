import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appSocket } from '../realtime/appSocket'
import type { GroceryList } from './types'
import { useLists } from './useLists'

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

const grocery = (items: GroceryList['items'], recent: string[] = []): GroceryList => ({
  id: 'grocery',
  title: 'Grocery',
  updated_at: new Date().toISOString(),
  recent_names: recent,
  items,
})

const item = (id: string, name: string, checked = false) => ({
  id,
  name,
  note: null,
  checked,
  added_at: new Date().toISOString(),
  checked_at: checked ? new Date().toISOString() : null,
  source: 'touch' as const,
})

const options = { apiBaseUrl: 'http://api.test' }

beforeEach(() => {
  appSocket.__resetForTests()
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => grocery([]) }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useLists', () => {
  it('reconciles from GET /api/lists on mount and derives the unchecked count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => grocery([item('a', 'Milk'), item('b', 'Eggs', true)]) }),
    )
    const { result } = renderHook(() => useLists(options))
    await waitFor(() => expect(result.current.list?.items).toHaveLength(2))
    expect(result.current.uncheckedCount).toBe(1)
  })

  it('applies a list push from the shared socket', async () => {
    const { result } = renderHook(() => useLists(options))
    await waitFor(() => expect(result.current.list).not.toBeNull())

    act(() => {
      FakeWebSocket.last!.message({
        type: 'list-item-added',
        message: 'Added bread',
        lists: [grocery([item('c', 'Bread')])],
      })
    })
    expect(result.current.list?.items.map((i) => i.name)).toEqual(['Bread'])
  })

  it('ignores a non-list frame on the shared socket', async () => {
    const { result } = renderHook(() => useLists(options))
    await waitFor(() => expect(result.current.list).not.toBeNull())
    act(() => {
      FakeWebSocket.last!.message({ type: 'timer-started', message: 'x', timers: [] })
    })
    expect(result.current.list?.items).toEqual([])
  })

  it('fires onRemoved with the cleared items so the UI can offer Undo', async () => {
    const onRemoved = vi.fn()
    renderHook(() => useLists({ ...options, onRemoved }))
    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull())

    const removed = [item('a', 'Milk'), item('b', 'Eggs')]
    act(() => {
      FakeWebSocket.last!.message({
        type: 'list-cleared',
        message: 'Cleared 2 items (all)',
        lists: [grocery([])],
        removed,
      })
    })
    expect(onRemoved).toHaveBeenCalledWith(removed, 'cleared')
  })

  it('add() posts names and source', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ list: grocery([item('a', 'Milk')]), added: ['Milk'], already_present: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useLists(options))
    await act(async () => {
      await result.current.add('Milk')
    })
    const post = fetchMock.mock.calls.find(([, init]) => (init as { method?: string })?.method === 'POST')
    expect(String(post?.[0])).toContain('/api/lists/grocery/items')
    expect(JSON.parse((post?.[1] as { body: string }).body)).toMatchObject({ name: 'Milk', source: 'touch' })
  })

  it('restore() re-posts the removed items', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ list: grocery([]) }) })
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useLists(options))

    await act(async () => {
      await result.current.restore([item('a', 'Milk')])
    })
    const restore = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/restore'))
    expect(restore).toBeTruthy()
    expect(JSON.parse((restore?.[1] as { body: string }).body).items).toHaveLength(1)
  })

  it('reorder() optimistically reorders then posts the id list', async () => {
    const initial = grocery([item('a', 'Milk'), item('b', 'Eggs'), item('c', 'Bread')])
    const reordered = grocery([item('c', 'Bread'), item('a', 'Milk'), item('b', 'Eggs')])
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const target = String(url)
        if (target.endsWith('/reorder')) {
          return Promise.resolve({ ok: true, json: async () => ({ list: reordered }) })
        }
        return Promise.resolve({ ok: true, json: async () => initial })
      }),
    )
    const { result } = renderHook(() => useLists(options))
    await waitFor(() => expect(result.current.list?.items).toHaveLength(3))

    await act(async () => {
      await result.current.reorder(['c', 'a', 'b'])
    })
    expect(result.current.list?.items.map((i) => i.name)).toEqual(['Bread', 'Milk', 'Eggs'])
    const post = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).endsWith('/reorder'),
    )
    expect(JSON.parse((post?.[1] as { body: string }).body)).toEqual({ item_ids: ['c', 'a', 'b'] })
  })

  it('ignores a stale list-reordered echo right after a local reorder', async () => {
    const initial = grocery([item('a', 'Milk'), item('b', 'Eggs')])
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        if (String(url).endsWith('/reorder')) {
          return Promise.resolve({ ok: true, json: async () => ({ list: grocery([item('b', 'Eggs'), item('a', 'Milk')]) }) })
        }
        return Promise.resolve({ ok: true, json: async () => initial })
      }),
    )
    const { result } = renderHook(() => useLists(options))
    await waitFor(() => expect(result.current.list?.items).toHaveLength(2))

    await act(async () => {
      await result.current.reorder(['b', 'a'])
    })
    expect(result.current.list?.items.map((i) => i.name)).toEqual(['Eggs', 'Milk'])

    // A late broadcast carrying the OLD order must not revert the fresh drag.
    act(() => {
      FakeWebSocket.last!.message({ type: 'list-reordered', message: 'x', lists: [initial] })
    })
    expect(result.current.list?.items.map((i) => i.name)).toEqual(['Eggs', 'Milk'])
  })
})
