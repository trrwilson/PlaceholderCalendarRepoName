import { describe, expect, it } from 'vitest'
import { holidayOn } from './holidays'

describe('US holiday overlay', () => {
  it('resolves fixed-date holidays', () => {
    expect(holidayOn(new Date(2026, 0, 1))?.name).toBe("New Year's Day")
    expect(holidayOn(new Date(2026, 6, 4))?.name).toBe('Independence Day')
    expect(holidayOn(new Date(2026, 9, 31))?.name).toBe('Halloween')
    expect(holidayOn(new Date(2026, 11, 25))?.name).toBe('Christmas')
  })

  it('resolves floating holidays by their weekday rule', () => {
    // Labor Day 2026 — first Monday of September — is Sep 7 (the day in the mockup).
    expect(holidayOn(new Date(2026, 8, 7))?.name).toBe('Labor Day')
    // Thanksgiving 2026 — fourth Thursday of November — is Nov 26.
    expect(holidayOn(new Date(2026, 10, 26))?.name).toBe('Thanksgiving')
    // Memorial Day 2026 — last Monday of May — is May 25.
    expect(holidayOn(new Date(2026, 4, 25))?.name).toBe('Memorial Day')
    // MLK Jr. Day 2026 — third Monday of January — is Jan 19.
    expect(holidayOn(new Date(2026, 0, 19))?.name).toBe('MLK Jr. Day')
  })

  it('computes Easter Sunday across years', () => {
    expect(holidayOn(new Date(2026, 3, 5))?.name).toBe('Easter') // 2026-04-05
    expect(holidayOn(new Date(2027, 2, 28))?.name).toBe('Easter') // 2027-03-28
  })

  it('carries an icon and leaves ordinary days empty', () => {
    expect(holidayOn(new Date(2026, 8, 7))?.icon).toBeTruthy()
    expect(holidayOn(new Date(2026, 8, 9))).toBeUndefined()
  })
})
