import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import './App.css'
import { addDays, DAY_MS, isSameDay, resolveMonthView, sameMonth, startOfDay, startOfWeek, toIsoDate, type WeekStart } from './dates'
import { holidayOn } from './holidays'
import type { DashboardActions } from './voice/types'
import type { WakeState } from './voice/wake/useWakeWord'
import { useVoiceSession } from './voice/useVoiceSession'
import { useVoiceConfig } from './voice/useVoiceConfig'
import { useAudioInput } from './voice/useAudioInput'
import { useAudioOutput } from './voice/useAudioOutput'
import { VoiceOverlay } from './voice/VoiceOverlay'
import { VoiceToast } from './voice/VoiceToast'
import { TimerView } from './timers/TimerView'
import { useTimers } from './timers/useTimers'
import { ListsView } from './lists/ListsView'
import { useLists } from './lists/useLists'
import type { ListItem } from './lists/types'
import { usePrivacy } from './privacy/usePrivacy'
import { PrivacyPad } from './privacy/PrivacyPad'
import { useDisplay } from './display/useDisplay'
import { useCameraActivity } from './camera/useCameraActivity'
import type { StoredClip } from './camera/types'

type CalendarSource = 'mock' | 'outlook' | 'google'
// `name` is the raw account handle; `display_name` is the natural personal name the
// provider resolved (given name > full name > handle). Older snapshots omit both new
// fields, so treat them as optional and fall back.
type Calendar = { id: string; name: string; display_name?: string; color: string; source?: CalendarSource; enabled: boolean }
type EventCategory = { id: string; name: string; color: string } // color: a concrete #rrggbb from the provider (e.g. Outlook master-category swatch)
type CalendarEvent = { id: string; calendar_id: string; title: string; starts_at: string; ends_at: string; location: string | null; all_day: boolean; categories?: EventCategory[] }
type Snapshot = { calendars: Calendar[]; events: CalendarEvent[] }
type ConnectionState = 'connecting' | 'live' | 'offline'
type ViewMode = 'home' | 'week' | 'month' | 'timer' | 'lists'
type SemanticColorMode = 'category-first' | 'people-first'
type CalendarAuthState = 'connected' | 'connecting' | 'disconnected' | 'not_applicable'
type CalendarAuth = { provider: string; state: CalendarAuthState; account: string | null; accounts?: string[]; user_code: string | null; verification_uri: string | null; verification_uri_complete: string | null; verification_qr: string | null; expires_in: number | null; error: string | null }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WAKE_HOURS = Array.from({ length: 14 }, (_, index) => index + 7)
const colorClass = (color: string) => `calendar-${color}`
const personName = (calendar?: Calendar) => calendar?.display_name || calendar?.name || ''
// Privacy mode: obscure the *what* (title, location, category) while keeping the
// *when / how many / whose* — see docs/privacy-mode-plan.md. A deterministic
// placeholder, never the real string transformed, so nothing about the title
// (length, shape) leaks. Category treatment drops entirely (identity colour
// only, which is the "whose" the household keeps).
const REDACTED_TITLE = '•••'
const redactEvent = (event: CalendarEvent): CalendarEvent => ({
  ...event,
  title: REDACTED_TITLE,
  location: null,
  categories: [],
})
// A small provider mark shown after a person's name (e.g. "Travis ⧉"). Inline SVG so it
// scales with the surrounding type and needs no asset. `mock` has no badge.
function ProviderBadge({ source }: { source?: CalendarSource }) {
  if (source === 'outlook') {
    return (
      <svg className="provider-badge" viewBox="0 0 24 24" role="img" aria-label="Outlook calendar" focusable="false">
        <rect x="1" y="4" width="22" height="16" rx="2.5" fill="#0F6CBD" />
        <path fill="#fff" d="M8 8.4c-2 0-3.4 1.5-3.4 3.7S6 15.8 8 15.8s3.4-1.5 3.4-3.7S10 8.4 8 8.4zm0 5.9c-1 0-1.7-.9-1.7-2.2S7 9.9 8 9.9s1.7.9 1.7 2.2-.7 2.2-1.7 2.2z" />
        <path fill="#fff" opacity=".85" d="M12.4 9.3 19 6.7v10.6l-6.6-2.6z" />
      </svg>
    )
  }
  if (source === 'google') {
    return (
      <svg className="provider-badge" viewBox="0 0 24 24" role="img" aria-label="Google calendar" focusable="false">
        <path fill="#4285F4" d="M22 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.6a4.8 4.8 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.5 3.1-7.6z" />
        <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.4-2.6c-.9.6-2 1-3.3 1-2.6 0-4.8-1.7-5.5-4.1H2.9v2.6A10 10 0 0 0 12 22z" />
        <path fill="#FBBC05" d="M6.5 13.9a6 6 0 0 1 0-3.8V7.5H2.9a10 10 0 0 0 0 9z" />
        <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 2.9 7.5l3.6 2.6C7.2 7.7 9.4 6 12 6z" />
      </svg>
    )
  }
  return null
}
const COLOR_MODE_KEY = 'mission-control.semantic-color-mode'
const readColorMode = (): SemanticColorMode => window.localStorage.getItem(COLOR_MODE_KEY) === 'people-first' ? 'people-first' : 'category-first'
const WEEK_START_KEY = 'mission-control.week-start'
const readWeekStart = (): WeekStart => window.localStorage.getItem(WEEK_START_KEY) === 'sunday' ? 'sunday' : 'monday'
// Once someone opens the bake-off disclosure they usually keep switching providers, so
// remember it across sessions — the engineering knobs stay one tap closer.
const ADVANCED_OPEN_KEY = 'mission-control.settings-advanced-open'
const readAdvancedOpen = (): boolean => {
  try { return window.localStorage.getItem(ADVANCED_OPEN_KEY) === 'open' } catch { return false }
}
const CALENDAR_PALETTE = ['coral', 'ocean', 'gold', 'fern', 'violet'] as const
// Stacked all-day/multi-day bars shown in Week and Month before the rest collapse to a "+N" count.
const SPAN_MAX_LANES = 3
// The most rows (full-size event chips, plus a "+N more" row when it's needed) a Month day cell
// will ever show. Event typography and touch size never shrink to fit more — the overflow is
// disclosed progressively instead (see AGENTS.md). A 4K kiosk cell clears three rows; a 1080p
// cell only two, so the ceiling follows viewport height rather than scaling the chips down.
function readMonthRowCap() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 2
  return window.matchMedia('(min-height: 1600px)').matches ? 3 : 2
}
function useMonthRowCap() {
  const [cap, setCap] = useState(readMonthRowCap)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(min-height: 1600px)')
    const update = () => setCap(readMonthRowCap())
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return cap
}
const WAKE_STATUS_TEXT: Record<WakeState, string> = {
  off: 'Off',
  loading: 'Starting…',
  armed: 'Armed — listening locally for the phrase',
  suspended: 'Paused while you’re talking',
  error: 'Unavailable — push-to-talk still works',
}
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
  const [timerNotice, setTimerNotice] = useState<string | null>(null)
  const [listNotice, setListNotice] = useState<{ text: string; restore?: ListItem[] } | null>(null)
  const [privacyPadOpen, setPrivacyPadOpen] = useState(false)
  const [privacyNotice, setPrivacyNotice] = useState(false)
  const filterRef = useRef<HTMLDivElement>(null)
  const settingsRef = useRef<HTMLDivElement>(null)
  const linkedAccountsRef = useRef(0)
  const hadActiveTimerRef = useRef(false)

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
    if (mode === 'timer') return
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

  const timers = useTimers({
    apiBaseUrl: API_URL,
    onConnectionChange: setConnection,
    onStarted: (_timer, replaced) => {
      setMode('timer')
      setSelectedEvent(null)
      if (replaced) setTimerNotice(`Replaced your ${replaced.label ? `“${replaced.label}” ` : ''}timer`)
    },
    onFired: () => { setMode('timer'); setSelectedEvent(null); setFilterOpen(false); setSettingsOpen(false) },
  })

  // Once a timer exists it becomes the default view: the first time one appears
  // (any modality, cold boot included) switch to the Timer tab. Manual
  // navigation afterwards is left alone — the switch only fires on the edge.
  useEffect(() => {
    if (timers.hasActiveTimer && !hadActiveTimerRef.current) setMode('timer')
    hadActiveTimerRef.current = timers.hasActiveTimer
  }, [timers.hasActiveTimer])

  useEffect(() => {
    if (!timerNotice) return
    const clear = window.setTimeout(() => setTimerNotice(null), 6_000)
    return () => window.clearTimeout(clear)
  }, [timerNotice])

  // The grocery list. Backend-owned + persisted; a voice add / remove / clear on
  // any screen lands here through the shared `/api/ws` push. See docs/lists-plan.md.
  const lists = useLists({
    apiBaseUrl: API_URL,
    onRemoved: (removed: ListItem[], kind) => {
      if (kind !== 'cleared' || removed.length === 0) return
      const noun = removed.length === 1 ? 'item' : 'items'
      setListNotice({ text: `Cleared ${removed.length} ${noun}`, restore: removed })
    },
  })

  useEffect(() => {
    if (!listNotice) return
    const clear = window.setTimeout(() => setListNotice(null), 8_000)
    return () => window.clearTimeout(clear)
  }, [listNotice])

  // Privacy mode. Household-global + persisted: a long-press on the logo, a
  // Settings row, or a voice command locks it here; only the on-screen PIN
  // unlocks it. Backed by usePrivacy → GET /api/privacy + the shared ws push.
  const privacy = usePrivacy(API_URL)

  // The physical wall panel's brightness / night mode. Backend-owned (a browser
  // tab cannot set Windows brightness); this hook reconciles from GET /api/display
  // and the shared ws push. See docs/display-dimming-plan.md.
  const display = useDisplay(API_URL)

  // The eufy camera clip gallery — a thumbnail review of the latest footage,
  // replacing the home view's "garage door" placeholder. Backend-owned (it
  // holds the eufy bridge connection); this hook reconciles from
  // GET /api/household and the shared ws push. See docs/eufy-sdk-integration.md.
  const camera = useCameraActivity(API_URL)
  const [selectedClip, setSelectedClip] = useState<StoredClip | null>(null)

  function enterPrivacyMode() {
    if (!privacy.available || privacy.locked) return
    void privacy.lock().then((ok) => {
      if (ok) setPrivacyNotice(true)
    })
  }

  // Whatever locked it (this screen, another screen, or voice), collapse the
  // interactive chrome and any open sheet.
  useEffect(() => {
    if (!privacy.locked) {
      setPrivacyPadOpen(false)
      setPrivacyNotice(false)
      return
    }
    setFilterOpen(false)
    setSettingsOpen(false)
    setSelectedEvent(null)
    setConnectOpen(false)
    setSelectedClip(null)
  }, [privacy.locked])

  // The no-PIN undo window closes on its own after a few seconds.
  useEffect(() => {
    if (!privacyNotice) return
    const clear = window.setTimeout(() => setPrivacyNotice(false), 8_000)
    return () => window.clearTimeout(clear)
  }, [privacyNotice])

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

  // Privacy mode redacts at the render boundary — the snapshot the backend sent
  // is untouched, the kiosk just chooses not to show the specifics, so unlock is
  // instant. Category treatment collapses to identity colour (people-first).
  const redacting = privacy.locked
  const displayColorMode: SemanticColorMode = redacting ? 'people-first' : colorMode
  const selectEvent = redacting ? () => undefined : setSelectedEvent
  const shownTodayEvents = redacting ? todayEvents.map(redactEvent) : todayEvents
  const shownTodaySpans = redacting ? todaySpans.map(redactEvent) : todaySpans
  const shownNextEvents = redacting ? nextEvents.map(redactEvent) : nextEvents
  const shownVisibleEvents = redacting ? visibleEvents.map(redactEvent) : visibleEvents

  // The viewed period now lives in the global header (Week/Month dropped their own heading
  // band); the dock offers a "Today" jump only while you've paged away from the current one.
  const weekStartDate = startOfWeek(viewDate, weekStart)
  const viewedPeriod = mode === 'week'
    ? formatMonthRange(weekStartDate, addDays(weekStartDate, 6))
    : mode === 'month'
      ? resolveMonthView(viewDate, now, weekStart).title
      : null
  const viewingToday = mode === 'home' || mode === 'timer'
    || (mode === 'week' && isSameDay(weekStartDate, startOfWeek(now, weekStart)))
    || (mode === 'month' && sameMonth(viewDate, now))

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
      const named = new Map((snapshot?.calendars ?? []).map((calendar) => [calendar.id, `${calendar.name} ${personName(calendar)}`.toLowerCase()]))
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
    setPeopleFilter: (mode, people) => {
      const all = snapshot?.calendars ?? []
      const resolve = (ref: string): string | null => {
        const needle = ref.trim().toLowerCase()
        if (!needle) return null
        const byId = all.find((calendar) => calendar.id.toLowerCase() === needle)
        if (byId) return byId.id
        const byName = all.find((calendar) =>
          personName(calendar).toLowerCase().includes(needle) ||
          calendar.name.toLowerCase().includes(needle) ||
          personName(calendar).toLowerCase().split(' ')[0] === needle,
        )
        return byName?.id ?? null
      }
      const resolved = people.map((ref) => ({ ref, id: resolve(ref) }))
      const ids = resolved.filter((r) => r.id).map((r) => r.id as string)
      const unmatched = resolved.filter((r) => !r.id).map((r) => r.ref)
      if (mode === 'all') setEnabledCalendars(all.map((calendar) => calendar.id))
      else if (mode === 'only' && ids.length) setEnabledCalendars(ids)
      else if (mode === 'add' && ids.length)
        setEnabledCalendars((current) => [...new Set([...current, ...ids])])
      else if (mode === 'remove' && ids.length)
        setEnabledCalendars((current) => current.filter((id) => !ids.includes(id)))
      setFilterOpen(false)
      setSettingsOpen(false)
      return { matched: ids, unmatched }
    },
    requestPrivacyUnlock: () => setPrivacyPadOpen(true),
  }), [snapshot])

  const voice = useVoiceSession({
    apiBaseUrl: API_URL,
    actions: voiceActions,
    surface: 'kiosk',
    privacyLocked: privacy.locked,
  })
  const voiceConfig = useVoiceConfig(API_URL)
  const audioInput = useAudioInput()
  const audioOutput = useAudioOutput({
    apiBaseUrl: API_URL,
    invokeAvailable: voiceConfig.config.invoke_speaker_configured,
  })

  function navigate(amount: number) {
    setViewDate((current) => amount === 0 ? (mode === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now)) : mode === 'month' ? new Date(current.getFullYear(), current.getMonth() + amount, 1) : addDays(current, amount * (mode === 'week' ? 7 : 1)))
    setSelectedEvent(null)
    setFilterOpen(false)
    setSettingsOpen(false)
  }

  function goHome() {
    setViewDate(new Date())
    // The Home / brand control always goes Home. A running timer makes the Timer
    // view the *ambient* default (cold boot and on-fire land there via the
    // hasActiveTimer edge effect and onFired; a future idle-revert would too) but
    // it never overrides an explicit tap — navigation stays unlocked while a timer
    // runs. See docs/timer-plan.md → "Default view while a timer is active".
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

  function startTimerFromTouch(durationSeconds: number, label: string | null) {
    timers.start(durationSeconds, label).catch((error: unknown) => {
      setTimerNotice(error instanceof Error ? error.message : 'Could not start the timer.')
    })
  }

  function extendTimer(addSeconds: number) {
    timers.extend(addSeconds).catch((error: unknown) => {
      setTimerNotice(error instanceof Error ? error.message : 'Could not extend the timer.')
    })
  }

  function timerAction(verb: 'pause' | 'resume' | 'restart') {
    timers[verb]().catch((error: unknown) => {
      setTimerNotice(error instanceof Error ? error.message : `Could not ${verb} the timer.`)
    })
  }

  return (
    <main className={`kiosk-shell${redacting ? ' is-private' : ''}`}>
      {redacting && <span className="privacy-watermark" aria-hidden>Privacy mode</span>}
      <header className="global-header">
        <BrandLockup onHome={goHome} onLongPress={privacy.available && !redacting ? enterPrivacyMode : undefined} />
        <div className="header-center"><span className="header-period">{viewedPeriod ?? formatDate(now)}</span><span className="header-now">{viewedPeriod && <small>{formatShortDate(now)}</small>}<strong>{formatTime(now)}</strong></span></div>
        <div className="header-actions">{redacting && <button className="privacy-lock" aria-label="Turn off privacy mode" onClick={() => setPrivacyPadOpen(true)}><span aria-hidden>🔒</span></button>}{!redacting && (authNeedsSetup ? <button className="calendar-alert" onClick={() => { goHome(); setAddingCalendar(false); setConnectOpen(true) }}><i />Calendar sign-in</button> : <SyncStatus connection={connection} />)}<button className={`ask-button voice-${voice.status}`} aria-label={voice.status === 'listening' ? 'Stop voice input' : 'Ask Mission Control'} aria-pressed={voice.status === 'listening'} disabled={voice.status === 'unavailable' && voice.error?.kind === 'disabled'} onClick={() => (voice.status === 'listening' ? voice.stopTurn() : voice.startTurn())}><span className="mic-symbol">◉</span><b>{voice.status === 'unavailable' ? 'Voice off' : voice.status === 'listening' ? 'Listening' : 'Ask'}</b></button>{voice.micActive && <span className="mic-live" role="status" aria-label="Microphone is on"><i />Mic on</span>}{voice.status === 'armed' && !voice.micActive && <span className="wake-armed" role="status" aria-label={`Listening for ${voice.wake.phrase}`}><i />“{voice.wake.phrase}”</span>}{!redacting && <button className="add-button" aria-label="Add an event"><span>+</span><b>Add</b></button>}</div>
      </header>

      <section className="view-frame">
        {mode === 'home' && <HomeView now={now} todayEvents={shownTodayEvents} todaySpans={shownTodaySpans} upcoming={shownNextEvents} calendarById={calendarById} onSelect={selectEvent} colorMode={displayColorMode} calendarAlert={authNeedsSetup && !redacting ? { account: auth?.account ?? null, onConnect: () => { setAddingCalendar(false); setConnectOpen(true) } } : null} camera={camera} redacting={redacting} onSelectClip={redacting ? () => undefined : setSelectedClip} apiBaseUrl={API_URL} />}
        {mode === 'week' && <WeekView viewDate={viewDate} now={now} events={shownVisibleEvents} calendarById={calendarById} onSelect={selectEvent} onNavigate={navigate} colorMode={displayColorMode} weekStart={weekStart} />}
        {mode === 'month' && <MonthView viewDate={viewDate} now={now} events={shownVisibleEvents} calendarById={calendarById} onSelect={selectEvent} onNavigate={navigate} colorMode={displayColorMode} weekStart={weekStart} />}
        {mode === 'timer' && <TimerView timer={timers.timer} remainingMs={timers.remainingMs} alarm={timers.alarm} onStart={startTimerFromTouch} onExtend={extendTimer} onPause={() => timerAction('pause')} onResume={() => timerAction('resume')} onRestart={() => timerAction('restart')} onCancel={() => { void timers.cancel() }} onDismiss={() => { void timers.dismiss() }} />}
        {mode === 'lists' && <ListsView list={lists.list} recentItems={lists.recentItems} redacted={redacting} onAdd={(name) => { if (!redacting) void lists.add(name) }} onToggle={(id, checked) => { if (!redacting) void lists.toggle(id, checked) }} onRemove={(id) => { if (!redacting) void lists.remove(id) }} onClear={(scope) => { if (!redacting) void lists.clear(scope) }} onReorder={(ids) => { if (!redacting) void lists.reorder(ids) }} />}
      </section>

      <footer className="bottom-dock"><div className="dock-primary"><nav className="mode-nav"><div className="dock-cluster dock-views"><button onClick={goHome} className={mode === 'home' ? 'active' : ''}>Home</button><button onClick={() => { setMode('week'); setViewDate(new Date()); setFilterOpen(false); setSettingsOpen(false) }} className={mode === 'week' ? 'active' : ''}>Week</button><button onClick={() => { setMode('month'); setViewDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); setFilterOpen(false); setSettingsOpen(false) }} className={mode === 'month' ? 'active' : ''}>Month</button></div><div className="dock-cluster dock-appliances"><button onClick={() => { setMode('timer'); setFilterOpen(false); setSettingsOpen(false) }} className={`dock-timer ${mode === 'timer' ? 'active' : ''} ${timers.hasActiveTimer ? 'running' : ''} ${timers.timer?.state === 'paused' ? 'paused' : ''} ${timers.alarm ? 'firing' : ''}`}><span>Timer</span>{timers.hasActiveTimer && mode !== 'timer' && <span className="dock-timer-remaining dock-badge">{timers.alarm ? 'Done' : timers.timer?.state === 'paused' ? 'Paused' : formatDockRemaining(timers.remainingMs)}</span>}</button><button onClick={() => { setMode('lists'); setFilterOpen(false); setSettingsOpen(false) }} className={`dock-lists ${mode === 'lists' ? 'active' : ''} ${lists.uncheckedCount > 0 ? 'has-items' : ''}`}><span>Lists</span>{lists.uncheckedCount > 0 && mode !== 'lists' && <span className="dock-lists-count dock-badge">{lists.uncheckedCount}</span>}</button></div></nav>{!viewingToday && <button className="dock-today" onClick={() => navigate(0)} aria-label="Jump to today">Today</button>}</div>{!redacting && <div className="dock-adjust"><div className="dock-actions" ref={filterRef}><button className="filter-toggle" onClick={() => { setFilterOpen((open) => !open); setSettingsOpen(false) }} aria-expanded={filterOpen}>People <span className="filter-count">{enabledCalendars.length}/{calendars.length || 4}</span></button>{filterOpen && <div className="filter-popover">{calendars.map((calendar) => <button className="filter-row" onClick={() => toggleCalendar(calendar.id)} key={calendar.id}><span className={`calendar-swatch ${colorClass(calendar.color)}`} /><span className="filter-name">{personName(calendar)}<ProviderBadge source={calendar.source} /></span><strong>{enabledCalendars.includes(calendar.id) ? '✓' : ''}</strong></button>)}</div>}</div><div className="dock-actions" ref={settingsRef}><button className="settings-toggle" onClick={() => { setSettingsOpen((open) => !open); setFilterOpen(false) }} aria-expanded={settingsOpen} aria-label="Open settings"><span className="settings-gear" aria-hidden>⚙</span><span>Settings</span></button>{settingsOpen && <SettingsSheet auth={auth} onAddCalendar={addCalendar} colorMode={colorMode} onColorMode={setColorMode} weekStart={weekStart} onWeekStart={setWeekStart} calendars={calendars} onCalendarColor={chooseCalendarColor} audioInput={audioInput} audioOutput={audioOutput} voiceConfig={voiceConfig} display={display} wake={voice.wake} onSetWakeEnabled={voice.setWakeEnabled} onSetWakeProvider={voice.setWakeProvider} onSetWakeGateEnabled={voice.setWakeGateEnabled} onClose={() => setSettingsOpen(false)} />}</div></div>}</footer>
      {selectedEvent && !redacting && <EventDetail event={selectedEvent} calendar={calendarById.get(selectedEvent.calendar_id)} onClose={() => setSelectedEvent(null)} />}
      {selectedClip && !redacting && <CameraClipModal clip={selectedClip} apiBaseUrl={API_URL} onClose={() => setSelectedClip(null)} />}
      {connectOpen && auth && !redacting && <CalendarConnect auth={auth} addingCalendar={addingCalendar} onStart={beginConnect} onCancel={cancelConnect} onClose={() => { setConnectOpen(false); setAddingCalendar(false) }} />}
      {privacyPadOpen && <PrivacyPad onClose={() => setPrivacyPadOpen(false)} onUnlock={privacy.unlock} onUndo={privacyNotice ? () => { void privacy.undo(); setPrivacyPadOpen(false); setPrivacyNotice(false) } : undefined} cooldownMs={privacy.cooldownMs} />}
      <VoiceOverlay status={voice.status} activationStyle={voice.activationStyle} transcript={voice.transcript} error={voice.error} onStop={voice.stopTurn} onDismissError={voice.dismissError} />
      {voice.status === 'unavailable' && voice.error && <VoiceToast error={voice.error} onRetry={voice.startTurn} onDismiss={voice.dismissError} />}
      {timerNotice && <div className="timer-notice" role="status">{timerNotice}<button aria-label="Dismiss" onClick={() => setTimerNotice(null)}>×</button></div>}
      {listNotice && <div className="timer-notice list-notice" role="status">{listNotice.text}{listNotice.restore && <button className="list-notice-undo" onClick={() => { void lists.restore(listNotice.restore!); setListNotice(null) }}>Undo</button>}<button aria-label="Dismiss" onClick={() => setListNotice(null)}>×</button></div>}
      {privacyNotice && <div className="timer-notice list-notice" role="status">Privacy mode on<button className="list-notice-undo" onClick={() => { void privacy.undo(); setPrivacyNotice(false) }}>Undo</button><button aria-label="Dismiss" onClick={() => setPrivacyNotice(false)}>×</button></div>}
    </main>
  )
}

// Settings is the densest surface in the app, so it lives in the centred sheet
// family (not a corner popover): a category rail + a scrolling panel. Everyday
// display preferences (event colour, week start, per-calendar colour) are front
// and centre; the voice bake-off and mic-routing knobs sit behind an "Advanced"
// disclosure under "Voice & sound". See docs/controls-layout-design.md.
type SettingsCategory = 'display' | 'calendars' | 'voice'
function SettingsSheet({
  auth, onAddCalendar, colorMode, onColorMode, weekStart, onWeekStart, calendars, onCalendarColor,
  audioInput, audioOutput, voiceConfig, display, wake, onSetWakeEnabled, onSetWakeProvider, onSetWakeGateEnabled, onClose,
}: {
  auth: CalendarAuth | null
  onAddCalendar: () => void
  colorMode: SemanticColorMode
  onColorMode: (mode: SemanticColorMode) => void
  weekStart: WeekStart
  onWeekStart: (start: WeekStart) => void
  calendars: Calendar[]
  onCalendarColor: (calendarId: string, color: string) => void
  audioInput: ReturnType<typeof useAudioInput>
  audioOutput: ReturnType<typeof useAudioOutput>
  voiceConfig: ReturnType<typeof useVoiceConfig>
  display: ReturnType<typeof useDisplay>
  wake: ReturnType<typeof useVoiceSession>['wake']
  onSetWakeEnabled: ReturnType<typeof useVoiceSession>['setWakeEnabled']
  onSetWakeProvider: ReturnType<typeof useVoiceSession>['setWakeProvider']
  onSetWakeGateEnabled: ReturnType<typeof useVoiceSession>['setWakeGateEnabled']
  onClose: () => void
}) {
  const diagnostics = audioInput.diagnostics
  const outputDiagnostics = audioOutput.diagnostics
  const linkedAccounts = auth?.accounts ?? (auth?.account ? [auth.account] : [])
  const hasCalendars = auth?.provider === 'outlook_personal' && auth.state === 'connected'
  const hasProviders = voiceConfig.config.enabled && voiceConfig.config.providers.length > 0
  const hasMic = diagnostics.available && (voiceConfig.config.enabled || wake.available)
  const hasSpeaker =
    (outputDiagnostics.available || outputDiagnostics.invokeAvailable) &&
    (voiceConfig.config.enabled || wake.available)
  const hasAdvanced = hasProviders || wake.providers.length > 1 || hasMic || hasSpeaker
  const hasVoice = wake.available || hasAdvanced
  const categories: { id: SettingsCategory; label: string }[] = [
    { id: 'display', label: 'Display' },
    ...(hasCalendars ? [{ id: 'calendars' as const, label: 'Calendars' }] : []),
    ...(hasVoice ? [{ id: 'voice' as const, label: 'Voice & sound' }] : []),
  ]
  const [category, setCategory] = useState<SettingsCategory>('display')
  const [advancedOpen, setAdvancedOpen] = useState(readAdvancedOpen)
  useEffect(() => {
    try { window.localStorage.setItem(ADVANCED_OPEN_KEY, advancedOpen ? 'open' : 'closed') } catch { /* private mode */ }
  }, [advancedOpen])
  const active = categories.some((entry) => entry.id === category) ? category : 'display'
  return (
    <div className="detail-scrim" role="presentation" onClick={onClose}>
      <section className="detail-sheet settings-sheet" role="dialog" aria-label="Settings" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}>
        <button className="close-detail" onClick={onClose} aria-label="Close settings">×</button>
        <div className="settings-layout">
          <nav className="settings-rail" aria-label="Settings categories">
            <p className="settings-rail-title">Settings</p>
            {categories.map((entry) => (
              <button key={entry.id} className={active === entry.id ? 'active' : ''} aria-pressed={active === entry.id} onClick={() => setCategory(entry.id)}>{entry.label}</button>
            ))}
          </nav>
          <div className="settings-panel">
            {active === 'display' && <>
              <div className="settings-group">
                <h3>Event colours</h3>
                <div className="seg">
                  <button className={colorMode === 'category-first' ? 'selected' : ''} aria-pressed={colorMode === 'category-first'} onClick={() => onColorMode('category-first')}>Color events by category</button>
                  <button className={colorMode === 'people-first' ? 'selected' : ''} aria-pressed={colorMode === 'people-first'} onClick={() => onColorMode('people-first')}>Color events by person/calendar</button>
                </div>
              </div>
              <div className="settings-group">
                <h3>Week starts on</h3>
                <div className="seg seg-block">
                  <button className={weekStart === 'monday' ? 'selected' : ''} aria-pressed={weekStart === 'monday'} onClick={() => onWeekStart('monday')}>Monday</button>
                  <button className={weekStart === 'sunday' ? 'selected' : ''} aria-pressed={weekStart === 'sunday'} onClick={() => onWeekStart('sunday')}>Sunday</button>
                </div>
              </div>
              <div className="settings-group">
                <h3>Night mode</h3>
                <button className="switch-row" role="switch" aria-checked={display.nightMode} onClick={() => { void display.setNightMode(!display.nightMode) }}>
                  <span>Dim the wall panel to about a tenth</span>
                  <span className="switch-track" aria-hidden />
                </button>
                <p className="settings-note">{display.mechanism === 'none' ? 'This screen isn’t running the display service — night mode has no effect here.' : 'Also try saying “night mode”.'}</p>
              </div>
              {calendars.length > 0 && <div className="settings-group">
                <h3>Calendar colours</h3>
                {calendars.map((calendar) => (
                  <div className="calendar-color-row" key={calendar.id}>
                    <span className="calendar-color-name"><span className={`calendar-swatch ${colorClass(calendar.color)}`} />{personName(calendar)}<ProviderBadge source={calendar.source} /></span>
                    <span className="calendar-color-options" role="group" aria-label={`${personName(calendar)} color`}>
                      {CALENDAR_PALETTE.map((color) => (
                        <button type="button" key={color} className={`color-dot ${colorClass(color)} ${calendar.color === color ? 'selected' : ''}`} aria-label={`${personName(calendar)}: ${color}`} aria-pressed={calendar.color === color} onClick={() => onCalendarColor(calendar.id, color)} />
                      ))}
                    </span>
                  </div>
                ))}
              </div>}
            </>}

            {active === 'calendars' && <div className="settings-group">
              <h3>Linked calendars</h3>
              {linkedAccounts.length > 0
                ? linkedAccounts.map((account) => <p className="settings-note" key={account}>{account}</p>)
                : <p className="settings-note">No calendars linked yet.</p>}
              <button className="settings-add-calendar" onClick={onAddCalendar}>Add another Outlook calendar</button>
            </div>}

            {active === 'voice' && <>
              {wake.available && <div className="settings-group">
                <h3>Wake word</h3>
                <button className="switch-row" role="switch" aria-checked={wake.userEnabled} onClick={() => onSetWakeEnabled(!wake.userEnabled)}>
                  <span>Say “{wake.phrase}” to start talking</span>
                  <span className="switch-track" aria-hidden />
                </button>
                <p className="settings-note">{WAKE_STATUS_TEXT[wake.state]}</p>
              </div>}
              {hasAdvanced && <div className="settings-advanced">
                <button type="button" className="settings-advanced-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>Advanced (bake-off)</button>
                {advancedOpen && <div className="settings-advanced-body">
                  {hasProviders && <div className="settings-group">
                    <h3>Voice provider</h3>
                    <div className="settings-provider-list">
                      {voiceConfig.config.providers.map((provider) => (
                        <button key={provider.id} className={voiceConfig.config.provider === provider.id ? 'selected' : ''} aria-pressed={voiceConfig.config.provider === provider.id} disabled={voiceConfig.busy || !provider.implemented || (!provider.configured && voiceConfig.config.provider !== provider.id)} onClick={() => { void voiceConfig.setProvider(provider.id) }}>{provider.label}{!provider.implemented ? ' — soon' : !provider.configured ? ' — needs config' : ''}</button>
                      ))}
                    </div>
                    <p className="settings-note">Bake-off switch — applies to the next turn.</p>
                  </div>}
                  {wake.providers.length > 1 && <div className="settings-group">
                    <h3>Keyword provider</h3>
                    <div className="settings-provider-list">
                      {wake.providers.map((keyword) => (
                        <button key={keyword.id} className={wake.provider === keyword.id ? 'selected' : ''} aria-pressed={wake.provider === keyword.id} disabled={wake.busy || !keyword.implemented || (!keyword.configured && wake.provider !== keyword.id)} onClick={() => { void onSetWakeProvider(keyword.id) }}>{keyword.label}{!keyword.implemented ? ' — soon' : !keyword.configured ? ' — needs backend package' : ''}</button>
                      ))}
                    </div>
                    <p className="settings-note">openWakeWord runs in the browser; Azure runs on the backend.</p>
                  </div>}
                  {wake.invokeGateConfigured && <div className="settings-group">
                    <h3>On-device audio gate</h3>
                    <button className="switch-row" role="switch" aria-checked={wake.invokeGateEnabled} disabled={wake.busy} onClick={() => { void onSetWakeGateEnabled(!wake.invokeGateEnabled) }}>
                      <span>Gate the mic on the Invoke before the keyword check</span>
                      <span className="switch-track" aria-hidden />
                    </button>
                    <p className="settings-note">{wake.invokeGateEnabled ? 'On — the Invoke only streams after a candidate; the keyword detector then re-checks it, and both must accept.' : 'Off — the keyword detector runs on the continuous mic feed.'}</p>
                  </div>}
                  {(wake.detail || wake.activationLatencyMs != null) && <p className="settings-note">Wake status: {WAKE_STATUS_TEXT[wake.state]}{wake.detail ? ` — ${wake.detail}` : ''}{wake.activationLatencyMs != null ? ` · last wake→listening ${wake.activationLatencyMs} ms` : ''}</p>}
                  {hasMic && <div className="settings-group">
                    <h3>Microphone</h3>
                    <div className="settings-provider-list">
                      <button className={diagnostics.selection.mode === 'auto' ? 'selected' : ''} aria-pressed={diagnostics.selection.mode === 'auto'} onClick={() => audioInput.choose({ mode: 'auto' })}>Automatic{diagnostics.vbCablePresent ? ' — using VB-CABLE' : ''}</button>
                      {diagnostics.devices.map((device) => (
                        <button key={device.deviceId} className={diagnostics.selection.mode === 'device' && diagnostics.selection.deviceId === device.deviceId ? 'selected' : ''} aria-pressed={diagnostics.selection.mode === 'device' && diagnostics.selection.deviceId === device.deviceId} onClick={() => audioInput.choose({ mode: 'device', deviceId: device.deviceId, label: device.label })}>{device.label || 'Unnamed input'}{device.isVbCable ? ' — VB-CABLE' : ''}</button>
                      ))}
                    </div>
                    <p className="settings-note">{diagnostics.boundLabel ? `Capturing from “${diagnostics.boundLabel}”. ` : ''}Automatic prefers a VB-CABLE input when present.</p>
                  </div>}
                  {hasSpeaker && <div className="settings-group">
                    <h3>Speaker</h3>
                    <div className="settings-provider-list">
                      <button className={outputDiagnostics.selection.mode === 'auto' ? 'selected' : ''} aria-pressed={outputDiagnostics.selection.mode === 'auto'} onClick={() => audioOutput.choose({ mode: 'auto' })}>Automatic</button>
                      {outputDiagnostics.devices.filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications').map((device) => (
                        <button key={device.deviceId} className={outputDiagnostics.selection.mode === 'device' && outputDiagnostics.selection.deviceId === device.deviceId ? 'selected' : ''} aria-pressed={outputDiagnostics.selection.mode === 'device' && outputDiagnostics.selection.deviceId === device.deviceId} onClick={() => audioOutput.choose({ mode: 'device', deviceId: device.deviceId, label: device.label })}>{device.label || 'Unnamed output'}{device.isVbCable ? ' — VB-CABLE, avoid' : ''}</button>
                      ))}
                      {outputDiagnostics.invokeAvailable && <button className={outputDiagnostics.selection.mode === 'invoke' ? 'selected' : ''} aria-pressed={outputDiagnostics.selection.mode === 'invoke'} onClick={() => audioOutput.choose({ mode: 'invoke' })}>Invoke (Wi-Fi)</button>}
                    </div>
                    <p className="settings-note">{outputDiagnostics.selection.mode === 'invoke'
                      ? (outputDiagnostics.invokeStatus.connected
                          ? `Streaming to the Invoke — ${outputDiagnostics.invokeStatus.streamedSeconds}s sent${outputDiagnostics.invokeStatus.reconnects ? `, ${outputDiagnostics.invokeStatus.reconnects} reconnect${outputDiagnostics.invokeStatus.reconnects === 1 ? '' : 's'}` : ''}${outputDiagnostics.invokeStatus.sheds ? `, ${outputDiagnostics.invokeStatus.sheds} dropped` : ''}. The local screen is muted.`
                          : outputDiagnostics.invokeStatus.link === 'up'
                            ? `Invoke link is unstable${outputDiagnostics.invokeStatus.sheds ? `, ${outputDiagnostics.invokeStatus.sheds} dropped` : ''}${outputDiagnostics.invokeStatus.reconnects ? `, ${outputDiagnostics.invokeStatus.reconnects} reconnect${outputDiagnostics.invokeStatus.reconnects === 1 ? '' : 's'}` : ''} — playing on the screen too until it settles.`
                            : 'Connecting to the Invoke…')
                      : `Playing to “${outputDiagnostics.routedLabel}”. The assistant, the listening cue and the timer chime all use this; automatic follows the system default and steps off a VB-CABLE default.`}</p>
                  </div>}
                </div>}
              </div>}
            </>}
          </div>
        </div>
      </section>
    </div>
  )
}

// The brand lockup is the Home control; a press-and-hold on it is the
// understated way into privacy mode (only when a PIN is configured). Short press
// still goes Home. The gesture-vs-tap disambiguation mirrors ViewPager's swipe:
// if the long-press fired, the trailing click is suppressed. See
// docs/privacy-mode-plan.md.
const LONG_PRESS_MS = 600
function BrandLockup({ onHome, onLongPress }: { onHome: () => void; onLongPress?: () => void }) {
  const held = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false })
  const cancel = () => {
    if (held.current.timer != null) window.clearTimeout(held.current.timer)
    held.current.timer = null
  }
  return (
    <button
      className="brand-lockup"
      aria-label="Go to Home"
      onPointerDown={(event) => {
        if (!event.isPrimary || !onLongPress) return
        held.current.fired = false
        held.current.timer = window.setTimeout(() => {
          held.current.fired = true
          onLongPress()
        }, LONG_PRESS_MS)
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={() => { cancel(); held.current.fired = false }}
      onClickCapture={(event) => {
        if (held.current.fired) {
          held.current.fired = false
          event.stopPropagation()
          event.preventDefault()
        }
      }}
      onClick={onHome}
    >
      <span className="brand-icon">M</span>
      <strong>Mission Control</strong>
    </button>
  )
}

// A holiday is ambient context, not an event: it renders as a small, non-interactive label
// in the empty space beside the date (never a chip, never a lane), one step smaller than the
// surrounding type. See `holidays.ts` and AGENTS.md → "Holidays".
function HolidayNote({ date, className }: { date: Date; className: string }) {
  const holiday = holidayOn(date)
  if (!holiday) return null
  return (
    <span className={`holiday-note ${className}`}>
      <span className="holiday-note-icon" aria-hidden>{holiday.icon}</span>
      <span className="holiday-note-name">{holiday.name}</span>
    </span>
  )
}

function HomeView({ now, todayEvents, todaySpans, upcoming, calendarById, onSelect, colorMode, calendarAlert, camera, redacting, onSelectClip, apiBaseUrl }: { now: Date; todayEvents: CalendarEvent[]; todaySpans: CalendarEvent[]; upcoming: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; colorMode: SemanticColorMode; calendarAlert: { account: string | null; onConnect: () => void } | null; camera: ReturnType<typeof useCameraActivity>; redacting: boolean; onSelectClip: (clip: StoredClip) => void; apiBaseUrl: string }) {
  const tomorrow = upcoming.filter((event) => !isSpanningEvent(event) && isSameDay(new Date(event.starts_at), addDays(now, 1))).slice(0, 3)
  return <div className="home-view"><div className="home-grid"><section className="today-schedule"><div className="view-heading"><div><p className="section-kicker">Today</p><h2>{todayEvents.length} things on the rhythm</h2><HolidayNote date={now} className="holiday-note-home" /></div><span className="date-pill">{formatShortDate(now)}</span></div>{todaySpans.length > 0 && <div className="today-banners">{todaySpans.map((event) => <SpanBanner event={event} calendar={calendarById.get(event.calendar_id)} now={now} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div>}{todayEvents.length ? <div className="large-agenda">{todayEvents.map((event) => <LargeEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} past={new Date(event.ends_at) < now} colorMode={colorMode} key={event.id} />)}</div> : todaySpans.length ? null : <EmptyState text="A clear rest of the day." />}</section><aside className="home-rail"><section className="next-card"><div className="view-heading"><div><p className="section-kicker">Coming up</p><h2>Next</h2></div><span className="arrow-mark">→</span></div><div className="next-list">{upcoming.slice(0, 4).map((event) => <CompactEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div></section><section className="tomorrow-card"><p className="section-kicker">Tomorrow</p><h2>{formatWeekday(addDays(now, 1))}</h2><HolidayNote date={addDays(now, 1)} className="holiday-note-home" />{tomorrow.length ? tomorrow.map((event) => <CompactEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />) : <p>No events planned yet.</p>}</section>{calendarAlert ? <section className="exception-card"><span className="exception-mark">!</span><div><p className="section-kicker">Needs attention</p><strong>Calendar sign-in needed</strong><span>{calendarAlert.account ? `Reconnect ${calendarAlert.account}` : 'Connect a household calendar'}</span></div><button onClick={calendarAlert.onConnect}>Connect</button></section> : <CameraGalleryCard camera={camera} redacting={redacting} onSelectClip={onSelectClip} apiBaseUrl={apiBaseUrl} />}</aside></div></div>
}

// Tastefully laid-out review of the latest eufy camera clips, in the slot the
// "garage door" placeholder used to occupy. Collapses to nothing when the
// feature is off or there's simply nothing new (principle 4: normal status
// earns no chrome) — same rule the exception card it replaced followed.
// Thumbnail affordance follows the industry-standard tappable-video language
// (YouTube/Nest/Ring): a bottom gradient scrim, a centered play glyph sized
// for a touch target, and a duration pill, so it reads as playable at a
// glance without a text label. See docs/eufy-sdk-integration.md.
const CLIP_RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', DAY_MS], ['hour', 3_600_000], ['minute', 60_000],
]
function formatClipRelativeTime(occurredAt: string, now: Date): string {
  const diffMs = now.getTime() - new Date(occurredAt).getTime()
  for (const [unit, unitMs] of CLIP_RELATIVE_UNITS) {
    const amount = Math.floor(diffMs / unitMs)
    if (amount >= 1) return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-amount, unit)
  }
  return 'just now'
}
function formatClipDuration(seconds: number | null): string | null {
  if (!seconds || seconds < 1) return null
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
function CameraGalleryCard({ camera, redacting, onSelectClip, apiBaseUrl }: { camera: ReturnType<typeof useCameraActivity>; redacting: boolean; onSelectClip: (clip: StoredClip) => void; apiBaseUrl: string }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    return () => window.clearInterval(id)
  }, [])
  if (!camera.available) return null
  // A 2x2 grid of up to four true 16:9 crops. Target is 4K at 100% OS scaling
  // (3840x2160) ONLY -- 2560x1440 was tried and rejected (the whole rail is
  // ~101px short there, not just this card; see App.css). Anything below 4K
  // may clip this card's bottom row silently (no document-level scrolling).
  const shown = camera.clips.slice(0, 4)
  if (shown.length === 0) return null
  return (
    <section className="camera-review">
      <div className="view-heading"><p className="section-kicker">Camera</p><h2>Recent activity</h2></div>
      <div className="camera-thumb-row">
        {shown.map((clip) => redacting
          ? <span className="camera-thumb camera-thumb-private" key={clip.clip_id} aria-label="Camera thumbnail hidden — privacy mode is on"><span className="camera-thumb-private-icon" aria-hidden>🎥</span></span>
          : <button className="camera-thumb" key={clip.clip_id} onClick={() => onSelectClip(clip)} aria-label={`Play ${clip.camera_name} clip from ${formatClipRelativeTime(clip.occurred_at, now)}`}>
              <img src={`${apiBaseUrl}/api/camera/clip/${encodeURIComponent(clip.clip_id)}/thumbnail`} alt="" loading="lazy" />
              <span className="camera-thumb-scrim" aria-hidden />
              <span className="camera-thumb-play" aria-hidden>▶</span>
              {formatClipDuration(clip.approx_duration_seconds) && <span className="camera-thumb-duration">{formatClipDuration(clip.approx_duration_seconds)}</span>}
              <span className="camera-thumb-meta"><strong>{clip.camera_name}</strong><span>{formatClipRelativeTime(clip.occurred_at, now)}</span></span>
            </button>)}
      </div>
    </section>
  )
}

// The clip player: a centered modal (not the bottom-anchored `.detail-sheet`
// family — the brief calls for a majority-of-screen dialog with a visible
// margin) reusing the same scrim/Escape/outside-tap dismiss convention as
// every other overlay in this app. A plain <video> is the whole player —
// playback is a solved problem, no library needed.
function CameraClipModal({ clip, apiBaseUrl, onClose }: { clip: StoredClip; apiBaseUrl: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="clip-modal-scrim" role="presentation" onClick={onClose}>
      <section className="clip-modal" role="dialog" aria-label={`${clip.camera_name} clip`} onClick={(event) => event.stopPropagation()}>
        <button className="close-detail" onClick={onClose} aria-label="Close video">×</button>
        <video className="clip-modal-video" src={`${apiBaseUrl}/api/camera/clip/${encodeURIComponent(clip.clip_id)}/video`} controls autoPlay playsInline />
        <p className="clip-modal-caption"><strong>{clip.camera_name}</strong><span>{new Date(clip.occurred_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span></p>
      </section>
    </div>
  )
}

// Wraps a Week/Month grid with the navigation that used to sit in the heading: a quiet ‹ ›
// zone down each margin (they occupy their own grid tracks, so they never cover a day cell),
// plus a horizontal drag anywhere on the view — pull right for the previous period, flick
// left for the next. The drag has to be mostly horizontal and clear a screen-relative
// distance so it can't be mistaken for a tap or a vertical scroll of a packed day cell.
const SWIPE_DOMINANCE = 1.4
function ViewPager({ unit, onNavigate, children }: { unit: 'week' | 'month'; onNavigate: (amount: number) => void; children: ReactNode }) {
  const gesture = useRef({ x: 0, y: 0, swiped: false })
  return (
    <div
      className="view-pager"
      onPointerDown={(event) => { if (event.isPrimary) gesture.current = { x: event.clientX, y: event.clientY, swiped: false } }}
      onPointerUp={(event) => {
        const { x, y } = gesture.current
        const dx = event.clientX - x
        const dy = event.clientY - y
        const narrow = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches
        if (narrow || Math.abs(dx) < Math.max(80, window.innerWidth * 0.05) || Math.abs(dx) < Math.abs(dy) * SWIPE_DOMINANCE) return
        gesture.current.swiped = true
        window.setTimeout(() => { gesture.current.swiped = false }, 0)
        onNavigate(dx > 0 ? -1 : 1)
      }}
      onPointerCancel={() => { gesture.current.swiped = false }}
      onClickCapture={(event) => { if (gesture.current.swiped) { event.stopPropagation(); event.preventDefault() } }}
    >
      <button className="page-edge page-edge-prev" aria-label={`Previous ${unit}`} onClick={() => onNavigate(-1)}><span aria-hidden>‹</span></button>
      {children}
      <button className="page-edge page-edge-next" aria-label={`Next ${unit}`} onClick={() => onNavigate(1)}><span aria-hidden>›</span></button>
    </div>
  )
}

function WeekView({ viewDate, now, events, calendarById, onSelect, onNavigate, colorMode, weekStart }: { viewDate: Date; now: Date; events: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; onNavigate: (amount: number) => void; colorMode: SemanticColorMode; weekStart: WeekStart }) {
  const start = startOfWeek(viewDate, weekStart)
  const weekDays = Array.from({ length: 7 }, (_, index) => addDays(start, index))
  // Holidays sit on the top lane of the always-present all-day row, centred under their date.
  // Their columns are reserved so any event covering that day stacks below, never over, them.
  const weekHolidays = weekDays.map((day) => holidayOn(day))
  const holidayCols = new Set(weekHolidays.flatMap((holiday, index) => (holiday ? [index + 1] : [])))
  const { bars, overflow } = layoutSpans(events, weekDays, SPAN_MAX_LANES, holidayCols)
  const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0)
  return <div className="week-view"><ViewPager unit="week" onNavigate={onNavigate}><div className="week-grid"><div className="time-gutter week-corner" />{weekDays.map((day) => <div className={`week-day-head ${isSameDay(day, now) ? 'today' : ''}`} key={toIsoDate(day)}><span>{WEEKDAYS[day.getDay()]}</span><strong>{day.getDate()}</strong></div>)}<div className="time-gutter allday-label"><span>{laneCount ? 'all-day' : ''}</span></div><div className="allday-lane">{weekHolidays.map((holiday, index) => holiday ? <span className="allday-holiday" style={{ gridColumn: index + 1, gridRow: 1 }} key={`holiday-${toIsoDate(weekDays[index])}`}><i aria-hidden>{holiday.icon}</i><span>{holiday.name}</span></span> : null)}{bars.map((bar) => <SpanBar bar={bar} calendar={calendarById.get(bar.event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={bar.event.id} />)}{weekDays.map((day, index) => { const extra = overflow.get(toIsoDate(day)) ?? 0; return extra ? <span className="span-overflow" style={{ gridColumn: index + 1, gridRow: SPAN_MAX_LANES + 1 }} key={toIsoDate(day)}>+{extra}</span> : null })}</div><div className="time-gutter hours">{WAKE_HOURS.map((hour) => <span key={hour}>{formatHour(hour)}</span>)}</div>{weekDays.map((day) => { const dayEvents = events.filter((event) => !isSpanningEvent(event) && isSameDay(new Date(event.starts_at), day)); return <div className={`week-column ${isSameDay(day, now) ? 'today-column' : ''}`} key={toIsoDate(day)}>{WAKE_HOURS.map((hour) => <div className="hour-line" key={hour} />)}{dayEvents.map((event) => <WeekEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div> })}</div></ViewPager></div>
}

function MonthView({ viewDate, now, events, calendarById, onSelect, onNavigate, colorMode, weekStart }: { viewDate: Date; now: Date; events: CalendarEvent[]; calendarById: Map<string, Calendar>; onSelect: (event: CalendarEvent) => void; onNavigate: (amount: number) => void; colorMode: SemanticColorMode; weekStart: WeekStart }) {
  const { days, refMonth } = resolveMonthView(viewDate, now, weekStart)
  const weeks = Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7))
  const eventsByDay = groupEvents(events.filter((event) => !isSpanningEvent(event)))
  // Which day's full list is expanded in the contextual sheet (opened from a "+N more" chip).
  const [openDay, setOpenDay] = useState<Date | null>(null)
  const rowCap = useMonthRowCap()
  return <div className="month-view"><ViewPager unit="month" onNavigate={onNavigate}><div className="month-grid">{weeks.map((week, weekIndex) => { const { bars, overflow } = layoutSpans(events, week, SPAN_MAX_LANES); const laneCount = bars.reduce((max, bar) => Math.max(max, bar.lane + 1), 0); return <div className="month-week" style={{ '--span-lanes': String(laneCount) } as CSSProperties} key={toIsoDate(week[0])}>{week.map((day) => { const dayEvents = eventsByDay.get(toIsoDate(day)) ?? []; const chipBudget = dayEvents.length > rowCap ? rowCap - 1 : rowCap; const shownEvents = dayEvents.slice(0, chipBudget); const hiddenCount = dayEvents.length - shownEvents.length; const today = isSameDay(day, now); const extra = overflow.get(toIsoDate(day)) ?? 0; return <div className={`day-cell ${sameMonth(day, refMonth) ? '' : 'muted-day'} ${today ? 'today' : ''}`} key={toIsoDate(day)}><div className="day-heading">{weekIndex === 0 && <span className="weekday-tag">{WEEKDAYS[day.getDay()]}</span>}<span className="day-number">{day.getDate()}</span>{today && <span className="today-label">Today</span>}<HolidayNote date={day} className="holiday-note-month" /></div><div className="day-events">{shownEvents.map((event) => <EventChip event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}{hiddenCount > 0 && <button className="day-more" onClick={() => setOpenDay(day)} aria-label={`Show ${hiddenCount} more ${hiddenCount === 1 ? 'event' : 'events'} on ${formatSpanDate(day)}`}>+{hiddenCount} more</button>}{extra > 0 && <span className="more-events">+{extra} spanning</span>}</div></div> })}{bars.length > 0 && <div className="month-week-spans">{bars.map((bar) => <SpanBar bar={bar} calendar={calendarById.get(bar.event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={bar.event.id} />)}</div>}</div> })}</div></ViewPager>{openDay && <DayEventsSheet day={openDay} events={events} calendarById={calendarById} colorMode={colorMode} onSelect={(event) => { setOpenDay(null); onSelect(event) }} onClose={() => setOpenDay(null)} />}</div>
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
  if (colorMode === 'category-first') return { color: PALETTE_TOKEN[calendar.color] ?? PALETTE_TOKEN.coral, label: personName(calendar) }
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
  return <button className={`today-banner ${semanticEventClass(event, calendar, colorMode)}`} style={semanticEventStyle(event, calendar, colorMode)} onClick={() => onSelect(event)}><span className="today-banner-label">{label}</span><span className="today-banner-main"><strong>{event.title}</strong>{event.location && <small>{event.location}</small>}</span><span className="event-owner">{personName(calendar)}<ProviderBadge source={calendar?.source} /></span></button>
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
function LargeEvent({ event, calendar, onSelect, colorMode, past = false }: EventProps & { colorMode: SemanticColorMode; past?: boolean }) { return <button className={`large-event ${semanticEventClass(event, calendar, colorMode)} ${past ? 'past' : ''}`} style={semanticEventStyle(event, calendar, colorMode)} onClick={() => onSelect(event)}><SecondaryTriangle accent={eventAccent(event, calendar, colorMode)} /><span className="large-event-time">{event.all_day ? 'ALL DAY' : formatEventTime(event.starts_at)}</span><span className="large-event-main"><strong>{event.title}</strong>{event.location && <small>{event.location}</small>}</span><span className="event-owner">{personName(calendar)}<ProviderBadge source={calendar?.source} /></span><span className="event-arrow">›</span></button> }
function CompactEvent({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { return <button className={`compact-event ${semanticEventClass(event, calendar, colorMode)}`} style={semanticEventStyle(event, calendar, colorMode)} onClick={() => onSelect(event)}><SecondaryTriangle accent={eventAccent(event, calendar, colorMode)} /><span><strong>{event.title}</strong><small>{event.all_day ? 'All day' : formatEventTime(event.starts_at)}</small></span></button> }
function WeekEvent({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { const start = new Date(event.starts_at); const end = new Date(event.ends_at); const top = ((start.getHours() + start.getMinutes() / 60) - 7) / 14 * 100; const height = Math.max(((end.getTime() - start.getTime()) / 3_600_000) / 14 * 100, 8); return <button className={`week-event ${semanticEventClass(event, calendar, colorMode)}`} style={{ top: `${Math.max(top, 1)}%`, height: `${Math.min(height, 97 - Math.max(top, 1))}%`, ...semanticEventStyle(event, calendar, colorMode) }} onClick={() => onSelect(event)}><SecondaryTriangle accent={eventAccent(event, calendar, colorMode)} /><strong>{event.title}</strong><span>{event.all_day ? 'All day' : formatEventTime(event.starts_at)}</span></button> }
function EventChip({ event, calendar, onSelect, colorMode }: EventProps & { colorMode: SemanticColorMode }) { return <button className={`event-chip ${semanticEventClass(event, calendar, colorMode)} ${event.all_day ? 'all-day' : ''}`} style={semanticEventStyle(event, calendar, colorMode)} onClick={() => onSelect(event)}><SecondaryTriangle accent={eventAccent(event, calendar, colorMode)} /><span className="event-time">{event.all_day ? 'ALL DAY' : formatEventTime(event.starts_at)}</span><strong>{event.title}</strong></button> }
function EventDetail({ event, calendar, onClose }: { event: CalendarEvent; calendar?: Calendar; onClose: () => void }) { const categories = event.categories ?? []; return <div className="detail-scrim" role="presentation" onClick={onClose}><section className="detail-sheet" role="dialog" aria-label="Event details" onClick={(eventClick) => eventClick.stopPropagation()}><button className="close-detail" onClick={onClose} aria-label="Close event details">×</button><span className={`detail-bar ${colorClass(calendar?.color ?? 'coral')}`} /><p className="section-kicker"><span className={`identity-dot ${colorClass(calendar?.color ?? 'coral')}`} />{personName(calendar) || 'Household event'}<ProviderBadge source={calendar?.source} /></p><h2>{event.title}</h2><p className="detail-time">{formatEventWhen(event)}</p>{event.location && <p className="detail-location">{event.location}</p>}{categories.length > 0 && <div className="detail-categories"><span>Categories</span>{categories.map((category) => <span className="category-label" style={categoryVar(category.color)} key={category.id}><i />{category.name}</span>)}</div>}<div className="detail-actions"><button onClick={onClose}>Done</button><button className="quiet-action" onClick={onClose}>More actions later</button></div></section></div> }
function EmptyState({ text }: { text: string }) { return <div className="empty-state"><span>✓</span><strong>{text}</strong><small>No urgent plans ahead.</small></div> }
// Normal sync is silent — this renders nothing while the connection is healthy. Only an actual
// exception (offline) earns header space: a compact warning flag whose detail sits behind a tap
// (outside interaction and Escape dismiss it), never spelled out in the header itself.
function SyncStatus({ connection }: { connection: ConnectionState }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false) }
    const dismissEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissEscape)
    return () => { document.removeEventListener('pointerdown', dismissOutside); document.removeEventListener('keydown', dismissEscape) }
  }, [open])
  if (connection !== 'offline') return null
  return (
    <div className="sync-status" ref={ref}>
      <button className="sync-status-flag" aria-label="Sync status" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span aria-hidden>!</span></button>
      {open && <div className="sync-status-detail" role="status">Offline — showing the last schedule that loaded. The display keeps trying to reconnect on its own.</div>}
    </div>
  )
}
function DayEventsSheet({ day, events, calendarById, colorMode, onSelect, onClose }: { day: Date; events: CalendarEvent[]; calendarById: Map<string, Calendar>; colorMode: SemanticColorMode; onSelect: (event: CalendarEvent) => void; onClose: () => void }) {
  const items = events.filter((event) => (isSpanningEvent(event) ? coversDay(event, day) : isSameDay(new Date(event.starts_at), day))).sort(sortEvents)
  return <div className="detail-scrim" role="presentation" onClick={onClose}><section className="detail-sheet day-sheet" role="dialog" aria-label={`Events on ${formatSpanDate(day)}`} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}><button className="close-detail" onClick={onClose} aria-label="Close">×</button><p className="section-kicker">{formatWeekday(day)}</p><h2>{items.length} {items.length === 1 ? 'event' : 'events'}</h2><div className="day-sheet-list">{items.map((event) => <CompactEvent event={event} calendar={calendarById.get(event.calendar_id)} onSelect={onSelect} colorMode={colorMode} key={event.id} />)}</div></section></div>
}
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
// per-day "+N" count so the lane block stays bounded. `reservedFirstLaneCols` are day columns
// already spoken for on the top lane (the Week view's non-interactive holiday labels) — an event
// covering one of those days can't take lane 0, so the holiday always sits ahead of it.
function layoutSpans(events: CalendarEvent[], days: Date[], maxLanes: number, reservedFirstLaneCols: Set<number> = new Set()): { bars: SpanBarLayout[]; overflow: Map<string, number> } {
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
    let lane = 0
    while (lane < maxLanes) {
      if (lane >= laneEnd.length) laneEnd.push(0)
      const clashesHoliday = lane === 0 && [...reservedFirstLaneCols].some((col) => col >= startCol && col <= endCol)
      if (laneEnd[lane] < startCol && !clashesHoliday) break
      lane += 1
    }
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
// The soonest-to-fire timer's remaining time, shown on the dock Timer button while a
// timer runs and another view is on screen. Calm by design: seconds under an hour,
// whole minutes past it (a multi-hour timer shouldn't tick in the chrome).
function formatDockRemaining(ms: number) { const total = Math.max(0, Math.round(ms / 1000)); const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const seconds = total % 60; const pad = (value: number) => String(value).padStart(2, '0'); return hours > 0 ? `${hours}:${pad(minutes)}` : `${minutes}:${pad(seconds)}` }
function formatEventTime(value: string) { return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }
function formatDate(date: Date) { return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) }
function formatShortDate(date: Date) { return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) }
function formatWeekday(date: Date) { return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) }
function formatMonthRange(start: Date, end: Date) { return start.getMonth() === end.getMonth() ? `${start.toLocaleDateString([], { month: 'long' })} ${start.getDate()}–${end.getDate()}` : `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })}` }
function formatHour(hour: number) { return new Date(2020, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' }) }

export default App
