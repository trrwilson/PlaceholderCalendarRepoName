import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'

import { chooseSkew, freeBand, OPPOSITE, reconcileOrder, resolveCaption, shuffled, type ResolvedCaption, type Skew } from './captionLayout'
import type { PhotoItem } from './types'
import { photoUrl } from './usePhotoStream'

// How long each photo stays up. Open question Q5 in docs/photo-stream-plan.md —
// a constant for now, not a Setting.
export const PHOTO_DWELL_MS = 20_000
const SWIPE_PX = 40
// Caption block width as a share of the tile: never narrower than reads well,
// never wider than a comfortable line, whatever the letterbox happens to be.
const CAPTION_MIN = 0.24
const CAPTION_MAX = 0.42

type Box = { width: number; height: number }
type Layer = { src: string; photo: PhotoItem; caption: ResolvedCaption | null; skew: Skew | null }

/**
 * Digital-photo-frame tile for Home: one photo at a time in a shuffled order,
 * crossfading to the next after `PHOTO_DWELL_MS`. Swipe, or tap the left/right
 * third, to step; tap the middle to open details (`onOpen`). Photos are shown
 * whole (`object-fit: contain`), never cropped.
 *
 * A photo with a resolvable caption is pushed to one edge of its letterbox
 * (picked at random along the axis that has space) and its caption sits on the
 * opposite edge, in the space the aspect mismatch already left empty, on a
 * frosted-glass panel where it has to overlap the photo.
 *
 * Two stacked layers: the incoming photo is decoded off-screen first, then its
 * layer fades in over the outgoing one, so there's never a blank flash.
 */
export function PhotoTile({ photos, apiBaseUrl, paused = false, onOpen }: { photos: PhotoItem[]; apiBaseUrl: string; paused?: boolean; onOpen?: (photo: PhotoItem) => void }) {
  const [order, setOrder] = useState<string[]>(() => shuffled(photos.map((p) => p.id)))
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [layers, setLayers] = useState<{ a: Layer | null; b: Layer | null; front: 'a' | 'b' }>({ a: null, b: null, front: 'a' })
  const [tick, setTick] = useState(0) // bumps on manual steps to restart the dwell timer
  const [box, setBox] = useState<Box>({ width: 0, height: 0 })
  // Read at show time (inside an async decode callback), so it must not be a stale render's value.
  const boxRef = useRef<Box>(box)
  boxRef.current = box
  const tileRef = useRef<HTMLElement | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)

  const byId = new Map(photos.map((p) => [p.id, p]))
  const idsKey = photos.map((p) => p.id).join('\n')
  useEffect(() => {
    setOrder((prev) => reconcileOrder(prev, idsKey ? idsKey.split('\n') : []))
  }, [idsKey])

  const position = currentId ? order.indexOf(currentId) : -1
  const current = byId.get(order[Math.max(position, 0)] ?? '') ?? null
  const count = order.length
  const src = current ? photoUrl(apiBaseUrl, current.id, current.version) : null

  const hasCurrent = current !== null
  useLayoutEffect(() => {
    const element = tileRef.current
    if (!element) return
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      boxRef.current = next
      setBox(next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [hasCurrent])

  // Load the target photo into the back layer, then flip which layer is in front.
  // The skew is drawn once per showing, so the same photo lands differently on
  // its next turn; a caption-only edit updates the front layer in place.
  const caption = current ? resolveCaption(current) : null
  const captionKey = caption ? `${caption.kind}:${caption.text}` : ''
  useEffect(() => {
    if (!src || !current) return
    let cancelled = false
    const show = () => {
      if (cancelled) return
      setLayers((prev) => {
        const front = prev[prev.front]
        if (front?.src === src) {
          const sameCaption = (front.caption ? `${front.caption.kind}:${front.caption.text}` : '') === captionKey
          return sameCaption ? prev : { ...prev, [prev.front]: { ...front, photo: current, caption } }
        }
        const back = prev.front === 'a' ? 'b' : 'a'
        return { ...prev, [back]: { src, photo: current, caption, skew: caption ? chooseSkew(current, boxRef.current) : null }, front: back }
      })
    }
    const img = new Image()
    img.src = src
    if (typeof img.decode === 'function') img.decode().then(show, show)
    else show()
    return () => {
      cancelled = true
    }
    // The tile size is read at show time only; a resize shouldn't re-roll the skew.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, captionKey])

  const step = (delta: number) => {
    if (!count) return
    const at = Math.max(position, 0)
    if (delta > 0 && at === count - 1 && count > 2) {
      // End of a pass: reshuffle for the next one, never repeating the photo just shown.
      const next = shuffled(order)
      if (next[0] === order[at]) next.push(next.shift()!)
      setOrder(next)
      setCurrentId(next[0])
      return
    }
    setCurrentId(order[(((at + delta) % count) + count) % count])
  }

  useEffect(() => {
    if (paused || count < 2) return
    const id = window.setTimeout(() => step(1), PHOTO_DWELL_MS)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, count, current?.id, tick])

  if (!current) return null

  const manualStep = (delta: number) => {
    step(delta)
    setTick((t) => t + 1)
  }
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    start.current = { x: event.clientX, y: event.clientY }
  }
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const origin = start.current
    start.current = null
    if (!origin) return
    const dx = event.clientX - origin.x
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(event.clientY - origin.y)) {
      if (count > 1) manualStep(dx < 0 ? 1 : -1)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const third = (event.clientX - rect.left) / Math.max(rect.width, 1)
    if (third < 1 / 3 && count > 1) manualStep(-1)
    else if (third > 2 / 3 && count > 1) manualStep(1)
    else onOpen?.(layers[layers.front]?.photo ?? current)
  }

  return (
    <section ref={tileRef} className="photo-tile" aria-roledescription="slideshow" aria-label="Household photos" onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => (start.current = null)}>
      {(['a', 'b'] as const).map((key) => {
        const layer = layers[key]
        if (!layer) return null
        const isFront = layers.front === key
        return (
          <figure key={key} className={`photo-layer ${isFront ? 'front' : ''}`} data-skew={layer.skew ?? 'center'} aria-hidden={!isFront}>
            <img src={layer.src} alt={isFront ? layer.caption?.text ?? layer.photo.name : ''} draggable={false} style={{ objectPosition: objectPosition(layer.skew) }} />
            {layer.caption && <figcaption className={`photo-caption caption-${layer.caption.kind}`} style={captionStyle(layer, box)}>{layer.caption.text}</figcaption>}
          </figure>
        )
      })}
    </section>
  )
}

function objectPosition(skew: Skew | null): string {
  if (skew === 'left') return 'left center'
  if (skew === 'right') return 'right center'
  if (skew === 'top') return 'center top'
  if (skew === 'bottom') return 'center bottom'
  return 'center'
}

// The caption goes on the side opposite the skew, sized for reading first and
// then placed in the letterbox: when the band is narrower than a readable block
// it overlaps the photo, which the glass panel is there to handle.
function captionStyle(layer: Layer, box: Box): CSSProperties {
  const skew = layer.skew
  if (!skew || !box.width) return {}
  const side = OPPOSITE[skew]
  const band = freeBand(layer.photo, box, skew)
  const gap = 'var(--photo-caption-gap)'
  if (side === 'left' || side === 'right') {
    const width = Math.min(box.width * CAPTION_MAX, Math.max(box.width * CAPTION_MIN, band))
    // Hug short captions; the computed width only caps how far a long one runs.
    return { [side]: 0, bottom: 0, width: 'fit-content', maxWidth: `calc(${Math.round(width)}px - 2 * ${gap})`, margin: gap }
  }
  return { [side]: 0, left: 0, right: 0, margin: `${gap} auto`, maxWidth: `calc(${Math.round(box.width * 0.7)}px - 2 * ${gap})`, width: 'fit-content' }
}
