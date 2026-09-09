import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { appSocket } from './realtime/appSocket'

describe('Mission Control dashboard', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    appSocket.__resetForTests()
    window.localStorage.clear()
    const today = new Date()
    const startsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16).toISOString()
    const endsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 17, 15).toISOString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ calendars: [{ id: 'jordan', name: 'Jordan', color: 'gold', enabled: true }, { id: 'home', name: 'Home', color: 'fern', enabled: true }], events: [{ id: 'swim', calendar_id: 'jordan', title: 'Swim practice', starts_at: startsAt, ends_at: endsAt, location: 'Riverside pool', all_day: false, categories: [{ id: 'sports', name: 'Sports', color: '#27ae60' }, { id: 'school', name: 'School', color: '#2d9cdb' }] }, { id: 'dinner', calendar_id: 'home', title: 'Taco night', starts_at: startsAt, ends_at: endsAt, location: null, all_day: false, categories: [] }] }) }))
    vi.stubGlobal('WebSocket', class { addEventListener() {} close() {} })
  })

  it('moves between purpose-built Home, Week, and Month modes', async () => {
    render(<App />)
    expect(screen.getByText('Today')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[0])
    await waitFor(() => expect(document.querySelector('.week-view .week-grid')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    // The viewed period now lives in the global header rather than a per-view heading band.
    const currentMonth = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    expect(await screen.findByText(currentMonth)).toBeInTheDocument()
    expect(document.querySelector('.header-period')).toHaveTextContent(currentMonth)
  })

  it('reveals event details when a household event is touched', async () => {
    render(<App />)
    const event = await screen.findByRole('button', { name: /Swim practice/ })
    fireEvent.click(event)

    expect(await screen.findByRole('dialog', { name: 'Event details' })).toBeInTheDocument()
    expect(screen.getAllByText('Riverside pool').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Sports')).toBeInTheDocument()
    expect(screen.getByText('School')).toBeInTheDocument()
  })

  it('defaults to category-first and paints the primary category colour from the provider', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('category-dominant'))
    expect(document.querySelector('.large-event')).toHaveStyle({ '--category-color': '#27ae60' })
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('button', { name: 'Color events by category' })).toHaveClass('selected')

    // An event with no provider category still renders through the dominant treatment — a generic
    // neutral swatch rather than the calendar identity colour — so it aligns with categorised ones.
    const uncategorized = document.querySelectorAll('.large-event')[1]
    expect(uncategorized).toHaveClass('category-dominant')
    expect(uncategorized).not.toHaveClass('calendar-fern')
    expect(uncategorized).toHaveStyle({ '--category-color': '#6e8596' })
    // ...and it now carries the calendar-identity triangle, like every other category-first card.
    expect(uncategorized.querySelector('.secondary-triangle')).toBeInTheDocument()
    expect(uncategorized).toHaveStyle({ '--event-accent': 'var(--fern)' })
  })

  it('persists people-first mode and falls back to calendar identity without categories', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('category-dominant'))
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    expect(window.localStorage.getItem('mission-control.semantic-color-mode')).toBe('people-first')
    expect(document.querySelector('.large-event')).toHaveClass('calendar-gold')

    cleanup()
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-gold'))
  })

  it('defaults the week to Monday and persists a Sunday choice', async () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    await waitFor(() => expect(document.querySelector('.weekday-tag')).toHaveTextContent('Mon'))
    expect(document.querySelectorAll('.weekday-tag')[6]).toHaveTextContent('Sun')

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveClass('selected')
    fireEvent.click(screen.getByRole('button', { name: 'Sunday' }))
    expect(window.localStorage.getItem('mission-control.week-start')).toBe('sunday')
    await waitFor(() => expect(document.querySelector('.weekday-tag')).toHaveTextContent('Sun'))

    cleanup()
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    await waitFor(() => expect(document.querySelector('.weekday-tag')).toHaveTextContent('Sun'))
  })

  it('overrides a calendar identity color from Settings and persists the choice', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-gold'))

    fireEvent.click(screen.getByRole('button', { name: 'Jordan: violet' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-violet'))
    expect(JSON.parse(window.localStorage.getItem('mission-control.calendar-colors') as string)).toEqual({ jordan: 'violet' })

    cleanup()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-violet'))
  })

  it('clears a calendar override when the provider default is reselected', async () => {
    window.localStorage.setItem('mission-control.calendar-colors', JSON.stringify({ jordan: 'violet' }))
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-violet'))

    fireEvent.click(screen.getByRole('button', { name: 'Jordan: gold' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-gold'))
    expect(JSON.parse(window.localStorage.getItem('mission-control.calendar-colors') as string)).toEqual({})
  })

  it('filters a calendar behind the People control', async () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Home' })[0])
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Swim practice/ }).length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole('button', { name: /People/ })[0])
    fireEvent.click(document.querySelector('.filter-row') as HTMLElement)

    await waitFor(() => expect(screen.getByRole('button', { name: /People/ })).toHaveTextContent('1/2'))
  })

  it('shows the natural name and a provider badge for a linked account in People', async () => {
    const today = new Date()
    const startsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16).toISOString()
    const endsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 17).toISOString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({
      calendars: [{ id: 'trrwilson@hotmail.com', name: 'trrwilson', display_name: 'Travis', color: 'ocean', source: 'outlook', enabled: true }],
      events: [{ id: 'e1', calendar_id: 'trrwilson@hotmail.com', title: 'Dentist', starts_at: startsAt, ends_at: endsAt, location: null, all_day: false, categories: [] }],
    }) }))

    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /People/ })).toHaveTextContent('1/1'))
    fireEvent.click(screen.getByRole('button', { name: /People/ }))

    const row = document.querySelector('.filter-row') as HTMLElement
    expect(row).toHaveTextContent('Travis')
    expect(row).not.toHaveTextContent('trrwilson')
    expect(row.querySelector('.provider-badge')).toBeInTheDocument()
  })

  it('dismisses the People popover outside, with Escape, and on mode navigation', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /People/ })).toHaveTextContent('2/2'))
    const people = screen.getByRole('button', { name: /People/ })
    fireEvent.click(people)
    expect(document.querySelector('.filter-row')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('.filter-row')).not.toBeInTheDocument()

    fireEvent.click(people)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.filter-row')).not.toBeInTheDocument()

    fireEvent.click(people)
    fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[0])
    expect(document.querySelector('.filter-row')).not.toBeInTheDocument()
  })

  it('pins a multi-day event as a Home banner and spans it across Week and Month', async () => {
    const today = new Date()
    const midnight = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset).toISOString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({
      calendars: [{ id: 'family', name: 'Family', color: 'coral', enabled: true }],
      events: [{ id: 'break', calendar_id: 'family', title: 'School break', starts_at: midnight(-1), ends_at: midnight(2), location: null, all_day: true, categories: [] }],
    }) }))

    render(<App />)

    const banner = await screen.findByRole('button', { name: /School break/ })
    expect(banner).toHaveClass('today-banner')
    expect(banner).toHaveTextContent('Day 2 of 3')
    expect(document.querySelector('.large-agenda')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[0])
    await waitFor(() => expect(document.querySelector('.allday-lane .span-bar')).toHaveTextContent('School break'))
    expect(document.querySelector('.week-column .week-event')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    await waitFor(() => expect(document.querySelector('.month-week-spans .span-bar')).toHaveTextContent('School break'))
    expect(document.querySelector('.day-events .event-chip')).not.toBeInTheDocument()
  })

  it('paints multi-day spans with the primary colour — category first, then account', async () => {
    const today = new Date()
    const midnight = (offset: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset).toISOString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({
      calendars: [{ id: 'family', name: 'Family', color: 'fern', enabled: true }],
      events: [{ id: 'break', calendar_id: 'family', title: 'School break', starts_at: midnight(-1), ends_at: midnight(2), location: null, all_day: true, categories: [{ id: 'holiday', name: 'Holiday', color: '#8e44ad' }] }],
    }) }))

    render(<App />)

    // Category-first (default): the Home banner and the Month/Week span bar carry the category colour.
    const banner = await screen.findByRole('button', { name: /School break/ })
    expect(banner).toHaveClass('category-dominant')
    expect(banner).toHaveStyle({ '--category-color': '#8e44ad' })

    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    await waitFor(() => expect(document.querySelector('.month-week-spans .span-bar')).toBeInTheDocument())
    const bar = document.querySelector('.month-week-spans .span-bar') as HTMLElement
    expect(bar).toHaveClass('category-dominant')
    expect(bar).toHaveStyle({ '--category-color': '#8e44ad' })

    // People-first: the span bar falls back to the account identity colour instead.
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    await waitFor(() => expect(document.querySelector('.month-week-spans .span-bar')).toHaveClass('calendar-fern'))
  })

  it('starts a timer, keeps navigation unlocked, and tracks the countdown in the dock', async () => {
    const today = new Date()
    const startsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16).toISOString()
    const running = {
      id: 't1',
      label: 'Oven',
      created_at: new Date().toISOString(),
      fires_at: new Date(Date.now() + 600_000).toISOString(),
      duration_seconds: 600,
      state: 'running',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, opts?: { method?: string }) => {
        const target = String(url)
        if (target.includes('/api/timers')) {
          if (opts?.method === 'POST') {
            return Promise.resolve({ ok: true, status: 200, json: async () => ({ timer: running, replaced: null }) })
          }
          return Promise.resolve({ ok: true, json: async () => [] })
        }
        return Promise.resolve({
          json: async () => ({
            calendars: [{ id: 'home', name: 'Home', color: 'fern', enabled: true }],
            events: [{ id: 'd', calendar_id: 'home', title: 'Taco night', starts_at: startsAt, ends_at: startsAt, location: null, all_day: false, categories: [] }],
          }),
        })
      }),
    )

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /^Timer/ }))
    expect(await screen.findByRole('button', { name: 'Start timer' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '10 min' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }))

    // The running countdown appears; the Timer tab is marked active-with-a-timer.
    await waitFor(() => expect(document.querySelector('.timer-running')).toBeInTheDocument())
    expect(document.querySelector('.dock-timer')).toHaveClass('running')
    // On the Timer view itself the dock readout stays hidden — the big countdown repeats it.
    expect(document.querySelector('.dock-timer-remaining')).not.toBeInTheDocument()

    // Navigating away leaves the timer running and surfaces its countdown in the dock.
    fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[0])
    await waitFor(() => expect(document.querySelector('.week-view')).toBeInTheDocument())
    expect(document.querySelector('.dock-timer-remaining')?.textContent).toMatch(/^\d+:\d{2}$/)

    // The brand / Home control now goes Home — a running timer no longer traps navigation —
    // and the countdown follows onto the Home view.
    fireEvent.click(screen.getByRole('button', { name: 'Go to Home' }))
    await waitFor(() => expect(document.querySelector('.home-view')).toBeInTheDocument())
    expect(document.querySelector('.dock-timer-remaining')?.textContent).toMatch(/^\d+:\d{2}$/)
  })

  it('shows the grocery list, checks an item off, and carries the count in the dock', async () => {
    const grocery = {
      id: 'grocery',
      title: 'Grocery',
      updated_at: new Date().toISOString(),
      recent_names: ['Paper towels'],
      items: [
        { id: 'i1', name: 'Milk', note: null, checked: false, added_at: new Date().toISOString(), checked_at: null, source: 'voice' },
        { id: 'i2', name: 'Eggs', note: null, checked: false, added_at: new Date().toISOString(), checked_at: null, source: 'touch' },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL, opts?: { method?: string }) => {
        const target = String(url)
        if (target.includes('/api/lists/grocery/items/i1') && opts?.method === 'PATCH') {
          const next = { ...grocery, items: [{ ...grocery.items[0], checked: true }, grocery.items[1]] }
          return Promise.resolve({ ok: true, json: async () => ({ list: next, removed: [], added: [], already_present: [] }) })
        }
        if (target.includes('/api/lists/grocery')) {
          return Promise.resolve({ ok: true, json: async () => grocery })
        }
        return Promise.resolve({
          json: async () => ({
            calendars: [{ id: 'home', name: 'Home', color: 'fern', enabled: true }],
            events: [],
          }),
        })
      }),
    )

    render(<App />)
    // The dock carries the "to get" count while another view is on screen.
    await waitFor(() => expect(document.querySelector('.dock-lists-count')?.textContent).toBe('2'))

    fireEvent.click(screen.getByRole('button', { name: /^Lists/ }))
    expect(await screen.findByRole('button', { name: 'Check off Milk' })).toBeInTheDocument()
    expect(screen.getByText('2 to get')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Check off Milk' }))
    await waitFor(() => expect(screen.getByText('1 to get')).toBeInTheDocument())
    // Checked items move to the "Got it" strip.
    expect(screen.getByRole('button', { name: 'Put Milk back on the list' })).toBeInTheDocument()
  })

  it('keeps the Home/Week/Month/Timer/Lists group stable and shows Today only as a contextual action', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toBeInTheDocument())
    const nav = document.querySelector('.mode-nav') as HTMLElement
    const modeLabels = () => Array.from(nav.querySelectorAll('button')).map((button) => button.textContent)
    const baseline = modeLabels()
    expect(baseline).toEqual(['Home', 'Week', 'Month', 'Timer', 'Lists'])
    // Today is not a peer mode and is absent while the current period is in view.
    expect(document.querySelector('.dock-today')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[0])
    await waitFor(() => expect(document.querySelector('.week-view')).toBeInTheDocument())
    expect(document.querySelector('.dock-today')).not.toBeInTheDocument()

    // Page back a week: Today appears, outside the mode group, without disturbing it.
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }))
    await waitFor(() => expect(document.querySelector('.dock-today')).toBeInTheDocument())
    expect(document.querySelector('.mode-nav .dock-today')).not.toBeInTheDocument()
    expect(modeLabels()).toEqual(baseline)

    // Returning to today removes it again — still no movement of the mode group.
    fireEvent.click(screen.getByRole('button', { name: 'Jump to today' }))
    await waitFor(() => expect(document.querySelector('.dock-today')).not.toBeInTheDocument())
    expect(modeLabels()).toEqual(baseline)
  })

  it('keeps sync status invisible while healthy and reveals offline detail on demand', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toBeInTheDocument())
    expect(document.querySelector('.sync-status')).not.toBeInTheDocument()
    expect(screen.queryByText(/Live sync/)).not.toBeInTheDocument()

    cleanup()
    vi.stubGlobal('fetch', vi.fn((url: string | URL) => {
      const target = String(url)
      if (target.includes('/api/timers')) return Promise.resolve({ ok: true, json: async () => [] })
      if (target.includes('/api/calendar')) return Promise.reject(new Error('offline'))
      return Promise.resolve({ ok: true, json: async () => ({}) })
    }))
    render(<App />)
    const flag = await screen.findByRole('button', { name: 'Sync status' })
    expect(document.querySelector('.sync-status-detail')).not.toBeInTheDocument()
    fireEvent.click(flag)
    expect(document.querySelector('.sync-status-detail')).toHaveTextContent(/Offline/)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('.sync-status-detail')).not.toBeInTheDocument())
  })

  it('collapses extra Month events into a tappable "+N more" that opens a day sheet', async () => {
    const today = new Date()
    const at = (hour: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour).toISOString()
    const events = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].map((title, index) => ({
      id: title.toLowerCase(), calendar_id: 'home', title, starts_at: at(8 + index), ends_at: at(9 + index), location: null, all_day: false, categories: [],
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ calendars: [{ id: 'home', name: 'Home', color: 'fern', enabled: true }], events }) }))

    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    // jsdom has no matchMedia, so the row cap is the conservative 1080p ceiling (2 rows).
    const more = await screen.findByRole('button', { name: /Show 4 more events/ })
    // Full-size chips only fill the remaining rows — events are never shrunk to fit more.
    expect(document.querySelectorAll('.day-cell .event-chip').length).toBe(1)

    fireEvent.click(more)
    const sheet = await screen.findByRole('dialog', { name: /Events on/ })
    expect(within(sheet).getByText('Echo')).toBeInTheDocument()
    expect(within(sheet).getAllByText(/Alpha|Bravo|Charlie|Delta|Echo/).length).toBe(5)

    // A row in the sheet opens the normal event detail.
    fireEvent.click(within(sheet).getByRole('button', { name: /Echo/ }))
    expect(await screen.findByRole('dialog', { name: 'Event details' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /Events on/ })).not.toBeInTheDocument()
  })

  it('dismisses the Month day sheet with Escape', async () => {
    const today = new Date()
    const at = (hour: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour).toISOString()
    const events = Array.from({ length: 4 }, (_, index) => ({
      id: `e${index}`, calendar_id: 'home', title: `Event ${index}`, starts_at: at(8 + index), ends_at: at(9 + index), location: null, all_day: false, categories: [],
    }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ calendars: [{ id: 'home', name: 'Home', color: 'fern', enabled: true }], events }) }))

    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    fireEvent.click(await screen.findByRole('button', { name: /Show 3 more events/ }))
    const sheet = await screen.findByRole('dialog', { name: /Events on/ })
    fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Events on/ })).not.toBeInTheDocument())
  })

  it('shows the voice provider picker in Settings and switches provider', async () => {
    const config = {
      enabled: true,
      provider: 'gemini',
      providers: [
        { id: 'gemini', label: 'Gemini Live', implemented: true, configured: true },
        { id: 'azure_openai_realtime', label: 'Azure OpenAI Realtime (gpt-realtime-2.1)', implemented: false, configured: false },
      ],
    }
    const put = vi.fn()
    vi.stubGlobal('fetch', vi.fn((url: string | URL, opts?: { method?: string; body?: string }) => {
      const target = String(url)
      if (target.includes('/api/voice/config')) {
        if (opts?.method === 'PUT') {
          put(JSON.parse(opts.body ?? '{}'))
          return Promise.resolve({ ok: true, json: async () => config })
        }
        return Promise.resolve({ ok: true, json: async () => config })
      }
      if (target.includes('/api/timers')) return Promise.resolve({ ok: true, json: async () => [] })
      return Promise.resolve({ json: async () => ({ calendars: [], events: [] }) })
    }))

    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    // The bake-off pickers live under Voice & sound → Advanced (collapsed by default).
    fireEvent.click(await screen.findByRole('button', { name: 'Voice & sound' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced (bake-off)' }))
    const gemini = await screen.findByRole('button', { name: /Gemini Live/ })
    expect(gemini).toHaveClass('selected')
    // An unimplemented contestant is listed but not selectable.
    expect(screen.getByRole('button', { name: /Azure OpenAI Realtime/ })).toBeDisabled()

    fireEvent.click(gemini)
    await waitFor(() => expect(put).toHaveBeenCalledWith({ provider: 'gemini' }))
  })

  it('remembers the Advanced (bake-off) disclosure across sessions so the pickers stay reachable', async () => {
    const config = {
      enabled: true,
      provider: 'gemini',
      providers: [{ id: 'gemini', label: 'Gemini Live', implemented: true, configured: true }],
    }
    vi.stubGlobal('fetch', vi.fn((url: string | URL) => {
      const target = String(url)
      if (target.includes('/api/voice/config')) return Promise.resolve({ ok: true, json: async () => config })
      if (target.includes('/api/timers')) return Promise.resolve({ ok: true, json: async () => [] })
      return Promise.resolve({ json: async () => ({ calendars: [], events: [] }) })
    }))

    const first = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Voice & sound' }))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced (bake-off)' }))
    expect(await screen.findByRole('button', { name: /Gemini Live/ })).toBeInTheDocument()
    expect(window.localStorage.getItem('mission-control.settings-advanced-open')).toBe('open')
    first.unmount()

    // A fresh mount (new kiosk session) reopens Settings with Advanced already expanded.
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Voice & sound' }))
    expect(await screen.findByRole('button', { name: /Gemini Live/ })).toBeInTheDocument()
  })

  it('shows a US holiday as a non-interactive label beside the date, not a calendar entry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 7, 9)) // Labor Day — first Monday of September 2026
    const at = (hour: number) => new Date(2026, 8, 7, hour).toISOString()
    const midnight = (day: number) => new Date(2026, 8, day).toISOString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      calendars: [{ id: 'home', name: 'Home', color: 'fern', enabled: true }],
      events: [
        { id: 'cookout', calendar_id: 'home', title: 'Cookout', starts_at: at(12), ends_at: at(14), location: null, all_day: false, categories: [] },
        { id: 'trip', calendar_id: 'home', title: 'Road trip', starts_at: midnight(6), ends_at: midnight(9), location: null, all_day: true, categories: [] },
        { id: 'fair', calendar_id: 'home', title: 'Book fair', starts_at: midnight(10), ends_at: midnight(12), location: null, all_day: true, categories: [] },
      ],
    }) }))
    try {
      render(<App />)
      // Home surfaces today's holiday under the headline; it is a plain label, never a button.
      const homeNote = await screen.findByText('Labor Day')
      expect(homeNote.closest('button')).toBeNull()
      expect(homeNote).toHaveClass('holiday-note-name')

      fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
      await waitFor(() => expect(document.querySelector('.month-grid')).toBeInTheDocument())
      const grid = document.querySelector('.month-grid') as HTMLElement
      const monthNote = within(grid).getByText('Labor Day')
      expect(monthNote.closest('button')).toBeNull()
      // It lives in the day heading, so the day's real events still render as chips.
      expect(monthNote.closest('.day-heading')).not.toBeNull()
      expect(grid.querySelector('.day-events .event-chip')).toBeInTheDocument()

      // Week puts the holiday on the always-present all-day lane as a plain centred label,
      // sharing its row with events that don't touch that day and sitting ahead of one that does.
      fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[0])
      await waitFor(() => expect(document.querySelector('.week-grid')).toBeInTheDocument())
      const lane = document.querySelector('.allday-lane') as HTMLElement
      const laneHoliday = lane.querySelector('.allday-holiday') as HTMLElement
      expect(laneHoliday).toHaveTextContent('Labor Day')
      expect(laneHoliday.tagName).toBe('SPAN')
      expect(laneHoliday.closest('button')).toBeNull()
      expect(laneHoliday.style.gridRow).toBe('1')
      const barRow = (title: string) => (Array.from(lane.querySelectorAll('.span-bar')).find((b) => b.textContent?.includes(title)) as HTMLElement).style.gridRow
      // "Book fair" (Thu–Fri) never touches Labor Day → same top row as the holiday.
      expect(barRow('Book fair')).toBe('1')
      // "Road trip" covers the holiday's day → it stacks onto the next row, never over the label.
      expect(barRow('Road trip')).toBe('2')
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismisses Settings outside and with Escape', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument())
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Settings' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument())
  })

  it('redacts event titles and goes read-only in privacy mode', async () => {
    const today = new Date()
    const startsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16).toISOString()
    const endsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 17).toISOString()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) => {
        const target = String(url)
        if (target.includes('/api/privacy')) {
          return Promise.resolve({ ok: true, json: async () => ({ locked: true, since: 't', available: true }) })
        }
        if (target.includes('/api/calendar')) {
          return Promise.resolve({ json: async () => ({
            calendars: [{ id: 'jordan', name: 'Jordan', color: 'gold', enabled: true }],
            events: [{ id: 'swim', calendar_id: 'jordan', title: 'Therapy', starts_at: startsAt, ends_at: endsAt, location: 'Downtown', all_day: false, categories: [] }],
          }) })
        }
        return Promise.resolve({ ok: true, json: async () => ({}) })
      }),
    )

    render(<App />)

    // The event is still there (when / whose), but the title is gone.
    await waitFor(() => expect(document.querySelector('.large-event')).toBeInTheDocument())
    expect(screen.queryByText('Therapy')).not.toBeInTheDocument()
    expect(screen.queryByText('Downtown')).not.toBeInTheDocument()
    expect(document.querySelector('.large-event-main strong')?.textContent).toBe('•••')

    // The interactive chrome is gone; the way back (padlock) is present.
    expect(screen.queryByRole('button', { name: 'Add an event' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Turn off privacy mode' })).toBeInTheDocument()
    expect(document.querySelector('.kiosk-shell')).toHaveClass('is-private')

    // Tapping an event opens nothing.
    fireEvent.click(document.querySelector('.large-event') as HTMLElement)
    expect(screen.queryByRole('dialog', { name: 'Event details' })).not.toBeInTheDocument()

    // The padlock opens the PIN keypad.
    fireEvent.click(screen.getByRole('button', { name: 'Turn off privacy mode' }))
    expect(await screen.findByRole('dialog', { name: 'Turn off privacy mode' })).toBeInTheDocument()
  })
})