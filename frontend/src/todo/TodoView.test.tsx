import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TodoSummary, TodoView } from './TodoView'
import type { TaskSnapshot } from './types'

const now = new Date(2026, 10, 9, 9, 0)
const owner = (task: { title: string }) => ({ name: 'Alex', colorClass: 'calendar-ocean', title: task.title })
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
  afterEach(cleanup)

  it('Home tile shows dated tasks and stays up with an empty state when nothing is due', () => {
    const { rerender, container } = render(<TodoSummary snapshot={snapshot} owner={owner} now={now} redacted={false} onOpen={vi.fn()} />)
    expect(screen.getByText('Call the dentist')).toBeInTheDocument()
    expect(screen.queryByText('Book camp')).toBeNull()
    rerender(<TodoSummary snapshot={{ ...snapshot, tasks: [snapshot.tasks[1]] }} owner={owner} now={now} redacted={false} onOpen={vi.fn()} />)
    expect(screen.getByText('Nothing due.')).toBeInTheDocument()
    rerender(<TodoSummary snapshot={{ ...snapshot, status: 'disabled' }} owner={owner} now={now} redacted={false} onOpen={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('privacy mode redacts titles but keeps the person and due date', () => {
    render(<TodoView snapshot={snapshot} owner={owner} now={now} redacted />)
    expect(screen.queryByText('Call the dentist')).toBeNull()
    expect(screen.getAllByText('•••').length).toBe(2)
    expect(screen.getAllByText('Alex').length).toBe(2)
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0)
  })

  it('detail sheet ticks a task off and shows a failure on the wall', async () => {
    const onSetCompleted = vi.fn().mockResolvedValueOnce('Sign in again from the kiosk to tick tasks off').mockResolvedValueOnce(null)
    render(<TodoView snapshot={snapshot} owner={owner} now={now} redacted={false} onSetCompleted={onSetCompleted} />)
    fireEvent.click(screen.getByText('Call the dentist'))
    fireEvent.click(screen.getByRole('button', { name: /Mark complete/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again')
    expect(onSetCompleted).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), true)
    fireEvent.click(screen.getByRole('button', { name: /Mark complete/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('a done task offers Reopen; without a handler the sheet stays read-only', () => {
    const done: TaskSnapshot = { ...snapshot, tasks: [{ ...snapshot.tasks[0], status: 'completed', completed_at: '2026-11-09T08:00:00' }] }
    const { rerender } = render(<TodoView snapshot={done} owner={owner} now={now} redacted={false} onSetCompleted={vi.fn()} />)
    fireEvent.click(screen.getByText('Call the dentist'))
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    rerender(<TodoView snapshot={done} owner={owner} now={now} redacted={false} />)
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull()
  })
})
