import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

describe('Mission Control dashboard', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    window.localStorage.clear()
    const today = new Date()
    const startsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16).toISOString()
    const endsAt = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 17, 15).toISOString()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ calendars: [{ id: 'jordan', name: 'Jordan', color: 'gold', enabled: true }, { id: 'home', name: 'Home', color: 'fern', enabled: true }], events: [{ id: 'swim', calendar_id: 'jordan', title: 'Swim practice', starts_at: startsAt, ends_at: endsAt, location: 'Riverside pool', all_day: false, categories: [{ id: 'sports', name: 'Sports', color: 'green' }, { id: 'school', name: 'School', color: 'blue' }] }, { id: 'dinner', calendar_id: 'home', title: 'Taco night', starts_at: startsAt, ends_at: endsAt, location: null, all_day: false, categories: [] }] }) }))
    vi.stubGlobal('WebSocket', class { addEventListener() {} close() {} })
  })

  it('moves between purpose-built Home, Week, and Month modes', async () => {
    render(<App />)
    expect(screen.getByText('Today')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[0])
    expect(await screen.findByText('Week at a glance')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    const currentMonth = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    expect(await screen.findByText(currentMonth)).toBeInTheDocument()
  })

  it('reveals event details when a household event is touched', async () => {
    render(<App />)
    const event = await screen.findByRole('button', { name: /Swim practice/ })
    fireEvent.click(event)

    expect(await screen.findByRole('dialog', { name: 'Event details' })).toBeInTheDocument()
    expect(screen.getAllByText('Riverside pool').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Sports')).toBeInTheDocument()
    expect(screen.getByText('School')).toBeInTheDocument()
  })

  it('defaults to category-first and uses the primary category surface', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('category-dominant', 'category-green'))
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('button', { name: 'Color events by category' })).toHaveClass('selected')
    expect(document.querySelector('.large-event.calendar-fern')).toBeInTheDocument()
  })

  it('persists people-first mode and falls back to calendar identity without categories', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('category-dominant'))
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    expect(window.localStorage.getItem('mission-control.semantic-color-mode')).toBe('people-first')
    expect(document.querySelector('.large-event')).toHaveClass('calendar-gold')

    cleanup()
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-gold'))
  })

  it('defaults the week to Monday and persists a Sunday choice', async () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    await waitFor(() => expect(document.querySelector('.weekday-row span')).toHaveTextContent('Mon'))
    expect(document.querySelectorAll('.weekday-row span')[6]).toHaveTextContent('Sun')

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveClass('selected')
    fireEvent.click(screen.getByRole('button', { name: 'Sunday' }))
    expect(window.localStorage.getItem('mission-control.week-start')).toBe('sunday')
    await waitFor(() => expect(document.querySelector('.weekday-row span')).toHaveTextContent('Sun'))

    cleanup()
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Month' })[0])
    await waitFor(() => expect(document.querySelector('.weekday-row span')).toHaveTextContent('Sun'))
  })

  it('overrides a calendar identity color from Settings and persists the choice', async () => {
    render(<App />)
    await waitFor(() => expect(document.querySelector('.large-event')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-gold'))

    fireEvent.click(screen.getByRole('button', { name: 'Jordan: violet' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-violet'))
    expect(JSON.parse(window.localStorage.getItem('mission-control.calendar-colors') as string)).toEqual({ jordan: 'violet' })

    cleanup()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-violet'))
  })

  it('clears a calendar override when the provider default is reselected', async () => {
    window.localStorage.setItem('mission-control.calendar-colors', JSON.stringify({ jordan: 'violet' }))
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Color events by person/calendar' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-violet'))

    fireEvent.click(screen.getByRole('button', { name: 'Jordan: gold' }))
    await waitFor(() => expect(document.querySelector('.large-event')).toHaveClass('calendar-gold'))
    expect(JSON.parse(window.localStorage.getItem('mission-control.calendar-colors') as string)).toEqual({})
  })

  it('filters a calendar behind the People control', async () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Home' })[0])
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Swim practice/ }).length).toBeGreaterThan(0))
    fireEvent.click(screen.getAllByRole('button', { name: /People/ })[0])
    fireEvent.click(document.querySelector('.filter-row') as HTMLElement)

    await waitFor(() => expect(screen.getByRole('button', { name: /People/ })).toHaveTextContent('1/2'))
  })

  it('dismisses the People popover outside, with Escape, and on mode navigation', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: /People/ })).toHaveTextContent('2/2'))
    const people = screen.getByRole('button', { name: /People/ })
    fireEvent.click(people)
    expect(document.querySelector('.filter-row')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('.filter-row')).not.toBeInTheDocument()

    fireEvent.click(people)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.filter-row')).not.toBeInTheDocument()

    fireEvent.click(people)
    fireEvent.click(screen.getAllByRole('button', { name: 'Week' })[0])
    expect(document.querySelector('.filter-row')).not.toBeInTheDocument()
  })

  it('dismisses Settings outside and with Escape', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument())
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Settings' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument())
  })
})