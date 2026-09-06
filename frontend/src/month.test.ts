import { describe, expect, it } from 'vitest'
import { naturalMonthGrid, resolveMonthView } from './dates'

const iso = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')

describe('month view layout', () => {
  it('keeps an ordinary month at five rows', () => {
    const { days, title } = resolveMonthView(new Date(2026, 8, 1), new Date(2026, 8, 15), 'monday')
    expect(days).toHaveLength(35)
    expect(iso(days[0])).toBe('2026-08-31')
    expect(title).toBe('September 2026')
  })

  it('drops the spill days of a six-row month when today is earlier in the month', () => {
    // November 2026 is a six-row month (Mon-start): the 30th would land in a wasted sixth row.
    expect(naturalMonthGrid(new Date(2026, 10, 1), 'monday')).toHaveLength(42)
    const { days, title } = resolveMonthView(new Date(2026, 10, 1), new Date(2026, 10, 15), 'monday')
    expect(days).toHaveLength(35)
    expect(days.some((day) => iso(day) === '2026-11-30')).toBe(false)
    expect(title).toBe('November 2026')
  })

  it('shifts to the next month grid and spans the title once today is a spill day', () => {
    const { days, title, refMonth } = resolveMonthView(new Date(2026, 10, 1), new Date(2026, 10, 30), 'monday')
    expect(days).toHaveLength(35)
    expect(iso(days[0])).toBe('2026-11-30')
    expect(days.some((day) => iso(day) === '2026-11-30')).toBe(true)
    expect(title).toBe('November–December 2026')
    expect(refMonth.getMonth()).toBe(11)
  })

  it('keeps the shifted grid but drops the spanned title once the month has rolled over', () => {
    const { days, title } = resolveMonthView(new Date(2026, 10, 1), new Date(2026, 11, 1), 'monday')
    expect(iso(days[0])).toBe('2026-11-30')
    expect(title).toBe('December 2026')
  })
})
