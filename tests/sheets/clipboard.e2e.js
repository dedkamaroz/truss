import { test, expect } from '@playwright/test'
import { watch, openWorkbook, clickCell, domCellText, rawOf, cellPoint, typeInto } from './helpers.js'

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

async function dragSelect(page, from, to) {
  const a = await cellPoint(page, from[0], from[1])
  const b = await cellPoint(page, to[0], to[1])
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
}

async function dragHandle(page, to) {
  const handle = await page.locator('.pane-main .ov-handle').boundingBox()
  const b = await cellPoint(page, to[0], to[1])
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 6 })
  await page.mouse.up()
}

test('copy puts TSV on the clipboard and pasting TSV fills a block', async ({ page }) => {
  const w = watch(page)
  await openWorkbook(page)
  await typeInto(page, 'A1', '1', 'Tab')
  await page.keyboard.type('2')
  await page.keyboard.press('Enter')
  await typeInto(page, 'A2', '3', 'Tab')
  await page.keyboard.type('4')
  await page.keyboard.press('Enter')
  await dragSelect(page, [0, 0], [1, 1])
  await page.keyboard.press('Control+c')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('1\t2\n3\t4')
  await expect(page.locator('.pane-main .ov-clip')).toHaveCount(1)

  await page.evaluate(() => navigator.clipboard.writeText('10\t20\n30\t40\n'))
  await clickCell(page, 'D3')
  await page.keyboard.press('Control+v')
  expect(await domCellText(page, 'D3')).toBe('10')
  expect(await domCellText(page, 'E3')).toBe('20')
  expect(await domCellText(page, 'D4')).toBe('30')
  expect(await domCellText(page, 'E4')).toBe('40')
  await expect(page.locator('.sheet-namebox')).toHaveValue('D3:E4')
  expect(w.errors).toEqual([])
})

test('copy/paste shifts relative references; cut/paste moves cells', async ({ page }) => {
  await openWorkbook(page)
  await typeInto(page, 'A1', '1')
  await typeInto(page, 'B1', '2')
  await typeInto(page, 'A2', '10')
  await typeInto(page, 'B2', '20')
  await typeInto(page, 'C1', '=A1+B1')
  await clickCell(page, 'C1')
  await page.keyboard.press('Control+c')
  await clickCell(page, 'C2')
  await page.keyboard.press('Control+v')
  expect(await rawOf(page, 'C2')).toBe('=A2+B2')
  expect(await domCellText(page, 'C2')).toBe('30')

  await dragSelect(page, [0, 0], [1, 1])
  await page.keyboard.press('Control+x')
  await clickCell(page, 'F5')
  await page.keyboard.press('Control+v')
  expect(await domCellText(page, 'F5')).toBe('1')
  expect(await domCellText(page, 'G6')).toBe('20')
  expect(await domCellText(page, 'A1')).toBe('')
  expect(await rawOf(page, 'B2')).toBe('')
  // Undo restores the cut in one step
  await page.keyboard.press('Control+z')
  expect(await domCellText(page, 'A1')).toBe('1')
  expect(await domCellText(page, 'F5')).toBe('')
})

test('fill handle continues series and adjusts formulas', async ({ page }) => {
  await openWorkbook(page)
  await typeInto(page, 'A1', '1')
  await typeInto(page, 'A2', '2')
  await dragSelect(page, [0, 0], [1, 0])
  await dragHandle(page, [4, 0])
  expect(await domCellText(page, 'A3')).toBe('3')
  expect(await domCellText(page, 'A4')).toBe('4')
  expect(await domCellText(page, 'A5')).toBe('5')
  await expect(page.locator('.sheet-namebox')).toHaveValue('A1:A5')

  await typeInto(page, 'B1', '=A1*10')
  await clickCell(page, 'B1')
  await dragHandle(page, [3, 1])
  expect(await rawOf(page, 'B2')).toBe('=A2*10')
  expect(await rawOf(page, 'B4')).toBe('=A4*10')
  expect(await domCellText(page, 'B3')).toBe('30')

  await clickCell(page, 'B1')
  await dragHandle(page, [0, 3])
  expect(await rawOf(page, 'D1')).toBe('=C1*10')
})
