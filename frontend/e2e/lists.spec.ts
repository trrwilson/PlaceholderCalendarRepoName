import { expect, test } from '@playwright/test'

const emptyCalendar = { calendars: [], events: [] }

const makeItem = (id: string, name: string, checked = false) => ({
  id,
  name,
  note: null,
  checked,
  added_at: new Date().toISOString(),
  checked_at: checked ? new Date().toISOString() : null,
  source: 'touch',
})

test.beforeEach(async ({ page }) => {
  await page.route('**/api/calendar**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(emptyCalendar) }),
  )
})

test('the grocery list fits the kiosk viewport and takes a quick-add and a check-off', async ({
  page,
}) => {
  let list = {
    id: 'grocery',
    title: 'Grocery',
    updated_at: new Date().toISOString(),
    recent_names: ['Paper towels', 'Onions'],
    items: [makeItem('i1', 'Milk'), makeItem('i2', 'Sourdough')],
  }

  await page.route('**/api/lists/grocery', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(list) }),
  )
  await page.route('**/api/lists/grocery/items', (route) => {
    const body = route.request().postDataJSON() as { name?: string; names?: string[] }
    const names = body.names ?? (body.name ? [body.name] : [])
    list = { ...list, items: [...names.map((n, i) => makeItem(`new${i}`, n)), ...list.items] }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ list, added: names, already_present: [] }),
    })
  })
  await page.route('**/api/lists/grocery/items/*', (route) => {
    list = {
      ...list,
      items: list.items.map((item) =>
        route.request().url().includes(item.id) ? { ...item, checked: true } : item,
      ),
    }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ list, removed: [], added: [], already_present: [] }),
    })
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

  await page.getByRole('button', { name: /^Lists/ }).click()
  await expect(page.getByRole('button', { name: 'Check off Milk' })).toBeVisible()
  await expect(page.getByText('2 to get')).toBeVisible()
  for (const size of [
    { width: 3840, height: 2160 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size)
    await assertNoOverflow()
  }

  // Quick-add a recent item.
  await page.getByRole('button', { name: 'Onions' }).click()
  await expect(page.getByRole('button', { name: 'Check off Onions' })).toBeVisible()

  // Check an item off — it moves to the "Got it" strip.
  await page.getByRole('button', { name: 'Check off Milk' }).click()
  await expect(page.getByRole('button', { name: 'Put Milk back on the list' })).toBeVisible()
  await assertNoOverflow()
})

test('drag a grip to reorder the list, and the new order sticks', async ({ page }) => {
  let list = {
    id: 'grocery',
    title: 'Grocery',
    updated_at: new Date().toISOString(),
    recent_names: [],
    items: [makeItem('a', 'Apples'), makeItem('b', 'Bread'), makeItem('c', 'Carrots')],
  }
  await page.route('**/api/lists/grocery', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(list) }),
  )
  await page.route('**/api/lists/grocery/reorder', (route) => {
    const ids = (route.request().postDataJSON() as { item_ids: string[] }).item_ids
    const byId = new Map(list.items.map((i) => [i.id, i]))
    const named = ids.map((id) => byId.get(id)).filter(Boolean) as typeof list.items
    const rest = list.items.filter((i) => !ids.includes(i.id))
    list = { ...list, items: [...named, ...rest] }
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ list, removed: [], added: [], already_present: [] }),
    })
  })

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await page.getByRole('button', { name: /^Lists/ }).click()

  const rowNames = () =>
    page.$$eval('.lists-row .lists-row-name', (els) => els.map((e) => e.textContent?.trim()))
  expect(await rowNames()).toEqual(['Apples', 'Bread', 'Carrots'])

  // Drag Carrots' grip up above Apples.
  const grip = page.getByRole('button', { name: 'Reorder Carrots' })
  const anchor = page.getByRole('button', { name: 'Check off Apples' })
  const g = (await grip.boundingBox())!
  const a = (await anchor.boundingBox())!
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2, a.y + 4, { steps: 10 })
  await page.mouse.up()

  await expect.poll(rowNames).toEqual(['Carrots', 'Apples', 'Bread'])
  // Re-render from the server (simulated reload) keeps the custom order.
  await page.reload()
  await page.getByRole('button', { name: /^Lists/ }).click()
  expect(await rowNames()).toEqual(['Carrots', 'Apples', 'Bread'])
})
