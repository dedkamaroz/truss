import { test, expect } from '@playwright/test'
import { watch, boot, apiCall, createModule, uid, shot } from './helpers.js'

async function openRowMenu(page, id) {
  const row = page.locator(`.sidebar-item[data-id="${id}"]`)
  await row.hover()
  await row.locator('.sidebar-item-more').click()
  await expect(page.getByRole('menu')).toBeVisible()
  return row
}

test('inline rename and emoji icon persist across reload', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const m = await createModule(page, { type: 'database', title: `Manage ${uid()}` })
  await page.reload()
  const row = page.locator(`.sidebar-item[data-id="${m.id}"]`)
  await expect(row).toBeVisible()

  // Rename through the context menu
  await openRowMenu(page, m.id)
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const input = row.locator('input.sidebar-rename')
  await expect(input).toBeFocused()
  const renamed = `Renamed ${uid()}`
  await input.fill(renamed)
  await input.press('Enter')
  await expect(row.locator('.sidebar-item-title')).toHaveText(renamed)
  await expect.poll(async () => (await apiCall(page, 'GET', `/api/modules/${m.id}`)).body.title).toBe(renamed)

  // Double-click rename, Escape cancels
  await row.locator('.sidebar-item-link').dblclick()
  await row.locator('input.sidebar-rename').fill('Should not stick')
  await row.locator('input.sidebar-rename').press('Escape')
  await expect(row.locator('.sidebar-item-title')).toHaveText(renamed)

  // Emoji icon via the picker
  await openRowMenu(page, m.id)
  await page.getByRole('menuitem', { name: 'Change icon' }).click()
  await page.locator('.emoji-option[aria-label="rocket"]').click()
  await expect(row.locator('.sidebar-item-icon')).toHaveText('🚀')
  await expect.poll(async () => (await apiCall(page, 'GET', `/api/modules/${m.id}`)).body.icon).toBe('🚀')

  await page.reload()
  await expect(row.locator('.sidebar-item-title')).toHaveText(renamed)
  await expect(row.locator('.sidebar-item-icon')).toHaveText('🚀')

  // Header title and icon are editable too, and keep the sidebar in sync
  await row.locator('.sidebar-item-link').click()
  await expect(page).toHaveURL(new RegExp(`#/m/${m.id}$`))
  await expect(page.locator('.breadcrumb')).toContainText(renamed)
  const headerTitle = page.locator('.page-title')
  await expect(headerTitle).toHaveValue(renamed)
  const headerName = `Header ${uid()}`
  await headerTitle.fill(headerName)
  await headerTitle.press('Enter')
  await expect(row.locator('.sidebar-item-title')).toHaveText(headerName)
  await page.locator('.page-icon').click()
  await page.locator('.emoji-picker input').fill('kangaroo')
  await page.locator('.emoji-option').first().click()
  await expect(page.locator('.page-icon')).toHaveText('🦘')
  await page.reload()
  await expect(page.locator('.page-title')).toHaveValue(headerName)
  await expect(page.locator('.page-icon')).toHaveText('🦘')
  await expect(page.locator('.breadcrumb')).toContainText(headerName)

  expect(w.dialogs).toEqual([])
  expect(w.errors).toEqual([])
})

test('archive, restore and permanent delete use the archive view and the custom confirm modal', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const title = `Archive me ${uid()}`
  const m = await createModule(page, { type: 'notebook', title })
  await page.reload()
  const row = page.locator(`.sidebar-item[data-id="${m.id}"]`)

  await openRowMenu(page, m.id)
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(row).toHaveCount(0)
  await expect(page.locator('.toast')).toContainText('archive')

  await page.locator('.sidebar-link[data-nav="archive"]').click()
  await expect(page).toHaveURL(/#\/archive$/)
  const archived = page.locator(`.archive-row[data-id="${m.id}"]`)
  await expect(archived).toContainText(title)
  await expect(archived).toContainText(/Archived \d{2}\/\d{2}\/\d{4}/)
  await shot(page, 'archive-view')

  await archived.getByRole('button', { name: 'Restore' }).click()
  await expect(archived).toHaveCount(0)
  await expect(row).toBeVisible()
  expect((await apiCall(page, 'GET', `/api/modules/${m.id}`)).body.archived_at).toBeNull()

  // Delete: cancel keeps it
  await openRowMenu(page, m.id)
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('cannot be undone')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeVisible()

  // Delete: confirm removes it permanently
  await openRowMenu(page, m.id)
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await dialog.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(row).toHaveCount(0)
  expect((await apiCall(page, 'GET', `/api/modules/${m.id}`)).status).toBe(404)

  // Delete permanently from the archive view
  const m2 = await createModule(page, { type: 'sheet', title: `Archived sheet ${uid()}` })
  await apiCall(page, 'POST', `/api/modules/${m2.id}/archive`)
  await page.goto('/#/')
  await page.goto('/#/archive')
  const row2 = page.locator(`.archive-row[data-id="${m2.id}"]`)
  await row2.getByRole('button', { name: 'Delete permanently' }).click()
  await dialog.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(row2).toHaveCount(0)
  expect((await apiCall(page, 'GET', `/api/modules/${m2.id}`)).status).toBe(404)

  expect(w.dialogs).toEqual([])
  expect(w.errors.filter((e) => !e.includes('404'))).toEqual([])
})
