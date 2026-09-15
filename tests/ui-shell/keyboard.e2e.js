import { test, expect } from '@playwright/test'
import { watch, boot, createModule, uid } from './helpers.js'

test('Ctrl+K quick switcher filters case-insensitively, arrow keys select, Enter navigates, Esc closes', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const tag = uid()
  const a = await createModule(page, { type: 'database', title: `Alpha Report ${tag}` })
  const b = await createModule(page, { type: 'sheet', title: `beta REPORT ${tag}` })
  await createModule(page, { type: 'notebook', title: `Gamma ${tag}` })
  await page.reload()
  await expect(page.locator(`.sidebar-item[data-id="${a.id}"]`)).toBeVisible()

  await page.keyboard.press('Control+k')
  const input = page.locator('.switcher-input')
  await expect(input).toBeFocused()
  await page.keyboard.type(`rEpOrT ${tag}`)
  const items = page.locator('.switcher-item')
  await expect(items).toHaveCount(2)
  const ids = await items.evaluateAll((els) => els.map((e) => e.dataset.id))
  expect(new Set(ids)).toEqual(new Set([a.id, b.id]))
  await expect(items.nth(0)).toHaveClass(/is-selected/)
  await page.keyboard.press('ArrowDown')
  await expect(items.nth(1)).toHaveClass(/is-selected/)
  await expect(items.nth(0)).not.toHaveClass(/is-selected/)
  await page.keyboard.press('ArrowDown') // wraps
  await expect(items.nth(0)).toHaveClass(/is-selected/)
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(page.locator('.switcher-input')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`#/m/${ids[1]}$`))

  // partial match on a single title
  await page.keyboard.press('Control+k')
  await page.keyboard.type(`gamm`)
  await expect(page.locator('.switcher-item')).not.toHaveCount(0)
  await page.keyboard.type(`a ${tag}`)
  await expect(page.locator('.switcher-item')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.switcher-input')).toHaveCount(0)
  expect(w.errors).toEqual([])
})

test('Esc closes menus and modals; focus is trapped in modals and restored afterwards', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const m = await createModule(page, { type: 'database', title: `Focus ${uid()}` })
  await page.reload()
  const row = page.locator(`.sidebar-item[data-id="${m.id}"]`)
  const more = row.locator('.sidebar-item-more')

  // menu: keyboard open, Esc closes, focus returns to trigger
  await row.locator('.sidebar-item-link').focus()
  await page.keyboard.press('Tab')
  await expect(more).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Change icon' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(more).toBeFocused()

  // modal: open delete confirm from the menu
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(more).toBeFocused()
  await expect(row).toBeVisible() // Esc is a cancel, not a confirm

  // template picker modal closes with Esc and restores focus to New
  await page.locator('.sidebar-new').focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.sidebar-new')).toBeFocused()

  // Ctrl+\ collapses and restores the sidebar
  await page.keyboard.press('Control+\\')
  await expect(page.locator('.app')).toHaveClass(/is-sidebar-collapsed/)
  await expect(page.locator('.sidebar')).toBeHidden()
  await page.locator('.topbar-expand').click()
  await expect(page.locator('.sidebar')).toBeVisible()

  expect(w.dialogs).toEqual([])
  expect(w.errors).toEqual([])
})
