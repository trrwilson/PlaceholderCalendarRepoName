import { describe, expect, it } from 'vitest'

import { chooseSkew, freeBand, reconcileOrder, resolveCaption, shuffledAvoidingRecent } from './captionLayout'
import type { PhotoItem } from './types'

const photo = (extra: Partial<PhotoItem> = {}): PhotoItem => ({ id: 'x', name: 'x.jpg', width: 4000, height: 3000, taken_at: null, version: 'v', bytes: 1, ...extra })
const box = { width: 1600, height: 900 }
const seq = (...values: number[]) => () => values.shift() ?? 0

describe('resolveCaption', () => {
  it('prefers the owner caption, then place, then month taken, then nothing', () => {
    expect(resolveCaption(photo({ caption: ' Sunrise ', place: 'Dublin, Ireland' }))).toEqual({ text: 'Sunrise', kind: 'caption' })
    expect(resolveCaption(photo({ caption: '  ', place: 'Dublin, Ireland' }))).toEqual({ text: 'Dublin, Ireland', kind: 'place' })
    const dated = resolveCaption(photo({ taken_at: '2014-07-31T10:00:00' }))
    expect(dated?.kind).toBe('date')
    expect(dated?.text).toMatch(/2014/)
    expect(resolveCaption(photo())).toBeNull()
  })
})

describe('chooseSkew', () => {
  it('uses the axis that has letterbox space', () => {
    expect(chooseSkew({ width: 3000, height: 4000 }, box, () => 0)).toBe('left')
    expect(chooseSkew({ width: 3000, height: 4000 }, box, () => 0.99)).toBe('right')
    expect(chooseSkew({ width: 6000, height: 2000 }, box, () => 0)).toBe('top')
    expect(chooseSkew({ width: 6000, height: 2000 }, box, () => 0.99)).toBe('bottom')
  })

  it('offers all four edges when the aspects match, and gives up without a size', () => {
    expect(chooseSkew({ width: 1920, height: 1080 }, box, () => 0.6)).toBe('top')
    expect(chooseSkew({ width: 1920, height: 1080 }, box, () => 0.99)).toBe('bottom')
    expect(chooseSkew({ width: null, height: 1080 }, box)).toBeNull()
  })
})

describe('freeBand', () => {
  it('is the whole letterbox on the caption side', () => {
    // 3:4 portrait in 1600x900 → drawn 675 wide, 925 px spare.
    expect(freeBand({ width: 3000, height: 4000 }, box, 'left')).toBeCloseTo(925)
    expect(freeBand({ width: 6000, height: 2000 }, box, 'top')).toBeCloseTo(900 - 1600 / 3)
  })
})

describe('reconcileOrder', () => {
  it('drops removed ids, keeps survivors in order, and scatters new ones', () => {
    expect(reconcileOrder(['a', 'b', 'c', 'd'], ['a', 'c', 'd'])).toEqual(['a', 'c', 'd'])
    // random 0 → insert at the front each time
    const next = reconcileOrder(['a', 'b'], ['a', 'b', 'n'], seq(0, 0))
    expect(next).toEqual(['n', 'a', 'b'])
    expect(reconcileOrder([], ['a', 'b', 'c']).sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('shuffledAvoidingRecent', () => {
  const ids = Array.from({ length: 25 }, (_, i) => `p${i}`)

  it('never replays a photo within the gap across many pass boundaries', () => {
    for (const n of [2, 3, 5, 11, 25]) {
      const library = ids.slice(0, n)
      const gap = Math.min(10, n - 1)
      const played: string[] = []
      for (let pass = 0; pass < 40; pass++) played.push(...shuffledAvoidingRecent(library, played.slice(-10), 10))
      played.forEach((id, i) => expect(played.slice(Math.max(0, i - gap), i)).not.toContain(id))
    }
  })

  it('is a plain shuffle with no history', () => {
    expect(shuffledAvoidingRecent(['a', 'b', 'c'], [], 10).sort()).toEqual(['a', 'b', 'c'])
  })

  it('pushes the photo on screen past the gap even when the shuffle puts it first', () => {
    // random 0.999 keeps the identity order: a would come first.
    const next = shuffledAvoidingRecent(['a', 'b', 'c', 'd'], ['a'], 2, () => 0.999)
    expect(next.indexOf('a')).toBeGreaterThanOrEqual(2)
  })
})
