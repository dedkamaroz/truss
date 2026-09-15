import { test, expect } from '@playwright/test'
import { watch, openWorkbook, clickCell, domCellText, rawOf, cellPoint } from './helpers.js'

const nameBox = (page) => page.locator('.sheet-namebox')

test('typing commits with Enter/Tab and moves; arrows, F2, Esc and Delete behave like Excel', async ({ page }) => {
  const w = watch(page)
  await openWorkbook(page)
  await clickCell(page, 'A1')
  await expect(nameBox(page)).toHaveValue('A1')

  await page.keyboard.type('10')
  await expect(page.locator('.sheet-editor')).not.toHaveClass(/is-idle/)
  await page.keyboard.press('Enter')
  await expect(nameBox(page)).toHaveValue('A2')
  expect(await domCellText(page, 'A1')).toBe('10')

  await page.keyboard.type('20')
  await page.keyboard.press('Tab')
  await expect(nameBox(page)).toHaveValue('B2')
  expect(await domCellText(page, 'A2')).toBe('20')

  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowUp')
  await expect(nameBox(page)).toHaveValue('A1')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(nameBox(page)).toHaveValue('B2')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowUp')

  // F2 edits in place, keeping the existing content
  await page.keyboard.press('F2')
  await expect(page.locator('.sheet-editor')).toHaveValue('10')
  await page.keyboard.type('5')
  await page.keyboard.press('Enter')
  expect(await domCellText(page, 'A1')).toBe('105')

  // Esc cancels a replacement edit
  await clickCell(page, 'A1')
  await page.keyboard.type('999')
  await page.keyboard.press('Escape')
  await expect(page.locator('.sheet-editor')).toHaveClass(/is-idle/)
  expect(await domCellText(page, 'A1')).toBe('105')
  expect(await rawOf(page, 'A1')).toBe('105')

  // Delete clears the selection
  await clickCell(page, 'A2')
  await page.keyboard.press('Shift+ArrowUp')
  await expect(nameBox(page)).toHaveValue('A1:A2')
  await page.keyboard.press('Delete')
  expect(await domCellText(page, 'A1')).toBe('')
  expect(await domCellText(page, 'A2')).toBe('')
  expect(w.errors).toEqual([])
})

test('formula bar shows the raw formula and commits edits made there', async ({ page }) => {
  await openWorkbook(page)
  await clickCell(page, 'A1')
  await page.keyboard.type('21')
  await page.keyboard.press('Enter')
  await clickCell(page, 'B1')
  await page.locator('.sheet-fx-input').click()
  await page.keyboard.type('=A1*2')
  await expect(page.locator('.sheet-editor')).toHaveValue('=A1*2')
  await page.keyboard.press('Enter')
  expect(await domCellText(page, 'B1')).toBe('42')
  await clickCell(page, 'B1')
  await expect(page.locator('.sheet-fx-input')).toHaveValue('=A1*2')
  await clickCell(page, 'A1')
  await expect(page.locator('.sheet-fx-input')).toHaveValue('21')
})

test('click-drag and Shift+arrow select ranges; status bar aggregates numbers', async ({ page }) => {
  await openWorkbook(page)
  await clickCell(page, 'A1')
  for (const v of ['4', '6', '11', 'text']) {
    await page.keyboard.type(v)
    await page.keyboard.press('Enter')
  }
  const a = await cellPoint(page, 0, 0)
  const b = await cellPoint(page, 3, 1)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
  await expect(nameBox(page)).toHaveValue('A1:B4')
  const status = page.locator('.sheet-status')
  await expect(status).toContainText('Sum')
  await expect(status.locator('.sheet-status-item').nth(0)).toHaveText('Sum21')
  await expect(status.locator('.sheet-status-item').nth(1)).toHaveText('Average7')
  await expect(status.locator('.sheet-status-item').nth(2)).toHaveText('Count4')

  await clickCell(page, 'A1')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(nameBox(page)).toHaveValue('A1:A2')
  await expect(status.locator('.sheet-status-item').nth(0)).toHaveText('Sum10')
  await expect(status.locator('.sheet-status-item').nth(1)).toHaveText('Average5')
  await expect(page.locator('.pane-main .ov-range')).toHaveCount(1)
})
