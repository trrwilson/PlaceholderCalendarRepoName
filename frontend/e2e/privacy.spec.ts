import { expect, test } from '@playwright/test'

const today = new Date()
const at = (h: number) =>
  new Date(today.getFullYear(), today.getMonth(), today.getDate(), h).toISOString()

const calendar = {
  calendars: [{ id: 'travis', name: 'Travis', color: 'coral', enabled: true }],
  events: [
    {
      id: 'e1',
      calendar_id: 'travis',
      title: 'Therapy appointment',
      starts_at: at(9),
      ends_at: at(10),
      location: 'Downtown clinic',
      all_day: false,
      categories: [],
    },
  ],
}

test('privacy mode redacts the specifics, keeps the shape, and unlocks with the PIN', async ({
  page,
}) => {
  let locked = false

  await page.route('**/api/calendar**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(calendar) }),
  )
  await page.route('**/api/privacy', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ locked, since: locked ? 't' : null, available: true }),
    }),
  )
  await page.route('**/api/privacy/lock', (route) => {
    locked = true
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ locked: true, since: 't', available: true }),
    })
  })
  await page.route('**/api/privacy/unlock', (route) => {
    const body = route.request().postDataJSON() as { pin: string }
    if (body.pin === '8426') {
      locked = false
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ locked: false, since: null, available: true }),
      })
    }
    return route.fulfill({ status: 401, contentType: 'application/json', body: '{"detail":"nope"}' })
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
  await expect(page.getByText('Therapy appointment')).toBeVisible()

  // Press and hold the logo to enter privacy mode.
  const brand = page.getByRole('button', { name: 'Go to Home' })
  await brand.dispatchEvent('pointerdown', { isPrimary: true })
  await page.waitForTimeout(750)
  await brand.dispatchEvent('pointerup')

  // The event is still on screen (when / whose), the title is not.
  await expect(page.locator('.kiosk-shell.is-private')).toBeVisible()
  await expect(page.getByText('Therapy appointment')).toBeHidden()
  await expect(page.getByText('Downtown clinic')).toBeHidden()
  await expect(page.locator('.large-event')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add an event' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeHidden()

  for (const size of [
    { width: 3840, height: 2160 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size)
    await assertNoOverflow()
  }

  // The padlock opens the keypad; the wrong PIN is refused, the right one restores the view.
  await page.getByRole('button', { name: 'Turn off privacy mode' }).click()
  const pad = page.getByRole('dialog', { name: 'Turn off privacy mode' })
  await expect(pad).toBeVisible()
  for (const digit of '0000') await pad.getByRole('button', { name: digit }).click()
  await expect(pad.getByText('That PIN is not right.')).toBeVisible()
  for (const digit of '8426') await pad.getByRole('button', { name: digit }).click()

  await expect(page.locator('.kiosk-shell.is-private')).toBeHidden()
  await expect(page.getByText('Therapy appointment')).toBeVisible()
})
