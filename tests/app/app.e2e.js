// End-to-end tests for the web UI against a real Truss server: boot under the host's strict CSP,
// persistence through /api/v2, live updates between two browsers, conflict merging, conversion of
// data held in the legacy tables, attachments and formulas.
import { test, expect } from '@playwright/test'

// The web_server's CSP (app/headers.py). Stricter than Truss's own: no inline styles at all.
const HOST_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

async function open(page, { csp = false } = {}) {
  const problems = []
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()) })
  if (csp) {
    await page.route('**/', async (route) => {
      const res = await route.fetch()
      await route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': HOST_CSP } })
    })
  }
  await page.goto('/')
  await expect(page.locator('#app')).not.toHaveClass(/app-booting/, { timeout: 15000 })
  await expect(page.locator('.load-pane')).toHaveCount(0, { timeout: 15000 })
  return problems
}

const token = (page) => page.locator('meta[name="truss-token"]').getAttribute('content')

async function api(page, method, path, body) {
  const t = await token(page)
  const res = await page.request.fetch(path, { method, headers: { 'X-Truss-Token': t, 'Content-Type': 'application/json' }, data: body })
  return { status: res.status(), body: await res.json().catch(() => null) }
}

async function workspace(page) { return (await api(page, 'GET', '/api/v2/workspace')).body }

async function waitSaved(page) {
  await expect(page.locator('.sync')).toHaveText('Saved', { timeout: 10000 })
}

async function newDatabase(page, title) {
  await page.getByRole('button', { name: /Home/ }).first().click().catch(() => {})
  await page.locator('.create-card', { hasText: 'New database' }).click()
  const t = page.locator('input.mtitle')
  await t.fill(title)
  await t.blur()
  await waitSaved(page)
  const ws = await workspace(page)
  return ws.modules.find((m) => m.module.title === title).module
}

test('boots under the host CSP with no errors and shows the sync state', async ({ page }) => {
  const problems = await open(page, { csp: true })
  await expect(page.locator('.sb')).toBeVisible()
  await expect(page.locator('.sync')).toHaveText('Saved')
  // Styles from app.css are applied (the CSP allows only same-origin sheets).
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.app')).backgroundColor)
  expect(bg).not.toBe('rgba(0, 0, 0, 0)')
  // Style attributes are applied through the CSSOM, which the CSP allows.
  await page.locator('.create-card', { hasText: 'New workbook' }).click()
  await expect(page.locator('.wb-c').first()).toHaveCSS('width', /\d+px/)
  expect(problems.filter((p) => !/favicon/.test(p))).toEqual([])
})

test('changes are saved to the server and survive a reload', async ({ page }) => {
  await open(page)
  const db = await newDatabase(page, 'Persist check')
  await page.locator('.new-btn').first().click()
  await page.locator('[data-cellinput]').fill('First row')
  await page.keyboard.press('Enter')
  await waitSaved(page)
  let ws = await workspace(page)
  let doc = ws.modules.find((m) => m.module.id === db.id)
  const tp = doc.module.props.find((p) => p.type === 'title')
  expect(doc.module.rows.some((r) => r.cells[tp.id] === 'First row')).toBe(true)
  await page.reload()
  await expect(page.locator('#app')).not.toHaveClass(/app-booting/)
  await expect(page.locator('.sb')).toContainText('Persist check')
})

async function twoBrowsers(browser) {
  const ca = await browser.newContext(), cb = await browser.newContext()
  return { a: await ca.newPage(), b: await cb.newPage(), close: () => Promise.all([ca.close(), cb.close()]) }
}

test('an edit in one browser appears in another without reloading', async ({ browser }) => {
  const { a, b, close } = await twoBrowsers(browser)
  await open(a)
  await open(b)
  await newDatabase(a, 'Shared live')
  await expect(b.locator('.sb')).toContainText('Shared live', { timeout: 10000 })
  await close()
})

test('concurrent edits to different rows are merged, not overwritten', async ({ browser }) => {
  const { a, b, close } = await twoBrowsers(browser)
  await open(a)
  const db = await newDatabase(a, 'Merge check')
  await open(b)
  // Hold B's event stream so it keeps a stale copy, then both edit.
  await b.route('**/api/v2/events**', () => {})
  await b.route('**/api/v2/changes**', () => {})
  await b.reload()
  await expect(b.locator('#app')).not.toHaveClass(/app-booting/)
  for (const [p, title] of [[a, 'From A'], [b, 'From B']]) {
    await p.locator('.sb').getByText('Merge check').click()
    await p.locator('.new-btn').first().click()
    await p.locator('[data-cellinput]').fill(title)
    await p.keyboard.press('Enter')
    await waitSaved(p)
  }
  const ws = await workspace(a)
  const doc = ws.modules.find((m) => m.module.id === db.id).module
  const tp = doc.props.find((p) => p.type === 'title')
  const titles = doc.rows.map((r) => r.cells[tp.id])
  expect(titles).toContain('From A')
  expect(titles).toContain('From B')
  await close()
})

test('data in the legacy tables is converted and shown', async ({ page }) => {
  await open(page)
  // Create a module the way the previous UI did, straight into the legacy tables.
  const created = await api(page, 'POST', '/api/modules', { type: 'notebook', title: 'Legacy notes' })
  expect(created.status).toBeLessThan(300)
  await page.reload()
  await expect(page.locator('#app')).not.toHaveClass(/app-booting/)
  await expect(page.locator('.sb')).toContainText('Legacy notes')
  const ws = await workspace(page)
  const doc = ws.modules.find((m) => m.module.title === 'Legacy notes')
  expect(doc.module.type).toBe('notebook')
  expect(doc.version).toBeGreaterThan(0)
})

test('images upload into a notebook block and display', async ({ page }) => {
  await open(page)
  await page.locator('.create-card', { hasText: 'New notebook' }).click()
  await waitSaved(page)
  await page.locator('.blk-show').first().click()
  await expect(page.locator('textarea.blk-in')).toBeFocused()
  await page.keyboard.type('/image')
  await page.locator('.slash-item', { hasText: 'Image' }).first().click()
  // A 1x1 PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.locator('.media-pick input[type=file]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png })
  const img = page.locator('.media-img img')
  await expect(img).toBeVisible({ timeout: 10000 })
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(1)
  await waitSaved(page)
})

test('workbook formulas evaluate, including the GST custom function', async ({ page }) => {
  await open(page)
  await page.locator('.create-card', { hasText: 'New workbook' }).click()
  const grid = page.locator('[data-grid]')
  await grid.focus()
  await page.keyboard.type('=GST(250)')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-cell="0,0"]')).toHaveText('25')
})

test('fast typing across cells keeps every keystroke', async ({ page }) => {
  await open(page)
  await page.locator('.create-card', { hasText: 'New workbook' }).click()
  await page.locator('[data-grid]').focus()
  // No pauses: keys land while the in-cell editor is still being created or removed.
  await page.keyboard.type('Item'); await page.keyboard.press('Tab'); await page.keyboard.type('Cost'); await page.keyboard.press('Enter')
  await page.keyboard.type('Cable'); await page.keyboard.press('Tab'); await page.keyboard.type('=GST(440)'); await page.keyboard.press('Enter')
  await expect(page.locator('[data-cell="0,0"]')).toHaveText('Item')
  await expect(page.locator('[data-cell="0,1"]')).toHaveText('Cost')
  await expect(page.locator('[data-cell="1,1"]')).toHaveText('Cable')
  await expect(page.locator('[data-cell="1,2"]')).toHaveText('44')
})
