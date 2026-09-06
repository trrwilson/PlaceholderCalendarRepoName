import { expect, test } from '@playwright/test'

const emptyCalendar = { calendars: [], events: [] }

test.beforeEach(async ({ page }) => {
  await page.route('**/api/calendar**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyCalendar) }),
  )
})

test('the Ask button is available and starts a voice turn on tap', async ({ page }) => {
  await page.route('**/api/voice/token', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ token: 'auth_tokens/x', model: 'test-model', expires_at: '2099-01-01T00:00:00' }),
    }),
  )
  await page.goto('/')
  const ask = page.getByRole('button', { name: 'Ask Mission Control' })
  await expect(ask).toBeEnabled()
  // The Live session / mic will not actually open in a headless browser, but the
  // overlay must appear as the turn is attempted.
  await ask.click()
  await expect(page.locator('.voice-overlay')).toBeVisible()
})

test('the Ask button reports when voice support is switched off', async ({ page }) => {
  await page.route('**/api/voice/token', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'voice support is disabled' }),
    }),
  )
  await page.goto('/')
  const ask = page.getByRole('button', { name: 'Ask Mission Control' })
  await ask.click()
  await expect(ask).toBeDisabled()
  await expect(ask).toHaveText(/Voice off/)
  // A transient toast announces why, with no retry for a hard "disabled" result.
  const toast = page.getByRole('alert')
  await expect(toast).toContainText('Voice is turned off')
  await expect(toast.getByRole('button', { name: 'Try again' })).toHaveCount(0)
})
