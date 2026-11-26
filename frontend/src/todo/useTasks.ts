import { useCallback, useEffect, useState } from 'react'

import { useAppSocket } from '../realtime/useAppSocket'
import type { TaskItem, TaskSnapshot } from './types'

/** Resolves to `null` on success, else a short message fit for the wall. */
export type TaskCompletion = (task: TaskItem, completed: boolean) => Promise<string | null>

const isSnapshot = (value: unknown): value is TaskSnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as TaskSnapshot).tasks)

/**
 * The backend-owned To Do snapshot. The one write is ticking a task off (or
 * reopening it); the server answers with the new snapshot and pushes it to every
 * screen. Reconciles from `GET /api/tasks`
 * whenever the shared socket (re)opens and applies `tasks` pushes in between.
 * `null` until the first answer; `status: 'disabled'` when the feature is off.
 */
export function useTasks(apiBaseUrl: string): { snapshot: TaskSnapshot | null; setCompleted: TaskCompletion } {
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/tasks`)
      if (!response.ok) return
      const data: unknown = await response.json()
      if (isSnapshot(data)) setSnapshot(data)
    } catch {
      // Offline: keep the last known tasks.
    }
  }, [apiBaseUrl])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useAppSocket(apiBaseUrl, {
    onOpen: () => void refresh(),
    onMessage: (data) => {
      if (data.type === 'tasks' && isSnapshot(data.tasks)) setSnapshot(data.tasks)
    },
  })

  const setCompleted = useCallback<TaskCompletion>(
    async (task, completed) => {
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/tasks/${encodeURIComponent(task.list_id)}/${encodeURIComponent(task.id)}/completed`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ completed }) },
        )
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null)
          const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : null
          return typeof detail === 'string' ? detail : 'Could not update the task'
        }
        const data: unknown = await response.json()
        if (isSnapshot(data)) setSnapshot(data)
        return null
      } catch {
        return 'Offline — try again'
      }
    },
    [apiBaseUrl],
  )

  return { snapshot, setCompleted }
}
