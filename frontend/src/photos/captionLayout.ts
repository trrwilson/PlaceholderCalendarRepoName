import type { PhotoItem } from './types'

// Caption resolution and the caption-skew layout for the Home photo tile
// (docs/photo-stream-plan.md §8). Pure functions; randomness is injected.

export type CaptionKind = 'caption' | 'place' | 'date'
export type ResolvedCaption = { text: string; kind: CaptionKind }

/** The owner's caption, else the short place name, else the month and year
 * taken, else nothing. Only the first is the household's own words; the
 * fallbacks are shown more quietly. */
export function resolveCaption(photo: PhotoItem): ResolvedCaption | null {
  if (photo.caption?.trim()) return { text: photo.caption.trim(), kind: 'caption' }
  if (photo.place?.trim()) return { text: photo.place.trim(), kind: 'place' }
  if (photo.taken_at) {
    const taken = new Date(photo.taken_at)
    if (!Number.isNaN(taken.getTime())) return { text: taken.toLocaleDateString([], { month: 'long', year: 'numeric' }), kind: 'date' }
  }
  return null
}

/** Which edge the photo is pushed to; its caption sits on the opposite edge. */
export type Skew = 'left' | 'right' | 'top' | 'bottom'
export const OPPOSITE: Record<Skew, Skew> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }

// Aspect ratios this close count as a match (no letterbox worth using).
const MATCH_TOLERANCE = 0.02

/** Pick a skew along the axis that has letterbox space: left/right when the
 * photo is narrower than the tile, top/bottom when it's wider, any of the four
 * when the aspects match. `null` when the photo's size is unknown. */
export function chooseSkew(photo: { width: number | null; height: number | null }, box: { width: number; height: number }, random: () => number = Math.random): Skew | null {
  if (!photo.width || !photo.height || !box.width || !box.height) return null
  const ratio = Math.log((photo.width / photo.height) / (box.width / box.height))
  const options: Skew[] = Math.abs(ratio) < MATCH_TOLERANCE ? ['left', 'right', 'top', 'bottom'] : ratio < 0 ? ['left', 'right'] : ['top', 'bottom']
  return options[Math.min(options.length - 1, Math.floor(random() * options.length))]
}

/** Size of the empty band the caption can use, in px, on the caption's side:
 * the whole letterbox, since the photo is pushed to the other edge. */
export function freeBand(photo: { width: number | null; height: number | null }, box: { width: number; height: number }, skew: Skew): number {
  if (!photo.width || !photo.height) return 0
  const scale = Math.min(box.width / photo.width, box.height / photo.height)
  return skew === 'left' || skew === 'right' ? Math.max(0, box.width - photo.width * scale) : Math.max(0, box.height - photo.height * scale)
}

/** Fisher–Yates shuffle (a copy). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Keep a shuffled play order in step with the current photo ids: removed ids
 * drop out, surviving ids keep their relative order, and new ids are dropped in
 * at random positions so a batch of additions doesn't play back-to-back. */
export function reconcileOrder(order: readonly string[], ids: readonly string[], random: () => number = Math.random): string[] {
  const wanted = new Set(ids)
  const next = order.filter((id) => wanted.has(id))
  const known = new Set(next)
  for (const id of shuffled(ids.filter((id) => !known.has(id)), random)) {
    next.splice(Math.floor(random() * (next.length + 1)), 0, id)
  }
  return next
}
