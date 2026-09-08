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

  it('starts the same device-code flow when adding a calendar from Settings', async () => {
    vi.stubGlobal('fetch', mockBackend({ provider: 'outlook_personal', state: 'connected', account: 'mia@outlook.com', accounts: ['mia@outlook.com'] } as Auth).fetchMock)
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Calendars' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add another Outlook calendar' }))

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument()
    expect(screen.getByText('Scan to finish on your phone')).toBeInTheDocument()
  })

  it('shows the newly added calendar once its sign-in completes', async () => {
    const startsAt = new Date(); startsAt.setHours(16, 0, 0, 0)
    const endsAt = new Date(startsAt); endsAt.setHours(17)
    const miaEvent = { id: 'mia-1', calendar_id: 'mia@outlook.com', title: 'Mia dentist', starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), location: null, all_day: false, categories: [] }
    const samEvent = { id: 'sam-1', calendar_id: 'sam@outlook.com', title: 'Sam soccer', starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), location: null, all_day: false, categories: [] }

    let auth: Auth = { provider: 'outlook_personal', state: 'connected', account: 'mia@outlook.com', accounts: ['mia@outlook.com'] } as Auth
    let snapshot = { calendars: [{ id: 'mia@outlook.com', name: 'mia', color: 'coral', enabled: true }], events: [miaEvent] }
    const fetchMock = vi.fn((url: string | URL, opts?: { method?: string }) => {
      const target = String(url)
      if (target.includes('/api/calendar/auth')) {
        if (opts?.method === 'POST') {
          auth = { ...auth, state: 'connecting', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', verification_qr: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E', expires_in: 880 }
          // the device flow finishes on the phone a moment later
          setTimeout(() => {
            auth = { provider: 'outlook_personal', state: 'connected', account: 'mia@outlook.com', accounts: ['mia@outlook.com', 'sam@outlook.com'] } as Auth
            snapshot = { calendars: [...snapshot.calendars, { id: 'sam@outlook.com', name: 'sam', color: 'ocean', enabled: true }], events: [miaEvent, samEvent] }
          }, 20)
        }
        return Promise.resolve({ ok: true, json: async () => auth })
      }
      return Promise.resolve({ ok: true, json: async () => snapshot })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Calendars' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add another Outlook calendar' }))
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument()

    // Once linked, the sheet closes on its own and the new account's events render.
    await waitFor(() => expect(screen.queryByText('Scan to finish on your phone')).not.toBeInTheDocument(), { timeout: 5000 })
    expect(await screen.findByRole('button', { name: /Sam soccer/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Mia dentist/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /People/ })).toHaveTextContent('2/2')
  }, 10000)

  it('keeps the add sheet open when the flow cannot start, instead of vanishing', async () => {
    // Backend can't begin a device flow (throttled / offline) and, because a
    // household is already linked, keeps reporting "connected". The old code
    // slammed the sheet shut on that; now it stays so the person can retry.
    const fetchMock = vi.fn((url: string | URL, opts?: { method?: string }) => {
      const target = String(url)
      if (target.includes('/api/calendar/auth')) {
        const connected = { provider: 'outlook_personal', state: 'connected', account: 'mia@outlook.com', accounts: ['mia@outlook.com'], error: opts?.method === 'POST' ? 'sign-in is temporarily unavailable' : null }
        return Promise.resolve({ ok: true, json: async () => connected })
      }
      return Promise.resolve({ ok: true, json: async () => EMPTY_SNAPSHOT })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Calendars' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add another Outlook calendar' }))

    expect(await screen.findByText('sign-in is temporarily unavailable')).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(screen.getByRole('dialog', { name: 'Connect calendar' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start sign-in' })).toBeInTheDocument()
  })

  it('stays quiet for the mock provider', async () => {
    vi.stubGlobal('fetch', mockBackend({ provider: 'mock', state: 'not_applicable' } as Auth).fetchMock)
    render(<App />)

    await waitFor(() => expect(screen.getByText('Today')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Calendar sign-in/ })).not.toBeInTheDocument()
  })
})
