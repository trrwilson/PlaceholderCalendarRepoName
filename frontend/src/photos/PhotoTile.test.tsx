import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PHOTO_DWELL_MS, PhotoTile } from './PhotoTile'
import type { PhotoItem } from './types'

const photo = (id: string, extra: Partial<PhotoItem> = {}): PhotoItem => ({ id, name: `${id}.jpg`, width: 4000, height: 3000, taken_at: null, version: 'v1', bytes: 10, ...extra })
const photos = [photo('a'), photo('b'), photo('c')]
const front = () => document.querySelector('.photo-layer.front img')?.getAttribute('alt')

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom never decodes images; make every decode resolve immediately.
  // jsdom has no PointerEvent; MouseEvent carries clientX/clientY for fireEvent.
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve() } })
  // 0.999 makes the Fisher–Yates shuffle an identity, so play order is a, b, c.
  vi.spyOn(Math, 'random').mockReturnValue(0.999)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function flush() {
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve() })
}

function sizeTiles(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height)
}

describe('PhotoTile', () => {
  it('renders nothing with no photos', () => {
    const { container } = render(<PhotoTile photos={[]} apiBaseUrl="" />)
    expect(container.firstChild).toBeNull()
  })

  it('advances after the dwell and starts a new pass at the end', async () => {
    render(<PhotoTile photos={photos} apiBaseUrl="http://api" />)
    await flush()
    expect(front()).toBe('a.jpg')
    expect(screen.getByRole('img').getAttribute('src')).toBe('http://api/api/photos/a?v=v1')
    for (const expected of ['b.jpg', 'c.jpg', 'a.jpg']) {
      act(() => { vi.advanceTimersByTime(PHOTO_DWELL_MS) })
      await flush()
      expect(front()).toBe(expected)
    }
  })

  it('swipes and side-taps step; a middle tap opens details; paused holds still', async () => {
    const onOpen = vi.fn()
    const { container } = render(<PhotoTile photos={photos} apiBaseUrl="" paused onOpen={onOpen} />)
    await flush()
    const tile = container.querySelector('.photo-tile')!
    vi.spyOn(tile, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 300, top: 0, height: 200 } as DOMRect)

    fireEvent.pointerDown(tile, { clientX: 290, clientY: 10 })
    fireEvent.pointerUp(tile, { clientX: 100, clientY: 12 })
    await flush()
    expect(front()).toBe('b.jpg')

    fireEvent.pointerDown(tile, { clientX: 20, clientY: 10 })
    fireEvent.pointerUp(tile, { clientX: 20, clientY: 10 })
    await flush()
    expect(front()).toBe('a.jpg')

    fireEvent.pointerDown(tile, { clientX: 150, clientY: 10 })
    fireEvent.pointerUp(tile, { clientX: 150, clientY: 10 })
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))

    act(() => { vi.advanceTimersByTime(PHOTO_DWELL_MS * 3) })
    await flush()
    expect(front()).toBe('a.jpg')
  })

  it('pushes a captioned photo to one edge and puts its caption on the other', async () => {
    sizeTiles(1600, 900)
    vi.spyOn(Math, 'random').mockReturnValue(0) // first option: skew left
    render(<PhotoTile photos={[photo('p', { width: 3000, height: 4000, caption: 'Annette Lake' })]} apiBaseUrl="" />)
    await flush()
    const layer = document.querySelector('.photo-layer.front') as HTMLElement
    expect(layer.dataset.skew).toBe('left')
    expect((layer.querySelector('img') as HTMLImageElement).style.objectPosition).toBe('left center')
    const caption = layer.querySelector('figcaption') as HTMLElement
    expect(caption.textContent).toBe('Annette Lake')
    expect(caption.className).toContain('caption-caption')
    expect(caption.style.right).toBe('0px')
    expect(front()).toBe('Annette Lake')
  })

  it('uses the top/bottom axis for a wide photo, and falls back to the place name', async () => {
    sizeTiles(1600, 900)
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    render(<PhotoTile photos={[photo('w', { width: 6000, height: 2000, place: 'Dublin, Ireland' })]} apiBaseUrl="" />)
    await flush()
    const layer = document.querySelector('.photo-layer.front') as HTMLElement
    expect(layer.dataset.skew).toBe('bottom')
    const caption = layer.querySelector('figcaption') as HTMLElement
    expect(caption.className).toContain('caption-place')
    expect(caption.style.top).toBe('0px')
  })

  it('leaves an uncaptioned photo centred with no caption', async () => {
    sizeTiles(1600, 900)
    render(<PhotoTile photos={[photo('n')]} apiBaseUrl="" />)
    await flush()
    const layer = document.querySelector('.photo-layer.front') as HTMLElement
    expect(layer.dataset.skew).toBe('center')
    expect(layer.querySelector('figcaption')).toBeNull()
  })
})
