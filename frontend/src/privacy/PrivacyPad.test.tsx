import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PrivacyPad } from './PrivacyPad'
import type { UnlockResult } from './types'

afterEach(() => cleanup())

const type = (pin: string) => {
  for (const digit of pin) fireEvent.click(screen.getByRole('button', { name: digit }))
}

describe('PrivacyPad', () => {
  it('submits four digits and closes on the right PIN', async () => {
    const onUnlock = vi.fn<(pin: string) => Promise<UnlockResult>>().mockResolvedValue('ok')
    const onClose = vi.fn()
    render(<PrivacyPad onUnlock={onUnlock} onClose={onClose} cooldownMs={0} />)

    type('8426')
    await waitFor(() => expect(onUnlock).toHaveBeenCalledWith('8426'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('shakes and clears on a wrong PIN, without closing', async () => {
    const onUnlock = vi.fn<(pin: string) => Promise<UnlockResult>>().mockResolvedValue('bad-pin')
    const onClose = vi.fn()
    render(<PrivacyPad onUnlock={onUnlock} onClose={onClose} cooldownMs={0} />)

    type('0000')
    await waitFor(() => expect(screen.getByText('That PIN is not right.')).toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
    // dots reset
    expect(document.querySelectorAll('.privacy-pad-dots .filled')).toHaveLength(0)
  })

  it('disables the keys during a cooldown', () => {
    render(<PrivacyPad onUnlock={vi.fn()} onClose={vi.fn()} cooldownMs={30_000} />)
    expect(screen.getByRole('button', { name: '8' })).toBeDisabled()
    expect(screen.getByText(/Locked for/)).toBeInTheDocument()
  })

  it('offers the no-PIN undo when it is still available', () => {
    const onUndo = vi.fn()
    render(<PrivacyPad onUnlock={vi.fn()} onClose={vi.fn()} onUndo={onUndo} cooldownMs={0} />)
    fireEvent.click(screen.getByRole('button', { name: /turn it back off/i }))
    expect(onUndo).toHaveBeenCalled()
  })

  it('has no text input (kiosk has no keyboard)', () => {
    render(<PrivacyPad onUnlock={vi.fn()} onClose={vi.fn()} cooldownMs={0} />)
    expect(document.querySelector('input')).toBeNull()
  })
})
