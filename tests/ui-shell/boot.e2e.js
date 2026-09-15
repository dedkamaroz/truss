import { test, expect } from '@playwright/test'
import { watch, boot, apiCall, shot, createModule, uid } from './helpers.js'

test('boots with no module files: no console errors or CSP violations, creates each type via the template picker', async ({ page }) => {
  const w = await watch(page)
  await boot(page)

  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.home-title')).toBeVisible()
  const newBtn = page.locator('.sidebar-new')
  await expect(newBtn).toBeVisible()
  await expect(newBtn).toHaveText('New')

  const templates = (await apiCall(page, 'GET', '/api/templates')).body
  expect(templates.length).toBeGreaterThanOrEqual(3)

  const created = []
  for (const type of ['database', 'sheet', 'notebook']) {
    await newBtn.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // one card per template served by /api/templates
    await expect(dialog.locator('.template-card')).toHaveCount(templates.length)
    if (type === 'database') await shot(page, 'boot-template-picker')
    await dialog.locator(`.template-card[data-type="${type}"][data-key="blank"]`).click()
    await expect(dialog).toHaveCount(0)

    await expect(page).toHaveURL(/#\/m\/[0-9a-f-]{36}$/)
    const id = page.url().split('#/m/')[1]
    const row = page.locator(`.sidebar-group[data-type="${type}"] .sidebar-item[data-id="${id}"]`)
    await expect(row).toBeVisible()
    await expect(row).toHaveClass(/is-active/)
    // every type now has a real module, so it mounts instead of the placeholder
    await expect(page.locator(`.module-body[data-type="${type}"]`)).toBeVisible()
    await expect(page.locator('.module-placeholder')).toHaveCount(0)

    const saved = await apiCall(page, 'GET', `/api/modules/${id}`)
    expect(saved.body.type).toBe(type)
    created.push(saved.body.title)
  }
  // the picker names new modules uniquely ("Untitled", "Untitled 2", ...)
  expect(new Set(created).size).toBe(created.length)
  expect(created.every((t) => /^Untitled( \d+)?$/.test(t))).toBe(true)

  // grouped by type: each group only holds its own type
  for (const type of ['database', 'sheet', 'notebook']) {
    const types = await page.locator(`.sidebar-group[data-type="${type}"] .sidebar-item`).evaluateAll((els) => els.map((e) => e.dataset.type))
    expect(types.length).toBeGreaterThan(0)
    expect(new Set(types)).toEqual(new Set([type]))
  }

  await shot(page, 'boot-module-placeholder')
  expect(w.errors).toEqual([])
  expect(await page.evaluate(() => window.__csp)).toEqual([])
  expect(w.dialogs).toEqual([])
})

test('unknown routes and missing modules render friendly states', async ({ page }) => {
  const w = await watch(page)
  await boot(page, '#/nope/here')
  await expect(page.locator('.empty-state-title')).toHaveText('Page not found')
  await page.goto('/#/m/00000000-0000-0000-0000-000000000000')
  await expect(page.locator('.empty-state-title')).toHaveText('Module not found')
  // the deliberate 404 lookup is the only console error allowed
  expect(w.errors.filter((e) => !e.includes('404'))).toEqual([])
})

test('renaming a module to a title that is already taken shows the unique title the server saved', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const name = `Budget ${uid()}`
  await createModule(page, { type: 'sheet', title: name })
  const other = await createModule(page, { type: 'notebook', title: `Notes ${uid()}` })
  await page.goto(`/#/m/${other.id}`)
  await page.reload() // API-created modules reach the sidebar on reload
  const header = page.locator('.page-title')
  await expect(header).toHaveValue(other.title)
  // pause while typing so the debounced live save lands while the header still has focus, then leave the field
  const patched = page.waitForResponse((r) => r.url().endsWith(`/api/modules/${other.id}`) && r.request().method() === 'PATCH')
  await header.fill(name)
  await patched
  await header.press('Enter')
  await expect(header).toHaveValue(`${name} 2`)
  await expect(page.locator(`.sidebar-item[data-id="${other.id}"] .sidebar-item-title`)).toHaveText(`${name} 2`)
  expect((await apiCall(page, 'GET', `/api/modules/${other.id}`)).body.title).toBe(`${name} 2`)
  expect(w.errors).toEqual([])
})
