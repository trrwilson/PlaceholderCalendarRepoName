import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import './App.css'
import { addDays, DAY_MS, isSameDay, resolveMonthView, sameMonth, startOfDay, startOfWeek, toIsoDate, type WeekStart } from './dates'
import type { DashboardActions } from './voice/types'
import { useVoiceSession } from './voice/useVoiceSession'
import { VoiceOverlay } from './voice/VoiceOverlay'
import { VoiceToast } from './voice/VoiceToast'

type Calendar = { id: string; name: string; color: string; enabled: boolean }
type EventCategory = { id: string; name: string; color: string } // color: a concrete #rrggbb from the provider (e.g. Outlook master-category swatch)
type CalendarEvent = { id: string; calendar_id: string; title: string; starts_at: string; ends_at: string; location: string | null; all_day: boolean; categories?: EventCategory[] }
type Snapshot = { calendars: Calendar[]; events: CalendarEvent[] }
type ConnectionState = 'connecting' | 'live' | 'offline'
type ViewMode = 'home' | 'week' | 'month'
type SemanticColorMode = 'category-first' | 'people-first'
type CalendarAuthState = 'connected' | 'connecting' | 'disconnected' | 'not_applicable'
type CalendarAuth = { provider: string; state: CalendarAuthState; account: string | null; accounts?: string[]; user_code: string | null; verification_uri: string | null; verification_uri_complete: string | null; verification_qr: string | null; expires_in: number | null; error: string | null }

type HouseholdException = { title: string; detail: string; action: string }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WAKE_HOURS = Array.from({ length: 14 }, (_, index) => index + 7)
const MOCK_EXCEPTION: HouseholdException = { title: 'Garage door open', detail: 'Open for 43 minutes', action: 'Check garage' }
const colorClass = (color: string) => `calendar-${color}`
const COLOR_MODE_KEY = 'mission-control.semantic-color-mode'
const readColorMode = (): SemanticColorMode => window.localStorage.getItem(COLOR_MODE_KEY) === 'people-first' ? 'people-first' : 'category-first'
const WEEK_START_KEY = 'mission-control.week-start'
const readWeekStart = (): WeekStart => window.localStorage.getItem(WEEK_START_KEY) === 'sunday' ? 'sunday' : 'monday'
const CALENDAR_PALETTE = ['coral', 'ocean', 'gold', 'fern', 'violet'] as const
// Stacked all-day/multi-day bars shown in Week and Month before the rest collapse to a "+N" count.
const SPAN_MAX_LANES = 3
const CALENDAR_COLORS_KEY = 'mission-control.calendar-colors'
const readCalendarColors = (): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CALENDAR_COLORS_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

function App() {
  const [mode, setMode] = useState<ViewMode>('home')
  const [viewDate, setViewDate] = useState(() => new Date())
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [enabledCalendars, setEnabledCalendars] = useState<string[]>([])
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [now, setNow] = useState(new Date())
  const [filterOpen, setFilterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [colorMode, setColorMode] = useState<SemanticColorMode>(readColorMode)
  const [weekStart, setWeekStart] = useState<WeekStart>(readWeekStart)
  const [calendarColors, setCalendarColors] = useState<Record<string, string>>(readCalendarColors)
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const [auth, setAuth] = useState<CalendarAuth | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const [addingCalendar, setAddingCalendar] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const filterRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)
  const linkedAccountsRef = useRef(0)

  const authNeedsSetup = auth != null && auth.state !== 'connected' && auth.state !== 'not_applicable'

  useEffect(() => {
    let active = true
    const poll = () => fetch(`${API_URL}/api/calendar/auth`)
      .then((response) => (response.ok ? (response.json() as Promise<CalendarAuth>) : null))
      .then((next) => { if (active && next && typeof next.state === 'string') setAuth(next) })
      .catch(() => undefined)
    poll()
    const timer = window.setInterval(poll, auth?.state === 'connecting' ? 3_000 : 20_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [auth?.state])

  useEffect(() => {
    if (auth?.state !== 'connected') return
    const linked = auth.accounts?.length ?? (auth.account ? 1 : 0)
    const gainedAccount = linked > linkedAccountsRef.current
    linkedAccountsRef.current = linked
    // A bare "connected" while a sign-in is in flight (an expired code, a stray
    // poll) must not tear down the QR — only close once the new calendar is
    // actually linked, or when this was the first sign-in.
    if (addingCalendar && !gainedAccount) return
    setConnectOpen((open) => {
      if (open || gainedAccount) setReloadKey((key) => key + 1)
      return false
    })
    setAddingCalendar(false)
  }, [auth?.state, auth?.accounts?.length, auth?.account, addingCalendar])

  function beginConnect() {
    setConnectOpen(true)
    fetch(`${API_URL}/api/calendar/auth/device`, { method: 'POST' })
      .then((response) => response.json() as Promise<CalendarAuth>)
      .then(setAuth)
      .catch(() => undefined)
  }

  function addCalendar() {
    setAddingCalendar(true)
    setSettingsOpen(false)
    beginConnect()
  }

  function cancelConnect() {
    setConnectOpen(false)
    setAddingCalendar(false)
    fetch(`${API_URL}/api/calendar/auth/device`, { method: 'DELETE' })
      .then((response) => response.json() as Promise<CalendarAuth>)
      .then(setAuth)
      .catch(() => undefined)
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!filterOpen && !settingsOpen) return
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!filterRef.current?.contains(target)) setFilterOpen(false)
      if (!settingsRef.current?.contains(target)) setSettingsOpen(false)
    }
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFilterOpen(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissEscape)
    window.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissEscape)
      window.removeEventListener('keydown', dismissEscape)
    }
  }, [filterOpen, settingsOpen])

  useEffect(() => {
    window.localStorage.setItem(COLOR_MODE_KEY, colorMode)
  }, [colorMode])

  useEffect(() => {
    window.localStorage.setItem(WEEK_START_KEY, weekStart)
  }, [weekStart])

  useEffect(() => {
    window.localStorage.setItem(CALENDAR_COLORS_KEY, JSON.stringify(calendarColors))
  }, [calendarColors])

  useEffect(() => {
    const range = rangeForView(mode, viewDate, now, weekStart)
    const params = new URLSearchParams({ starts_on: toIsoDate(range.start), ends_on: toIsoDate(range.end) })
    fetch(`${API_URL}/api/calendar?${params}`)
      .then((response) => response.json() as Promise<Snapshot>)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot)
        // Show every calendar the moment it appears — the first one on load, and
        // any later additions — while leaving existing on/off choices alone.
        setEnabledCalendars((current) => {
          const seen = new Set(current)
          const added = nextSnapshot.calendars.map((calendar) => calendar.id).filter((id) => !seen.has(id))
          return added.length ? [...current, ...added] : current
        })
      })
      .catch(() => setConnection('offline'))
  }, [mode, viewDate, now, weekStart, reloadKey])

  useEffect(() => {
    const socket = new WebSocket(API_URL.replace(/^http/, 'ws') + '/api/ws')
    socket.addEventListener('open', () => setConnection('live'))
    socket.addEventListener('close', () => setConnection('offline'))
    return () => socket.close()
  }, [])

  const providerCalendars = snapshot?.calendars ?? []
  const calendars = providerCalendars.map((calendar) => {
    const override = calendarColors[calendar.id]
    return override && override !== calendar.color ? { ...calendar, color: override } : calendar
  })
  const calendarById = new Map(calendars.map((calendar) => [calendar.id, calendar]))
  const visibleEvents = (snapshot?.events ?? []).filter((event) => enabledCalendars.includes(event.calendar_id))
  // Spanning events (all-day, plus anything crossing midnight) are pinned as banners rather
  // than interleaved with the timed agenda — they read as background context for the day.
  const todaySpans = visibleEvents.filter((event) => isSpanningEvent(event) && coversDay(event, now)).sort(sortEvents)
  const todayEvents = visibleEvents.filter((event) => !isSpanningEvent(event) && isSameDay(new Date(event.starts_at), now)).sort(sortEvents)
  const upcoming = visibleEvents.filter((event) => new Date(event.ends_at) >= now).sort(sortEvents)
  const pinnedIds = new Set([...todayEvents, ...todaySpans].map((event) => event.id))
  const nextEvents = upcoming.filter((event) => !pinnedIds.has(event.id))

  const voiceActions = useMemo<DashboardActions>(() => ({
    showView: (view, date) => {
      setMode(view as ViewMode)
      setViewDate(date ?? new Date())
      setSelectedEvent(null)
      setFilterOpen(false)
      setSettingsOpen(false)
    },
    focusDate: (date) => { setViewDate(date); setSelectedEvent(null) },
    highlightEvent: (query) => {
      const events = snapshot?.events ?? []
      const named = new Map((snapshot?.calendars ?? []).map((calendar) => [calendar.id, calendar.name.toLowerCase()]))
      const needle = query.trim().toLowerCase()
      const match = needle
        ? events.find((event) => event.title.toLowerCase().includes(needle))
          ?? events.find((event) => (named.get(event.calendar_id) ?? '').includes(needle))
        : undefined
      if (!match) return { matched: false }
      setSelectedEvent(match)
      return {
        matched: true,
        title: match.title,
        when: new Date(match.starts_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
      }
    },
  }), [snapshot])

  const voice = useVoiceSession({ apiBaseUrl: API_URL, actions: voiceActions, surface: 'kiosk' })

  function navigate(amount: number) {
    setViewDate((current) => amount === 0 ? (mode === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now)) : mode === 'month' ? new Date(current.getFullYear(), current.getMonth() + amount, 1) : addDays(current, amount * (mode === 'week' ? 7 : 1)))
    setSelectedEvent(null)
    setFilterOpen(false)
    setSettingsOpen(false)
  }

  function goHome() {
    setViewDate(new Date())
    setMode('home')
    setSelectedEvent(null)
    setFilterOpen(false)
    setSettingsOpen(false)
  }

  function chooseCalendarColor(calendarId: string, color: string) {
    const providerColor = providerCalendars.find((calendar) => calendar.id === calendarId)?.color
    setCalendarColors((current) => {
      const next = { ...current }
      if (color === providerColor) delete next[calendarId]
      else next[calendarId] = color
      return next
    })
  }

  function toggleCalendar(calendarId: string) {
    setEnabledCalendars((current) => current.includes(calendarId) ? current.filter((id) => id !== calendarId) : [...current, calendarId])
  }

  return (
    <main className="kiosk-shell">
      <header className="global-header">
        <button className="brand-lockup" onClick={goHome} aria-label="Go to Home"><span className="brand-icon">M</span><span><strong>Mission Control</strong><small>the household calendar</small></span></button>
        <div className="header-date"><span>{formatDate(now)}</span><strong>{formatTime(now)}</strong></div>
        <div className="header-actions">{authNeedsSetup ? <button className="calendar-alert" onClick={() => { goHome(); setAddingCalendar(false); setConnectOpen(true) }}><i />Calendar sign-in</button> : <span className={`connection ${connection}`}><i />{connection === 'live' ? 'Live sync' : connection === 'offline' ? 'Offline mode' : 'Connecting'}</span>}<button className={`ask-button voice-${voice.status}`} aria-label={voice.status === 'listening' ? 'Stop voice input' : 'Ask Mission Control'} aria-pressed={voice.status === 'listening'} disabled={voice.status === 'unavailable' && voice.error?.kind === 'disabled'} onClick={() => (voice.status === 'listening' ? voice.stopTurn() : voice.startTurn())}><span className="mic-symbol">◉</span><b>{voice.status === 'unavailable' ? 'Voice off' : voice.status === 'listening' ? 'Listening' : 'Ask'}</b></button>{voice.micActive && <span className="mic-live" role="status" aria-label="Microphone is on"><i />Mic on</span>}<button className="add-button" aria-label="Add an event"><span>+</span><b>Add</b></button></div>
      </header>

      <section className="view-frame">
        {mode === 'home' && <HomeView now={now} todayEvents={todayEvents} todaySpans={todaySpans} upcoming={nextEvents} calendarById={calendarById} onSelect={setSelectedEvent} colorMode={colorMode} calendarAlert={authNeedsSetup ? { account: auth?.account ?? null, onConnect: () => { setAddingCalendar(false); setConnectOpen(true) } } : null} />}
        {mode === 'week' && <WeekView viewDate={viewDate} now={now} events={visibleEvents} calendarById={calendarById} onSelect={setSelectedEvent} onNavigate={navigate} colorMode={colorMode} weekStart={weekStart} />}
        {mode === 'month' && <MonthView viewDate={viewDate} now={now} events={visibleEvents} calendarById={calendarById} onSelect={setSelectedEvent} onNavigate={navigate} colorMode={colorMode} weekStart={weekStart} />}
      </section>

      <footer className="bottom-dock"><nav><button onClick={goHome} className={mode === 'home' ? 'active' : ''}>Home</button><button onClick={() => { setMode('week'); setViewDate(new Date()); setFilterOpen(false); setSettingsOpen(false) }} className={mode === 'week' ? 'active' : ''}>Week</button><button onClick={() => { setMode('month'); setViewDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setFilterOpen(false); setSettingsOpen(false) }} className={mode === 'month' ? 'active' : ''}>Month</button></nav><div className="dock-actions" ref={filterRef}><button className="filter-toggle" onClick={() => { setFilterOpen((open) => !open); setSettingsOpen(false) }} aria-expanded={filterOpen}>People <span>{enabledCalendars.length}/{calendars.length || 4}</span></button>{filterOpen && <div className="filter-popover">{calendars.map((calendar) => <button className="filter-row" onClick={() => toggleCalendar(calendar.id)} key={calendar.id}><span className={`calendar-swatch ${colorClass(calendar.color)}`} /><span>{calendar.name}</span><strong>{enabledCalendars.includes(calendar.id) ? '✓' : ''}</strong></button>)}</div>}</div><div className="dock-actions" ref={settingsRef}><button className="settings-toggle" onClick={() => { setSettingsOpen((open) => !open); setFilterOpen(false) }} aria-expanded={settingsOpen} aria-label="Open settings">⚙<span>Settings</span></button>{settingsOpen && <div className="settings-popover" role="dialog" aria-label="Settings" onKeyDown={(event) => { if (event.key === 'Escape') setSettingsOpen(false) }}>{auth?.provider === 'outlook_personal' && auth.state === 'connected' && <><strong>Calendars</strong><button className="add-calendar-button" onClick={addCalendar}>Add another Outlook calendar</button></>}<strong>Event colors</strong><button className={colorMode === 'category-first' ? 'selected' : ''} onClick={() => setColorMode('category-first')}>Color events by category</button><button className={colorMode === 'people-first' ? 'selected' : ''} onClick={() => setColorMode('people-first')}>Color events by person/calendar</button><strong>Week starts on</strong><button className={weekStart === 'monday' ? 'selected' : ''} onClick={() => setWeekStart('monday')}>Monday</button><button className={weekStart === 'sunday' ? 'selected' : ''} onClick={() => setWeekStart('sunday')}>Sunday</button>{calendars.length > 0 && <><strong>Calendar colors</strong>{calendars.map((calendar) => <div className="calendar-color-row" key={calendar.id}><span className="calendar-color-name"><span className={`calendar-swatch ${colorClass(calendar.color)}`} />{calendar.name}</span><span className="calendar-color-options" role="group" aria-label={`${calendar.name} color`}>{CALENDAR_PALETTE.map((color) => <button type="button" key={color} className={`color-dot ${colorClass(color)} ${calendar.color === color ? 'selected' : ''}`} aria-label={`${calendar.name}: ${color}`} aria-pressed={calendar.color === color} onClick={() => chooseCalendarColor(calendar.id, color)} />)}</span></div>)}</>}</div>}</div></footer>
      {selectedEvent && <EventDetail event={selectedEvent} calendar={calendarById.get(selectedEvent.calendar_id)} onClose={() => setSelectedEvent(null)} />}
      {connectOpen && auth && <CalendarConnect auth={auth} addingCalendar={addingCalendar} onStart={beginConnect} onCancel={cancelConnect} onClose={() => { setConnectOpen(false); setAddingCalendar(false) }} />}
      <VoiceOverlay status={voice.status} transcript={voice.transcript} error={voice.error} onStop={voice.stopTurn} onDismissError={voice.dismissError} />
      {voice.status === 'unavailable' && voice.error && <VoiceToast error={voice.error} onRetry={voice.startTurn} onDismiss={voice.dismissError} />}
    </main>
  )
}

function HomeView({ now, todayEvents, todaySpans, upcoming, calendarById, onSelect, colorMode, calendarAlert }: { now: Date; todayEvents: CalendarEvent[]; todaySpans: CalendarEvent[]; upcoming: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; colorMode: SemanticColorMode; calendarAlert: { account: string | null; onConnect: () => void } | null }) {
  const tomorrow = upcoming.filter((event) => !isSpanningEvent(event) && isSameDay(new Date(event.starts_at), addDays(now, 1))).slice(0, 3)
  return <div className="home-view"><div className="home-grid"><section className="today-schedule"><div className="view-heading"><div><p className="section-kicker">Today</p><h2>{todayEvents.length} things on the rhythm</h2></div><span className="date-pill">{formatShortDate(now)}</span></div>{todaySpans.length > 0 && <div className="today-banners">{todaySpans.map((event) => <SpanBanner event={event} calendar={calendarById.get(event.calendar_id)} now={now} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div>}{todayEvents.length ? <div className="large-agenda">{todayEvents.map((event) => <LargeEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} past={new Date(event.ends_at) < now} colorMode={colorMode} key={event.id} />)}</div> : todaySpans.length ? null : <EmptyState text="A clear rest of the day." />}</section><aside className="home-rail"><section className="next-card"><div className="view-heading"><div><p className="section-kicker">Coming up</p><h2>Next</h2></div><span className="arrow-mark">→</span></div><div className="next-list">{upcoming.slice(0, 4).map((event) => <CompactEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div></section><section className="tomorrow-card"><p className="section-kicker">Tomorrow</p><h2>{formatWeekday(addDays(now, 1))}</h2>{tomorrow.length ? tomorrow.map((event) => <CompactEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />) : <p>No events planned yet.</p>}</section>{calendarAlert ? <section className="exception-card"><span className="exception-mark">!</span><div><p className="section-kicker">Needs attention</p><strong>Calendar sign-in needed</strong><span>{calendarAlert.account ? `Reconnect ${calendarAlert.account}` : 'Connect a household calendar'}</span></div><button onClick={calendarAlert.onConnect}>Connect</button></section> : <section className="exception-card"><span className="exception-mark">!</span><div><p className="section-kicker">Needs attention</p><strong>{MOCK_EXCEPTION.title}</strong><span>{MOCK_EXCEPTION.detail}</span></div><button onClick={() => undefined}>{MOCK_EXCEPTION.action}</button></section>}</aside></div></div>
}

function WeekView({ viewDate, now, events, calendarById, onSelect, onNavigate, colorMode, weekStart }: { viewDate: Date; now: Date; events: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; onNavigate: (amount: number) => void; colorMode: SemanticColorMode; weekStart: WeekStart }) {
  const start = startOfWeek(viewDate, weekStart)
  const weekDays = Array.from({ length: 7 }, (_, index) => addDays(start, index))
  const { bars, overflow } = layoutSpans(events, weekDays, SPAN_MAX_LANES)
  const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0)
  return <div className="week-view"><div className="view-heading week-heading"><div><p className="section-kicker">Week at a glance</p><h1>{formatMonthRange(start, addDays(start, 6))}</h1></div><div className="view-nav"><button onClick={() => onNavigate(-1)} aria-label="Previous week">‹</button><button onClick={() => onNavigate(1)} aria-label="Next week">›</button></div></div><div className="week-grid"><div className="time-gutter week-corner" />{weekDays.map((day) => <div className={`week-day-head ${isSameDay(day, now) ? 'today' : ''}`} key={toIsoDate(day)}><span>{WEEKDAYS[day.getDay()]}</span><strong>{day.getDate()}</strong></div>)}<div className="time-gutter allday-label"><span>{laneCount ? 'all-day' : ''}</span></div><div className="allday-lane">{bars.map((bar) => <SpanBar bar={bar} calendar={calendarById.get(bar.event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={bar.event.id} />)}{weekDays.map((day, index) => { const extra = overflow.get(toIsoDate(day)) ?? 0; return extra ? <span className="span-overflow" style={{ gridColumn: index + 1, gridRow: SPAN_MAX_LANES + 1 }} key={toIsoDate(day)}>+{extra}</span> : null })}</div><div className="time-gutter hours">{WAKE_HOURS.map((hour) => <span key={hour}>{formatHour(hour)}</span>)}</div>{weekDays.map((day) => { const dayEvents = events.filter((event) => !isSpanningEvent(event) && isSameDay(new Date(event.starts_at), day)); return <div className={`week-column ${isSameDay(day, now) ? 'today-column' : ''}`} key={toIsoDate(day)}>{WAKE_HOURS.map((hour) => <div className="hour-line" key={hour} />)}{dayEvents.map((event) => <WeekEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div> })}</div></div>
}

function MonthView({ viewDate, now, events, calendarById, onSelect, onNavigate, colorMode, weekStart }: { viewDate: Date; now: Date; events: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; onNavigate: (amount: number) => void; colorMode: SemanticColorMode; weekStart: WeekStart }) {
  const { days, title, refMonth } = resolveMonthView(viewDate, now, weekStart)
  const weeks = Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7))
  const eventsByDay = groupEvents(events.filter((event) => !isSpanningEvent(event)))
  return <div className="month-view"><div className="view-heading"><div><p className="section-kicker">Planning view</p><h1>{title}</h1></div><div className="view-nav"><button className="today-button" onClick={() => onNavigate(0)}>Today</button><button onClick={() => onNavigate(-1)} aria-label="Previous month">‹</button><button onClick={() => onNavigate(1)} aria-label="Next month">›</button></div></div><div className="month-grid">{weeks.map((week, weekIndex) => { const { bars, overflow } = layoutSpans(events, week, SPAN_MAX_LANES); const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0); return <div className="month-week" style={{ '--span-lanes': String(laneCount) } as CSSProperties} key={toIsoDate(week[0])}>{week.map((day) => { const dayEvents = eventsByDay.get(toIsoDate(day)) ?? []; const today = isSameDay(day, now); const extra = overflow.get(toIsoDate(day)) ?? 0; return <div className={`day-cell ${sameMonth(day, refMonth) ? '' : 'muted-day'} ${today ? 'today' : ''}`} key={toIsoDate(day)}><div className="day-heading">{weekIndex === 0 && <span className="weekday-tag">{WEEKDAYS[day.getDay()]}</span>}<span className="day-number">{day.getDate()}</span>{today && <span className="today-label">Today</span>}</div><div className="day-events">{dayEvents.map((event) => <EventChip event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}{extra > 0 && <span className="more-events">+{extra} spanning</span>}</div></div> })}{bars.length > 0 && <div className="month-week-spans">{bars.map((bar) => <SpanBar bar={bar} calendar={calendarById.get(bar.event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={bar.event.id} />)}</div>}</div> })}</div></div>
}

const categoryVar = (color?: string): CSSProperties | undefined => color ? ({ '--category-color': color } as CSSProperties) : undefined
// Pure identity tokens (matching the .calendar-<name> marker palette) for the secondary triangle.
const PALETTE_TOKEN: Record<string, string> = { coral: 'var(--coral)', ocean: 'var(--ocean)', gold: 'var(--gold)', fern: 'var(--fern)', violet: 'var(--violet)' }
// Events the provider gave no category still need a classification to sit beside the others: one
// low-saturation blue-grey that stays clear of the identity palette (coral/ocean/gold/fern/violet)
// and matches the neutral fallbacks already baked into App.css.
const UNCATEGORIZED: EventCategory = { id: '__uncategorized__', name: 'Uncategorized', color: '#6e8596' }
// One "main" association per classification, regardless of how many the backend attaches: the first
// real category wins, otherwise the generic uncategorized swatch stands in for it.
function primaryCategory(event: CalendarEvent) { return event.categories?.[0] ?? UNCATEGORIZED }
function mainCategory(event: CalendarEvent, colorMode: SemanticColorMode) { return colorMode === 'category-first' ? primaryCategory(event) : undefined }
function semanticEventClass(_event: CalendarEvent, calendar: Calendar | undefined, colorMode: SemanticColorMode) { return colorMode === 'category-first' ? 'category-dominant' : colorClass(calendar?.color ?? 'coral') }
// The secondary association — drawn as the left-edge triangle: the classification NOT painting the
// card. Shown whenever the event has a calendar; the category half always resolves (real or generic).
function eventAccent(event: CalendarEvent, calendar: Calendar | undefined, colorMode: SemanticColorMode): { color: string; label: string } | undefined {
  if (!calendar) return undefined
  if (colorMode === 'category-first') return { color: PALETTE_TOKEN[calendar.color] ?? PALETTE_TOKEN.coral, label: calendar.name }
  const category = primaryCategory(event)
  return { color: category.color, label: category.name }
}
function semanticEventStyle(event: CalendarEvent, calendar: Calendar | undefined, colorMode: SemanticColorMode): CSSProperties | undefined {
  const style: Record<string, string> = {}
  const primary = mainCategory(event, colorMode)
  if (primary) style['--category-color'] = primary.color
  const accent = eventAccent(event, calendar, colorMode)
  if (accent) style['--event-accent'] = accent.color
  return Object.keys(style).length ? (style as CSSProperties) : undefined
}
function SecondaryTriangle({ accent }: { accent?: { color: string; label: string } }) { if (!accent) return null; return <span className="secondary-triangle" role="img" aria-label={accent.label} /> }
function SpanBanner({ event, calendar, now, onSelect, colorMode }: EventProps & { now: Date; colorMode: SemanticColorMode }) {
  const label = isMultiDay(event) ? `Day ${dayIndexOf(event, now)} of ${spanLength(event)}` : 'All day'
  return <button className={`today-banner ${semanticEventClass(event, calendar, colorMode)}`} style={semanticEventStyle(event, calendar, colorMode)} onClick={() => onSelect(event)}><span className="today-banner-label">{label}</span><span className="today-banner-main"><strong>{event.title}</strong>{event.location && <small>{event.location}</small>}</span><span className="event-owner">{calendar?.name}</span></button>
}
function SpanBar({ bar, calendar, onSelect, colorMode }: { bar: SpanBarLayout; calendar?: Calendar; onSelect: (event: CalendarEvent) => void; colorMode: SemanticColorMode }) {
  const { event, startCol, endCol, lane, continuesBefore, continuesAfter } = bar
  const time = !event.all_day && isMultiDay(event)
  return <button
    className={`span-bar ${semanticEventClass(event, calendar, colorMode)} ${continuesBefore ? 'continues-before' : ''} ${continuesAfter ? 'continues-after' : ''}`}
    style={{ gridColumn: `${startCol} / ${endCol + 1}`, gridRow: lane + 1, ...semanticEventStyle(event, calendar, colorMode) }}
    onClick={() => onSelect(event)}
  >
    {continuesBefore && <span className="span-cap" aria-hidden>‹</span>}
    {time && !continuesBefore && <span className="span-bar-time">{formatEventTime(event.starts_at)}</span>}
    <strong>{event.title}</strong>
    {time && !continuesAfter && <span className="span-bar-time span-bar-end">{formatEventTime(event.ends_at)}</span>}
    {continuesAfter && <span className="span-cap span-cap-end" aria-hidden>›</span>}
  </button>
}
function LargeEvent({ event, calendar, onSelect, colorMode, past = false }: EventProps & { colorMode: SemanticColorMode; past?: boolean }) { return <button className={`large-event ${semanticEventClass(event, calendar, colorMode)} ${past ? 'past' : ''}`} style={semanticEventStyle(event, calendar, colorMode)} onClick={() => onSelect(event)}><SecondaryTriangle accent={eventAccent(event, calendar, colorMode)} /><span className="large-event-time">{event.all_day ? 'ALL DAY' : formatEventTime(event.starts_at)}</span><span className="large-event-main"><strong>{event.title}</strong>{event.location && <small>{event.location}</small>}</span><span className="event-owner">{calendar?.name}</span><span className="event-arrow">›</span></button> }
function CompactEvent({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { return <button className={`compact-event ${semanticEventClass(event, calendar, colorMode)}`} style={semanticEventStyle(event, calendar, colorMode)} onClick={() => onSelect(event)}><SecondaryTriangle accent={eventAccent(event, calendar, colorMode)} /><span><strong>{event.title}</strong><small>{event.all_day ? 'All day' : formatEventTime(event.starts_at)}</small></span></button> }
function WeekEvent({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { const start = new Date(event.starts_at); const end = new Date(event.ends_at); const top = ((start.getHours() + start.getMinutes() / 60) - 7) / 14 * 100; const height = Math.max(((end.getTime() - start.getTime()) / 3_600_000) / 14 * 100, 8); return <button className={`week-event ${semanticEventClass(event, calendar, colorMode)}`} style={{ top: `${Math.max(top, 1)}%`, height: `${Math.min(height, 97 - Math.max(top, 1))}%`, ...semanticEventStyle(event, calendar, colorMode) }} onClick={() => onSelect(event)}><SecondaryTriangle accent={eventAccent(event, calendar, colorMode)} /><strong>{event.title}</strong><span>{event.all_day ? 'All day' : formatEventTime(event.starts_at)}</span></button> }
function EventChip({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { return <button className={`event-chip ${semanticEventClass(event, calendar, colorMode)} ${event.all_day ? 'all-day' : ''}`} style={semanticEventStyle(event, calendar, colorMode)} onClick={() => onSelect(event)}><SecondaryTriangle accent={eventAccent(event, calendar, colorMode)} /><span className="event-time">{event.all_day ? 'ALL DAY' : formatEventTime(event.starts_at)}</span><strong>{event.title}</strong></button> }
function EventDetail({ event, calendar, onClose }: { event: CalendarEvent; calendar?: Calendar; onClose: () => void }) { const categories = event.categories ?? []; return <div className="detail-scrim" role="presentation" onClick={onClose}><section className="detail-sheet" role="dialog" aria-label="Event details" onClick={(eventClick) => eventClick.stopPropagation()}><button className="close-detail" onClick={onClose} aria-label="Close event details">×</button><span className={`detail-bar ${colorClass(calendar?.color ?? 'coral')}`} /><p className="section-kicker"><span className={`identity-dot ${colorClass(calendar?.color ?? 'coral')}`} />{calendar?.name ?? 'Household event'}</p><h2>{event.title}</h2><p className="detail-time">{formatEventWhen(event)}</p>{event.location && <p className="detail-location">{event.location}</p>}{categories.length > 0 && <div className="detail-categories"><span>Categories</span>{categories.map((category) => <span className="category-label" style={categoryVar(category.color)} key={category.id}><i />{category.name}</span>)}</div>}<div className="detail-actions"><button onClick={onClose}>Done</button><button className="quiet-action" onClick={onClose}>More actions later</button></div></section></div> }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>✓</span><strong>{text}</strong><small>No urgent plans ahead.</small></div> }
function stripScheme(uri: string | null) { return (uri ?? 'microsoft.com/devicelogin').replace(/^https?:\/\//, '') }
function CalendarConnect({ auth, addingCalendar, onStart, onCancel, onClose }: { auth: CalendarAuth; addingCalendar: boolean; onStart: () => void; onCancel: () => void; onClose: () => void }) {
  const connecting = auth.state === 'connecting'
  const heading = addingCalendar ? 'Add another Outlook calendar' : auth.account ? 'Reconnect your calendar' : 'Connect your Outlook calendar'
  const instruction = addingCalendar ? 'Scan the code with your phone and sign in with the Outlook account you want to add. Its calendar will appear alongside the calendars already on this display.' : 'A QR code and a short code will appear here. Scan it with your phone, sign in to your Microsoft account, and approve calendar access — nothing is typed on this screen.'
  return <div className="detail-scrim" role="presentation" onClick={onClose}><section className="detail-sheet connect-sheet" role="dialog" aria-label="Connect calendar" onClick={(event) => event.stopPropagation()}><button className="close-detail" onClick={onClose} aria-label="Close">×</button><span className="detail-bar calendar-coral" /><p className="section-kicker">Calendar sign-in</p>{connecting ? <><h2>Scan to finish on your phone</h2>{auth.verification_qr && <img className="connect-qr" src={auth.verification_qr} alt="QR code linking to the Microsoft sign-in page" />}<p className="connect-instruction">Go to <strong>{stripScheme(auth.verification_uri)}</strong> and enter this code:</p><p className="connect-code">{auth.user_code}</p><p className="connect-wait">Waiting for you to approve calendar access…</p><div className="detail-actions"><button className="quiet-action" onClick={onCancel}>Cancel</button></div></> : <><h2>{heading}</h2><p className="connect-instruction">{instruction}</p>{auth.error && <p className="connect-error">{auth.error}</p>}<div className="detail-actions"><button onClick={onStart}>Start sign-in</button><button className="quiet-action" onClick={onClose}>Not now</button></div></>}</section></div>
}

type EventProps = { event: CalendarEvent; calendar?: Calendar; onSelect: (event: CalendarEvent) => void }
function rangeForView(mode: ViewMode, date: Date, now: Date, weekStart: WeekStart) { if (mode === 'home') return { start: startOfDay(now), end: addDays(now, 14) }; if (mode === 'week') { const start = startOfWeek(date, weekStart); return { start, end: addDays(start, 6) } } const days = resolveMonthView(date, now, weekStart).days; return { start: days[0], end: days[days.length - 1] } }
function sortEvents(left: CalendarEvent, right: CalendarEvent) { return new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime() }
function groupEvents(events: CalendarEvent[]) { const grouped = new Map<string, CalendarEvent[]>(); events.forEach((event) => grouped.set(toIsoDate(new Date(event.starts_at)), [...(grouped.get(toIsoDate(new Date(event.starts_at))) ?? []), event].sort(sortEvents))); return grouped }

// --- Multi-day / all-day span handling ---
// All-day events carry an exclusive midnight end (Microsoft Graph's convention; the mock mirrors
// it), so the last calendar day an event actually covers is the day holding (ends_at - 1ms). Timed
// events that cross midnight get the same spanning treatment as all-day ones.
function eventStartDay(event: CalendarEvent) { return startOfDay(new Date(event.starts_at)) }
function eventEndDay(event: CalendarEvent) { return startOfDay(new Date(new Date(event.ends_at).getTime() - 1)) }
function spanLength(event: CalendarEvent) { return Math.round((eventEndDay(event).getTime() - eventStartDay(event).getTime()) / DAY_MS) + 1 }
function isMultiDay(event: CalendarEvent) { return eventEndDay(event).getTime() > eventStartDay(event).getTime() }
function isSpanningEvent(event: CalendarEvent) { return event.all_day || isMultiDay(event) }
function coversDay(event: CalendarEvent, day: Date) { const stamp = startOfDay(day).getTime(); return stamp >= eventStartDay(event).getTime() && stamp <= eventEndDay(event).getTime() }
function dayIndexOf(event: CalendarEvent, day: Date) { return Math.round((startOfDay(day).getTime() - eventStartDay(event).getTime()) / DAY_MS) + 1 }

type SpanBarLayout = { event: CalendarEvent; startCol: number; endCol: number; lane: number; continuesBefore: boolean; continuesAfter: boolean }
// Place spanning events into horizontal lanes across an ordered run of days (a week row, or the
// 7-day week grid). Longest events claim a lane first; anything past SPAN_MAX_LANES collapses to a
// per-day "+N" count so the lane block stays bounded.
function layoutSpans(events: CalendarEvent[], days: Date[], maxLanes: number): { bars: SpanBarLayout[]; overflow: Map<string, number> } {
  const first = startOfDay(days[0]).getTime()
  const last = startOfDay(days[days.length - 1]).getTime()
  const spanning = events
    .filter((event) => isSpanningEvent(event) && eventEndDay(event).getTime() >= first && eventStartDay(event).getTime() <= last)
    .sort((a, b) => eventStartDay(a).getTime() - eventStartDay(b).getTime() || spanLength(b) - spanLength(a) || a.title.localeCompare(b.title))
  const laneEnd: number[] = []
  const bars: SpanBarLayout[] = []
  const overflow = new Map<string, number>()
  for (const event of spanning) {
    const startStamp = eventStartDay(event).getTime()
    const endStamp = eventEndDay(event).getTime()
    const startCol = startStamp <= first ? 1 : Math.round((startStamp - first) / DAY_MS) + 1
    const endCol = endStamp >= last ? days.length : Math.round((endStamp - first) / DAY_MS) + 1
    let lane = laneEnd.findIndex((end) => end < startCol)
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(0) }
    if (lane >= maxLanes) {
      for (let col = startCol; col <= endCol; col += 1) { const key = toIsoDate(days[col - 1]); overflow.set(key, (overflow.get(key) ?? 0) + 1) }
      continue
    }
    laneEnd[lane] = endCol
    bars.push({ event, startCol, endCol, lane, continuesBefore: startStamp < first, continuesAfter: endStamp > last })
  }
  return { bars, overflow }
}
function formatSpanDate(date: Date) { return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) }
function formatEventWhen(event: CalendarEvent) {
  const multi = isMultiDay(event)
  if (event.all_day) return multi ? `All day · ${formatSpanDate(eventStartDay(event))} – ${formatSpanDate(eventEndDay(event))}` : 'All day'
  if (multi) return `${formatSpanDate(new Date(event.starts_at))}, ${formatEventTime(event.starts_at)} – ${formatSpanDate(new Date(event.ends_at))}, ${formatEventTime(event.ends_at)}`
  return `${formatEventTime(event.starts_at)} – ${formatEventTime(event.ends_at)}`
}
function formatTime(date: Date) { return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
function formatEventTime(value: string) { return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
function formatDate(date: Date) { return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) }
function formatShortDate(date: Date) { return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) }
function formatWeekday(date: Date) { return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) }
function formatMonthRange(start: Date, end: Date) { return start.getMonth() === end.getMonth() ? `${start.toLocaleDateString([], { month: 'long' })} ${start.getDate()}–${end.getDate()}` : `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}` }
function formatHour(hour: number) { return new Date(2020, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' }) }

export default App
