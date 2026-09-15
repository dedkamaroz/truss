import { test, expect } from '@playwright/test'
import { watch, boot, notebook, createPage, openPage, saved, getPage, shot } from './helpers.js'

const cell = (scope, r, c) => scope.locator(`.nb-cell[data-r="${r}"][data-c="${c}"]`)
const grid = (scope) => scope.locator('.nb-table').evaluate((t) => {
  const head = [...t.querySelectorAll('thead .nb-cell')].map((c) => c.textContent)
  const rows = [...t.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('.nb-cell')].map((c) => c.textContent))
  return [head, ...rows]
})
const storedGrid = (content) => [content.columns.map((c) => c.name), ...content.rows.map((r) => content.columns.map((c) => r.cells[c.id] ?? ''))]

async function paste(locator, text) {
  await locator.evaluate((el, t) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, text)
}

test('table notebook page: header editing, add/remove/reorder columns and rows, resize, keyboard navigation, TSV paste, undo, persistence', async ({ page }) => {
  const w = await watch(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await boot(page)
  const { module } = await notebook(page, { template: 'table' })
  const p = await createPage(page, module.id, { title: 'Contacts' })
  expect(Array.isArray(p.content.columns)).toBe(true)
  await openPage(page, module.id, p.id)
  const t = page.locator('.nb-page .nb-table-wrap')
  await expect(t).toBeVisible()
  expect(await grid(t)).toEqual([['Name', 'Notes', 'Status'], ['', '', ''], ['', '', ''], ['', '', '']])

  // header row is editable
  await cell(t, -1, 0).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Person')

  // keyboard navigation
  await page.keyboard.press('ArrowDown')
  await expect(cell(t, 0, 0)).toBeFocused()
  await page.keyboard.type('Ava')
  await page.keyboard.press('Tab')
  await expect(cell(t, 0, 1)).toBeFocused()
  await page.keyboard.type('Sydney')
  await page.keyboard.press('Enter')
  await expect(cell(t, 1, 1)).toBeFocused()
  await page.keyboard.type('Perth')
  await page.keyboard.press('Shift+Tab')
  await expect(cell(t, 1, 0)).toBeFocused()
  await page.keyboard.type('Ben')
  await page.keyboard.press('ArrowUp')
  await expect(cell(t, 0, 0)).toBeFocused()
  await page.keyboard.press('ArrowRight') // caret at end of "Ava" moves to the next cell
  await expect(cell(t, 0, 1)).toBeFocused()
  await page.keyboard.press('ArrowLeft') // caret placed at start, so left moves back
  await expect(cell(t, 0, 0)).toBeFocused()
  await cell(t, 2, 2).click()
  await page.keyboard.press('Tab') // last cell: Tab adds a row
  await expect(page.locator('.nb-page tbody tr')).toHaveCount(4)
  await expect(cell(t, 3, 0)).toBeFocused()
  await page.keyboard.press('Enter') // Enter on the last row adds another
  await expect(page.locator('.nb-page tbody tr')).toHaveCount(5)

  // TSV paste grows the table
  await paste(cell(t, 3, 1), 'x1\ty1\tz1\nx2\ty2\tz2\n')
  await expect(page.locator('.nb-page thead .nb-cell')).toHaveCount(4)
  expect((await grid(t)).slice(4)).toEqual([['', 'x1', 'y1', 'z1'], ['', 'x2', 'y2', 'z2']])
  await expect(cell(t, 4, 3)).toBeFocused()

  // add column (button) and name it
  await page.locator('.nb-page .nb-table-add-col').click()
  await expect(cell(t, -1, 4)).toBeFocused()
  await page.keyboard.type('Extra')
  // add row (button)
  await page.locator('.nb-page .nb-table-add-row').click()
  await expect(page.locator('.nb-page tbody tr')).toHaveCount(6)
  await expect(cell(t, 5, 0)).toBeFocused()
  await page.keyboard.type('Last')

  // remove column via its menu
  await cell(t, -1, 3).hover()
  await page.locator('.nb-page .nb-col-btn[data-c="3"]').click()
  await page.getByRole('menuitem', { name: 'Delete column' }).click()
  expect((await grid(t))[0]).toEqual(['Person', 'Notes', 'Status', 'Extra'])

  // reorder columns: menu and drag
  await page.locator('.nb-page .nb-col-btn[data-c="0"]').click()
  await page.getByRole('menuitem', { name: 'Move right' }).click()
  expect((await grid(t))[0]).toEqual(['Notes', 'Person', 'Status', 'Extra'])
  await page.locator('.nb-page .nb-col-btn[data-c="3"]').dragTo(page.locator('.nb-page th.nb-th[data-c="0"]'), { targetPosition: { x: 5, y: 10 } })
  expect((await grid(t))[0]).toEqual(['Extra', 'Notes', 'Person', 'Status'])

  // remove a row via its menu; reorder rows via drag and via menu
  await cell(t, 2, 0).hover()
  await page.locator('.nb-page .nb-row-btn[data-r="2"]').click()
  await page.getByRole('menuitem', { name: 'Delete row' }).click()
  await expect(page.locator('.nb-page tbody tr')).toHaveCount(5)
  const people = async () => (await grid(t)).slice(1).map((r) => r[2])
  expect(await people()).toEqual(['Ava', 'Ben', '', '', 'Last'])
  await page.locator('.nb-page .nb-row-btn[data-r="1"]').dragTo(page.locator('.nb-page tr.nb-tr[data-r="0"]'), { targetPosition: { x: 200, y: 3 } })
  expect(await people()).toEqual(['Ben', 'Ava', '', '', 'Last'])
  await page.locator('.nb-page .nb-row-btn[data-r="4"]').click()
  await page.getByRole('menuitem', { name: 'Move up' }).click()
  expect(await people()).toEqual(['Ben', 'Ava', '', 'Last', ''])

  // undo / redo on the table page
  await cell(t, 0, 2).click()
  await page.keyboard.press('Control+z')
  expect(await people()).toEqual(['Ben', 'Ava', '', '', 'Last'])
  await page.keyboard.press('Control+y')
  expect(await people()).toEqual(['Ben', 'Ava', '', 'Last', ''])

  // column resize with the mouse
  const handle = page.locator('.nb-page .nb-col-resize[data-c="1"]')
  const before = await page.locator('.nb-page th.nb-th[data-c="1"]').evaluate((th) => th.getBoundingClientRect().width)
  const box = await handle.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + 10, { steps: 5 })
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + 10, { steps: 5 })
  await page.mouse.up()
  const afterW = await page.locator('.nb-page th.nb-th[data-c="1"]').evaluate((th) => th.getBoundingClientRect().width)
  expect(afterW - before).toBeGreaterThan(80)
  expect(afterW - before).toBeLessThan(100)

  await saved(page)
  const dom = await grid(t)
  const stored = (await getPage(page, module.id, p.id)).content
  expect(storedGrid(stored)).toEqual(dom)
  expect(Math.abs(stored.columns[1].width - (280 + 90))).toBeLessThanOrEqual(3)
  await shot(page, 'table-page')

  await page.reload()
  await expect(page.locator('.nb-page .nb-table')).toBeVisible()
  expect(await grid(page.locator('.nb-page .nb-table-wrap'))).toEqual(dom)
  const w2 = await page.locator('.nb-page th.nb-th[data-c="1"]').evaluate((th) => th.getBoundingClientRect().width)
  expect(Math.abs(w2 - afterW)).toBeLessThanOrEqual(2)
  expect(w.errors).toEqual([])
})

test('table blocks inside text pages share the core table editing', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { module } = await notebook(page)
  const p = await createPage(page, module.id, { title: 'With table', content: [
    { id: 'p1', type: 'paragraph', html: 'Before', props: {} },
    { id: 't1', type: 'table', html: '', props: { columns: [{ id: 'a', name: 'Item', width: 160 }, { id: 'b', name: 'Qty', width: 120 }], rows: [{ id: 'r1', cells: { a: 'Pens', b: '4' } }] } },
    { id: 'p2', type: 'paragraph', html: 'After', props: {} },
  ] })
  await openPage(page, module.id, p.id)
  const t = page.locator('.nb-block[data-type="table"] .nb-table-wrap')
  await cell(t, 0, 1).click()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('5')
  await page.keyboard.press('Tab') // adds a row
  await expect(cell(t, 1, 0)).toBeFocused()
  await page.keyboard.type('Paper')
  await page.keyboard.press('Tab')
  await page.keyboard.type('10')
  await page.keyboard.press('ArrowUp')
  await expect(cell(t, 0, 1)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(cell(t, -1, 1)).toBeFocused()
  await paste(cell(t, 1, 0), 'Ink\t2\nTape\t3')
  await t.locator('.nb-table-add-col').click()
  await page.keyboard.type('Notes')
  await cell(t, 0, 0).hover()
  await t.locator('.nb-row-btn[data-r="0"]').click()
  await page.getByRole('menuitem', { name: 'Move down' }).click()
  // typing in a cell does not re-render the surrounding blocks
  const probe = await page.locator('.nb-block[data-id="p1"]').evaluate((el) => (el.__probe = 7))
  await cell(t, 1, 2).click()
  await page.keyboard.type('hi')
  expect(await page.locator('.nb-block[data-id="p1"]').evaluate((el) => el.__probe)).toBe(probe)

  const expected = [['Item', 'Qty', 'Notes'], ['Ink', '2', ''], ['Pens', '5', 'hi'], ['Tape', '3', '']]
  expect(await grid(t)).toEqual(expected)
  await saved(page)
  const stored = (await getPage(page, module.id, p.id)).content
  expect(stored.map((b) => b.type)).toEqual(['paragraph', 'table', 'paragraph'])
  expect(storedGrid(stored[1].props)).toEqual(expected)
  await page.reload()
  await expect(page.locator('.nb-block[data-type="table"] .nb-table')).toBeVisible()
  expect(await grid(page.locator('.nb-block[data-type="table"] .nb-table-wrap'))).toEqual(expected)
  expect(w.errors).toEqual([])
})
