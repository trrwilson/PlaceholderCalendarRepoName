// Mirrors the note models in backend/app/models.py — keep field names
// (snake_case) in sync with that file.

export interface Note {
  id: string
  text: string
  /** Centre position as a 0-1 fraction of the notes pane viewport. */
  x: number
  y: number
  z: number
  created_at: string
  updated_at: string
}
