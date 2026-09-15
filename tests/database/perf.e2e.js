import { test, expect } from '@playwright/test'
import { watch, boot, createModule, api, load, uid } from './helpers.js'

test('10,000 rows: interactive under 2 s, at most 300 row elements while scrolling, last row reachable, edits keep other row elements', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const w = await watch(page)
  await boot(page)
  const module = await createModule(page, { type: 'database', title: `Perf ${uid()}` })
  const base = `/api/databases/${module.id}`
  const data = await load(page, module.id)
  const title = data.properties[0]
  const num = await api(page, 'POST', `${base}/properties`, { name: 'Amount', type: 'number', config: { format: 'aud' } })
  const status = await api(page, 'POST', `${base}/properties`, { name: 'Status', type: 'status' })
  const note = await api(page, 'POST', `${base}/properties`, { name: 'Note', type: 'text' })
  const opts = status.config.options.map((o) => o.id)
  const seeded = await page.evaluate(async ({ base, t, n, s, x, opts }) => {
    const token = document.querySelector('meta[name="truss-token"]').content
    const create = Array.from({ length: 10000 }, (_, i) => ({ values: { [t]: `Row ${i}`, [n]: i * 1.5, [s]: opts[i % 3], [x]: `Note for row ${i}` } }))
    const res = await fetch(`${base}/rows/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Truss-Token': token }, body: JSON.stringify({ create }) })
    return (await res.json()).created.length
  }, { base, t: title.id, n: num.id, s: status.id, x: note.id, opts })
  expect(seeded).toBe(10000)

  // interactive: from navigation to an open cell editor
  const startedAt = Date.now()
  await page.goto(`/#/m/${module.id}`)
  const firstTitle = page.locator('.db-tr').first().locator(`.db-td[data-prop="${title.id}"]`)
  await expect(firstTitle).toContainText('Row 0')
  await firstTitle.click()
  await expect(page.locator('.db-inline-input')).toBeFocused()
  const interactiveMs = Date.now() - startedAt
  const readyMark = await page.evaluate(() => performance.getEntriesByName('truss:database-ready')[0]?.startTime)
  console.log(`10k rows: database ready ${Math.round(readyMark)} ms after navigation start, editor open ${interactiveMs} ms after goto`)
  expect(readyMark).toBeLessThan(2000)
  expect(interactiveMs).toBeLessThan(2000)
  await page.keyboard.press('Escape')

  // scrolling never renders more than 300 rows
  const maxRows = await page.evaluate(async () => {
    const scroller = document.querySelector('.db-table')
    let max = document.querySelectorAll('.db-tr').length
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const total = scroller.scrollHeight
    for (let i = 1; i <= 60; i++) {
      scroller.scrollTop = (total * i) / 60
      await frame()
      max = Math.max(max, document.querySelectorAll('.db-tr').length)
    }
    // a fast jump back to the top as well
    scroller.scrollTop = 0
    await frame()
    return Math.max(max, document.querySelectorAll('.db-tr').length)
  })
  console.log('max row elements while scrolling:', maxRows)
  expect(maxRows).toBeLessThanOrEqual(300)
  expect(maxRows).toBeGreaterThan(10)

  // wheel scrolling too
  await page.locator('.db-table').hover()
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 2500)
  expect(await page.locator('.db-tr').count()).toBeLessThanOrEqual(300)

  // the bottom shows the last row
  await page.evaluate(() => { const s = document.querySelector('.db-table'); s.scrollTop = s.scrollHeight })
  const last = page.locator('.db-tr', { hasText: 'Row 9999' })
  await expect(last).toBeVisible()
  await expect(last).toBeInViewport()
  expect(await page.locator('.db-tr').count()).toBeLessThanOrEqual(300)

  // editing one cell keeps every other row element (and cell) identical
  await page.evaluate(() => { const s = document.querySelector('.db-table'); s.scrollTop = 20000 })
  await expect.poll(() => page.locator('.db-tr').count()).toBeGreaterThan(10)
  await page.waitForTimeout(100)
  // a row in the middle of the viewport (rows at the ends of the DOM are overscan, outside the viewport)
  const target = await page.evaluate(() => {
    const r = document.querySelector('.db-table').getBoundingClientRect()
    return document.elementFromPoint(r.left + 200, r.top + r.height / 2).closest('.db-tr').dataset.rowId
  })
  await page.evaluate((target) => {
    window.__before = [...document.querySelectorAll('.db-tr')]
    window.__cells = [...document.querySelectorAll(`.db-tr:not([data-row-id="${target}"]) .db-td`)]
  }, target)
  await page.locator(`.db-tr[data-row-id="${target}"] .db-td[data-prop="${note.id}"]`).click()
  await page.locator('.db-inline-input').fill('Edited in place')
  await page.keyboard.press('Enter')
  await expect(page.locator(`.db-tr[data-row-id="${target}"] .db-td[data-prop="${note.id}"]`)).toHaveText('Edited in place')
  await expect.poll(async () => (await api(page, 'GET', `${base}/rows/${target}`)).values[note.id]).toBe('Edited in place')
  const identity = await page.evaluate(() => {
    const now = [...document.querySelectorAll('.db-tr')]
    return {
      sameRows: window.__before.length === now.length && window.__before.every((el, i) => el === now[i] && el.isConnected),
      cellsKept: window.__cells.every((td) => td.isConnected),
    }
  })
  expect(identity).toEqual({ sameRows: true, cellsKept: true })

  // small scrolls (such as revealing a cell while editing) keep existing row elements too
  const kept = await page.evaluate(async () => {
    const s = document.querySelector('.db-table')
    const before = [...document.querySelectorAll('.db-tr')]
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    s.scrollTop -= 150
    await frame()
    s.scrollTop += 300
    await frame()
    return before.every((el) => el.isConnected)
  })
  expect(kept).toBe(true)
  expect(await page.locator('.db-tr').count()).toBeLessThanOrEqual(300)
  expect(w.errors).toEqual([])
})
