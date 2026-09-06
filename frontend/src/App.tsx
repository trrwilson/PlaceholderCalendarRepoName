import { useEffect, useRef, useState } from 'react'
import './App.css'

type Calendar = { id: string; name: string; color: string; enabled: boolean }
type EventCategory = { id: string; name: string; color: string }
type CalendarEvent = { id: string; calendar_id: string; title: string; starts_at: string; ends_at: string; location: string | null; all_day: boolean; categories?: EventCategory[] }
type Snapshot = { calendars: Calendar[]; events: CalendarEvent[] }
type ConnectionState = 'connecting' | 'live' | 'offline'
type ViewMode = 'home' | 'week' | 'month'
type SemanticColorMode = 'category-first' | 'people-first'
type WeekStart = 'monday' | 'sunday'
type CalendarAuthState = 'connected' | 'connecting' | 'disconnected' | 'not_applicable'
type CalendarAuth = { provider: string; state: CalendarAuthState; account: string | null; user_code: string | null; verification_uri: string | null; verification_uri_complete: string | null; verification_qr: string | null; expires_in: number | null; error: string | null }

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
const weekStartDay = (weekStart: WeekStart) => weekStart === 'sunday' ? 0 : 1
const orderedWeekdays = (weekStart: WeekStart) => Array.from({ length: 7 }, (_, index) => WEEKDAYS[(index + weekStartDay(weekStart)) % 7])

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
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const [auth, setAuth] = useState<CalendarAuth | null>(null)
  const [connectOpen, setConnectOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const filterRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)

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
    if (auth?.state === 'connected') { setConnectOpen(false); setReloadKey((key) => key + 1) }
  }, [auth?.state])

  function beginConnect() {
    setConnectOpen(true)
    fetch(`${API_URL}/api/calendar/auth/device`, { method: 'POST' })
      .then((response) => response.json() as Promise<CalendarAuth>)
      .then(setAuth)
      .catch(() => undefined)
  }

  function cancelConnect() {
    setConnectOpen(false)
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
    const range = rangeForView(mode, viewDate, now, weekStart)
    const params = new URLSearchParams({ starts_on: toIsoDate(range.start), ends_on: toIsoDate(range.end) })
    fetch(`${API_URL}/api/calendar?${params}`)
      .then((response) => response.json() as Promise<Snapshot>)
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot)
        setEnabledCalendars((current) => current.length ? current : nextSnapshot.calendars.map((calendar) => calendar.id))
      })
      .catch(() => setConnection('offline'))
  }, [mode, viewDate, now, weekStart, reloadKey])

  useEffect(() => {
    const socket = new WebSocket(API_URL.replace(/^http/, 'ws') + '/api/ws')
    socket.addEventListener('open', () => setConnection('live'))
    socket.addEventListener('close', () => setConnection('offline'))
    return () => socket.close()
  }, [])

  const calendars = snapshot?.calendars ?? []
  const calendarById = new Map(calendars.map((calendar) => [calendar.id, calendar]))
  const visibleEvents = (snapshot?.events ?? []).filter((event) => enabledCalendars.includes(event.calendar_id))
  const todayEvents = visibleEvents.filter((event) => isSameDay(new Date(event.starts_at), now)).sort(sortEvents)
  const upcoming = visibleEvents.filter((event) => new Date(event.ends_at) >= now).sort(sortEvents)
  const nextEvents = upcoming.filter((event) => !todayEvents.some((todayEvent) => todayEvent.id === event.id))

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

  function toggleCalendar(calendarId: string) {
    setEnabledCalendars((current) => current.includes(calendarId) ? current.filter((id) => id !== calendarId) : [...current, calendarId])
  }

  return (
    <main className="kiosk-shell">
      <header className="global-header">
        <button className="brand-lockup" onClick={goHome} aria-label="Go to Home"><span className="brand-icon">M</span><span><strong>Mission Control</strong><small>the household calendar</small></span></button>
        <div className="header-date"><span>{formatDate(now)}</span><strong>{formatTime(now)}</strong></div>
        <div className="header-actions">{authNeedsSetup ? <button className="calendar-alert" onClick={() => { goHome(); setConnectOpen(true) }}><i />Calendar sign-in</button> : <span className={`connection ${connection}`}><i />{connection === 'live' ? 'Live sync' : connection === 'offline' ? 'Offline mode' : 'Connecting'}</span>}<button className="ask-button" aria-label="Ask Mission Control"><span className="mic-symbol">◉</span><b>Ask</b></button><button className="add-button" aria-label="Add an event"><span>+</span><b>Add</b></button></div>
      </header>

      <section className="view-frame">
        {mode === 'home' && <HomeView now={now} todayEvents={todayEvents} upcoming={nextEvents} calendarById={calendarById} onSelect={setSelectedEvent} colorMode={colorMode} calendarAlert={authNeedsSetup ? { account: auth?.account ?? null, onConnect: () => setConnectOpen(true) } : null} />}
        {mode === 'week' && <WeekView viewDate={viewDate} now={now} events={visibleEvents} calendarById={calendarById} onSelect={setSelectedEvent} onNavigate={navigate} colorMode={colorMode} weekStart={weekStart} />}
        {mode === 'month' && <MonthView viewDate={viewDate} now={now} events={visibleEvents} calendarById={calendarById} onSelect={setSelectedEvent} onNavigate={navigate} colorMode={colorMode} weekStart={weekStart} />}
      </section>

      <footer className="bottom-dock"><nav><button onClick={goHome} className={mode === 'home' ? 'active' : ''}>Home</button><button onClick={() => { setMode('week'); setViewDate(new Date()); setFilterOpen(false); setSettingsOpen(false) }} className={mode === 'week' ? 'active' : ''}>Week</button><button onClick={() => { setMode('month'); setViewDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setFilterOpen(false); setSettingsOpen(false) }} className={mode === 'month' ? 'active' : ''}>Month</button></nav><div className="dock-actions" ref={filterRef}><button className="filter-toggle" onClick={() => { setFilterOpen((open) => !open); setSettingsOpen(false) }} aria-expanded={filterOpen}>People <span>{enabledCalendars.length}/{calendars.length || 4}</span></button>{filterOpen && <div className="filter-popover">{calendars.map((calendar) => <button className="filter-row" onClick={() => toggleCalendar(calendar.id)} key={calendar.id}><span className={`calendar-swatch ${colorClass(calendar.color)}`} /><span>{calendar.name}</span><strong>{enabledCalendars.includes(calendar.id) ? '✓' : ''}</strong></button>)}</div>}</div><div className="dock-actions" ref={settingsRef}><button className="settings-toggle" onClick={() => { setSettingsOpen((open) => !open); setFilterOpen(false) }} aria-expanded={settingsOpen} aria-label="Open settings">⚙<span>Settings</span></button>{settingsOpen && <div className="settings-popover" role="dialog" aria-label="Settings" onKeyDown={(event) => { if (event.key === 'Escape') setSettingsOpen(false) }}><strong>Event colors</strong><button className={colorMode === 'category-first' ? 'selected' : ''} onClick={() => setColorMode('category-first')}>Color events by category</button><button className={colorMode === 'people-first' ? 'selected' : ''} onClick={() => setColorMode('people-first')}>Color events by person/calendar</button><strong>Week starts on</strong><button className={weekStart === 'monday' ? 'selected' : ''} onClick={() => setWeekStart('monday')}>Monday</button><button className={weekStart === 'sunday' ? 'selected' : ''} onClick={() => setWeekStart('sunday')}>Sunday</button></div>}</div></footer>
      {selectedEvent && <EventDetail event={selectedEvent} calendar={calendarById.get(selectedEvent.calendar_id)} onClose={() => setSelectedEvent(null)} />}
      {connectOpen && auth && <CalendarConnect auth={auth} onStart={beginConnect} onCancel={cancelConnect} onClose={() => setConnectOpen(false)} />}
    </main>
  )
}

function HomeView({ now, todayEvents, upcoming, calendarById, onSelect, colorMode, calendarAlert }: { now: Date; todayEvents: CalendarEvent[]; upcoming: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; colorMode: SemanticColorMode; calendarAlert: { account: string | null; onConnect: () => void } | null }) {
  const tomorrow = upcoming.filter((event) => isSameDay(new Date(event.starts_at), addDays(now, 1))).slice(0, 3)
  return <div className="home-view"><div className="home-grid"><section className="today-schedule"><div className="view-heading"><div><p className="section-kicker">Today</p><h2>{todayEvents.length} things on the rhythm</h2></div><span className="date-pill">{formatShortDate(now)}</span></div>{todayEvents.length ? <div className="large-agenda">{todayEvents.map((event) => <LargeEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} past={new Date(event.ends_at) < now} colorMode={colorMode} key={event.id} />)}</div> : <EmptyState text="A clear rest of the day." />}</section><aside className="home-rail"><section className="next-card"><div className="view-heading"><div><p className="section-kicker">Coming up</p><h2>Next</h2></div><span className="arrow-mark">→</span></div><div className="next-list">{upcoming.slice(0, 4).map((event) => <CompactEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div></section><section className="tomorrow-card"><p className="section-kicker">Tomorrow</p><h2>{formatWeekday(addDays(now, 1))}</h2>{tomorrow.length ? tomorrow.map((event) => <CompactEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />) : <p>No events planned yet.</p>}</section>{calendarAlert ? <section className="exception-card"><span className="exception-mark">!</span><div><p className="section-kicker">Needs attention</p><strong>Calendar sign-in needed</strong><span>{calendarAlert.account ? `Reconnect ${calendarAlert.account}` : 'Connect a household calendar'}</span></div><button onClick={calendarAlert.onConnect}>Connect</button></section> : <section className="exception-card"><span className="exception-mark">!</span><div><p className="section-kicker">Needs attention</p><strong>{MOCK_EXCEPTION.title}</strong><span>{MOCK_EXCEPTION.detail}</span></div><button onClick={() => undefined}>{MOCK_EXCEPTION.action}</button></section>}</aside></div></div>
}

function WeekView({ viewDate, now, events, calendarById, onSelect, onNavigate, colorMode, weekStart }: { viewDate: Date; now: Date; events: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; onNavigate: (amount: number) => void; colorMode: SemanticColorMode; weekStart: WeekStart }) {
  const start = startOfWeek(viewDate, weekStart)
  return <div className="week-view"><div className="view-heading week-heading"><div><p className="section-kicker">Week at a glance</p><h1>{formatMonthRange(start, addDays(start, 6))}</h1></div><div className="view-nav"><button onClick={() => onNavigate(-1)} aria-label="Previous week">‹</button><button onClick={() => onNavigate(1)} aria-label="Next week">›</button></div></div><div className="week-grid"><div className="time-gutter" />{Array.from({ length: 7 }, (_, index) => { const day = addDays(start, index); return <div className={`week-day-head ${isSameDay(day, now) ? 'today' : ''}`} key={toIsoDate(day)}><span>{WEEKDAYS[day.getDay()]}</span><strong>{day.getDate()}</strong></div> })}<div className="time-gutter hours">{WAKE_HOURS.map((hour) => <span key={hour}>{formatHour(hour)}</span>)}</div>{Array.from({ length: 7 }, (_, dayIndex) => { const day = addDays(start, dayIndex); const dayEvents = events.filter((event) => isSameDay(new Date(event.starts_at), day)); return <div className={`week-column ${isSameDay(day, now) ? 'today-column' : ''}`} key={toIsoDate(day)}>{WAKE_HOURS.map((hour) => <div className="hour-line" key={hour} />)}{dayEvents.map((event) => <WeekEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div> })}</div></div>
}

function MonthView({ viewDate, now, events, calendarById, onSelect, onNavigate, colorMode, weekStart }: { viewDate: Date; now: Date; events: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; onNavigate: (amount: number) => void; colorMode: SemanticColorMode; weekStart: WeekStart }) {
  const days = buildCalendarDays(viewDate, weekStart)
  const eventsByDay = groupEvents(events)
  return <div className="month-view"><div className="view-heading"><div><p className="section-kicker">Planning view</p><h1>{viewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h1></div><div className="view-nav"><button className="today-button" onClick={() => onNavigate(0)}>Today</button><button onClick={() => onNavigate(-1)} aria-label="Previous month">‹</button><button onClick={() => onNavigate(1)} aria-label="Next month">›</button></div></div><div className="weekday-row">{orderedWeekdays(weekStart).map((day) => <span key={day}>{day}</span>)}</div><div className="month-grid">{days.map((day) => { const dayEvents = eventsByDay.get(toIsoDate(day)) ?? []; const today = isSameDay(day, now); return <div className={`day-cell ${day.getMonth() !== viewDate.getMonth() ? 'muted-day' : ''} ${today ? 'today' : ''}`} key={toIsoDate(day)}><div className="day-heading"><span className="day-number">{day.getDate()}</span>{today && <span className="today-label">Today</span>}</div><div className="day-events">{dayEvents.slice(0, 4).map((event) => <EventChip event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}{dayEvents.length > 4 && <span className="more-events">+{dayEvents.length - 4} more</span>}</div></div> })}</div></div>
}

function CategoryMarkers({ categories = [] }: { categories?: EventCategory[] }) { if (!categories.length) return null; return <span className="category-markers" aria-label={categories.map((category) => category.name).join(', ')}>{categories.map((category) => <i className={`category-dot category-${category.color}`} title={category.name} key={category.id} />)}</span> }
function semanticEventClass(event: CalendarEvent, calendar: Calendar | undefined, colorMode: SemanticColorMode) { const category = event.categories?.[0]; return colorMode === 'category-first' && category ? `category-dominant category-${category.color}` : colorClass(calendar?.color ?? 'coral') }
function IdentityMarker({ calendar }: { calendar?: Calendar }) { if (!calendar) return null; return <span className={`identity-marker ${colorClass(calendar.color)}`} aria-label={calendar.name} /> }
function LargeEvent({ event, calendar, onSelect, colorMode, past = false }: EventProps & { colorMode: SemanticColorMode; past?: boolean }) { return <button className={`large-event ${semanticEventClass(event, calendar, colorMode)} ${past ? 'past' : ''}`} onClick={() => onSelect(event)}><span className="large-event-time">{event.all_day ? 'ALL DAY' : formatEventTime(event.starts_at)}</span><span className="large-event-main"><strong>{event.title}</strong>{event.location && <small>{event.location}</small>}</span><span className="event-owner"><IdentityMarker calendar={calendar} /><CategoryMarkers categories={colorMode === 'people-first' ? event.categories : []} />{calendar?.name}</span><span className="event-arrow">›</span></button> }
function CompactEvent({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { return <button className={`compact-event ${semanticEventClass(event, calendar, colorMode)}`} onClick={() => onSelect(event)}><span><strong>{event.title}</strong><small><IdentityMarker calendar={colorMode === 'category-first' ? calendar : undefined} /><CategoryMarkers categories={colorMode === 'people-first' ? event.categories : []} />{event.all_day ? 'All day' : formatEventTime(event.starts_at)}</small></span></button> }
function WeekEvent({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { const start = new Date(event.starts_at); const end = new Date(event.ends_at); const top = ((start.getHours() + start.getMinutes() / 60) - 7) / 14 * 100; const height = Math.max(((end.getTime() - start.getTime()) / 3_600_000) / 14 * 100, 8); return <button className={`week-event ${semanticEventClass(event, calendar, colorMode)}`} style={{ top: `${Math.max(top, 1)}%`, height: `${Math.min(height, 97 - Math.max(top, 1))}%` }} onClick={() => onSelect(event)}><strong>{event.title}</strong><span><IdentityMarker calendar={colorMode === 'category-first' ? calendar : undefined} /><CategoryMarkers categories={colorMode === 'people-first' ? event.categories : []} />{event.all_day ? 'All day' : formatEventTime(event.starts_at)}</span></button> }
function EventChip({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { return <button className={`event-chip ${semanticEventClass(event, calendar, colorMode)} ${event.all_day ? 'all-day' : ''}`} onClick={() => onSelect(event)}><span className="event-time">{event.all_day ? 'ALL DAY' : formatEventTime(event.starts_at)}</span><strong>{event.title}</strong><span><IdentityMarker calendar={colorMode === 'category-first' ? calendar : undefined} /><CategoryMarkers categories={colorMode === 'people-first' ? event.categories : []} /></span></button> }
function EventDetail({ event, calendar, onClose }: { event: CalendarEvent; calendar?: Calendar; onClose: () => void }) { const categories = event.categories ?? []; return <div className="detail-scrim" role="presentation" onClick={onClose}><section className="detail-sheet" role="dialog" aria-label="Event details" onClick={(eventClick) => eventClick.stopPropagation()}><button className="close-detail" onClick={onClose} aria-label="Close event details">×</button><span className={`detail-bar ${colorClass(calendar?.color ?? 'coral')}`} /><p className="section-kicker"><span className={`identity-dot ${colorClass(calendar?.color ?? 'coral')}`} />{calendar?.name ?? 'Household event'}</p><h2>{event.title}</h2><p className="detail-time">{event.all_day ? 'All day' : `${formatEventTime(event.starts_at)} – ${formatEventTime(event.ends_at)}`}</p>{event.location && <p className="detail-location">{event.location}</p>}{categories.length > 0 && <div className="detail-categories"><span>Categories</span>{categories.map((category) => <span className={`category-label category-${category.color}`} key={category.id}><i />{category.name}</span>)}</div>}<div className="detail-actions"><button onClick={onClose}>Done</button><button className="quiet-action" onClick={onClose}>More actions later</button></div></section></div> }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>✓</span><strong>{text}</strong><small>No urgent plans ahead.</small></div> }
function stripScheme(uri: string | null) { return (uri ?? 'microsoft.com/devicelogin').replace(/^https?:\/\//, '') }
function CalendarConnect({ auth, onStart, onCancel, onClose }: { auth: CalendarAuth; onStart: () => void; onCancel: () => void; onClose: () => void }) {
  const connecting = auth.state === 'connecting'
  return <div className="detail-scrim" role="presentation" onClick={onClose}><section className="detail-sheet connect-sheet" role="dialog" aria-label="Connect calendar" onClick={(event) => event.stopPropagation()}><button className="close-detail" onClick={onClose} aria-label="Close">×</button><span className="detail-bar calendar-coral" /><p className="section-kicker">Calendar sign-in</p>{connecting ? <><h2>Scan to finish on your phone</h2>{auth.verification_qr && <img className="connect-qr" src={auth.verification_qr} alt="QR code linking to the Microsoft sign-in page" />}<p className="connect-instruction">Go to <strong>{stripScheme(auth.verification_uri)}</strong> and enter this code:</p><p className="connect-code">{auth.user_code}</p><p className="connect-wait">Waiting for you to approve calendar access…</p><div className="detail-actions"><button className="quiet-action" onClick={onCancel}>Cancel</button></div></> : <><h2>{auth.account ? 'Reconnect your calendar' : 'Connect your Outlook calendar'}</h2><p className="connect-instruction">A QR code and a short code will appear here. Scan it with your phone, sign in to your Microsoft account, and approve calendar access — nothing is typed on this screen.</p>{auth.error && <p className="connect-error">{auth.error}</p>}<div className="detail-actions"><button onClick={onStart}>Start sign-in</button><button className="quiet-action" onClick={onClose}>Not now</button></div></>}</section></div>
}

type EventProps = { event: CalendarEvent; calendar?: Calendar; onSelect: (event: CalendarEvent) => void }
function rangeForView(mode: ViewMode, date: Date, now: Date, weekStart: WeekStart) { if (mode === 'home') return { start: startOfDay(now), end: addDays(now, 14) }; if (mode === 'week') { const start = startOfWeek(date, weekStart); return { start, end: addDays(start, 6) } } const start = new Date(date.getFullYear(), date.getMonth(), 1); const end = new Date(date.getFullYear(), date.getMonth() + 1, 0); const leading = (start.getDay() - weekStartDay(weekStart) + 7) % 7; const trailing = (weekStartDay(weekStart) + 6 - end.getDay() + 7) % 7; return { start: addDays(start, -leading), end: addDays(end, trailing) } }
function startOfDay(date: Date) { return new Date(date.getFullYear(), date.getMonth(), date.getDate()) }
function startOfWeek(date: Date, weekStart: WeekStart) { const start = startOfDay(date); start.setDate(start.getDate() - ((start.getDay() - weekStartDay(weekStart) + 7) % 7)); return start }
function addDays(date: Date, amount: number) { const result = new Date(date); result.setDate(result.getDate() + amount); return result }
function isSameDay(left: Date, right: Date) { return toIsoDate(left) === toIsoDate(right) }
function toIsoDate(date: Date) { return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-') }
function sortEvents(left: CalendarEvent, right: CalendarEvent) { return new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime() }
function groupEvents(events: CalendarEvent[]) { const grouped = new Map<string, CalendarEvent[]>(); events.forEach((event) => grouped.set(toIsoDate(new Date(event.starts_at)), [...(grouped.get(toIsoDate(new Date(event.starts_at))) ?? []), event].sort(sortEvents))); return grouped }
function formatTime(date: Date) { return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
function formatEventTime(value: string) { return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
function formatDate(date: Date) { return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) }
function formatShortDate(date: Date) { return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) }
function formatWeekday(date: Date) { return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) }
function formatMonthRange(start: Date, end: Date) { return start.getMonth() === end.getMonth() ? `${start.toLocaleDateString([], { month: 'long' })} ${start.getDate()}–${end.getDate()}` : `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}` }
function formatHour(hour: number) { return new Date(2020, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' }) }
function buildCalendarDays(month: Date, weekStart: WeekStart) { const start = new Date(month.getFullYear(), month.getMonth(), 1); start.setDate(start.getDate() - ((start.getDay() - weekStartDay(weekStart) + 7) % 7)); return Array.from({ length: 42 }, (_, index) => addDays(start, index)) }

export default App
