// End-to-end tests for the web UI against a real Truss server: boot under the host's strict CSP,
// persistence through /api/v2, live updates between two browsers, conflict merging, conversion of
// data held in the legacy tables, attachments and formulas.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

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

// ---------- database table: alignment, ranges, column moves, file previews ----------

async function tableWith(page, title, textCols, rows) {
  await open(page)
  await newDatabase(page, title)
  for (let i = 0; i < textCols; i++) {
    await page.getByRole('button', { name: 'Add a property' }).click()
    await page.getByRole('menuitem', { name: 'Text', exact: true }).click()
    await page.keyboard.press('Escape')
  }
  for (const r of rows) {
    await page.locator('.new-btn').first().click()
    await page.locator('[data-cellinput]').fill(r[0])
    for (const v of r.slice(1)) { await page.keyboard.press('Tab'); await page.keyboard.type(v) }
    await page.keyboard.press('Enter')
  }
  await waitSaved(page)
}
const tableText = (page) => page.evaluate(() => [...document.querySelectorAll('.dbt-row')].map((r) => [...r.querySelectorAll('.cell')].map((c) => (c.querySelector('.cell-text') || c).textContent.trim()).join('|')))

test('table cells line up with their headers', async ({ page }) => {
  await tableWith(page, 'Aligned', 6, [['1', '2', '3', '4', '5', '6', '7']])
  const w = await page.evaluate(() => ({
    th: [...document.querySelectorAll('.dbt-th')].map((e) => [Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().width)]),
    td: [...document.querySelector('.dbt-row').querySelectorAll('.cell')].map((e) => [Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().width)]),
  }))
  expect(w.td).toEqual(w.th)
})

test('drag-select, copy, paste, delete and undo a range of cells', async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await ctx.newPage()
  await tableWith(page, 'Ranges', 2, [['r1', 'a1', 'b1'], ['r2', 'a2', 'b2'], ['r3', 'a3', 'b3']])
  const cell = (r, c) => page.locator('.dbt-row').nth(r).locator('.cell').nth(c)
  const a = await cell(0, 1).boundingBox(), z = await cell(1, 2).boundingBox()
  await page.mouse.move(a.x + 20, a.y + 10); await page.mouse.down()
  await page.mouse.move(z.x + 20, z.y + 10, { steps: 6 }); await page.mouse.up()
  await expect(page.locator('.cell.csel')).toHaveCount(4)
  await expect(page.locator('[data-dbt]')).toBeFocused()
  await page.keyboard.press('Control+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('a1\tb1\r\na2\tb2')
  // Paste at row 3, column 2: fills it and adds a fourth row for the overflow.
  await cell(2, 1).click(); await page.keyboard.press('Escape')
  await page.keyboard.press('Control+v')
  await expect.poll(() => tableText(page)).toEqual(['r1|a1|b1', 'r2|a2|b2', 'r3|a1|b1', '|a2|b2'])
  await page.keyboard.press('Delete')
  await expect.poll(() => tableText(page)).toEqual(['r1|a1|b1', 'r2|a2|b2', 'r3||', '||'])
  await page.locator('.toast', { hasText: 'Cleared' }).getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => tableText(page)).toEqual(['r1|a1|b1', 'r2|a2|b2', 'r3|a1|b1', '|a2|b2'])
  await waitSaved(page)
  await ctx.close()
})

test('dragging a header moves the column; Shift+click selects columns to move together', async ({ page }) => {
  await tableWith(page, 'Columns', 2, [['r1', 'a1', 'b1']])
  const headers = () => page.locator('.dbt-th').allInnerTexts()
  const drag = async (from, to, side) => {
    const f = await page.locator('.dbt-th').nth(from).boundingBox(), t = await page.locator('.dbt-th').nth(to).boundingBox()
    await page.mouse.move(f.x + 30, f.y + 12); await page.mouse.down()
    await page.mouse.move(f.x + 60, f.y + 12, { steps: 3 })
    await page.mouse.move(side === 'before' ? t.x + 8 : t.x + t.width - 8, t.y + 12, { steps: 6 }); await page.mouse.up()
  }
  await drag(2, 0, 'before')
  await expect.poll(headers).toEqual(['Text 2', 'Name', 'Text'])
  await expect(page.locator('.pop')).toHaveCount(0)
  // Select Name and Text, then move both after Text 2... they already follow it, so move them before it.
  await page.locator('.dbt-th').nth(1).click({ modifiers: ['Shift'] })
  await page.locator('.dbt-th').nth(2).click({ modifiers: ['Shift'] })
  await expect(page.locator('.dbt-th.hl')).toHaveCount(2)
  await drag(1, 0, 'before')
  await expect.poll(headers).toEqual(['Name', 'Text', 'Text 2'])
  await expect.poll(() => tableText(page)).toEqual(['r1|a1|b1'])
})

test('image and PDF files show thumbnails and open in the viewer with pages and zoom', async ({ page }) => {
  const problems = await open(page, { csp: true })
  await newDatabase(page, 'Previews')
  await page.getByRole('button', { name: 'Add a property' }).click()
  await page.getByRole('menuitem', { name: 'Files' }).click()
  await page.keyboard.press('Escape')
  await page.locator('.new-btn').first().click()
  await page.locator('[data-cellinput]').fill('Applicant')
  await page.keyboard.press('Enter')
  await page.locator('.dbt-row .cell').nth(1).click()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  await page.locator('.pop input[type=file]').setInputFiles([{ name: 'three-pages.pdf', mimeType: 'application/pdf', buffer: fs.readFileSync(path.join(FIXTURES, 'three-pages.pdf')) }, { name: 'photo.png', mimeType: 'image/png', buffer: png }])
  await expect(page.locator('.pop .opt-row')).toHaveCount(2, { timeout: 10000 })
  await page.keyboard.press('Escape')
  // Both previews render: the image directly, the PDF's first page through PDF.js.
  await expect(page.locator('.dbt-row .thumb img')).toHaveCount(2, { timeout: 15000 })
  await expect(page.locator('.dbt-row .thumb.pdf img')).toHaveAttribute('src', /^data:image\/jpeg/)
  await page.locator('.dbt-row .thumb.pdf').click()
  const head = page.locator('.vw-head')
  await expect(head).toContainText('three-pages.pdf')
  await expect(head).toContainText('Page 1 of 3', { timeout: 15000 })
  await expect(page.locator('.vw-img')).toHaveAttribute('src', /^data:image\/png/, { timeout: 15000 })
  // Portrait page: a 9:16 frame.
  const f = await page.locator('.vw-frame').boundingBox()
  expect(Math.abs(f.width / f.height - 9 / 16)).toBeLessThan(0.02)
  await page.keyboard.press('PageDown')
  await expect(head).toContainText('Page 2 of 3')
  const w1 = await page.locator('.vw-img').evaluate((el) => el.offsetWidth)
  await page.keyboard.press('+')
  await expect(head).toContainText('125%')
  await expect.poll(() => page.locator('.vw-img').evaluate((el) => el.offsetWidth)).toBeGreaterThan(w1)
  await page.keyboard.press('0')
  await page.keyboard.press('ArrowRight')
  await expect(head).toContainText('photo.png')
  await expect(head).toContainText('File 2 of 2')
  await page.keyboard.press('Escape')
  await expect(page.locator('.vw-back')).toHaveCount(0)
  expect(problems.filter((p) => !/favicon/.test(p))).toEqual([])
  // The thumbnails were stored on the server: a fresh load shows them without fetching either original.
  await waitSaved(page)
  const originals = []
  page.on('request', (r) => { if (/\/api\/attachments\/[^/]+\/content/.test(r.url())) originals.push(r.url()) })
  await page.reload()
  await expect(page.locator('#app')).not.toHaveClass(/app-booting/)
  await page.locator('.sb').getByText('Previews').click()
  await expect(page.locator('.dbt-row .thumb img')).toHaveCount(2, { timeout: 15000 })
  for (const img of await page.locator('.dbt-row .thumb img').all()) await expect(img).toHaveAttribute('src', /\/api\/attachments\/[^/]+\/thumb\?/)
  await expect.poll(() => page.locator('.dbt-row .thumb img').first().evaluate((el) => el.naturalWidth)).toBeGreaterThan(0)
  expect(originals).toEqual([])
})

test('Excel-style entry: type, Tab to the next cell (wrapping rows), Enter, and arrows after typing', async ({ page }) => {
  await tableWith(page, 'Tabbing', 2, [['r1'], ['r2']])
  const cell = (r, c) => page.locator('.dbt-row').nth(r).locator('.cell').nth(c)
  await cell(0, 1).click()
  // No Enter between cells: Tab saves the cell and moves on; from the last column it wraps to the next row.
  await page.keyboard.type('a1'); await page.keyboard.press('Tab')
  await page.keyboard.type('b1'); await page.keyboard.press('Tab')
  await page.keyboard.type('R2'); await page.keyboard.press('Tab')
  await page.keyboard.type('a2'); await page.keyboard.press('Tab')
  await page.keyboard.type('b2'); await page.keyboard.press('Enter')
  await expect.poll(() => tableText(page)).toEqual(['r1|a1|b1', 'R2|a2|b2'])
  // An edit started by typing ends with an arrow key, which also moves.
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowRight')
  await page.keyboard.type('zz'); await page.keyboard.press('ArrowDown')
  await page.keyboard.type('yy'); await page.keyboard.press('Enter')
  await expect.poll(() => tableText(page)).toEqual(['r1|zz|b1', 'R2|yy|b2'])
  await waitSaved(page)
})

test('a large table stays responsive: bounded rendering, scrolling, new rows, typing', async ({ page }) => {
  await open(page)
  // Seed 1500 rows straight through the API.
  const t = await token(page)
  const rows = Array.from({ length: 1500 }, (_, i) => ({ id: 'bigrow' + i, cells: { name: 'Row ' + (i + 1), note: 'Note ' + (i + 1) }, body: [], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }))
  const doc = { id: 'bigtable', type: 'database', title: 'Big table', color: 'teal', props: [{ id: 'name', type: 'title', name: 'Name', config: {} }, { id: 'note', type: 'text', name: 'Note', config: {} }], rows, views: [{ id: 'v1', type: 'table', name: 'Table' }] }
  const r = await page.request.post('/api/v2/sync', { headers: { 'X-Truss-Token': t, 'Content-Type': 'application/json' }, data: { client: 'seed', puts: [{ module: doc, baseVersion: 0 }], deletes: [] } })
  expect(r.status()).toBe(200)
  await page.reload()
  await expect(page.locator('#app')).not.toHaveClass(/app-booting/)
  await page.locator('.sb').getByText('Big table').click()
  await expect(page.locator('.dbt-row').first()).toContainText('Row 1')
  // Only rows near the view are in the page.
  expect(await page.locator('.dbt-row').count()).toBeLessThan(120)
  // Scrolling to the end renders the last rows.
  await page.locator('[data-scroll="main"]').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(page.locator('.dbt-row', { hasText: 'Row 1500' })).toBeVisible()
  expect(await page.locator('.dbt-row').count()).toBeLessThan(120)
  // Back to the top, then New: the new last row is brought into view and edited.
  await page.locator('[data-scroll="main"]').evaluate((el) => { el.scrollTop = 0 })
  await expect(page.locator('.dbt-row').first()).toContainText('Row 1')
  await page.locator('.new-btn').first().click()
  await expect(page.locator('[data-cellinput]')).toBeFocused()
  await page.keyboard.type('Row 1501')
  await page.keyboard.press('Enter')
  await expect(page.locator('.dbt-row', { hasText: 'Row 1501' })).toBeVisible()
  // Typing into a cell costs no long frames.
  await page.evaluate(() => { window.__lf = []; new PerformanceObserver((l) => { for (const f of l.getEntries()) window.__lf.push(f.duration) }).observe({ type: 'long-animation-frame' }) })
  await page.locator('.dbt-row', { hasText: 'Row 1501' }).locator('.cell').nth(1).click()
  await page.keyboard.type('quick typing test', { delay: 20 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.dbt-row', { hasText: 'Row 1501' })).toContainText('quick typing test')
  const lf = await page.evaluate(() => window.__lf)
  expect(Math.max(0, ...lf)).toBeLessThan(150)
  await waitSaved(page)
})
