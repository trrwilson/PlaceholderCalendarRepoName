import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appSocket } from '../realtime/appSocket'
import type { PhotoStreamSnapshot } from './types'
import { usePhotoStream } from './usePhotoStream'

class FakeWebSocket {
  static last: FakeWebSocket | null = null
  listeners: Record<string, ((event: unknown) => void)[]> = {}
  constructor() { FakeWebSocket.last = this }
  addEventListener(type: string, cb: (event: unknown) => void) { ;(this.listeners[type] ??= []).push(cb) }
  removeEventListener() {}
  close() {}
  emit(type: string, event?: unknown) { ;(this.listeners[type] ?? []).forEach((cb) => cb(event)) }
  message(payload: unknown) { this.emit('message', { data: JSON.stringify(payload) }) }
}

const snap = (ids: string[]): PhotoStreamSnapshot => ({
  enabled: true,
  status: 'ok',
  photos: ids.map((id) => ({ id, name: id, width: null, height: null, taken_at: null, version: 'v', bytes: 1 })),
  last_sync: null,
  detail: null,
})

beforeEach(() => {
  appSocket.__resetForTests()
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
})
afterEach(() => vi.unstubAllGlobals())

describe('usePhotoStream', () => {
  it('reconciles from GET /api/photos and applies pushed snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => snap(['a']) }))
    const { result } = renderHook(() => usePhotoStream('http://api'))
    await waitFor(() => expect(result.current.photos.map((p) => p.id)).toEqual(['a']))
    act(() => FakeWebSocket.last!.message({ type: 'photos', photos: snap(['a', 'b']) }))
    expect(result.current.photos.map((p) => p.id)).toEqual(['a', 'b'])
    act(() => FakeWebSocket.last!.message({ type: 'lists', lists: [] }))
    expect(result.current.photos).toHaveLength(2)
  })

  it('stays disabled when the backend reports the feature off', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...snap([]), enabled: false, status: 'disabled' }) }))
    const { result } = renderHook(() => usePhotoStream('http://api'))
    await waitFor(() => expect(result.current.status).toBe('disabled'))
    expect(result.current.enabled).toBe(false)
  })
})
