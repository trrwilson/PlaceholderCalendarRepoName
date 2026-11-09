import { useState, type CSSProperties } from 'react'

import { BUCKET_LABELS, BUCKET_ORDER, bucketOf, dueLabel, groupByBucket, homeSummary } from './taskView'
import type { TaskItem, TaskList, TaskSnapshot } from './types'

const REDACTED = '•••'

/** Resolves a list's owner to a person (name + palette colour class). */
export type OwnerLookup = (ownerId: string) => { name: string; colorClass: string } | null

interface RowProps {
  task: TaskItem
  list: TaskList | undefined
  owner: OwnerLookup
  today: Date
  redacted: boolean
  onSelect?: (task: TaskItem) => void
}

function TaskRow({ task, list, owner, today, redacted, onSelect }: RowProps) {
  const person = list ? owner(list.owner_id) : null
  const due = dueLabel(task.due_on, today)
  const done = bucketOf(task, today) === 'done'
  const overdue = bucketOf(task, today) === 'overdue'
  const category = !redacted && task.category
  return (
    <button
      className={`task-row ${person?.colorClass ?? ''}${done ? ' is-done' : ''}`}
      onClick={onSelect && !redacted ? () => onSelect(task) : undefined}
      disabled={!onSelect || redacted}
    >
      <span className="task-main">
        <strong>
          {task.importance === 'high' && <span className="task-important" aria-label="Important">★ </span>}
          {redacted ? REDACTED : task.title}
        </strong>
        <small>
          {person && <span className="task-owner">{person.name}</span>}
          {list && !redacted && <span className="task-list-name">{list.name}</span>}
          {task.checklist_total > 0 && <span>{task.checklist_done}/{task.checklist_total}</span>}
        </small>
      </span>
      {category && <span className="task-category" style={{ '--category-color': category.color } as CSSProperties}>{category.name}</span>}
      {due && <span className={`task-due${overdue ? ' is-overdue' : ''}`}>{due}</span>}
    </button>
  )
}

interface ViewProps {
  snapshot: TaskSnapshot | null
  owner: OwnerLookup
  now: Date
  redacted: boolean
}

/** The To Do appliance mode: tasks grouped by due bucket. Read-only. */
export function TodoView({ snapshot, owner, now, redacted }: ViewProps) {
  const [selected, setSelected] = useState<TaskItem | null>(null)
  const lists = new Map((snapshot?.lists ?? []).map((list) => [list.id, list]))
  const groups = groupByBucket(snapshot?.tasks ?? [], now)
  const openCount = (snapshot?.tasks ?? []).filter((task) => task.status !== 'completed').length
  return (
    <div className="todo-view">
      <div className="view-heading">
        <p className="section-kicker">To Do · {openCount} open</p>
        {snapshot?.status === 'needs_sign_in' && <span className="todo-health">Sign in again to show To Do</span>}
        {snapshot?.status === 'stale' && snapshot.synced_at && <span className="todo-health">Not updated recently</span>}
      </div>
      {openCount === 0 && <p className="todo-empty">Nothing on the list.</p>}
      <div className="todo-columns">
        {BUCKET_ORDER.map((bucket) => {
          const tasks = groups.get(bucket) ?? []
          if (!tasks.length) return null
          return (
            <section key={bucket} className={`todo-bucket todo-bucket-${bucket}`}>
              <h2>{BUCKET_LABELS[bucket]} <span>{tasks.length}</span></h2>
              <div className="todo-rows">
                {tasks.map((task) => (
                  <TaskRow key={`${task.list_id}:${task.id}`} task={task} list={lists.get(task.list_id)} owner={owner} today={now} redacted={redacted} onSelect={setSelected} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
      {selected && !redacted && (
        <div className="detail-scrim" onClick={() => setSelected(null)} onKeyDown={(e) => e.key === 'Escape' && setSelected(null)} role="presentation">
          <section className="detail-sheet task-detail" role="dialog" aria-label={selected.title} onClick={(e) => e.stopPropagation()}>
            <button className="close-detail" aria-label="Close" onClick={() => setSelected(null)}>×</button>
            <span className={`detail-bar ${lists.get(selected.list_id) ? owner(lists.get(selected.list_id)!.owner_id)?.colorClass ?? '' : ''}`} />
            <h2>{selected.title}</h2>
            <p className="detail-time">{dueLabel(selected.due_on, now) ?? 'No due date'} · {lists.get(selected.list_id)?.name}</p>
            {selected.checklist_total > 0 && <p className="detail-location">{selected.checklist_done} of {selected.checklist_total} steps done</p>}
            {selected.has_note && <p className="detail-location">Has a note — open To Do to read it.</p>}
          </section>
        </div>
      )}
    </div>
  )
}

interface SummaryProps extends ViewProps {
  onOpen: () => void
  maxRows?: number
}

/** Home's NOW/NEXT card: overdue + due today only. Renders nothing when empty. */
export function TodoSummary({ snapshot, owner, now, redacted, onOpen, maxRows = 3 }: SummaryProps) {
  if (!snapshot || snapshot.status === 'disabled') return null
  const due = homeSummary(snapshot.tasks, now)
  if (!due.length) return null
  const lists = new Map(snapshot.lists.map((list) => [list.id, list]))
  const shown = due.slice(0, maxRows)
  const more = due.length - shown.length
  return (
    <section className="todo-summary">
      <div className="view-heading"><p className="section-kicker">To Do</p></div>
      <div className="todo-rows">
        {shown.map((task) => (
          <TaskRow key={`${task.list_id}:${task.id}`} task={task} list={lists.get(task.list_id)} owner={owner} today={now} redacted={redacted} onSelect={() => onOpen()} />
        ))}
      </div>
      {more > 0 && <button className="day-more todo-more" onClick={onOpen}>+{more} more</button>}
    </section>
  )
}
