import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PhotoDetail } from './PhotoDetail'
import { cameraName, exposureLine } from './photoFacts'
import type { PhotoItem } from './types'

const base: PhotoItem = { id: 'p', name: '20180423_100048.jpg', width: 4032, height: 3024, taken_at: '2018-04-23T10:00:48', version: 'v1', bytes: 10 }

afterEach(() => cleanup())

describe('PhotoDetail', () => {
  it('shows the facts it has and leaves out the rest', () => {
    render(<PhotoDetail photo={{ ...base, caption: 'Hiking the PCT', place_detail: 'Dublin, Co Dublin, Ireland', latitude: 53.35, longitude: -6.26, camera_make: 'samsung', camera_model: 'SM-G960U', f_number: 1.7, exposure_seconds: 1 / 120, iso: 50, focal_length_mm: 4.3, tags: ['Crumb'], original_type: 'image/jpeg', original_bytes: 2_500_000 }} apiBaseUrl="" onClose={() => undefined} />)
    expect(screen.getByRole('dialog', { name: 'Photo details' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Hiking the PCT' })).toBeInTheDocument()
    expect(screen.getByText('Dublin, Co Dublin, Ireland')).toBeInTheDocument()
    expect(screen.getByText('53.3500° N, 6.2600° W')).toBeInTheDocument()
    expect(screen.getByText('Samsung SM-G960U')).toBeInTheDocument()
    expect(screen.getByText('ƒ/1.7 · 1/120 s · ISO 50 · 4.3 mm')).toBeInTheDocument()
    expect(screen.getByText('Crumb')).toBeInTheDocument()
    expect(screen.getByText('JPEG · 4,032 × 3,024 · 2.5 MB')).toBeInTheDocument()
  })

  it('titles an uncaptioned photo quietly and omits empty rows', () => {
    render(<PhotoDetail photo={{ ...base, taken_at: null, place: 'Dublin, Ireland' }} apiBaseUrl="" onClose={() => undefined} />)
    expect(screen.getByRole('heading', { name: 'Dublin, Ireland' })).toHaveClass('photo-detail-untitled')
    expect(screen.getByText('Date unknown')).toBeInTheDocument()
    expect(screen.queryByText('Camera')).toBeNull()
    expect(screen.queryByText('Tags')).toBeNull()
  })

  it('closes on Escape, the scrim, and Done', () => {
    const onClose = vi.fn()
    const { container } = render(<PhotoDetail photo={base} apiBaseUrl="" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(container.querySelector('.clip-modal-scrim')!)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('formatting', () => {
  it('drops a make the model already carries', () => {
    expect(cameraName({ ...base, camera_make: 'Apple', camera_model: 'iPhone 12' })).toBe('Apple iPhone 12')
    expect(cameraName({ ...base, camera_make: 'NIKON', camera_model: 'NIKON D7000' })).toBe('NIKON D7000')
    expect(cameraName(base)).toBeNull()
    expect(exposureLine({ ...base, exposure_seconds: 2 })).toBe('2 s')
  })
})
