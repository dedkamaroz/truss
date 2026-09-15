import { test, expect } from '@playwright/test'
import { openWorkbook, apiCall, clickCell, domCellText, waitGrid } from './helpers.js'

const letters = (c) => {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

test('1,000x26 values + 10,000 formulas: opens fast, virtualised DOM, sub-50 ms commits', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const m = await openWorkbook(page, { title: 'Perf book' })
  const sid = (await apiCall(page, 'GET', `/api/sheets/${m.id}`)).body.sheets[0].id
  const cells = []
  for (let r = 0; r < 1000; r++) {
    for (let c = 0; c < 26; c++) cells.push({ sheet: sid, row: r, col: c, raw: String((r * 7 + c * 13) % 997) })
    for (let k = 0; k < 9; k++) cells.push({ sheet: sid, row: r, col: 26 + k, raw: `=${letters(k)}${r + 1}*2+${letters(k + 1)}${r + 1}` })
    cells.push({ sheet: sid, row: r, col: 35, raw: `=SUM(A${r + 1}:Z${r + 1})+$A$1` })
  }
  expect(cells.filter((c) => c.raw.startsWith('=')).length).toBe(10000)
  expect((await apiCall(page, 'POST', `/api/sheets/${m.id}/cells`, { cells })).status).toBe(200)

  // Cold open: full page load straight into the workbook.
  await page.goto('about:blank')
  await page.goto(`/#/m/${m.id}`)
  const openedAt = await page.waitForFunction(() => {
    const h = window.__trussSheet
    return h && document.querySelectorAll('.sheet-app .sheet-cell').length > 100 && performance.now()
  }, null, { polling: 'raf' })
  const openMs = await openedAt.jsonValue()
  console.log(`open to interactive: ${Math.round(openMs)} ms`)
  expect(openMs).toBeLessThan(2000)
  expect(await domCellText(page, 'A2')).toBe('7')

  // Interactive right away: a commit recalculates dependants.
  await clickCell(page, 'A1')
  const commit = await page.evaluate(() => {
    const editor = document.querySelector('.sheet-editor')
    editor.value = '500'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
    const t0 = performance.now()
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    const ms = performance.now() - t0
    const h = window.__trussSheet
    return { ms, value: h.model.getValue(h.sheet.id, 0, 35), shown: [...document.querySelectorAll('.pane-main .sheet-cell')].find((e) => e.style.left === '0px' && e.style.top === '0px')?.textContent }
  })
  console.log(`commit: ${commit.ms.toFixed(1)} ms`)
  expect(commit.shown).toBe('500')
  expect(commit.ms).toBeLessThan(50)

  // Scroll to the bottom-right in steps; the DOM never holds more than 2,000 cells.
  const counts = await page.evaluate(async () => {
    const sc = document.querySelector('.sheet-scroller')
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()))
    const out = []
    for (let i = 1; i <= 30; i++) {
      sc.scrollTop = (26 * 1000 * i) / 30
      sc.scrollLeft = (100 * 36 * i) / 30
      await frame()
      out.push(document.querySelectorAll('.sheet-cell').length)
    }
    for (let i = 0; i < 5; i++) {
      sc.scrollTop = sc.scrollHeight
      sc.scrollLeft = sc.scrollWidth
      await frame()
      await frame()
      out.push(document.querySelectorAll('.sheet-cell').length)
    }
    return out
  })
  console.log(`max cell elements while scrolling: ${Math.max(...counts)}`)
  expect(Math.max(...counts)).toBeLessThanOrEqual(2000)
  expect(Math.min(...counts)).toBeGreaterThan(50)
  await page.evaluate(() => {
    const sc = document.querySelector('.sheet-scroller')
    sc.scrollTop = 26 * 990
    sc.scrollLeft = 0
  })
  await expect.poll(() => page.locator('.head-row .sheet-hcell', { hasText: /^1000$/ }).count()).toBe(1)
  await expect.poll(() => domCellText(page, 'A1000')).toBe(String((999 * 7) % 997))
})

test('reload of the large workbook stays under 2 s', async ({ page }) => {
  test.setTimeout(60_000)
  const m = await openWorkbook(page)
  const sid = (await apiCall(page, 'GET', `/api/sheets/${m.id}`)).body.sheets[0].id
  const cells = []
  for (let r = 0; r < 1000; r++) for (let c = 0; c < 26; c++) cells.push({ sheet: sid, row: r, col: c, raw: r % 10 === 0 ? `=SUM(A${r + 2}:A${r + 11})` : String(r + c) })
  await apiCall(page, 'POST', `/api/sheets/${m.id}/cells`, { cells })
  await page.reload()
  await waitGrid(page)
  const ms = await page.evaluate(() => performance.now())
  expect(ms).toBeLessThan(2000)
})
