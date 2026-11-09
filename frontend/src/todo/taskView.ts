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

export function groupByBucket(tasks: TaskItem[], today: Date): Map<DueBucket, TaskItem[]> {
  const groups = new Map<DueBucket, TaskItem[]>()
  for (const bucket of BUCKET_ORDER) groups.set(bucket, [])
  for (const task of tasks) groups.get(bucketOf(task, today))!.push(task)
  return groups
}

/** NOW/NEXT for Home: open tasks overdue or due today, most urgent first. */
export function homeSummary(tasks: TaskItem[], today: Date): TaskItem[] {
  const rank = (task: TaskItem) => (bucketOf(task, today) === 'overdue' ? 0 : 1)
  return tasks
    .filter((task) => {
      const bucket = bucketOf(task, today)
      return bucket === 'overdue' || bucket === 'today'
    })
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(b.importance === 'high') - Number(a.importance === 'high') ||
        a.title.localeCompare(b.title),
    )
}
