import { afterEach, describe, expect, it, vi } from 'vitest'

import { dispatchToolCall, type ToolContext } from './tools'

const iso = (h: number) => {
  const d = new Date(2026, 8, 11, h, 0, 0)
  return d.toISOString()
}

function context(overrides: Partial<ToolContext['actions']> = {}): ToolContext {
  return {
    apiBaseUrl: 'http://api.test',
    actions: {
      showView: vi.fn(),
      focusDate: vi.fn(),
      highlightEvent: vi.fn(() => ({ matched: true, title: 'Swim practice', when: 'Fri 4:00 PM' })),
      ...overrides,
    },
  }
}

function stubCalendar(events: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        calendars: [
          { id: 'jordan', name: 'Jordan' },
          { id: 'alex', name: 'Alex' },
        ],
        events,
      }),
    }),
  )
}

afterEach(() => vi.unstubAllGlobals())

describe('voice tool dispatch', () => {
  it('routes show_view to the dashboard with a parsed local date', async () => {
    const ctx = context()
    const result = await dispatchToolCall('show_view', { view: 'week', date: '2026-09-11' }, ctx)
    expect(ctx.actions.showView).toHaveBeenCalledWith('week', new Date(2026, 8, 11))
    expect(result).toMatchObject({ ok: true, showing: 'week' })
  })

  it('rejects a malformed date instead of guessing', async () => {
    const ctx = context()
    const result = await dispatchToolCall('focus_date', { date: 'friday' }, ctx)
    expect(ctx.actions.focusDate).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it('reports when highlight_event finds nothing in view', async () => {
    const ctx = context({ highlightEvent: () => ({ matched: false }) })
    const result = await dispatchToolCall('highlight_event', { query: 'dentist' }, ctx)
    expect(result.ok).toBe(false)
  })

  it('condenses a day agenda from the calendar API', async () => {
    stubCalendar([
      {
        id: 'swim',
        calendar_id: 'jordan',
        title: 'Swim practice',
        starts_at: iso(16),
        ends_at: iso(17),
        location: 'Riverside pool',
        all_day: false,
      },
    ])
    const result = await dispatchToolCall('get_agenda', { date: '2026-09-11' }, context())
    expect(result.date).toBe('2026-09-11')
    expect(result.events).toMatchObject([{ title: 'Swim practice', who: 'Jordan', location: 'Riverside pool' }])
  })

  it('detects overlapping events for check_conflicts', async () => {
    stubCalendar([
      { id: 'a', calendar_id: 'jordan', title: 'Swim', starts_at: iso(16), ends_at: iso(18), all_day: false },
      { id: 'b', calendar_id: 'alex', title: 'Standup', starts_at: iso(17), ends_at: iso(19), all_day: false },
    ])
    const result = await dispatchToolCall('check_conflicts', { date: '2026-09-11' }, context())
    expect(result.has_conflicts).toBe(true)
    expect(result.conflicts).toHaveLength(1)
  })

  it('is closed to unknown tools', async () => {
    const result = await dispatchToolCall('create_event', {}, context())
    expect(result).toEqual({ ok: false, error: 'unknown tool create_event' })
  })
})
