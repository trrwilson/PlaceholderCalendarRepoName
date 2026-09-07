import { expect, test } from '@playwright/test'

const emptyCalendar = { calendars: [], events: [] }

test.beforeEach(async ({ page }) => {
  await page.route('**/api/calendar**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyCalendar) }),
  )
})

test('start a timer from the tab, reach the alarm state, and dismiss it', async ({ page }) => {
  let timers: unknown[] = []
  await page.route('**/api/timers', async (route) => {
    if (route.request().method() === 'POST') {
      const now = Date.now()
      // Fire almost immediately so the test exercises the alarm path quickly;
      // the client counts down from `fires_at` regardless of the nominal duration.
      const timer = {
        id: 't1',
        label: (route.request().postDataJSON() as { label: string | null }).label,
        created_at: new Date(now).toISOString(),
        fires_at: new Date(now + 3_000).toISOString(),
        duration_seconds: 5,
        state: 'running',
      }
      timers = [timer]
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ timer, replaced: null }) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(timers) })
  })
  await page.route('**/api/timers/*', (route) => {
    timers = []
    return route.fulfill({ status: 204, body: '' })
  })

  const assertNoOverflow = async () => {
    const overflow = await page.evaluate(() => ({
      horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }))
    expect(overflow.horizontal).toBe(0)
    expect(overflow.vertical).toBe(0)
  }

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')

  await page.getByRole('button', { name: /^Timer/ }).click()
  await expect(page.locator('.timer-setup')).toBeVisible()
  await assertNoOverflow()

  await page.getByRole('button', { name: '1 min' }).click()
  await page.getByRole('button', { name: 'Start timer' }).click()

  await expect(page.locator('.timer-running')).toBeVisible()
  for (const size of [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    await assertNoOverflow()
  }

  await expect(page.getByText('Timer finished')).toBeVisible({ timeout: 10_000 })
  for (const size of [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    await assertNoOverflow()
  }

  await page.getByRole('button', { name: 'Dismiss timer' }).click()
  await expect(page.getByRole('button', { name: 'Start timer' })).toBeVisible()
  await assertNoOverflow()
})
