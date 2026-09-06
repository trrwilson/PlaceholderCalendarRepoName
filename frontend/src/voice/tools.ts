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
type ApiSnapshot = { calendars: { id: string; name: string }[]; events: ApiEvent[] }

const isoDate = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null

const parseLocalDate = (value: string): Date => {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}

async function fetchRange(ctx: ToolContext, start: string, end: string) {
  const params = new URLSearchParams({ starts_on: start, ends_on: end })
  const response = await fetch(`${ctx.apiBaseUrl}/api/calendar?${params}`)
  if (!response.ok) throw new Error(`calendar request failed (${response.status})`)
  const snapshot: ApiSnapshot = await response.json()
  const names = new Map(snapshot.calendars.map((c) => [c.id, c.name]))
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
      if (!['home', 'week', 'month'].includes(view)) return { ok: false, error: 'unknown view' }
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
    default:
      return { ok: false, error: `unknown tool ${name}` }
  }
}
