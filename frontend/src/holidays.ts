// US holiday overlay for the calendar views. This is presentation only: holidays are NOT
// calendar events and never come from a provider — they are a pure function of the date,
// computed here in the browser's local zone (the domain is naive local time; see AGENTS.md),
// the same class of client-only helper as `dates.ts`. The set mirrors the "Holidays in
// United States" calendar people already see in Google / Outlook: the federal holidays plus
// the widely-observed cultural days. Each carries a small thematic emoji.

export type Holiday = { name: string; icon: string }

const pad = (value: number) => String(value).padStart(2, '0')
const isoKey = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`

// The nth (1-based) occurrence of a weekday (0 = Sunday … 6 = Saturday) in a 1-based month.
function nthWeekday(year: number, month: number, weekday: number, n: number) {
  const firstDow = new Date(year, month - 1, 1).getDay()
  return isoKey(year, month, 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7)
}

// The last occurrence of a weekday in a 1-based month.
function lastWeekday(year: number, month: number, weekday: number) {
  const last = new Date(year, month, 0)
  return isoKey(year, month, last.getDate() - ((last.getDay() - weekday + 7) % 7))
}

// Gregorian Easter Sunday (the "Anonymous" / Meeus algorithm).
function easter(year: number) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return isoKey(year, month, day)
}

// Extend the calendar by adding rows here. Keep icons emoji (no committed asset — see
// docs/credits.md) and avoid regional-indicator flags: Windows renders them as letters.
// On a date collision the earlier row wins, so order fixed dates before Easter.
function buildYear(year: number): Map<string, Holiday> {
  const rows: Array<[string, Holiday]> = [
    [isoKey(year, 1, 1), { name: "New Year's Day", icon: '🎉' }],
    [nthWeekday(year, 1, 1, 3), { name: 'MLK Jr. Day', icon: '✊' }],
    [isoKey(year, 2, 14), { name: "Valentine's Day", icon: '❤️' }],
    [nthWeekday(year, 2, 1, 3), { name: "Presidents' Day", icon: '🎩' }],
    [isoKey(year, 3, 17), { name: "St. Patrick's Day", icon: '☘️' }],
    [easter(year), { name: 'Easter', icon: '🐣' }],
    [nthWeekday(year, 5, 0, 2), { name: "Mother's Day", icon: '💐' }],
    [lastWeekday(year, 5, 1), { name: 'Memorial Day', icon: '🎖️' }],
    [isoKey(year, 6, 19), { name: 'Juneteenth', icon: '🕊️' }],
    [nthWeekday(year, 6, 0, 3), { name: "Father's Day", icon: '👔' }],
    [isoKey(year, 7, 4), { name: 'Independence Day', icon: '🎆' }],
    [nthWeekday(year, 9, 1, 1), { name: 'Labor Day', icon: '🛠️' }],
    [isoKey(year, 10, 31), { name: 'Halloween', icon: '🎃' }],
    [isoKey(year, 11, 11), { name: 'Veterans Day', icon: '🎗️' }],
    [nthWeekday(year, 11, 4, 4), { name: 'Thanksgiving', icon: '🦃' }],
    [isoKey(year, 12, 24), { name: 'Christmas Eve', icon: '🕯️' }],
    [isoKey(year, 12, 25), { name: 'Christmas', icon: '🎄' }],
    [isoKey(year, 12, 31), { name: "New Year's Eve", icon: '🥂' }],
  ]
  const map = new Map<string, Holiday>()
  for (const [key, holiday] of rows) if (!map.has(key)) map.set(key, holiday)
  return map
}

const byYear = new Map<number, Map<string, Holiday>>()

export function holidayOn(date: Date): Holiday | undefined {
  const year = date.getFullYear()
  let forYear = byYear.get(year)
  if (!forYear) {
    forYear = buildYear(year)
    byYear.set(year, forYear)
  }
  return forYear.get(isoKey(year, date.getMonth() + 1, date.getDate()))
}
