import { useEffect, useRef, useState, type PointerEvent } from 'react'

import type { PhotoItem } from './types'
import { photoUrl } from './usePhotoStream'

// How long each photo stays up. Open question Q5 in docs/photo-stream-plan.md —
// a constant for now, not a Setting.
export const PHOTO_DWELL_MS = 20_000
const SWIPE_PX = 40

/**
 * Digital-photo-frame tile for Home: one photo at a time, crossfading to the
 * next after `PHOTO_DWELL_MS`. Swipe left/right, or tap the left/right third, to
 * step back/forward (any manual step restarts the dwell). Photos are shown
 * whole (`object-fit: contain`) with no crop or effect — display only.
 *
 * Two stacked layers: the incoming photo is decoded off-screen first, then its
 * layer fades in over the outgoing one, so there's never a blank flash.
 */
export function PhotoTile({ photos, apiBaseUrl, paused = false }: { photos: PhotoItem[]; apiBaseUrl: string; paused?: boolean }) {
  const [index, setIndex] = useState(0)
  const [layers, setLayers] = useState<{ a: string | null; b: string | null; front: 'a' | 'b' }>({ a: null, b: null, front: 'a' })
  const [tick, setTick] = useState(0) // bumps on manual steps to restart the dwell timer
  const start = useRef<{ x: number; y: number } | null>(null)

  const count = photos.length
  const safeIndex = count ? ((index % count) + count) % count : 0
  const current = count ? photos[safeIndex] : null
  const src = current ? photoUrl(apiBaseUrl, current.id, current.version) : null

  // Load the target photo into the back layer, then flip which layer is in front.
  useEffect(() => {
    if (!src) return
    let cancelled = false
    const show = () => {
      if (cancelled) return
      setLayers((prev) => {
        if (prev[prev.front] === src) return prev
        const back = prev.front === 'a' ? 'b' : 'a'
        return { ...prev, [back]: src, front: back }
      })
    }
    const img = new Image()
    img.src = src
    if (typeof img.decode === 'function') img.decode().then(show, show)
    else show()
    return () => {
      cancelled = true
    }
  }, [src])

  useEffect(() => {
    if (paused || count < 2) return
    const id = window.setTimeout(() => setIndex((i) => i + 1), PHOTO_DWELL_MS)
    return () => window.clearTimeout(id)
  }, [paused, count, safeIndex, tick])

  if (!current) return null

  const step = (delta: number) => {
    setIndex((i) => i + delta)
    setTick((t) => t + 1)
  }
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    start.current = { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const origin = start.current
    start.current = null
    if (!origin || count < 2) return
    const dx = event.clientX - origin.x
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(event.clientY - origin.y)) {
      step(dx < 0 ? 1 : -1)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const third = (event.clientX - rect.left) / Math.max(rect.width, 1)
    if (third < 1 / 3) step(-1)
    else if (third > 2 / 3) step(1)
  }

  return (
    <section className="photo-tile" aria-roledescription="slideshow" aria-label="Household photos" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (start.current = null)}>
      {(['a', 'b'] as const).map((layer) =>
        layers[layer] ? <img key={layer} className={`photo-layer ${layers.front === layer ? 'front' : ''}`} src={layers[layer]!} alt={layers.front === layer ? current.name : ''} draggable={false} /> : null,
      )}
    </section>
  )
}
