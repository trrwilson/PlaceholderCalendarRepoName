// Dispatches a Gemini tool call to the dashboard (UI tools) or the calendar API
// (read-only data tools). Mirrors backend/app/voice/tools.py — keep names in sync.

import type { DashboardActions, ViewMode } from './types'

export interface ToolContext {
  actions: DashboardActions
  apiBaseUrl: string
  /** Privacy mode is on: refuse every command except summoning the unlock
   *  keypad. The assistant session itself stays up (see docs/privacy-mode-plan.md,
   *  resolution 5). */
  privacyLocked?: boolean
}

type ApiEvent = {
  id: string
  calendar_id: string
  title: string
  starts_at: string
  ends_at: string
  location: string | null
  all_day: boolean
}
type ApiSnapshot = { calendars: { id: string; name: string; display_name?: string }[]; events: ApiEvent[] }

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null

const parseLocalDate = (value: string): Date => {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const parseLocalDateTime = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0))
}

const TIMER_MAX_SECONDS = 21_600
const DEFAULT_LIST_ID = 'grocery'

type ApiListItem = { id: string; name: string; checked: boolean }
type ApiList = { id: string; title: string; items: ApiListItem[] }

const listId = (value: unknown): string =>
  typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : DEFAULT_LIST_ID

const normalizeItem = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '')

async function fetchList(ctx: ToolContext, id: string): Promise<ApiList | null> {
  const response = await fetch(`${ctx.apiBaseUrl}/api/lists/${id}`)
  return response.ok ? ((await response.json()) as ApiList) : null
}

function findItem(list: ApiList, query: string): ApiListItem | null {
  const needle = normalizeItem(query)
  if (!needle) return null
  return (
    list.items.find((item) => normalizeItem(item.name) === needle) ??
    list.items.find((item) => normalizeItem(item.name).includes(needle)) ??
    list.items.find((item) => needle.includes(normalizeItem(item.name))) ??
    null
  )
}

type ApiTimer = {
  id: string
  label: string | null
  fires_at: string
  state: string
  remaining_seconds?: number | null
}

async function currentTimer(ctx: ToolContext): Promise<ApiTimer | null> {
  const response = await fetch(`${ctx.apiBaseUrl}/api/timers`)
  if (!response.ok) return null
  const list: unknown = await response.json()
  return Array.isArray(list) ? ((list[0] as ApiTimer | undefined) ?? null) : null
}

async function fetchRange(ctx: ToolContext, start: string, end: string) {
  const params = new URLSearchParams({ starts_on: start, ends_on: end })
  const response = await fetch(`${ctx.apiBaseUrl}/api/calendar?${params}`)
  if (!response.ok) throw new Error(`calendar request failed (${response.status})`)
  const snapshot: ApiSnapshot = await response.json()
  // Prefer the natural personal name so the assistant says "Travis", not "trrwilson".
  const names = new Map(snapshot.calendars.map((c) => [c.id, c.display_name || c.name]))
  return snapshot.events.map((event) => ({
    title: event.title,
    who: names.get(event.calendar_id) ?? event.calendar_id,
    date: event.starts_at.slice(0, 10),
    time: event.all_day
      ? 'all day'
      : new Date(event.starts_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    start: event.starts_at,
    end: event.ends_at,
    location: event.location ?? undefined,
  }))
}

function overlaps(day: Awaited<ReturnType<typeof fetchRange>>) {
  const timed = day.filter((e) => e.time !== 'all day')
  const clashes: { a: string; b: string }[] = []
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      if (timed[i].start < timed[j].end && timed[j].start < timed[i].end) {
        clashes.push({ a: `${timed[i].title} (${timed[i].who})`, b: `${timed[j].title} (${timed[j].who})` })
      }
    }
  }
  return clashes
}

export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<Record<string, unknown>> {
  // Privacy mode: the assistant stays reachable but does nothing except bring up
  // the unlock keypad. Everything else — including reads, so no titles are ever
  // spoken — is politely refused.
  if (ctx.privacyLocked && name !== 'request_privacy_unlock' && name !== 'enter_privacy_mode') {
    return {
      ok: false,
      error:
        'Privacy mode is on. I can bring up the keypad to turn it off — otherwise it stays this way until someone enters the PIN on the display.',
    }
  }
  switch (name) {
    case 'enter_privacy_mode': {
      const response = await fetch(`${ctx.apiBaseUrl}/api/privacy/lock`, { method: 'POST' })
      if (response.status === 409) {
        return { ok: false, error: 'Privacy mode is not set up on this display.' }
      }
      return response.ok
        ? { ok: true, note: 'Privacy mode is on. It takes the on-screen PIN to turn off.' }
        : { ok: false, error: `could not turn on privacy mode (${response.status})` }
    }
    case 'request_privacy_unlock': {
      ctx.actions.requestPrivacyUnlock()
      return { ok: true, note: 'Ask them to enter the four-digit PIN on the display.' }
    }
    case 'set_night_mode': {
      const on = args.on === true || args.on === 'true'
      const response = await fetch(`${ctx.apiBaseUrl}/api/display`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ night_mode: on }),
      })
      if (!response.ok) {
        return { ok: false, error: `could not change night mode (${response.status})` }
      }
      const state = (await response.json()) as { night_mode: boolean; brightness: number }
      return { ok: true, night_mode: state.night_mode, brightness: state.brightness }
    }
    case 'show_view': {
      const view = args.view as ViewMode
      if (!['home', 'week', 'month', 'timer', 'lists'].includes(view)) return { ok: false, error: 'unknown view' }
      const date = isoDate(args.date)
      ctx.actions.showView(view, date ? parseLocalDate(date) : null)
      return { ok: true, showing: view, date: date ?? undefined }
    }
    case 'focus_date': {
      const date = isoDate(args.date)
      if (!date) return { ok: false, error: 'expected date as YYYY-MM-DD' }
      ctx.actions.focusDate(parseLocalDate(date))
      return { ok: true, focused: date }
    }
    case 'highlight_event': {
      const result = ctx.actions.highlightEvent(String(args.query ?? ''))
      return result.matched
        ? { ok: true, highlighted: result.title, when: result.when }
        : { ok: false, error: 'no matching event is currently in view' }
    }
    case 'set_people_filter': {
      const mode = args.mode as 'only' | 'add' | 'remove' | 'all'
      if (!['only', 'add', 'remove', 'all'].includes(mode)) return { ok: false, error: 'unknown mode' }
      const people = Array.isArray(args.people) ? args.people.map((p) => String(p)) : []
      if (mode !== 'all' && people.length === 0) return { ok: false, error: 'no people named' }
      const result = ctx.actions.setPeopleFilter(mode, people)
      if (mode !== 'all' && result.matched.length === 0) {
        return { ok: false, error: `no household calendar matched ${people.join(', ')}` }
      }
      return { ok: true, showing: result.matched, unmatched: result.unmatched }
    }
    case 'get_events': {
      const start = isoDate(args.start)
      const end = isoDate(args.end)
      if (!start || !end) return { ok: false, error: 'expected start and end as YYYY-MM-DD' }
      return { events: await fetchRange(ctx, start, end) }
    }
    case 'get_agenda': {
      const date = isoDate(args.date)
      if (!date) return { ok: false, error: 'expected date as YYYY-MM-DD' }
      return { date, events: await fetchRange(ctx, date, date) }
    }
    case 'check_conflicts': {
      const date = isoDate(args.date)
      if (!date) return { ok: false, error: 'expected date as YYYY-MM-DD' }
      const clashes = overlaps(await fetchRange(ctx, date, date))
      return { date, conflicts: clashes, has_conflicts: clashes.length > 0 }
    }
    case 'start_timer': {
      let seconds: number | null = null
      const target = parseLocalDateTime(args.fires_at)
      if (target) seconds = Math.round((target.getTime() - Date.now()) / 1000)
      if (seconds == null && args.duration_seconds != null) seconds = Number(args.duration_seconds)
      if (seconds == null && args.duration_minutes != null) {
        seconds = Math.round(Number(args.duration_minutes) * 60)
      }
      if (seconds == null || !Number.isFinite(seconds)) {
        return { ok: false, error: 'need a duration or a target time' }
      }
      if (seconds <= 0) return { ok: false, error: 'that time is already past' }
      if (seconds > TIMER_MAX_SECONDS) return { ok: false, error: 'Timers can be at most six hours.' }
      const label =
        typeof args.label === 'string' && args.label.trim() ? args.label.trim() : null
      const response = await fetch(`${ctx.apiBaseUrl}/api/timers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ duration_seconds: seconds, label }),
      })
      if (response.status === 422) return { ok: false, error: 'Timers can be at most six hours.' }
      if (!response.ok) return { ok: false, error: `could not start the timer (${response.status})` }
      const result = (await response.json()) as {
        timer: ApiTimer
        replaced: ApiTimer | null
      }
      return {
        ok: true,
        fires_at: result.timer.fires_at,
        label: result.timer.label ?? undefined,
        replaced_label: result.replaced
          ? (result.replaced.label ?? 'your previous timer')
          : undefined,
      }
    }
    case 'cancel_timer': {
      const timer = await currentTimer(ctx)
      if (!timer) return { ok: false, error: 'no timer is running' }
      const response = await fetch(`${ctx.apiBaseUrl}/api/timers/${timer.id}`, { method: 'DELETE' })
      return response.ok ? { ok: true } : { ok: false, error: 'could not stop the timer' }
    }
    case 'extend_timer': {
      const minutes = Number(args.add_minutes)
      if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: 'how many minutes?' }
      const timer = await currentTimer(ctx)
      if (!timer) return { ok: false, error: 'no timer is running' }
      const response = await fetch(`${ctx.apiBaseUrl}/api/timers/${timer.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add_seconds: Math.round(minutes * 60) }),
      })
      if (response.status === 422) return { ok: false, error: 'Timers can be at most six hours.' }
      if (!response.ok) return { ok: false, error: 'could not extend the timer' }
      const next = (await response.json()) as ApiTimer
      return { ok: true, fires_at: next.fires_at }
    }
    case 'pause_timer': {
      const timer = await currentTimer(ctx)
      if (!timer) return { ok: false, error: 'no timer is running' }
      if (timer.state === 'paused') return { ok: true, already_paused: true }
      const response = await fetch(`${ctx.apiBaseUrl}/api/timers/${timer.id}/pause`, { method: 'POST' })
      return response.ok ? { ok: true } : { ok: false, error: 'could not pause the timer' }
    }
    case 'resume_timer': {
      const timer = await currentTimer(ctx)
      if (!timer) return { ok: false, error: 'no timer is set' }
      if (timer.state !== 'paused') return { ok: true, already_running: true }
      const response = await fetch(`${ctx.apiBaseUrl}/api/timers/${timer.id}/resume`, { method: 'POST' })
      return response.ok ? { ok: true } : { ok: false, error: 'could not resume the timer' }
    }
    case 'restart_timer': {
      const timer = await currentTimer(ctx)
      if (!timer) return { ok: false, error: 'no timer is set' }
      const response = await fetch(`${ctx.apiBaseUrl}/api/timers/${timer.id}/restart`, { method: 'POST' })
      if (!response.ok) return { ok: false, error: 'could not restart the timer' }
      const next = (await response.json()) as ApiTimer
      return { ok: true, fires_at: next.fires_at }
    }
    case 'get_timer': {
      const timer = await currentTimer(ctx)
      if (!timer) return { running: false }
      const paused = timer.state === 'paused'
      const remainingMs = paused
        ? (timer.remaining_seconds ?? 0) * 1000
        : new Date(timer.fires_at).getTime() - Date.now()
      return {
        running: timer.state === 'running',
        firing: timer.state === 'fired',
        paused,
        remaining_minutes: Math.max(0, Math.round(remainingMs / 60_000)),
        label: timer.label ?? undefined,
      }
    }
    case 'add_to_list': {
      const raw = Array.isArray(args.items)
        ? args.items
        : typeof args.items === 'string'
          ? [args.items]
          : typeof args.item === 'string'
            ? [args.item]
            : []
      const names = raw.map((entry) => String(entry).trim()).filter(Boolean)
      if (!names.length) return { ok: false, error: 'nothing to add' }
      const response = await fetch(`${ctx.apiBaseUrl}/api/lists/${listId(args.list)}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ names, source: 'voice' }),
      })
      if (response.status === 404) return { ok: false, error: 'I only have the grocery list.' }
      if (!response.ok) return { ok: false, error: `could not add to the list (${response.status})` }
      const result = (await response.json()) as {
        added: string[]
        already_present: string[]
      }
      return { ok: true, added: result.added, already_present: result.already_present }
    }
    case 'remove_from_list':
    case 'check_off_item': {
      const id = listId(args.list)
      const list = await fetchList(ctx, id)
      if (!list) return { ok: false, error: 'I only have the grocery list.' }
      const item = findItem(list, String(args.item ?? ''))
      if (!item) return { ok: false, error: `${String(args.item ?? 'that')} isn't on the list` }
      if (name === 'check_off_item') {
        const response = await fetch(`${ctx.apiBaseUrl}/api/lists/${id}/items/${item.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ checked: true }),
        })
        return response.ok ? { ok: true, checked: item.name } : { ok: false, error: 'could not check it off' }
      }
      const response = await fetch(`${ctx.apiBaseUrl}/api/lists/${id}/items/${item.id}`, {
        method: 'DELETE',
      })
      return response.ok ? { ok: true, removed: item.name } : { ok: false, error: 'could not remove it' }
    }
    case 'clear_list': {
      const scope = args.scope === 'checked' ? 'checked' : 'all'
      const response = await fetch(`${ctx.apiBaseUrl}/api/lists/${listId(args.list)}/clear`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope }),
      })
      if (response.status === 404) return { ok: false, error: 'I only have the grocery list.' }
      if (!response.ok) return { ok: false, error: 'could not clear the list' }
      const result = (await response.json()) as { removed: unknown[] }
      return { ok: true, scope, removed_count: Array.isArray(result.removed) ? result.removed.length : 0 }
    }
    case 'get_list': {
      const list = await fetchList(ctx, listId(args.list))
      if (!list) return { ok: false, error: 'I only have the grocery list.' }
      return {
        items: list.items.map((item) => ({ name: item.name, checked: item.checked })),
        unchecked_count: list.items.filter((item) => !item.checked).length,
      }
    }
    default:
      return { ok: false, error: `unknown tool ${name}` }
  }
}
