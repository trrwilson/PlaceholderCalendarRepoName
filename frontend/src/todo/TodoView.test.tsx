import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TodoSummary, TodoView } from './TodoView'
import type { TaskSnapshot } from './types'

const now = new Date(2026, 10, 9, 9, 0)
const owner = () => ({ name: 'Alex', colorClass: 'calendar-ocean' })
const base = { id: 'x', list_id: 'l', status: 'not_started', importance: 'normal', completed_at: null, category: null, checklist_total: 0, checklist_done: 0, has_note: false } as const
const snapshot: TaskSnapshot = {
  status: 'ok',
  synced_at: null,
  lists: [{ id: 'l', name: 'Tasks', owner_id: 'alex', is_shared: false, is_owner: true, is_default: true }],
  tasks: [
    { ...base, id: 'a', title: 'Call the dentist', due_on: '2026-11-09' },
    { ...base, id: 'b', title: 'Book camp', due_on: null },
  ],
}

describe('To Do UI', () => {
  it('Home summary shows due-today tasks only and hides when nothing is due', () => {
    const { rerender, container } = render(<TodoSummary snapshot={snapshot} owner={owner} now={now} redacted={false} onOpen={vi.fn()} />)
    expect(screen.getByText('Call the dentist')).toBeInTheDocument()
    expect(screen.queryByText('Book camp')).toBeNull()
    rerender(<TodoSummary snapshot={{ ...snapshot, tasks: [snapshot.tasks[1]] }} owner={owner} now={now} redacted={false} onOpen={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('privacy mode redacts titles but keeps the person and due date', () => {
    render(<TodoView snapshot={snapshot} owner={owner} now={now} redacted />)
    expect(screen.queryByText('Call the dentist')).toBeNull()
    expect(screen.getAllByText('•••').length).toBe(2)
    expect(screen.getAllByText('Alex').length).toBe(2)
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0)
  })
})
