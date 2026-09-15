import { test, expect } from '@playwright/test'
import { watch, openWorkbook, clickCell, domCellText, rawOf, cellPoint, typeInto, flushSaves, waitGrid } from './helpers.js'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test('Ctrl+Z / Ctrl+Y undo and redo 60 value edits, pastes, formatting and row insertion', async ({ page }) => {
  test.setTimeout(90_000)
  const w = watch(page)
  await openWorkbook(page)
  await clickCell(page, 'A1')
  for (let i = 1; i <= 60; i++) {
    await page.keyboard.type(String(i))
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowUp')
  }
  expect(await domCellText(page, 'A1')).toBe('60')
  for (let i = 0; i < 55; i++) await page.keyboard.press('Control+z')
  expect(await domCellText(page, 'A1')).toBe('5')
  for (let i = 0; i < 52; i++) await page.keyboard.press('Control+y')
  expect(await domCellText(page, 'A1')).toBe('57')
  await page.keyboard.press('Control+Shift+z')
  expect(await domCellText(page, 'A1')).toBe('58')

  // paste
  await page.evaluate(() => navigator.clipboard.writeText('a\tb\nc\td'))
  await clickCell(page, 'C3')
  await page.keyboard.press('Control+v')
  expect(await domCellText(page, 'D4')).toBe('d')
  await page.keyboard.press('Control+z')
  expect(await domCellText(page, 'D4')).toBe('')
  expect(await domCellText(page, 'C3')).toBe('')
  await page.keyboard.press('Control+y')
  expect(await domCellText(page, 'C3')).toBe('a')

  // formatting
  await clickCell(page, 'C3')
  await page.keyboard.press('Control+b')
  const weight = async () => page.evaluate(({ x, y }) => getComputedStyle(document.elementsFromPoint(x, y).find((e) => e.classList.contains('sheet-cell'))).fontWeight, await cellPoint(page, 2, 2))
  expect(Number(await weight())).toBeGreaterThanOrEqual(600)
  await page.keyboard.press('Control+z')
  expect(Number(await weight())).toBeLessThan(600)
  await page.keyboard.press('Control+y')
  expect(Number(await weight())).toBeGreaterThanOrEqual(600)

  // row insertion
  await typeInto(page, 'F1', '=SUM(A1:A3)')
  const p = await cellPoint(page, 1, 0)
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.locator('.popover .menu-item', { hasText: 'Insert row above' }).click()
  expect(await rawOf(page, 'F1')).toBe('=SUM(A1:A4)')
  expect(await domCellText(page, 'C4')).toBe('a')
  await page.keyboard.press('Control+z')
  expect(await rawOf(page, 'F1')).toBe('=SUM(A1:A3)')
  expect(await domCellText(page, 'C3')).toBe('a')
  await page.keyboard.press('Control+y')
  expect(await rawOf(page, 'F1')).toBe('=SUM(A1:A4)')
  expect(await domCellText(page, 'C4')).toBe('a')

  // the undo buttons reflect history
  await expect(page.locator('.sheet-tb[title^="Undo"]')).toBeEnabled()
  await flushSaves(page)
  await page.reload()
  await waitGrid(page)
  expect(await rawOf(page, 'F1')).toBe('=SUM(A1:A4)')
  expect(await domCellText(page, 'A1')).toBe('58')
  expect(await domCellText(page, 'D5')).toBe('d')
  expect(w.errors).toEqual([])
})

test('saves are batched: 20 typed characters produce at most 2 cell-save requests, and survive reload', async ({ page }) => {
  await openWorkbook(page)
  const saves = []
  page.on('request', (r) => {
    if (r.url().includes('/api/sheets/') && r.method() !== 'GET') saves.push(`${r.method()} ${new URL(r.url()).pathname}`)
  })
  await clickCell(page, 'B2')
  await page.keyboard.type('abcdefghijklmnopqrst', { delay: 20 })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const cellSaves = saves.filter((s) => s.endsWith('/cells'))
  expect(cellSaves.length).toBeGreaterThanOrEqual(1)
  expect(cellSaves.length).toBeLessThanOrEqual(2)
  expect(saves.length).toBe(cellSaves.length)
  await expect(page.locator('.sheet-save-state')).toHaveText('All changes saved')

  // An edit made just before reloading is not lost (flushed on page hide).
  await typeInto(page, 'B3', 'last minute')
  await page.reload()
  await waitGrid(page)
  expect(await domCellText(page, 'B2')).toBe('abcdefghijklmnopqrst')
  await expect.poll(() => domCellText(page, 'B3')).toBe('last minute')
})
