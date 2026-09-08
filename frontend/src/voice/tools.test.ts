import { afterEach, describe, expect, it, vi } from 'vitest'

import { dispatchToolCall, type ToolContext } from './tools'

const iso = (h: number) => {
  const d = new Date(2026, 8, 11, h, 0, 0)
  return d.toISOString()
}

function context(
  overrides: Partial<ToolContext['actions']> = {},
  ctx: Partial<Omit<ToolContext, 'actions'>> = {},
): ToolContext {
  return {
    apiBaseUrl: 'http://api.test',
    actions: {
      showView: vi.fn(),
      focusDate: vi.fn(),
      highlightEvent: vi.fn(() => ({ matched: true, title: 'Swim practice', when: 'Fri 4:00 PM' })),
      setPeopleFilter: vi.fn(() => ({ matched: ['jordan'], unmatched: [] })),
      requestPrivacyUnlock: vi.fn(),
      ...overrides,
    },
    ...ctx,
  }
}

function stubCalendar(events: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        calendars: [
          { id: 'jordan', name: 'jordan', display_name: 'Jordan' },
          { id: 'alex', name: 'alex@example.com', display_name: 'Alex' },
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

  it('names the person by their natural display name, not the account handle', async () => {
    stubCalendar([
      { id: 'x', calendar_id: 'alex', title: 'Standup', starts_at: iso(9), ends_at: iso(10), all_day: false },
    ])
    const result = await dispatchToolCall('get_agenda', { date: '2026-09-11' }, context())
    expect((result.events as { who: string }[])[0].who).toBe('Alex')
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

  it('starts a timer from a spoken duration', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        timer: { id: 't1', label: 'pasta', fires_at: '2026-09-11T16:15:00', state: 'running' },
        replaced: null,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchToolCall('start_timer', { duration_minutes: 15, label: 'pasta' }, context())

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/timers')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ duration_seconds: 900, label: 'pasta' })
    expect(result).toMatchObject({ ok: true, label: 'pasta' })
  })

  it('resolves an absolute target time to a duration for start_timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 11, 14, 0, 0))
    try {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ timer: { id: 't', label: null, fires_at: 'x', state: 'running' }, replaced: null }),
      })
      vi.stubGlobal('fetch', fetchMock)
      await dispatchToolCall('start_timer', { fires_at: '2026-09-11T15:30:00' }, context())
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ duration_seconds: 5400, label: null })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a timer longer than six hours without calling the backend', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await dispatchToolCall('start_timer', { duration_minutes: 400 }, context())
    expect(result).toEqual({ ok: false, error: 'Timers can be at most six hours.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a backend 422 as a spoken six-hour error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({}) }))
    const result = await dispatchToolCall('start_timer', { duration_minutes: 90 }, context())
    expect(result).toEqual({ ok: false, error: 'Timers can be at most six hours.' })
  })

  it('cancels the running timer by looking up its id first', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 't9', label: null, fires_at: 'x', state: 'running' }] })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchToolCall('cancel_timer', {}, context())
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/timers/t9')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' })
    expect(result).toEqual({ ok: true })
  })

  it('reports when there is no timer to extend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }))
    const result = await dispatchToolCall('extend_timer', { add_minutes: 5 }, context())
    expect(result).toEqual({ ok: false, error: 'no timer is running' })
  })

  it('pauses the running timer via its pause sub-resource', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 't3', label: null, fires_at: 'x', state: 'running' }] })
      .mockResolvedValueOnce({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchToolCall('pause_timer', {}, context())
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/timers/t3/pause')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST' })
    expect(result).toEqual({ ok: true })
  })

  it('does not re-pause an already paused timer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 't3', label: null, fires_at: 'x', state: 'paused' }] })
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchToolCall('pause_timer', {}, context())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, already_paused: true })
  })

  it('resumes a paused timer and restarts from any state', async () => {
    const paused = { id: 't4', label: null, fires_at: 'x', state: 'paused', remaining_seconds: 120 }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [paused] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => [paused] })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...paused, state: 'running', fires_at: 'y' }) })
    vi.stubGlobal('fetch', fetchMock)

    expect(await dispatchToolCall('resume_timer', {}, context())).toEqual({ ok: true })
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/timers/t4/resume')

    const restarted = await dispatchToolCall('restart_timer', {}, context())
    expect(String(fetchMock.mock.calls[3][0])).toContain('/api/timers/t4/restart')
    expect(restarted).toMatchObject({ ok: true })
  })

  it('reports paused state through get_timer using the frozen remaining time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ id: 't5', label: 'bread', fires_at: 'x', state: 'paused', remaining_seconds: 300 }],
      }),
    )
    const result = await dispatchToolCall('get_timer', {}, context())
    expect(result).toMatchObject({ running: false, paused: true, remaining_minutes: 5, label: 'bread' })
  })

  // -- grocery list ---------------------------------------------------------

  const listWith = (items: { id: string; name: string; checked?: boolean }[]) => ({
    id: 'grocery',
    title: 'Grocery',
    items: items.map((item) => ({ checked: false, ...item })),
  })

  it('adds multiple items to the grocery list in one call', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ list: listWith([]), added: ['eggs', 'bread'], already_present: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchToolCall('add_to_list', { items: ['eggs', 'bread'] }, context())
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/api/lists/grocery/items')
    expect(JSON.parse((init as { body: string }).body)).toEqual({ names: ['eggs', 'bread'], source: 'voice' })
    expect(result).toMatchObject({ ok: true, added: ['eggs', 'bread'] })
  })

  it('resolves an item name to its id before removing it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => listWith([{ id: 'a', name: 'Whole milk' }]) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ list: listWith([]), removed: [{ id: 'a' }] }) })
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchToolCall('remove_from_list', { item: 'milk' }, context())
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/lists/grocery/items/a')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' })
    expect(result).toMatchObject({ ok: true, removed: 'Whole milk' })
  })

  it('says when an item to remove is not on the list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => listWith([{ id: 'a', name: 'Eggs' }]) }))
    const result = await dispatchToolCall('check_off_item', { item: 'milk' }, context())
    expect(result).toEqual({ ok: false, error: "milk isn't on the list" })
  })

  it('clears the whole list by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ list: listWith([]), removed: [{ id: 'a' }, { id: 'b' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await dispatchToolCall('clear_list', {}, context())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ scope: 'all' })
    expect(result).toMatchObject({ ok: true, scope: 'all', removed_count: 2 })
  })

  it('reads the list back for get_list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => listWith([{ id: 'a', name: 'Milk' }, { id: 'b', name: 'Eggs', checked: true }]),
      }),
    )
    const result = await dispatchToolCall('get_list', {}, context())
    expect(result).toMatchObject({
      items: [{ name: 'Milk', checked: false }, { name: 'Eggs', checked: true }],
      unchecked_count: 1,
    })
  })

  describe('privacy mode', () => {
    it('enter_privacy_mode posts to /api/privacy/lock', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
      vi.stubGlobal('fetch', fetchMock)
      const result = await dispatchToolCall('enter_privacy_mode', {}, context())
      expect(String(fetchMock.mock.calls[0][0])).toContain('/api/privacy/lock')
      expect(result).toMatchObject({ ok: true })
    })

    it('request_privacy_unlock opens the on-screen keypad', async () => {
      const ctx = context()
      const result = await dispatchToolCall('request_privacy_unlock', {}, ctx)
      expect(ctx.actions.requestPrivacyUnlock).toHaveBeenCalled()
      expect(result).toMatchObject({ ok: true })
    })

    it('refuses every other tool while privacy mode is locked', async () => {
      const ctx = context({}, { privacyLocked: true })
      for (const tool of ['get_events', 'show_view', 'start_timer', 'add_to_list', 'get_list']) {
        const result = await dispatchToolCall(tool, { view: 'home', start: '2026-09-11', end: '2026-09-11' }, ctx)
        expect(result.ok).toBe(false)
        expect(String(result.error)).toContain('Privacy mode is on')
      }
    })

    it('still allows request_privacy_unlock while locked', async () => {
      const ctx = context({}, { privacyLocked: true })
      const result = await dispatchToolCall('request_privacy_unlock', {}, ctx)
      expect(result).toMatchObject({ ok: true })
      expect(ctx.actions.requestPrivacyUnlock).toHaveBeenCalled()
    })
  })
})
