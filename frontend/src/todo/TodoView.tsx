import { useState, type CSSProperties } from 'react'

import type { TaskCompletion } from './useTasks'

import { BUCKET_LABELS, BUCKET_ORDER, bucketOf, dueLabel, groupByBucket, homeSummary } from './taskView'
import type { TaskItem, TaskList, TaskSnapshot } from './types'

const REDACTED = '•••'

/**
 * Who a task is for and the title to show: a household member named at the end of
 * the title ("…--Travis") is the assignee, then a category naming a member, else
 * the list owner (the creator). `title` has any assignee marker removed.
 */
export type OwnerLookup = (task: TaskItem, list: TaskList | undefined) => { name: string | null; colorClass: string; title: string }

interface RowProps {
  task: TaskItem
  list: TaskList | undefined
  owner: OwnerLookup
  today: Date
  redacted: boolean
  onSelect?: (task: TaskItem) => void
}

function TaskRow({ task, list, owner, today, redacted, onSelect }: RowProps) {
  const person = owner(task, list)
  const due = dueLabel(task.due_on, today)
  const done = bucketOf(task, today) === 'done'
  const overdue = bucketOf(task, today) === 'overdue'
  const category = !redacted && task.category
  return (
    <button
      className={`task-row ${person.colorClass}${done ? ' is-done' : ''}`}
      onClick={onSelect && !redacted ? () => onSelect(task) : undefined}
      disabled={!onSelect || redacted}
    >
      <span className="task-main">
        <strong>
          {task.importance === 'high' && <span className="task-important" aria-label="Important">★ </span>}
          {redacted ? REDACTED : person.title}
        </strong>
        <small>
          {person.name && <span className="task-owner">{person.name}</span>}
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
  /** Ticks a task off or reopens it; absent = read-only (e.g. the Home tile). */
  onSetCompleted?: TaskCompletion
  owner: OwnerLookup
  now: Date
  redacted: boolean
}

/** The To Do appliance mode: tasks grouped by due bucket. Read-only. */
export function TodoView({ snapshot, owner, now, redacted, onSetCompleted }: ViewProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyOf = (task: TaskItem) => `${task.list_id}:${task.id}`
  // Follow the live snapshot so the sheet reflects a completion as soon as it lands.
  const selected = (snapshot?.tasks ?? []).find((task) => keyOf(task) === selectedKey) ?? null
  const setSelected = (task: TaskItem | null) => {
    setSelectedKey(task ? keyOf(task) : null)
    setError(null)
  }
  const toggleCompleted = async (task: TaskItem) => {
    if (!onSetCompleted || pending) return
    setPending(true)
    setError(null)
    const problem = await onSetCompleted(task, task.status !== 'completed')
    setPending(false)
    if (problem) setError(problem)
    else setSelected(null)
  }
  const lists = new Map((snapshot?.lists ?? []).map((list) => [list.id, list]))
  const selectedPerson = selected ? owner(selected, lists.get(selected.list_id)) : null
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
            <span className={`detail-bar ${selectedPerson!.colorClass}`} />
            <h2>{selectedPerson!.title}</h2>
            <p className="detail-time">{dueLabel(selected.due_on, now) ?? 'No due date'} · {lists.get(selected.list_id)?.name}{selectedPerson!.name ? ` · ${selectedPerson!.name}` : ''}</p>
            {selected.checklist_total > 0 && <p className="detail-location">{selected.checklist_done} of {selected.checklist_total} steps done</p>}
            {selected.has_note && <p className="detail-location">Has a note — open To Do to read it.</p>}
            {onSetCompleted && (
              <div className="task-detail-actions">
                <button className={`task-complete${selected.status === 'completed' ? ' is-reopen' : ''}`} disabled={pending} onClick={() => void toggleCompleted(selected)}>
                  {pending ? 'Saving…' : selected.status === 'completed' ? 'Reopen' : '✓ Mark complete'}
                </button>
                {error && <p className="task-complete-error" role="alert">{error}</p>}
              </div>
            )}
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

/** Home's full-height To Do tile: overdue and due today first, then upcoming. */
export function TodoSummary({ snapshot, owner, now, redacted, onOpen, maxRows = 8 }: SummaryProps) {
  if (!snapshot || snapshot.status === 'disabled') return null
  const rows = homeSummary(snapshot.tasks, now)
  const lists = new Map(snapshot.lists.map((list) => [list.id, list]))
  const shown = rows.slice(0, maxRows)
  const more = rows.length - shown.length
  return (
    <section className="todo-summary">
      <div className="view-heading"><p className="section-kicker">To Do</p>{snapshot.status === 'needs_sign_in' && <span className="todo-health">Sign in again</span>}</div>
      {shown.length ? (
        <div className="todo-rows">
          {shown.map((task) => (
            <TaskRow key={`${task.list_id}:${task.id}`} task={task} list={lists.get(task.list_id)} owner={owner} today={now} redacted={redacted} onSelect={() => onOpen()} />
          ))}
        </div>
      ) : <p className="todo-empty">Nothing due.</p>}
      {more > 0 && <button className="day-more todo-more" onClick={onOpen}>+{more} more</button>}
    </section>
  )
}
