import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TimerView } from './TimerView'
import type { Timer } from './types'

const noop = () => undefined
const baseProps = {
  timer: null,
  remainingMs: 0,
  alarm: false,
  onStart: noop,
  onExtend: noop,
  onPause: noop,
  onResume: noop,
  onRestart: noop,
  onCancel: noop,
  onDismiss: noop,
}

afterEach(() => cleanup())

describe('TimerView', () => {
  it('starts from the setup surface with the entered duration and label', () => {
    const onStart = vi.fn()
    render(<TimerView {...baseProps} onStart={onStart} />)

    fireEvent.click(screen.getByRole('button', { name: '15 min' }))
    fireEvent.click(screen.getByRole('button', { name: 'Oven' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start timer' }))

    expect(onStart).toHaveBeenCalledWith(15 * 60, 'Oven')
  })

  it('cannot dial past six hours and disables Start at zero', () => {
    render(<TimerView {...baseProps} />)
    const plus = screen.getByRole('button', { name: 'Add one minute' })
    for (let i = 0; i < 400; i += 1) fireEvent.click(plus)
    expect(screen.getByText('6:00:00')).toBeInTheDocument()

    const minus = screen.getByRole('button', { name: 'Subtract one minute' })
    for (let i = 0; i < 400; i += 1) fireEvent.click(minus)
    expect(screen.getByText('00:00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start timer' })).toBeDisabled()
  })

  it('shows a running countdown with extend and cancel controls', () => {
    const timer: Timer = {
      id: 't',
      label: 'pasta',
      created_at: '2026-09-06T08:00:00',
      fires_at: '2026-09-06T08:10:00',
      duration_seconds: 600,
      state: 'running',
    }
    const onExtend = vi.fn()
    render(<TimerView {...baseProps} timer={timer} remainingMs={90_000} onExtend={onExtend} />)

    expect(screen.getByText('01:30')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+5 min' }))
    expect(onExtend).toHaveBeenCalledWith(300)
  })

  it('pauses a running timer and resumes a paused one', () => {
    const running: Timer = {
      id: 't',
      label: 'pasta',
      created_at: '2026-09-06T08:00:00',
      fires_at: '2026-09-06T08:10:00',
      duration_seconds: 600,
      state: 'running',
    }
    const onPause = vi.fn()
    const { rerender } = render(<TimerView {...baseProps} timer={running} remainingMs={300_000} onPause={onPause} />)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(onPause).toHaveBeenCalled()

    const onResume = vi.fn()
    const paused: Timer = { ...running, state: 'paused', remaining_seconds: 300 }
    rerender(<TimerView {...baseProps} timer={paused} remainingMs={300_000} onResume={onResume} />)
    expect(screen.getByText('Paused')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalled()
  })

  it('dismisses the alarm when the surface is tapped', () => {
    const timer: Timer = {
      id: 't',
      label: 'pasta',
      created_at: '2026-09-06T08:00:00',
      fires_at: '2026-09-06T08:10:00',
      duration_seconds: 600,
      state: 'fired',
    }
    const onDismiss = vi.fn()
    render(<TimerView {...baseProps} timer={timer} alarm onDismiss={onDismiss} />)

    expect(screen.getByText('Timer finished')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss timer' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
