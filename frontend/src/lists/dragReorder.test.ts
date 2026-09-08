import { describe, expect, it } from 'vitest'

import { moveItem } from './dragReorder'

describe('moveItem', () => {
  it('moves an element down', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an element up', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('returns the same array reference for a no-op', () => {
    const arr = ['a', 'b', 'c']
    expect(moveItem(arr, 1, 1)).toBe(arr)
  })

  it('ignores out-of-range indices', () => {
    const arr = ['a', 'b']
    expect(moveItem(arr, 5, 0)).toBe(arr)
    expect(moveItem(arr, 0, -1)).toBe(arr)
  })
})
