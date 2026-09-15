import { test, expect } from '@playwright/test'
import { watch, boot, api, load, cell, uid, newDb, addRows, open, rowValues } from './helpers.js'

async function addPropertyViaUi(page, type) {
  await page.locator('.db-th-add').click()
  await page.locator(`.db-type-item[data-type="${type}"]`).click()
}

test('two-way relation: create via UI, link and unlink with the searchable picker, both sides stay in sync', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const tasks = await newDb(page, `Tasks ${uid()}`)
  const projects = await newDb(page, `Projects ${uid()}`)
  const [write, review, ship] = await addRows(page, tasks, [{ Name: 'Write brief' }, { Name: 'Review contract' }, { Name: 'Ship release' }])
  const [launch] = await addRows(page, projects, [{ Name: 'Launch' }])
  await open(page, projects)

  // create the relation through the type picker and the relation dialog
  await addPropertyViaUi(page, 'relation')
  const dialog = page.locator('.db-relation-modal')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.db-dialog-confirm')).toBeDisabled()
  await dialog.locator('.db-rel-db-search').fill(tasks.module.title.slice(0, 8))
  await dialog.locator(`.db-rel-db[data-module-id="${tasks.module.id}"]`).click()
  await expect(dialog.locator('.db-rel-twoway input')).toBeChecked()
  await dialog.locator('.db-dialog-confirm').click()
  await expect(page.locator('.db-th[data-type="relation"]')).toHaveCount(1)
  await expect(page.locator('.db-prop-menu')).toBeVisible() // the new column opens its menu for renaming
  await page.keyboard.press('Escape')
  await expect(page.locator('.db-prop-menu')).toHaveCount(0)

  const pd = await load(page, projects.module.id)
  const rel = pd.properties.find((p) => p.type === 'relation')
  expect(rel.config).toMatchObject({ targetModuleId: tasks.module.id, twoWay: true })
  const td = await load(page, tasks.module.id)
  const reverse = td.properties.find((p) => p.id === rel.config.reversePropertyId)
  expect(reverse).toMatchObject({ type: 'relation', name: projects.module.title })

  // link two tasks through the picker (search narrows the list)
  await cell(page, launch.id, rel.id).click()
  const picker = page.locator('.db-rel-editor')
  await expect(picker.locator('.db-rel-row')).toHaveCount(3)
  await picker.locator('.db-rel-search').fill('rev')
  await expect(picker.locator('.db-rel-row')).toHaveCount(1)
  await picker.locator(`.db-rel-row[data-row-id="${review.id}"]`).click()
  await picker.locator('.db-rel-search').fill('')
  await picker.locator(`.db-rel-row[data-row-id="${write.id}"]`).click()
  await expect(picker.locator('.db-rel-row.is-selected')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(cell(page, launch.id, rel.id).locator('.db-rel-chip')).toHaveText(['Review contract', 'Write brief'])
  await expect.poll(async () => (await rowValues(page, projects)).get(launch.id)[rel.id]).toEqual([review.id, write.id])
  let tv = await rowValues(page, tasks)
  expect(tv.get(review.id)[reverse.id]).toEqual([launch.id])
  expect(tv.get(write.id)[reverse.id]).toEqual([launch.id])
  expect(tv.get(ship.id)[reverse.id]).toBeUndefined()

  // the other side shows the link in its UI
  await open(page, tasks)
  await expect(cell(page, review.id, reverse.id).locator('.db-rel-chip')).toHaveText(['Launch'])

  // unlink from the Tasks side: Projects follows
  await cell(page, review.id, reverse.id).click()
  await page.locator(`.db-rel-editor .db-rel-row.is-selected[data-row-id="${launch.id}"]`).click()
  await page.keyboard.press('Escape')
  await expect(cell(page, review.id, reverse.id).locator('.db-rel-chip')).toHaveCount(0)
  await expect.poll(async () => (await rowValues(page, projects)).get(launch.id)[rel.id]).toEqual([write.id])

  // deleting a task row (row menu + confirm) removes its id from Projects
  await page.locator(`.db-tr[data-row-id="${write.id}"]`).click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Delete row' }).click()
  await page.locator('.modal-confirm .btn-danger').click()
  await expect(page.locator(`.db-tr[data-row-id="${write.id}"]`)).toHaveCount(0)
  await expect.poll(async () => (await rowValues(page, projects)).get(launch.id)[rel.id]).toBeUndefined()
  await open(page, projects)
  await expect(cell(page, launch.id, rel.id).locator('.db-rel-chip')).toHaveCount(0)

  // deleting the relation property asks with a custom confirm naming the reverse property, then removes both
  await page.locator(`.db-th[data-prop="${rel.id}"]`).click()
  await page.locator('.db-prop-menu .menu-item', { hasText: 'Delete property' }).click()
  const confirm = page.locator('.modal-confirm')
  await expect(confirm).toContainText(`"${reverse.name}" property`)
  await confirm.locator('.btn-danger').click()
  await expect(page.locator('.db-th[data-type="relation"]')).toHaveCount(0)
  await expect.poll(async () => (await load(page, tasks.module.id)).properties.some((p) => p.id === reverse.id)).toBe(false)
  expect((await load(page, projects.module.id)).properties.some((p) => p.id === rel.id)).toBe(false)
  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})

test('same-database relation: link rows inside one database, the reverse column updates in place', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const people = await newDb(page, `People ${uid()}`)
  const [boss, alex, sam] = await addRows(page, people, [{ Name: 'Morgan (boss)' }, { Name: 'Alex' }, { Name: 'Sam' }])
  await open(page, people)
  await page.locator('.db-th-add').click()
  await page.locator('.db-type-item[data-type="relation"]').click()
  await page.locator(`.db-rel-db[data-module-id="${people.module.id}"]`).click()
  await page.locator('.db-relation-modal .db-dialog-confirm').click()
  await expect(page.locator('.db-th[data-type="relation"]')).toHaveCount(2)
  await expect(page.locator('.db-prop-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.db-prop-menu')).toHaveCount(0)
  const d = await load(page, people.module.id)
  const [rel, reverse] = d.properties.filter((p) => p.type === 'relation')
  expect(rel.config).toMatchObject({ targetModuleId: people.module.id, twoWay: true, reversePropertyId: reverse.id })
  expect(reverse.config.reversePropertyId).toBe(rel.id)

  for (const r of [alex, sam]) {
    await cell(page, r.id, rel.id).click()
    await page.locator('.db-rel-search').fill('boss')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
  }
  await expect(cell(page, alex.id, rel.id).locator('.db-rel-chip')).toHaveText(['Morgan (boss)'])
  await expect(cell(page, boss.id, reverse.id).locator('.db-rel-chip')).toHaveText(['Alex', 'Sam'])
  const v = await rowValues(page, people)
  expect(v.get(boss.id)[reverse.id]).toEqual([alex.id, sam.id])

  // creating a new row from the picker links it too
  await cell(page, sam.id, rel.id).click()
  await page.locator('.db-rel-search').fill('Priya')
  await page.locator('.db-rel-editor .db-opt-create').click()
  await page.keyboard.press('Escape')
  await expect(cell(page, sam.id, rel.id).locator('.db-rel-chip')).toHaveText(['Morgan (boss)', 'Priya'])
  const after = await load(page, people.module.id)
  const priya = after.rows.find((r) => r.values[after.properties[0].id] === 'Priya')
  expect(priya.values[reverse.id]).toEqual([sam.id])
  expect(w.errors).toEqual([])
})

test('the picker renders at most 50 rows of a large related database, with a narrowing hint and search', async ({ page }) => {
  await boot(page)
  const big = await newDb(page, `Big ${uid()}`)
  await api(page, 'POST', `${big.base}/rows/batch`, { create: Array.from({ length: 180 }, (_, i) => ({ values: { [big.P.Name.id]: `Item ${i + 1}` } })) })
  const host = await newDb(page, `Host ${uid()}`, { Items: ['relation', { targetModuleId: big.module.id }] })
  const [row] = await addRows(page, host, [{ Name: 'Host row' }])
  await open(page, host)
  await cell(page, row.id, host.P.Items.id).click()
  await expect(page.locator('.db-rel-editor .db-rel-row')).toHaveCount(50)
  await expect(page.locator('.db-rel-more')).toContainText('Showing 50 of 180')
  await page.locator('.db-rel-search').fill('Item 17')
  await expect(page.locator('.db-rel-editor .db-rel-row')).toHaveCount(11) // 17, 170-179
})
