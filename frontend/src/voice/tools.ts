// Dispatches a Gemini tool call to the dashboard (UI tools) or the calendar API
// (read-only data tools). Mirrors backend/app/voice/tools.py — keep names in sync.

import type { DashboardActions, ViewMode } from './types'

export interface ToolContext {
  actions: DashboardActions
  apiBaseUrl: string
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

type ApiTimer = { id: string; label: string | null; fires_at: string; state: string }

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
  switch (name) {
    case 'show_view': {
      const view = args.view as ViewMode
      if (!['home', 'week', 'month', 'timer'].includes(view)) return { ok: false, error: 'unknown view' }
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
    case 'get_timer': {
      const timer = await currentTimer(ctx)
      if (!timer) return { running: false }
      const remainingMs = new Date(timer.fires_at).getTime() - Date.now()
      return {
        running: timer.state === 'running',
        firing: timer.state === 'fired',
        remaining_minutes: Math.max(0, Math.round(remainingMs / 60_000)),
        label: timer.label ?? undefined,
      }
    }
    default:
      return { ok: false, error: `unknown tool ${name}` }
  }
}
