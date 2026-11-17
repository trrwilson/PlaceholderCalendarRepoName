// Pure presentation helpers for To Do: due buckets, labels, the Home summary.
// No React, no network — unit-tested in taskView.test.ts.

import type { TaskItem } from './types'

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'someday' | 'done'

export const BUCKET_LABELS: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  upcoming: 'Upcoming',
  someday: 'No date',
  done: 'Done',
}

export const BUCKET_ORDER: DueBucket[] = ['overdue', 'today', 'upcoming', 'someday', 'done']

/** `YYYY-MM-DD` for a local Date. */
export const isoDay = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const parseDay = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function bucketOf(task: TaskItem, today: Date): DueBucket {
  if (task.status === 'completed') return 'done'
  if (!task.due_on) return 'someday'
  const todayIso = isoDay(today)
  if (task.due_on < todayIso) return 'overdue'
  if (task.due_on === todayIso) return 'today'
  return 'upcoming'
}

/** "Today", "Tomorrow", "Yesterday", a weekday within the week, else "Nov 14". */
export function dueLabel(dueOn: string | null, today: Date): string | null {
  if (!dueOn) return null
  const due = parseDay(dueOn)
  const base = parseDay(isoDay(today))
  const days = Math.round((due.getTime() - base.getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days > 1 && days < 7) return due.toLocaleDateString(undefined, { weekday: 'long' })
  return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** How far back Done reaches. Older completions are history, not household status. */
export const DONE_WINDOW_DAYS = 7

export function groupByBucket(tasks: TaskItem[], today: Date): Map<DueBucket, TaskItem[]> {
  const groups = new Map<DueBucket, TaskItem[]>()
  for (const bucket of BUCKET_ORDER) groups.set(bucket, [])
  const base = parseDay(isoDay(today))
  base.setDate(base.getDate() - DONE_WINDOW_DAYS)
  const doneSince = isoDay(base)
  for (const task of tasks) {
    const bucket = bucketOf(task, today)
    // completed_at is naive local ISO, so string order is time order.
    if (bucket === 'done' && !(task.completed_at && task.completed_at >= doneSince)) continue
    groups.get(bucket)!.push(task)
  }
  groups.get('done')!.sort((a, b) => b.completed_at!.localeCompare(a.completed_at!))
  return groups
}

const HOME_RANK: Partial<Record<DueBucket, number>> = { overdue: 0, today: 1, upcoming: 2 }

/** Home tile: open dated tasks — overdue, then today, then upcoming by date. */
export function homeSummary(tasks: TaskItem[], today: Date): TaskItem[] {
  const rank = (task: TaskItem) => HOME_RANK[bucketOf(task, today)] ?? 9
  return tasks
    .filter((task) => rank(task) < 9)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (rank(a) === 2 ? a.due_on!.localeCompare(b.due_on!) : 0) ||
        Number(b.importance === 'high') - Number(a.importance === 'high') ||
        a.title.localeCompare(b.title),
    )
}
