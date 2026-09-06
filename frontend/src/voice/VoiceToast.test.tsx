import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VoiceToast } from './VoiceToast'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('VoiceToast', () => {
  it('shows the failure kind, the detail, and a retry for recoverable failures', () => {
    const onRetry = vi.fn()
    render(<VoiceToast error={{ kind: 'network', message: 'Could not reach the voice service.' }} onRetry={onRetry} onDismiss={vi.fn()} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Can’t reach the voice service')
    expect(screen.getByText('Could not reach the voice service.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('omits retry when voice is switched off at the backend', () => {
    render(<VoiceToast error={{ kind: 'disabled', message: 'off' }} onRetry={vi.fn()} onDismiss={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('auto-dismisses after its timeout', () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<VoiceToast error={{ kind: 'session', message: 'dropped' }} onRetry={vi.fn()} onDismiss={onDismiss} />)
    expect(onDismiss).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
