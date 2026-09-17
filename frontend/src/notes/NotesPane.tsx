import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

import { useSuppressVoice } from '../voice/suppression'
import { useNoteDictation } from './useNoteDictation'
import { useNotes } from './useNotes'
import type { Note } from './types'

const REDACTED_TEXT = '•••'
// Some part of a note always stays inside the board and drag-reachable — this
// is how much of its width/height must stay in bounds, in pixels.
const MIN_VISIBLE_PX = 32
// A long, still ("negligible movement") hold opens the edit/delete dialog
// instead of a drag.
const LONG_PRESS_MS = 2_000
const LONG_PRESS_MOVE_TOLERANCE_PX = 6

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Font size buckets by content length — a lightweight stand-in for real
 * measure-and-shrink text fitting, good enough for a handful of short lines. */
function fitFontSize(text: string): string {
  const len = text.length
  if (len <= 24) return '1.55em'
  if (len <= 70) return '1.15em'
  if (len <= 150) return '0.85em'
  return '0.65em'
}

interface StickyNoteProps {
  note: Note
  redacting: boolean
  boardRef: RefObject<HTMLDivElement | null>
  onMove: (id: string, x: number, y: number) => void
  onLongPress: (note: Note) => void
}

function StickyNote({ note, redacting, boardRef, onMove, onLongPress }: StickyNoteProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startClientX: number
    startClientY: number
    startX: number
    startY: number
    moved: boolean
    timer: number | null
  } | null>(null)

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (redacting) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const timer = window.setTimeout(() => {
        const state = dragRef.current
        if (state && !state.moved) {
          dragRef.current = null
          onLongPress(note)
        }
      }, LONG_PRESS_MS)
      dragRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: note.x,
        startY: note.y,
        moved: false,
        timer,
      }
    },
    [note, onLongPress, redacting],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = dragRef.current
      const board = boardRef.current
      const noteEl = ref.current
      if (!state || !board || !noteEl) return
      const dxPx = event.clientX - state.startClientX
      const dyPx = event.clientY - state.startClientY
      if (!state.moved && Math.hypot(dxPx, dyPx) > LONG_PRESS_MOVE_TOLERANCE_PX) {
        state.moved = true
        if (state.timer) window.clearTimeout(state.timer)
      }
      if (!state.moved) return
      const boardRect = board.getBoundingClientRect()
      const noteRect = noteEl.getBoundingClientRect()
      const cw = boardRect.width
      const ch = boardRect.height
      const nw = noteRect.width
      const nh = noteRect.height
      const cx = state.startX * cw + dxPx
      const cy = state.startY * ch + dyPx
      const left = clamp(cx - nw / 2, MIN_VISIBLE_PX - nw, cw - MIN_VISIBLE_PX)
      const top = clamp(cy - nh / 2, MIN_VISIBLE_PX - nh, ch - MIN_VISIBLE_PX)
      setLive({ x: (left + nw / 2) / cw, y: (top + nh / 2) / ch })
    },
    [boardRef],
  )

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = dragRef.current
      if (!state) return
      if (state.timer) window.clearTimeout(state.timer)
      try {
        event.currentTarget.releasePointerCapture(event.pointerId)
      } catch {
        // already released
      }
      dragRef.current = null
      if (state.moved && live) onMove(note.id, live.x, live.y)
      setLive(null)
    },
    [live, note.id, onMove],
  )

  const pos = live ?? { x: note.x, y: note.y }
  return (
    <div
      ref={ref}
      className={`sticky-note${redacting ? ' sticky-note-private' : ''}`}
      style={{ left: `${pos.x * 100}%`, top: `${pos.y * 100}%`, zIndex: note.z }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role={redacting ? undefined : 'button'}
      aria-label={redacting ? 'Note (hidden — privacy mode is on)' : `Note: ${note.text}. Hold to edit, drag to move.`}
    >
      <p style={{ fontSize: redacting ? undefined : fitFontSize(note.text) }}>
        {redacting ? REDACTED_TEXT : note.text}
      </p>
    </div>
  )
}

interface NoteModalProps {
  apiBaseUrl: string
  title: string
  initialText?: string
  onCancel: () => void
  onSave: (text: string) => void
  onDelete?: () => void
}

function NoteModal({ apiBaseUrl, title, initialText = '', onCancel, onSave, onDelete }: NoteModalProps) {
  const [text, setText] = useState(initialText)
  const dictation = useNoteDictation(apiBaseUrl)
  // The whole time this dialog is open (not just while actively recording) —
  // it owns speech input, so the wake word / Ask button stay quiet underneath
  // it (see frontend/src/voice/suppression.ts).
  useSuppressVoice(true)

  const startRecording = useCallback(async () => {
    const transcript = await dictation.record()
    if (transcript) setText(transcript)
  }, [dictation])

  return (
    <div className="detail-scrim" role="presentation" onClick={onCancel}>
      <section
        className="detail-sheet note-modal"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <button className="close-detail" onClick={onCancel} aria-label="Close">
          ×
        </button>
        <p className="section-kicker">{title}</p>
        <textarea
          className="note-modal-text"
          value={text}
          readOnly
          placeholder="Tap the microphone and say what to write…"
          aria-label="Note text"
        />
        <button
          className={`note-mic mic-${dictation.status}`}
          onClick={() => void startRecording()}
          disabled={dictation.status === 'recording' || dictation.status === 'transcribing'}
          aria-label={dictation.status === 'recording' ? 'Recording — listening' : 'Record note text'}
        >
          <span aria-hidden>🎤</span>
          <b>
            {dictation.status === 'recording'
              ? 'Listening…'
              : dictation.status === 'transcribing'
                ? 'Transcribing…'
                : dictation.status === 'error'
                  ? "Couldn't hear that — try again"
                  : 'Tap to speak'}
          </b>
        </button>
        <div className="detail-actions">
          {onDelete && (
            <button className="quiet-action note-delete" onClick={onDelete}>
              Delete
            </button>
          )}
          <button className="quiet-action" onClick={onCancel}>
            Cancel
          </button>
          <button onClick={() => onSave(text)} disabled={!text.trim()}>
            OK
          </button>
        </div>
      </section>
    </div>
  )
}

export function NotesPane({ apiBaseUrl, redacting }: { apiBaseUrl: string; redacting: boolean }) {
  const notes = useNotes(apiBaseUrl)
  const boardRef = useRef<HTMLDivElement>(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<Note | null>(null)

  const ordered = [...notes.notes].sort((a, b) => a.z - b.z)

  return (
    <section className="notes-pane">
      <div className="view-heading">
        <p className="section-kicker">Notes</p>
      </div>
      <div className="notes-board" ref={boardRef}>
        {ordered.map((note) => (
          <StickyNote
            key={note.id}
            note={note}
            redacting={redacting}
            boardRef={boardRef}
            onMove={(id, x, y) => void notes.update(id, { x, y })}
            onLongPress={setEditing}
          />
        ))}
      </div>
      {!redacting && (
        <button className="notes-fab" onClick={() => setCreating(true)} aria-label="Add a note">
          <span aria-hidden>+</span>
        </button>
      )}
      {creating && (
        <NoteModal
          apiBaseUrl={apiBaseUrl}
          title="New note"
          onCancel={() => setCreating(false)}
          onSave={(text) => {
            // A little spread so notes created back-to-back don't stack exactly —
            // each is still freely draggable afterwards.
            const jitter = () => 0.5 + (Math.random() - 0.5) * 0.15
            void notes.create(text.trim(), jitter(), jitter())
            setCreating(false)
          }}
        />
      )}
      {editing && (
        <NoteModal
          apiBaseUrl={apiBaseUrl}
          title="Edit note"
          initialText={editing.text}
          onCancel={() => setEditing(null)}
          onSave={(text) => {
            void notes.update(editing.id, { text: text.trim() })
            setEditing(null)
          }}
          onDelete={() => {
            void notes.remove(editing.id)
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}
