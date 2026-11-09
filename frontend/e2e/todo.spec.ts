import { expect, test } from '@playwright/test'

// To Do (docs/todo-integration-plan.md): read-only tasks in their own mode and a
// Home NOW card — never in the calendar views — with no document scroll.

const iso = (offsetDays: number) => {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const task = (id: string, title: string, due_on: string | null, extra = {}) => ({
  id,
  list_id: 'l1',
  title,
  status: 'not_started',
  importance: 'normal',
  due_on,
  completed_at: null,
  category: null,
  checklist_total: 0,
  checklist_done: 0,
  has_note: false,
  ...extra,
})

const snapshot = {
  status: 'ok',
  synced_at: new Date().toISOString(),
  lists: [{ id: 'l1', name: 'Tasks', owner_id: 'alex', is_shared: false, is_owner: true, is_default: true }],
  tasks: [
    task('a', 'Renew car registration', iso(-1), { importance: 'high' }),
    task('b', 'Call the dentist', iso(0)),
    task('c', 'Book summer camp', null),
    task('d', 'Get arborist quote', iso(3)),
  ],
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/calendar**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        calendars: [{ id: 'alex', name: 'Alex', color: 'ocean', enabled: true }],
        events: [],
      }),
    }),
  )
  await page.route('**/api/tasks', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(snapshot) }),
  )
})

const assertNoOverflow = async (page: import('@playwright/test').Page) => {
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))
  expect(overflow.horizontal).toBe(0)
  expect(overflow.vertical).toBe(0)
}

test('Home shows only overdue and due-today tasks, and To Do mode groups the rest', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')

  const summary = page.locator('.todo-summary')
  await expect(summary.getByText('Renew car registration')).toBeVisible()
  await expect(summary.getByText('Call the dentist')).toBeVisible()
  await expect(summary.getByText('Book summer camp')).toHaveCount(0)
  for (const size of [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    await assertNoOverflow(page)
  }

  await page.getByRole('button', { name: /^To Do/ }).click()
  await expect(page.getByRole('heading', { name: /Overdue/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /No date/ })).toBeVisible()
  await expect(page.getByText('Get arborist quote')).toBeVisible()
  for (const size of [{ width: 3840, height: 2160 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    await assertNoOverflow(page)
  }

  // Tasks never appear in the calendar views.
  await page.getByRole('button', { name: 'Week', exact: true }).click()
  await expect(page.getByText('Call the dentist')).toHaveCount(0)
})

test('the To Do mode is absent when the feature is disabled', async ({ page }) => {
  await page.route('**/api/tasks', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'disabled', lists: [], tasks: [], synced_at: null }),
    }),
  )
  await page.goto('/')
  await expect(page.getByRole('button', { name: /^Lists/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^To Do/ })).toHaveCount(0)
  await expect(page.locator('.todo-summary')).toHaveCount(0)
})
