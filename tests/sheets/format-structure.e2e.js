import { test, expect } from '@playwright/test'
import { watch, openWorkbook, clickCell, domCellText, rawOf, cellPoint, typeInto, flushSaves, waitGrid, apiCall } from './helpers.js'

async function cellStyle(page, a1Row, a1Col) {
  const p = await cellPoint(page, a1Row, a1Col)
  return page.evaluate(({ x, y }) => {
    const el = document.elementsFromPoint(x, y).find((e) => e.classList.contains('sheet-cell'))
    const cs = getComputedStyle(el)
    return { weight: cs.fontWeight, style: cs.fontStyle, color: cs.color, bg: cs.backgroundColor, justify: cs.justifyContent, text: el.textContent }
  }, p)
}

async function pickMenu(page, label) {
  await page.locator('.popover .menu-item', { hasText: label }).first().click()
}

async function reload(page) {
  await flushSaves(page)
  await page.reload()
  await waitGrid(page)
}

test('bold, italic, colours, alignment and number formats apply to selections and persist', async ({ page }) => {
  const w = watch(page)
  await openWorkbook(page)
  await typeInto(page, 'A1', 'Label')
  await typeInto(page, 'B1', 'Other')
  await typeInto(page, 'A2', '1234.5')
  await typeInto(page, 'A3', '0.256')
  await typeInto(page, 'A4', '14/05/2026')
  const plain = await cellStyle(page, 0, 0)

  await clickCell(page, 'A1')
  await page.keyboard.press('Shift+ArrowRight')
  await page.locator('.sheet-tb[title^="Bold"]').click()
  await page.locator('.sheet-tb[title^="Italic"]').click()
  await page.locator('.sheet-tb[title="Text colour"]').click()
  await page.locator('.sheet-palette .sheet-swatch[data-colour="red"]').click()
  await page.locator('.sheet-tb[title="Fill colour"]').click()
  await page.locator('.sheet-palette .sheet-swatch[data-colour="yellow"]').click()
  await page.locator('.sheet-tb[title="Align centre"]').click()

  await clickCell(page, 'A2')
  await page.locator('.sheet-nf').click()
  await pickMenu(page, 'Currency (AUD)')
  expect(await domCellText(page, 'A2')).toBe('$1,234.50')
  await clickCell(page, 'A3')
  await page.locator('.sheet-nf').click()
  await pickMenu(page, 'Percent')
  expect(await domCellText(page, 'A3')).toBe('25.60%')
  await clickCell(page, 'A4')
  await page.locator('.sheet-nf').click()
  await pickMenu(page, 'Number')
  const serial = await domCellText(page, 'A4')
  expect(serial).toMatch(/^46,\d{3}\.00$/)
  await page.locator('.sheet-nf').click()
  await pickMenu(page, 'Date')
  expect(await domCellText(page, 'A4')).toBe('14/05/2026')

  const check = async () => {
    for (const col of [0, 1]) {
      const s = await cellStyle(page, 0, col)
      expect(Number(s.weight)).toBeGreaterThanOrEqual(600)
      expect(s.style).toBe('italic')
      expect(s.color).not.toBe(plain.color)
      expect(s.bg).not.toBe(plain.bg)
      expect(s.justify).toBe('center')
    }
    expect(await domCellText(page, 'A2')).toBe('$1,234.50')
    expect(await domCellText(page, 'A3')).toBe('25.60%')
    expect(await domCellText(page, 'A4')).toBe('14/05/2026')
  }
  await check()
  await reload(page)
  await check()
  await clickCell(page, 'A1')
  await expect(page.locator('.sheet-tb[title^="Bold"]')).toHaveAttribute('aria-pressed', 'true')
  expect(w.errors).toEqual([])
})

test('column resize by drag persists', async ({ page }) => {
  await openWorkbook(page)
  const head = page.locator('.head-col .sheet-hcell', { hasText: /^B$/ })
  const box = await head.boundingBox()
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2, { steps: 3 })
  await page.mouse.move(box.x + box.width + 61, box.y + box.height / 2, { steps: 3 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await head.boundingBox()).width)).toBe(Math.round(box.width + 62))
  const rowHead = page.locator('.head-row .sheet-hcell', { hasText: /^3$/ })
  const rb = await rowHead.boundingBox()
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height - 1)
  await page.mouse.down()
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height + 20, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await rowHead.boundingBox()).height)).toBe(Math.round(rb.height + 21))
  await reload(page)
  const after = await page.locator('.head-col .sheet-hcell', { hasText: /^B$/ }).boundingBox()
  expect(Math.round(after.width)).toBe(Math.round(box.width + 62))
  const rowAfter = await page.locator('.head-row .sheet-hcell', { hasText: /^3$/ }).boundingBox()
  expect(Math.round(rowAfter.height)).toBe(Math.round(rb.height + 21))
})

test('insert and delete rows/columns via context menu rewrite formulas', async ({ page }) => {
  const w = watch(page)
  const m = await openWorkbook(page)
  const data = (await apiCall(page, 'GET', `/api/sheets/${m.id}`)).body
  const sid = data.sheets[0].id
  const cells = Array.from({ length: 10 }, (_, r) => ({ sheet: sid, row: r, col: 0, raw: String(r + 1) }))
  cells.push({ sheet: sid, row: 0, col: 2, raw: '=SUM(A1:A10)' })
  await apiCall(page, 'POST', `/api/sheets/${m.id}/cells`, { cells })
  await page.reload()
  await waitGrid(page)
  expect(await domCellText(page, 'C1')).toBe('55')

  const p = await cellPoint(page, 4, 0)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await pickMenu(page, 'Insert row above')
  expect(await rawOf(page, 'C1')).toBe('=SUM(A1:A11)')
  expect(await domCellText(page, 'A5')).toBe('')
  expect(await domCellText(page, 'A6')).toBe('5')
  await typeInto(page, 'A5', '100')
  expect(await domCellText(page, 'C1')).toBe('155')

  const colHead = await page.locator('.head-col .sheet-hcell', { hasText: /^B$/ }).boundingBox()
  await page.mouse.click(colHead.x + colHead.width / 2, colHead.y + colHead.height / 2, { button: 'right' })
  await pickMenu(page, 'Delete column')
  expect(await rawOf(page, 'B1')).toBe('=SUM(A1:A11)')

  await page.mouse.click(colHead.x + 10, colHead.y + colHead.height / 2, { button: 'right' })
  await pickMenu(page, 'Insert column left')
  expect(await rawOf(page, 'C1')).toBe('=SUM(A1:A11)')

  await reload(page)
  expect(await rawOf(page, 'C1')).toBe('=SUM(A1:A11)')
  expect(await domCellText(page, 'C1')).toBe('155')
  expect(await domCellText(page, 'A6')).toBe('5')

  const r3 = await page.locator('.head-row .sheet-hcell', { hasText: /^3$/ }).boundingBox()
  await page.mouse.click(r3.x + r3.width / 2, r3.y + r3.height / 2, { button: 'right' })
  await pickMenu(page, 'Delete row')
  expect(await rawOf(page, 'C1')).toBe('=SUM(A1:A10)')
  expect(await domCellText(page, 'C1')).toBe('152')
  expect(w.errors).toEqual([])
})

test('freezing the first row and column keeps headers visible while scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const m = await openWorkbook(page)
  const data = (await apiCall(page, 'GET', `/api/sheets/${m.id}`)).body
  const sid = data.sheets[0].id
  const cells = []
  for (let c = 0; c < 40; c++) cells.push({ sheet: sid, row: 0, col: c, raw: `Head ${c}` })
  for (let r = 1; r < 300; r++) cells.push({ sheet: sid, row: r, col: 0, raw: `Row ${r}` })
  await apiCall(page, 'POST', `/api/sheets/${m.id}/cells`, { cells })
  await page.reload()
  await waitGrid(page)

  await page.locator('.sheet-freeze').click()
  await pickMenu(page, 'Freeze first row and column')
  await expect(page.locator('.pane-top.has-freeze')).toHaveCount(1)
  const grid = await page.locator('.sheet-grid').boundingBox()
  await page.mouse.move(grid.x + grid.width / 2, grid.y + grid.height / 2)
  await page.mouse.wheel(1500, 4000)
  await expect.poll(() => page.evaluate(() => document.querySelector('.sheet-scroller').scrollTop)).toBeGreaterThan(3000)
  await expect.poll(() => page.evaluate(() => document.querySelector('.sheet-scroller').scrollLeft)).toBeGreaterThan(1000)

  expect(await domCellText(page, 'A1')).toBe('Head 0')
  const topTexts = await page.locator('.pane-top .sheet-cell').allTextContents()
  expect(topTexts.some((t) => /^Head (1[0-9]|2[0-9])$/.test(t))).toBe(true)
  const leftTexts = await page.locator('.pane-left .sheet-cell').allTextContents()
  expect(leftTexts.some((t) => /^Row 1[4-9][0-9]$/.test(t))).toBe(true)
  // The frozen row sits directly under the column headers
  const topBox = await page.locator('.pane-top').boundingBox()
  const headBox = await page.locator('.head-col:not(.is-frozen)').boundingBox()
  expect(Math.round(topBox.y)).toBe(Math.round(headBox.y + headBox.height))
  await reload(page)
  await expect(page.locator('.pane-top.has-freeze')).toHaveCount(1)
})

test('sheet tabs: add, rename by double-click rewrites formulas, delete with confirm, reorder by drag', async ({ page }) => {
  const w = watch(page)
  await openWorkbook(page)
  await page.locator('.sheet-tab-add').click()
  await expect(page.locator('.sheet-tab')).toHaveText(['Sheet1', 'Sheet2'])
  await typeInto(page, 'A1', '7')
  await page.locator('.sheet-tab', { hasText: 'Sheet1' }).click()
  await typeInto(page, 'A1', '=Sheet2!A1*3')
  expect(await domCellText(page, 'A1')).toBe('21')

  await page.locator('.sheet-tab', { hasText: 'Sheet2' }).dblclick()
  const input = page.locator('.sheet-tab-input')
  await expect(input).toBeVisible()
  await input.fill('Rates Table')
  await input.press('Enter')
  await expect(page.locator('.sheet-tab')).toHaveText(['Sheet1', 'Rates Table'])
  expect(await rawOf(page, 'A1', 'Sheet1')).toBe("='Rates Table'!A1*3")

  await page.locator('.sheet-tab-add').click()
  await expect(page.locator('.sheet-tab')).toHaveText(['Sheet1', 'Rates Table', 'Sheet3'])

  // reorder: drag Sheet3 to the front
  const src = await page.locator('.sheet-tab', { hasText: 'Sheet3' }).boundingBox()
  const dst = await page.locator('.sheet-tab', { hasText: 'Sheet1' }).boundingBox()
  await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2)
  await page.mouse.down()
  await page.mouse.move(src.x - 20, src.y + src.height / 2, { steps: 5 })
  await page.mouse.move(dst.x + 4, dst.y + dst.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(page.locator('.sheet-tab')).toHaveText(['Sheet3', 'Sheet1', 'Rates Table'])

  // delete with the custom confirm dialog
  await page.locator('.sheet-tab', { hasText: 'Rates Table' }).click({ button: 'right' })
  await pickMenu(page, 'Delete')
  const dialog = page.locator('.modal-confirm')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Rates Table')
  await dialog.locator('button', { hasText: 'Cancel' }).click()
  await expect(page.locator('.sheet-tab')).toHaveCount(3)
  await page.locator('.sheet-tab', { hasText: 'Rates Table' }).click({ button: 'right' })
  await pickMenu(page, 'Delete')
  await page.locator('.modal-confirm button', { hasText: 'Delete sheet' }).click()
  await expect(page.locator('.sheet-tab')).toHaveText(['Sheet3', 'Sheet1'])
  expect(await rawOf(page, 'A1', 'Sheet1')).toBe('=#REF!*3')

  await reload(page)
  await expect(page.locator('.sheet-tab')).toHaveText(['Sheet3', 'Sheet1'])
  expect(await rawOf(page, 'A1', 'Sheet1')).toBe('=#REF!*3')
  expect(w.dialogs).toEqual([])
  expect(w.errors).toEqual([])
})
