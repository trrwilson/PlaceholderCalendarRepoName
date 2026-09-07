import { expect, test } from '@playwright/test'

// Event dates are anchored to "today" so the suite does not rot once the wall
// clock passes a hardcoded date.
const at = (dayOffset: number, hour: number, minute = 0) => {
  const base = new Date()
  base.setHours(0, 0, 0, 0)
  base.setDate(base.getDate() + dayOffset)
  base.setHours(hour, minute)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}:00`
}

const snapshot = {
  calendars: [
    { id: 'family', name: 'Family', color: 'coral', enabled: true },
    { id: 'jordan', name: 'Jordan', color: 'gold', enabled: true },
  ],
  events: [
    { id: 'swim', calendar_id: 'jordan', title: 'Swim practice', starts_at: at(0, 16), ends_at: at(0, 17, 15), location: 'Riverside pool', all_day: false },
    { id: 'dinner', calendar_id: 'family', title: 'Taco night', starts_at: at(0, 18, 30), ends_at: at(0, 20), location: null, all_day: false },
    { id: 'dentist', calendar_id: 'jordan', title: 'Dentist appointment', starts_at: at(1, 10), ends_at: at(1, 11), location: 'Cedar Street Dental', all_day: false },
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
  await expect(page.locator('.week-view .week-grid')).toBeVisible()
  await assertNoDocumentOverflow(page)

  await page.getByRole('button', { name: /Swim practice/ }).click()
  await expect(page.getByRole('dialog', { name: 'Event details' })).toBeVisible()
  await page.getByRole('button', { name: 'Close event details' }).click()
  await page.getByRole('button', { name: 'Month' }).first().click()
  await expect(page.locator('.month-grid')).toBeVisible()
  await expect(page.locator('.header-period')).toBeVisible()
  await assertNoDocumentOverflow(page)

  await page.getByRole('button', { name: /People/ }).click()
  await page.locator('.filter-row').filter({ hasText: 'Jordan' }).click()
  await expect(page.getByRole('button', { name: /Swim practice/ })).not.toBeVisible()
})