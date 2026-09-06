// Calendar-grid date helpers. All dates are treated as local wall-clock (the domain has no time
// zones — see AGENTS.md), so every function here works in the browser's local zone.

export type WeekStart = 'monday' | 'sunday'

export const DAY_MS = 86_400_000

export const weekStartDay = (weekStart: WeekStart) => (weekStart === 'sunday' ? 0 : 1)

export function startOfDay(date: Date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()) }
export function startOfWeek(date: Date, weekStart: WeekStart) { const start = startOfDay(date); start.setDate(start.getDate() - ((start.getDay() - weekStartDay(weekStart) + 7) % 7)); return start }
export function addDays(date: Date, amount: number) { const result = new Date(date); result.setDate(result.getDate() + amount); return result }
export function toIsoDate(date: Date) { return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-') }
export function isSameDay(left: Date, right: Date) { return toIsoDate(left) === toIsoDate(right) }
export function sameMonth(day: Date, reference: Date) { return day.getMonth() === reference.getMonth() && day.getFullYear() === reference.getFullYear() }
export function monthLabel(date: Date) { return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }

// The natural grid for a month: whole weeks from the one containing the 1st to the one containing
// the last day — five rows for most months, six when the days spill past 35 cells.
export function naturalMonthGrid(month: Date, weekStart: WeekStart) {
  const start = startOfWeek(new Date(month.getFullYear(), month.getMonth(), 1), weekStart)
  const lastRow = startOfWeek(new Date(month.getFullYear(), month.getMonth() + 1, 0), weekStart)
  const rows = Math.round((lastRow.getTime() - start.getTime()) / (7 * DAY_MS)) + 1
  return Array.from({ length: rows * 7 }, (_, index) => addDays(start, index))
}

// Month view is always five rows. A six-row month drops its final days; if "today" is one of those
// dropped days we shift to next month's grid (which begins on exactly those days) so today stays on
// screen, and the title spans both months until the calendar has fully rolled over.
export function resolveMonthView(viewDate: Date, now: Date, weekStart: WeekStart): { days: Date[]; title: string; refMonth: Date } {
  const grid = naturalMonthGrid(viewDate, weekStart)
  if (grid.length <= 35) return { days: grid, title: monthLabel(viewDate), refMonth: viewDate }
  const firstSpill = startOfDay(grid[35])
  if (startOfDay(now).getTime() < firstSpill.getTime()) {
    return { days: grid.slice(0, 35), title: monthLabel(viewDate), refMonth: viewDate }
  }
  const nextMonth = new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1)
  const shifted = naturalMonthGrid(nextMonth, weekStart).slice(0, 35)
  const title = sameMonth(now, viewDate)
    ? `${viewDate.toLocaleDateString(undefined, { month: 'long' })}–${monthLabel(nextMonth)}`
    : monthLabel(nextMonth)
  return { days: shifted, title, refMonth: nextMonth }
}
