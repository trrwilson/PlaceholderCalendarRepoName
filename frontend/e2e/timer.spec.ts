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

test('pause holds the countdown and resume continues it', async ({ page }) => {
  let timers: Record<string, unknown>[] = []
  const nowIso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

  await page.route('**/api/timers', async (route) => {
    if (route.request().method() === 'POST') {
      const timer = {
        id: 't1',
        label: null,
        created_at: nowIso(0),
        fires_at: nowIso(600_000),
        duration_seconds: 600,
        state: 'running',
        remaining_seconds: null,
      }
      timers = [timer]
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ timer, replaced: null }) })
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(timers) })
  })
  await page.route('**/api/timers/*/pause', (route) => {
    timers = [{ ...timers[0], state: 'paused', remaining_seconds: 480 }]
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(timers[0]) })
  })
  await page.route('**/api/timers/*/resume', (route) => {
    timers = [{ ...timers[0], state: 'running', remaining_seconds: null, fires_at: nowIso(480_000) }]
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(timers[0]) })
  })

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await page.getByRole('button', { name: /^Timer/ }).click()
  await page.getByRole('button', { name: '5 min', exact: true }).click()
  await page.getByRole('button', { name: 'Start timer' }).click()

  await expect(page.locator('.timer-running')).toBeVisible()
  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.locator('.timer-paused')).toBeVisible()
  await expect(page.getByText('Paused')).toBeVisible()

  await page.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()
})
