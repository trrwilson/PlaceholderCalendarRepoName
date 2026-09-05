import { expect, test } from '@playwright/test'

const snapshot = {
  calendars: [
    { id: 'family', name: 'Family', color: 'coral', enabled: true },
    { id: 'jordan', name: 'Jordan', color: 'gold', enabled: true },
  ],
  events: [
    { id: 'swim', calendar_id: 'jordan', title: 'Swim practice', starts_at: '2026-09-05T16:00:00', ends_at: '2026-09-05T17:15:00', location: 'Riverside pool', all_day: false },
    { id: 'dinner', calendar_id: 'family', title: 'Taco night', starts_at: '2026-09-05T18:30:00', ends_at: '2026-09-05T20:00:00', location: null, all_day: false },
    { id: 'dentist', calendar_id: 'jordan', title: 'Dentist appointment', starts_at: '2026-09-06T10:00:00', ends_at: '2026-09-06T11:00:00', location: 'Cedar Street Dental', all_day: false },
  ],
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/calendar**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) }))
})

async function assertNoDocumentOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(() => ({ horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth, vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight }))
  expect(overflow.horizontal).toBe(0)
  expect(overflow.vertical).toBe(0)
}

test('Home is the ambient default and fits a 3840x2160 kiosk viewport', async ({ page }) => {
  await page.setViewportSize({ width: 3840, height: 2160 })
  await page.goto('/')
  await expect(page.getByText('Today')).toBeVisible()
  await expect(page.getByText('Garage door open')).toBeVisible()
  await expect(page.getByRole('button', { name: /Swim practice/ }).first()).toBeVisible()
  await assertNoDocumentOverflow(page)
})

test('Week, Month, event detail, and filters work at 1920x1080', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Week' }).first().click()
  await expect(page.getByText('Week at a glance')).toBeVisible()
  await assertNoDocumentOverflow(page)

  await page.getByRole('button', { name: /Swim practice/ }).click()
  await expect(page.getByRole('dialog', { name: 'Event details' })).toBeVisible()
  await page.getByRole('button', { name: 'Close event details' }).click()
  await page.getByRole('button', { name: 'Month' }).first().click()
  await expect(page.getByText('Planning view')).toBeVisible()
  await assertNoDocumentOverflow(page)

  await page.getByRole('button', { name: /People/ }).click()
  await page.locator('.filter-row').filter({ hasText: 'Jordan' }).click()
  await expect(page.getByRole('button', { name: /Swim practice/ })).not.toBeVisible()
})