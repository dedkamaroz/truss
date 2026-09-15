import { test, expect } from '@playwright/test'
import { watch, boot, load } from './helpers.js'

async function pick(page, key) {
  await page.locator('.sidebar-new').click()
  const dialog = page.getByRole('dialog')
  await dialog.locator(`.template-card[data-type="database"][data-key="${key}"]`).click()
  await expect(dialog).toHaveCount(0)
  await expect(page).toHaveURL(/#\/m\/[0-9a-f-]{36}$/)
  await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1)
  return page.url().split('#/m/')[1]
}

test('database templates are offered in the shell template picker and create correctly', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  await page.locator('.sidebar-new').click()
  const cards = page.getByRole('dialog').locator('.template-card[data-type="database"]')
  await expect(cards).toHaveCount(3)
  await expect(page.getByRole('dialog').locator('.template-card[data-key="task_tracker"] .template-card-name')).toHaveText('Task tracker')
  await expect(page.getByRole('dialog').locator('.template-card[data-key="contacts"] .template-card-name')).toHaveText('Contacts')
  await page.keyboard.press('Escape')

  // task tracker
  const taskId = await pick(page, 'task_tracker')
  await expect(page.locator('.db-th .db-th-name')).toHaveText(['Name', 'Status', 'Assignee', 'Due', 'Priority'])
  await expect(page.locator('.db-tab .db-tab-name')).toHaveText(['Table', 'Board'])
  await expect(page.locator('.db-tr')).toHaveCount(5)
  await expect(page.locator('.db-tr').first().locator('.db-status')).toBeVisible()
  const task = await load(page, taskId)
  const by = Object.fromEntries(task.properties.map((p) => [p.name, p]))
  expect(task.properties.map((p) => [p.name, p.type])).toEqual([['Name', 'title'], ['Status', 'status'], ['Assignee', 'text'], ['Due', 'date'], ['Priority', 'select']])
  expect(by.Status.config.options.map((o) => o.name)).toEqual(['Not started', 'In progress', 'Done'])
  expect(task.views.map((v) => v.type)).toEqual(['table', 'board'])
  expect(task.views[1].config.group_by).toBe(by.Status.id)
  await page.locator('.db-tab[data-type="board"]').click()
  await expect(page.locator('.db-board-col-head .db-status')).toHaveText(['Not started', 'In progress', 'Done'])

  // contacts
  const contactsId = await pick(page, 'contacts')
  const contacts = await load(page, contactsId)
  expect(contacts.properties.map((p) => p.type)).toEqual(['title', 'text', 'email', 'phone', 'multi_select', 'url', 'files'])
  await expect(page.locator('.db-tr')).toHaveCount(3)
  await expect(page.locator('.db-tr a.db-link[href^="mailto:"]').first()).toHaveText('casey@example.com')

  // blank
  const blankId = await pick(page, 'blank')
  const blank = await load(page, blankId)
  expect(blank.properties.map((p) => [p.name, p.type])).toEqual([['Name', 'title']])
  expect(blank.rows).toEqual([])
  await expect(page.locator('.db-th')).toHaveCount(1)
  await expect(page.locator('.db-tr')).toHaveCount(0)
  await expect(page.locator('.db-add-row')).toBeVisible()
  expect(w.errors).toEqual([])
})
