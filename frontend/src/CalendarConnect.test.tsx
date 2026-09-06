import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

type Auth = Record<string, unknown> & { state: string }

const EMPTY_SNAPSHOT = { calendars: [], events: [] }

function mockBackend(initial: Auth) {
  let auth: Auth = initial
  const fetchMock = vi.fn((url: string | URL, opts?: { method?: string }) => {
    const target = String(url)
    if (target.includes('/api/calendar/auth')) {
      if (opts?.method === 'POST') {
        auth = {
          ...auth,
          state: 'connecting',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          verification_qr: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E',
          expires_in: 880,
        }
      } else if (opts?.method === 'DELETE') {
        auth = { provider: 'outlook_personal', state: 'disconnected' } as Auth
      }
      return Promise.resolve({ ok: true, json: async () => auth })
    }
    return Promise.resolve({ ok: true, json: async () => EMPTY_SNAPSHOT })
  })
  return { fetchMock, current: () => auth }
}

describe('calendar sign-in', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('WebSocket', class { addEventListener() {} close() {} })
  })

  it('shows a connect prompt and walks through the device code', async () => {
    vi.stubGlobal('fetch', mockBackend({ provider: 'outlook_personal', state: 'disconnected' } as Auth).fetchMock)
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /Calendar sign-in/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start sign-in' }))

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /QR code/ })).toBeInTheDocument()
    expect(screen.getByText(/microsoft\.com\/devicelogin/)).toBeInTheDocument()
  })

  it('stays quiet when the calendar is connected', async () => {
    vi.stubGlobal('fetch', mockBackend({ provider: 'outlook_personal', state: 'connected', account: 'mia@outlook.com' } as Auth).fetchMock)
    render(<App />)

    await waitFor(() => expect(screen.getByText('Today')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Calendar sign-in/ })).not.toBeInTheDocument()
  })

  it('stays quiet for the mock provider', async () => {
    vi.stubGlobal('fetch', mockBackend({ provider: 'mock', state: 'not_applicable' } as Auth).fetchMock)
    render(<App />)

    await waitFor(() => expect(screen.getByText('Today')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Calendar sign-in/ })).not.toBeInTheDocument()
  })
})
