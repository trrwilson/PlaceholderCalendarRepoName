import { useCallback, useEffect, useState } from 'react'

import { useAppSocket } from '../realtime/useAppSocket'
import type { TaskSnapshot } from './types'

const isSnapshot = (value: unknown): value is TaskSnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as TaskSnapshot).tasks)

/**
 * The backend-owned To Do snapshot (read-only). Reconciles from `GET /api/tasks`
 * whenever the shared socket (re)opens and applies `tasks` pushes in between.
 * `null` until the first answer; `status: 'disabled'` when the feature is off.
 */
export function useTasks(apiBaseUrl: string): TaskSnapshot | null {
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

  return snapshot
}
