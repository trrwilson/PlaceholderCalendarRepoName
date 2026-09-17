import { useCallback, useEffect, useMemo, useState } from 'react'

import type { Note } from './types'

// Some tests stub `fetch` for every URL with the calendar-snapshot shape
// rather than filtering by path — same defensive shape check `useLists`'
// `isList` does, so a mismatched/mocked response is silently ignored instead
// of getting cast straight into state.
const isNote = (value: unknown): value is Note =>
  !!value && typeof value === 'object' && typeof (value as Note).id === 'string'
const isNoteArray = (value: unknown): value is Note[] => Array.isArray(value) && value.every(isNote)

export interface NotesApi {
  notes: Note[]
  create: (text: string, x?: number, y?: number) => Promise<Note | null>
  update: (id: string, patch: { text?: string; x?: number; y?: number }) => Promise<Note | null>
  remove: (id: string) => Promise<void>
}

/**
 * Owns the Home notes pane's sticky notes. Unlike lists/timers this is a
 * single-kiosk, single-viewer surface — no `/api/ws` push, just a fetch on
 * mount and an optimistic local update on every mutation (see
 * backend/app/notes.py and AGENTS.md's "no realtime unless needed" rule).
 */
export function useNotes(apiBaseUrl: string): NotesApi {
  const [notes, setNotes] = useState<Note[]>([])

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/notes`)
      if (!response.ok) return
      const data: unknown = await response.json()
      if (isNoteArray(data)) setNotes(data)
    } catch {
      // Offline: keep the last known board.
    }
  }, [apiBaseUrl])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const create = useCallback(
    async (text: string, x = 0.5, y = 0.5): Promise<Note | null> => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/notes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, x, y }),
        })
        if (!response.ok) return null
        const data: unknown = await response.json()
        if (!isNote(data)) return null
        setNotes((current) => [...current, data])
        return data
      } catch {
        return null
      }
    },
    [apiBaseUrl],
  )

  const update = useCallback(
    async (id: string, patch: { text?: string; x?: number; y?: number }): Promise<Note | null> => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/notes/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!response.ok) return null
        const data: unknown = await response.json()
        if (!isNote(data)) return null
        setNotes((current) => current.map((existing) => (existing.id === id ? data : existing)))
        return data
      } catch {
        return null
      }
    },
    [apiBaseUrl],
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      setNotes((current) => current.filter((note) => note.id !== id))
      try {
        await fetch(`${apiBaseUrl}/api/notes/${id}`, { method: 'DELETE' })
      } catch {
        void refresh() // request lost — fall back to the server's state
      }
    },
    [apiBaseUrl, refresh],
  )

  return useMemo(() => ({ notes, create, update, remove }), [notes, create, update, remove])
}
