import { describe, expect, it } from 'vitest'

import { bucketOf, dueLabel, groupByBucket, homeSummary, isoDay } from './taskView'
import type { TaskItem } from './types'

const today = new Date(2026, 10, 9, 9, 0) // Mon 9 Nov 2026, local

const task = (id: string, extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  list_id: 'l',
  title: id,
  status: 'not_started',
  importance: 'normal',
  due_on: null,
  completed_at: null,
  category: null,
  checklist_total: 0,
  checklist_done: 0,
  has_note: false,
  ...extra,
})

describe('taskView', () => {
  it('buckets by local due date and status', () => {
    expect(isoDay(today)).toBe('2026-11-09')
    expect(bucketOf(task('a', { due_on: '2026-11-08' }), today)).toBe('overdue')
    expect(bucketOf(task('b', { due_on: '2026-11-09' }), today)).toBe('today')
    expect(bucketOf(task('c', { due_on: '2026-11-20' }), today)).toBe('upcoming')
    expect(bucketOf(task('d'), today)).toBe('someday')
    expect(bucketOf(task('e', { due_on: '2026-11-01', status: 'completed' }), today)).toBe('done')
  })

  it('labels due dates for the room', () => {
    expect(dueLabel(null, today)).toBeNull()
    expect(dueLabel('2026-11-09', today)).toBe('Today')
    expect(dueLabel('2026-11-10', today)).toBe('Tomorrow')
    expect(dueLabel('2026-11-08', today)).toBe('Yesterday')
    expect(dueLabel('2026-11-12', today)).toMatch(/Thu/)
  })

  it('groups every task exactly once', () => {
    const groups = groupByBucket([task('a', { due_on: '2026-11-08' }), task('b')], today)
    expect(groups.get('overdue')!.map((t) => t.id)).toEqual(['a'])
    expect(groups.get('someday')!.map((t) => t.id)).toEqual(['b'])
  })

  it('home summary keeps only overdue and due-today open tasks, overdue first', () => {
    const summary = homeSummary(
      [
        task('later', { due_on: '2026-11-12' }),
        task('today', { due_on: '2026-11-09' }),
        task('urgent', { due_on: '2026-11-09', importance: 'high' }),
        task('late', { due_on: '2026-11-02' }),
        task('done', { due_on: '2026-11-09', status: 'completed' }),
        task('undated'),
      ],
      today,
    )
    expect(summary.map((t) => t.id)).toEqual(['late', 'urgent', 'today'])
  })
})
