import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PHOTO_DWELL_MS, PhotoTile } from './PhotoTile'
import type { PhotoItem } from './types'

const photo = (id: string): PhotoItem => ({ id, name: `${id}.jpg`, width: 4000, height: 3000, taken_at: null, version: 'v1', bytes: 10 })
const photos = [photo('a'), photo('b'), photo('c')]
const shown = () => screen.getByRole('img').getAttribute('alt')

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom never decodes images; make every decode resolve immediately.
  // jsdom has no PointerEvent; MouseEvent carries clientX/clientY for fireEvent.
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve() } })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function flush() {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve() })
}

describe('PhotoTile', () => {
  it('renders nothing with no photos', () => {
    const { container } = render(<PhotoTile photos={[]} apiBaseUrl="" />)
    expect(container.firstChild).toBeNull()
  })

  it('advances after the dwell and wraps around', async () => {
    render(<PhotoTile photos={photos} apiBaseUrl="http://api" />)
    await flush()
    expect(shown()).toBe('a.jpg')
    expect(screen.getByRole('img').getAttribute('src')).toBe('http://api/api/photos/a?v=v1')
    for (const expected of ['b.jpg', 'c.jpg', 'a.jpg']) {
      act(() => { vi.advanceTimersByTime(PHOTO_DWELL_MS) })
      await flush()
      expect(screen.getAllByRole('img').find((img) => img.className.includes('front'))?.getAttribute('alt')).toBe(expected)
    }
  })

  it('swipes and side-taps step forward and back; paused holds still', async () => {
    const { rerender, container } = render(<PhotoTile photos={photos} apiBaseUrl="" paused />)
    await flush()
    const tile = container.querySelector('.photo-tile')!
    const front = () => screen.getAllByRole('img').find((img) => img.className.includes('front'))?.getAttribute('alt')

    fireEvent.pointerDown(tile, { clientX: 300, clientY: 10 })
    fireEvent.pointerUp(tile, { clientX: 100, clientY: 12 })
    await flush()
    await flush()
    expect(front()).toBe('b.jpg')

    fireEvent.pointerDown(tile, { clientX: 100, clientY: 10 })
    fireEvent.pointerUp(tile, { clientX: 300, clientY: 10 })
    await flush()
    expect(front()).toBe('a.jpg')

    act(() => { vi.advanceTimersByTime(PHOTO_DWELL_MS * 3) })
    await flush()
    expect(front()).toBe('a.jpg')
    rerender(<PhotoTile photos={photos} apiBaseUrl="" />)
  })
})
