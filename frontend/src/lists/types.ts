// Mirrors the list models in backend/app/models.py — keep field names
// (snake_case) in sync with that file. See docs/lists-plan.md.

export type ListItemSource = 'voice' | 'touch'

export interface ListItem {
  id: string
  name: string
  note: string | null
  checked: boolean
  added_at: string
  checked_at: string | null
  source: ListItemSource
}

export interface GroceryList {
  id: string
  title: string
  items: ListItem[]
  updated_at: string
  recent_names: string[]
}

export interface ListMutationResult {
  list: GroceryList
  removed: ListItem[]
  added: string[]
  already_present: string[]
}

/** The server→client envelope (backend ApplicationMessage), list fields only. */
export interface ListMessage {
  type: string
  message: string
  lists?: GroceryList[]
  list?: GroceryList | null
  removed?: ListItem[]
}

export type ListClearScope = 'checked' | 'all'

export const DEFAULT_LIST_ID = 'grocery'
