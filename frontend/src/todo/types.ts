// Mirrors the To Do models in backend/app/models.py (TaskList / TaskItem /
// TaskSnapshot) — change both sides in the same commit. snake_case on both.
// See docs/todo-integration-plan.md.

export type TaskStatus = 'not_started' | 'in_progress' | 'completed' | 'waiting' | 'deferred'
export type TaskImportance = 'low' | 'normal' | 'high'
export type TaskSyncStatus = 'ok' | 'stale' | 'needs_sign_in' | 'disabled'

export interface TaskCategory {
  id: string
  name: string
  color: string
}

export interface TaskList {
  id: string
  name: string
  /** The owning account's HouseholdCalendar.id — the person-colour key. */
  owner_id: string
  is_shared: boolean
  /** False when another member shared this list with the account. */
  is_owner: boolean
  is_default: boolean
}

export interface TaskItem {
  id: string
  list_id: string
  title: string
  status: TaskStatus
  importance: TaskImportance
  /** Household-local due date, `YYYY-MM-DD`. */
  due_on: string | null
  completed_at: string | null
  category: TaskCategory | null
  checklist_total: number
  checklist_done: number
  has_note: boolean
}

export interface TaskSnapshot {
  lists: TaskList[]
  tasks: TaskItem[]
  synced_at: string | null
  status: TaskSyncStatus
  error?: string | null
}
