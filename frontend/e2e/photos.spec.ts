import { expect, test } from '@playwright/test'

// Photo stream tile (docs/photo-stream-plan.md): with To Do on it owns the top-row
// slot beside the To Do tile; otherwise it fills the Home rail's lower slot when
// there is no camera gallery or sign-in alert. It steps on swipe/tap, and never
// introduces document-level scrolling at either kiosk resolution.

const PNG = (rgb: string) =>
  Buffer.from(
    // 1x1 PNGs in two colours — enough to see the layer swap.
    rgb === 'red'
      ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
      : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==',
    'base64',
  )

const photos = {
  enabled: true,
  status: 'ok',
  last_sync: null,
  detail: null,
  photos: [
    { id: 'one', name: 'Beach.jpg', width: 4000, height: 3000, taken_at: null, version: 'v1', bytes: 1 },
    { id: 'two', name: 'Garden.jpg', width: 3000, height: 4000, taken_at: null, version: 'v1', bytes: 1 },
  ],
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/calendar**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ calendars: [], events: [] }) }))
  await page.route('**/api/photos', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(photos) }))
  await page.route('**/api/photos/one?**', (route) => route.fulfill({ contentType: 'image/png', body: PNG('red') }))
  await page.route('**/api/photos/two?**', (route) => route.fulfill({ contentType: 'image/png', body: PNG('blue') }))
})

for (const size of [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }]) {
  test(`photo tile fits Home at ${size.width}x${size.height} and steps on tap`, async ({ page }) => {
    await page.setViewportSize(size)
    await page.goto('/')
    const tile = page.locator('.photo-tile')
    await expect(tile).toBeVisible()
    await expect(tile.getByRole('img', { name: 'Beach.jpg' })).toBeVisible()

    const box = (await tile.boundingBox())!
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2)
    await expect(tile.getByRole('img', { name: 'Garden.jpg' })).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)
    expect(overflow).toBe(0)
  })
}

test('with To Do on, the photo tile takes the top-row slot instead of the rail', async ({ page }) => {
  const snapshot = { status: 'ok', synced_at: new Date().toISOString(), lists: [{ id: 'l1', name: 'Tasks', owner_id: 'alex', is_shared: false, is_owner: true, is_default: true }], tasks: [] }
  await page.route('**/api/tasks', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) }))
  await page.setViewportSize({ width: 3840, height: 2160 })
  await page.goto('/')
  const tile = page.locator('.home-grid.has-todo > .photo-tile')
  await expect(tile).toBeVisible()
  await expect(page.locator('.photo-tile')).toHaveCount(1)
  await expect(page.locator('.photos-placeholder')).toHaveCount(0)
  const [tileBox, todoBox] = [(await tile.boundingBox())!, (await page.locator('.todo-summary').boundingBox())!]
  expect(tileBox.x).toBeGreaterThan(todoBox.x)
  expect(Math.abs(tileBox.y - todoBox.y)).toBeLessThan(2)
  for (const size of [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight)
    expect(overflow).toBe(0)
  }
})
