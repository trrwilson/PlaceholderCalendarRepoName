import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useActivityPing } from './useActivityPing'

const url = 'http://api.test'

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useActivityPing', () => {
  it('POSTs a touch activity pulse on pointerdown', () => {
    renderHook(() => useActivityPing(url))
    document.dispatchEvent(new Event('pointerdown'))
    expect(fetch).toHaveBeenCalledWith(
      `${url}/api/presence/activity`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ source: 'touch' }) }),
    )
  })

  it('throttles a burst of taps to one request', () => {
    renderHook(() => useActivityPing(url))
    document.dispatchEvent(new Event('pointerdown'))
    document.dispatchEvent(new Event('pointerdown'))
    document.dispatchEvent(new Event('pointerdown'))
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('sends again once the throttle window elapses', () => {
    renderHook(() => useActivityPing(url))
    document.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(10_001)
    document.dispatchEvent(new Event('pointerdown'))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useActivityPing(url))
    unmount()
    document.dispatchEvent(new Event('pointerdown'))
    expect(fetch).not.toHaveBeenCalled()
  })
})
