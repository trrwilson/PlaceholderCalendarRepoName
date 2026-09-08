import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppSocket } from '../realtime/useAppSocket'
import {
  DEFAULT_LIST_ID,
  type GroceryList,
  type ListClearScope,
  type ListItem,
  type ListMessage,
  type ListMutationResult,
} from './types'

const isList = (value: unknown): value is GroceryList =>
  !!value && typeof value === 'object' && Array.isArray((value as GroceryList).items)

interface Options {
  apiBaseUrl: string
  listId?: string
  /**
   * Fired when a clear or a remove takes items off the list — from this kiosk or
   * a voice command on any screen. Drives the on-screen "Cleared N · Undo".
   */
  onRemoved?: (removed: ListItem[], kind: 'cleared' | 'removed') => void
}

export interface ListsApi {
  list: GroceryList | null
  /** Items still to get — the ambient "N things" signal. */
  uncheckedCount: number
  /** Distinct item names added before, newest first — the touch quick-add grid. */
  recentItems: string[]
  add: (name: string, note?: string | null) => Promise<ListMutationResult | null>
  toggle: (itemId: string, checked: boolean) => Promise<void>
  remove: (itemId: string) => Promise<ListItem | null>
  clear: (scope: ListClearScope) => Promise<ListItem[]>
  restore: (items: ListItem[]) => Promise<void>
  /** Apply a custom drag order (item ids in the desired order); persisted. */
  reorder: (orderedIds: string[]) => Promise<void>
}

/**
 * Owns the household grocery list. The backend is authoritative — it persists to
 * a JSON file and pushes every change over the shared `/api/ws` connection; this
 * hook reconciles from `GET /api/lists/{id}` whenever the socket (re)opens and
 * applies pushes in between. See docs/lists-plan.md.
 */
export function useLists({ apiBaseUrl, listId = DEFAULT_LIST_ID, onRemoved }: Options): ListsApi {
  const [list, setList] = useState<GroceryList | null>(null)
  const listRef = useRef<GroceryList | null>(null)
  listRef.current = list
  const onRemovedRef = useRef(onRemoved)
  onRemovedRef.current = onRemoved
  // While a local drag-reorder is settling, ignore `list-reordered` echoes so a
  // slightly-stale broadcast can't yank rows back mid-gesture.
  const suppressReorderUntil = useRef(0)

  const apply = useCallback(
    (lists: GroceryList[] | undefined, single: GroceryList | null | undefined) => {
      if (isList(single) && single.id === listId) return setList(single)
      const next = lists?.find((entry) => isList(entry) && entry.id === listId)
      if (next) setList(next)
    },
    [listId],
  )

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/lists/${listId}`)
      if (!response.ok) return
      const data: unknown = await response.json()
      if (isList(data)) setList(data)
    } catch {
      // Offline: keep the last known list.
    }
  }, [apiBaseUrl, listId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useAppSocket(apiBaseUrl, {
    onOpen: () => void refresh(),
    onMessage: (data) => {
      const message = data as unknown as ListMessage
      if (!message.type?.startsWith('list')) return
      const staleReorder =
        message.type === 'list-reordered' && Date.now() < suppressReorderUntil.current
      if (!staleReorder && (Array.isArray(message.lists) || message.list)) {
        apply(message.lists, message.list)
      }
      if (message.removed?.length) {
        onRemovedRef.current?.(message.removed, message.type === 'list-cleared' ? 'cleared' : 'removed')
      }
    },
  })

  const post = useCallback(
    async (path: string, body: unknown): Promise<ListMutationResult> => {
      const response = await fetch(`${apiBaseUrl}/api/lists/${listId}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const detail = await response
          .json()
          .then((b: { detail?: unknown }) => (typeof b.detail === 'string' ? b.detail : null))
          .catch(() => null)
        throw new Error(detail ?? `list request failed (${response.status})`)
      }
      const result = (await response.json()) as ListMutationResult
      setList(result.list)
      return result
    },
    [apiBaseUrl, listId],
  )

  const add = useCallback(
    (name: string, note?: string | null) =>
      post('/items', { name: name.trim(), note: note ?? null, source: 'touch' }).catch(
        () => null,
      ),
    [post],
  )

  const toggle = useCallback(
    async (itemId: string, checked: boolean) => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/lists/${listId}/items/${itemId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ checked }),
        })
        if (response.ok) setList(((await response.json()) as ListMutationResult).list)
      } catch {
        // Offline: the WS echo / next reconcile will correct the view.
      }
    },
    [apiBaseUrl, listId],
  )

  const remove = useCallback(
    async (itemId: string): Promise<ListItem | null> => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/lists/${listId}/items/${itemId}`, {
          method: 'DELETE',
        })
        if (!response.ok) return null
        const result = (await response.json()) as ListMutationResult
        setList(result.list)
        return result.removed[0] ?? null
      } catch {
        return null
      }
    },
    [apiBaseUrl, listId],
  )

  const clear = useCallback(
    async (scope: ListClearScope): Promise<ListItem[]> => {
      const result = await post('/clear', { scope }).catch(() => null)
      return result?.removed ?? []
    },
    [post],
  )

  const restore = useCallback(
    async (items: ListItem[]) => {
      if (items.length) await post('/restore', { items }).catch(() => undefined)
    },
    [post],
  )

  const reorder = useCallback(
    async (orderedIds: string[]) => {
      const prev = listRef.current
      if (prev) {
        const byId = new Map(prev.items.map((item) => [item.id, item]))
        const named = orderedIds.map((id) => byId.get(id)).filter((i): i is ListItem => !!i)
        const namedIds = new Set(named.map((i) => i.id))
        setList({ ...prev, items: [...named, ...prev.items.filter((i) => !namedIds.has(i.id))] })
      }
      suppressReorderUntil.current = Date.now() + 1_500
      try {
        await post('/reorder', { item_ids: orderedIds })
      } catch {
        void refresh() // request lost — fall back to the server's order
      }
    },
    [post, refresh],
  )

  return useMemo(
    () => ({
      list,
      uncheckedCount: (list?.items ?? []).filter((item) => !item.checked).length,
      recentItems: list?.recent_names ?? [],
      add,
      toggle,
      remove,
      clear,
      restore,
      reorder,
    }),
    [list, add, toggle, remove, clear, restore, reorder],
  )
}
