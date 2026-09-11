import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appSocket } from '../realtime/appSocket'
import type { CameraGallerySnapshot, StoredClip } from './types'
import { useCameraActivity } from './useCameraActivity'

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

const clip = (over: Partial<StoredClip> = {}): StoredClip => ({
  clip_id: 'a:1',
  camera_id: 'a',
  camera_name: 'Front Door',
  occurred_at: '2026-09-07T18:30:00',
  approx_duration_seconds: 20,
  has_thumbnail: true,
  ...over,
})

const snapshot = (over: Partial<CameraGallerySnapshot> = {}): CameraGallerySnapshot => ({
  clips: [],
  source_status: 'connected',
  cameras_online: true,
  ...over,
})

const url = 'http://api.test'

beforeEach(() => {
  appSocket.__resetForTests()
  FakeWebSocket.last = null
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => snapshot() }))
})

afterEach(() => vi.unstubAllGlobals())

describe('useCameraActivity', () => {
  it('reconciles from GET /api/household on mount', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => snapshot({ clips: [clip()] }) }),
    )
    const { result } = renderHook(() => useCameraActivity(url))
    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.clips).toHaveLength(1)
    expect(result.current.clips[0].clip_id).toBe('a:1')
  })

  it('treats a 409 as unavailable and clears any prior clips', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({}) }))
    const { result } = renderHook(() => useCameraActivity(url))
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(result.current.clips).toEqual([])
  })

  it('applies a camera_clips push from the shared socket', async () => {
    const { result } = renderHook(() => useCameraActivity(url))
    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull())
    act(() => {
      FakeWebSocket.last!.message({
        type: 'camera_clips',
        message: 'x',
        camera_clips: [clip({ clip_id: 'b:2', camera_name: 'KittyCam' })],
        camera_status: 'connected',
      })
    })
    expect(result.current.available).toBe(true)
    expect(result.current.clips[0].clip_id).toBe('b:2')
    expect(result.current.sourceStatus).toBe('connected')
  })

  it('ignores messages of other types', async () => {
    const { result } = renderHook(() => useCameraActivity(url))
    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull())
    act(() => {
      FakeWebSocket.last!.message({ type: 'display', message: 'x' })
    })
    expect(result.current.clips).toEqual([])
  })
})
