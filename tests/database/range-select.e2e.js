import { test, expect } from '@playwright/test'
import { watch, boot, api, load, cell, uid, newDb, addRows, open, shot } from '../database-relations-io/helpers.js'

/** Presses from the centre of one locator to the centre of another in small steps. */
async function drag(page, from, to) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 })
  await page.mouse.up()
}

/** Text the grid puts on the clipboard for Ctrl+C (read from the copy event, no clipboard permission needed). */
async function copied(page) {
  await page.evaluate(() => document.addEventListener('copy', (e) => { window.__copied = e.clipboardData.getData('text/plain') }, { once: true }))
  await page.keyboard.press('Control+c')
  return page.evaluate(() => window.__copied)
}

test('drag across cells selects a block: Ctrl+C copies it as TSV, Delete clears it, a plain click still edits', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const db = await newDb(page, `Range ${uid()}`, { Owner: ['text'], Score: ['number'] })
  const rows = await addRows(page, db, [
    { Name: 'One', Owner: 'Ann', Score: 1 },
    { Name: 'Two', Owner: 'Bob', Score: 2 },
    { Name: 'Three', Owner: '=cmd', Score: -3 },
    { Name: 'Four', Owner: 'Dee', Score: 4 },
  ])
  const P = db.P
  await open(page, db)

  await drag(page, cell(page, rows[0].id, P.Owner.id), cell(page, rows[2].id, P.Score.id))
  await expect(page.locator('.db-td.is-in-range')).toHaveCount(6)
  await expect(page.locator('.db-inline-input')).toHaveCount(0) // the drag did not start editing
  await expect(cell(page, rows[3].id, P.Owner.id)).not.toHaveClass(/is-in-range/)
  await shot(page, 'range-cells')

  // spreadsheet-ready text; a formula-looking value is neutralised like CSV export, numbers are not
  expect(await copied(page)).toBe('Ann\t1\nBob\t2\n\'=cmd\t-3')

  await page.keyboard.press('Delete')
  await expect.poll(async () => (await load(page, db.module.id)).rows.map((r) => [r.values[P.Name.id], r.values[P.Owner.id] ?? null, r.values[P.Score.id] ?? null]))
    .toEqual([['One', null, null], ['Two', null, null], ['Three', null, null], ['Four', 'Dee', 4]])

  // shift+arrow extends from the cursor, shift+click extends from the anchor
  await cell(page, rows[0].id, P.Score.id).click()
  await page.keyboard.press('Escape') // leave the inline editor, keeping the cell selected
  await expect(page.locator('.db-table')).toBeFocused()
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.db-td.is-in-range')).toHaveCount(2)
  await cell(page, rows[3].id, P.Owner.id).click({ modifiers: ['Shift'] })
  await expect(page.locator('.db-td.is-in-range')).toHaveCount(8)
  await expect(page.locator('.db-inline-input')).toHaveCount(0)

  // a block of cells is not a row selection: the row menu stays single-row
  await cell(page, rows[1].id, P.Owner.id).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Delete row' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Delete \d+ rows/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // a plain click collapses the range and edits as before
  await cell(page, rows[1].id, P.Owner.id).click()
  await expect(page.locator('.db-inline-input')).toBeVisible()
  await expect(page.locator('.db-td.is-in-range')).toHaveCount(0)
  expect(w.errors).toEqual([])
})

test('drag down the gutter selects whole rows, which can be deleted together', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const db = await newDb(page, `Rows ${uid()}`, { Owner: ['text'] })
  const rows = await addRows(page, db, ['A', 'B', 'C', 'D', 'E'].map((Name) => ({ Name, Owner: Name.toLowerCase() })))
  await open(page, db)
  const gutter = (i) => page.locator(`.db-tr[data-row-id="${rows[i].id}"] .db-gutter`)

  await drag(page, gutter(1), gutter(3))
  await expect(page.locator('.db-tr.is-row-selected')).toHaveCount(3)
  await expect(page.getByRole('menu')).toHaveCount(0) // the drag did not open the row menu
  expect(await copied(page)).toBe('B\tb\nC\tc\nD\td')
  await shot(page, 'range-rows')

  await page.locator(`.db-tr[data-row-id="${rows[2].id}"] .db-td`).first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete 3 rows' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(page.locator('.db-tr')).toHaveCount(2)
  await expect.poll(async () => (await load(page, db.module.id)).rows.map((r) => r.values[db.P.Name.id])).toEqual(['A', 'E'])

  // outside a multi-row selection the row menu is the usual single-row one
  await page.locator(`.db-tr[data-row-id="${rows[0].id}"] .db-td`).first().click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Delete row' })).toBeVisible()
  expect(w.errors).toEqual([])
})

test('dragging past the bottom edge auto-scrolls and keeps extending the selection', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const db = await newDb(page, `Scroll ${uid()}`)
  const rows = await addRows(page, db, Array.from({ length: 80 }, (_, i) => ({ Name: `Row ${i + 1}` })))
  await open(page, db)
  const grid = page.locator('.db-table')
  const box = await grid.boundingBox()
  const first = await cell(page, rows[0].id, db.P.Name.id).boundingBox()
  await page.mouse.move(first.x + 20, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(first.x + 20, box.y + box.height - 4, { steps: 10 })
  await expect.poll(() => grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(300)
  await page.mouse.up()
  const count = await page.locator('.db-tr.is-row-selected, .db-td.is-selected, .db-td.is-in-range').count()
  expect(count).toBeGreaterThan(10)
  expect(await copied(page)).toMatch(/^Row 1\nRow 2\n[\s\S]*Row 2\d/)
  expect(w.errors).toEqual([])
})
