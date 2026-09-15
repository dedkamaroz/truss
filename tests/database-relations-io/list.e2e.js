import { test, expect } from '@playwright/test'
import { watch, boot, api, apiCall, load, cell, uid, newDb, addRows, open, shot } from './helpers.js'

const rowByTitle = (data, title) => data.rows.find((r) => r.values[data.properties.find((p) => p.type === 'title').id] === title)

test('list column: rows follow the source database, lookups fill new rows, removed entries are flagged', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const cities = await newDb(page, `Cities ${uid()}`)
  const [sydney, , darwin] = await addRows(page, cities, [{ Name: 'Sydney' }, { Name: 'Melbourne' }, { Name: 'Darwin' }])
  const details = await newDb(page, `City details ${uid()}`, { State: ['text'] })
  await addRows(page, details, [{ Name: 'Sydney', State: 'NSW' }, { Name: 'Hobart', State: 'TAS' }, { Name: 'Darwin', State: 'NT' }])

  const offices = await newDb(page, `Offices ${uid()}`, { Staff: ['number'] })
  offices.P.City = await api(page, 'POST', `${offices.base}/properties`, { name: 'City', type: 'list', config: { sourceModuleId: cities.module.id } })
  offices.P.State = await api(page, 'POST', `${offices.base}/properties`, {
    name: 'State', type: 'lookup', config: { sourcePropertyId: offices.P.City.id, targetModuleId: details.module.id, matchPropertyId: details.P.Name.id, returnPropertyId: details.P.State.id },
  })
  let data = await load(page, offices.module.id)
  expect(data.rows.map((r) => r.values[offices.P.Name.id])).toEqual(['Sydney', 'Melbourne', 'Darwin'])
  const syd = rowByTitle(data, 'Sydney')
  expect(syd.values[offices.P.City.id]).toEqual({ id: sydney.id, text: 'Sydney' })

  await open(page, offices)
  const P = offices.P
  await expect(cell(page, syd.id, P.City.id)).toHaveText('Sydney')
  await expect(cell(page, syd.id, P.State.id)).toHaveText('NSW')
  await expect(page.locator('.db-root')).toHaveClass(/is-rows-locked/)
  await expect(page.locator('.db-add-row')).toBeHidden()
  await expect(page.locator('.db-new')).toBeHidden()
  // other columns stay editable
  await api(page, 'PATCH', `${offices.base}/rows/${syd.id}`, { values: { [P.Staff.id]: 12 } })

  // a new source entry appears in the open view with its lookup already filled
  await api(page, 'POST', `${cities.base}/rows`, { values: { [cities.P.Name.id]: 'Hobart' } })
  const hobartCell = page.locator(`.db-td[data-prop="${P.State.id}"]`, { hasText: 'TAS' })
  await expect(hobartCell).toHaveCount(1, { timeout: 8000 })

  // a rename follows through to the list cell and the untouched title
  await api(page, 'PATCH', `${cities.base}/rows/${sydney.id}`, { values: { [cities.P.Name.id]: 'Sydney CBD' } })
  await expect(cell(page, syd.id, P.City.id)).toHaveText('Sydney CBD', { timeout: 8000 })
  await expect(cell(page, syd.id, P.Name.id)).toContainText('Sydney CBD')

  // a deleted source entry: the row stays with its data, flagged
  data = await load(page, offices.module.id)
  const dar = rowByTitle(data, 'Darwin')
  await api(page, 'DELETE', `${cities.base}/rows/${darwin.id}`)
  await expect(cell(page, dar.id, P.City.id).locator('.db-list-missing')).toBeVisible({ timeout: 8000 })
  await expect(cell(page, dar.id, P.City.id)).toContainText('Darwin')
  await shot(page, 'list-column')

  // rows still in the source can't be deleted; flagged rows can
  expect((await apiCall(page, 'DELETE', `${offices.base}/rows/${syd.id}`)).status).toBe(400)
  expect((await apiCall(page, 'POST', `${offices.base}/rows`, { values: {} })).status).toBe(400)
  await api(page, 'DELETE', `${offices.base}/rows/${dar.id}`)
  expect((await load(page, offices.module.id)).rows.map((r) => r.values[P.Name.id]).sort()).toEqual(['Hobart', 'Melbourne', 'Sydney CBD'])
  expect(w.errors.filter((e) => !/40[04]/.test(e))).toEqual([])
})

test('list column is added through the type picker; existing rows are matched by title', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const cities = await newDb(page, `Capitals ${uid()}`)
  await addRows(page, cities, [{ Name: 'Canberra' }, { Name: 'Perth' }])
  const trips = await newDb(page, `Trips ${uid()}`)
  const [perthRow, otherRow] = await addRows(page, trips, [{ Name: 'perth' }, { Name: 'Somewhere else' }])
  await open(page, trips)
  await page.locator('.db-th-add').click()
  await page.locator('.db-type-item[data-type="list"]').click()
  const dialog = page.locator('.db-relation-modal')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.db-rel-twoway')).toHaveCount(0)
  await expect(dialog.locator(`.db-rel-db[data-module-id="${trips.module.id}"]`)).toHaveCount(0) // not itself
  await dialog.locator(`.db-rel-db[data-module-id="${cities.module.id}"]`).click()
  await dialog.locator('.db-dialog-confirm').click()
  await expect(dialog).toHaveCount(0)
  await page.keyboard.press('Escape')

  const data = await load(page, trips.module.id)
  const list = data.properties.find((p) => p.type === 'list')
  expect(list.config).toMatchObject({ sourceModuleId: cities.module.id })
  const perth = data.rows.find((r) => r.id === perthRow.id)
  expect(perth.values[list.id].text).toBe('Perth') // matched, not duplicated
  expect(data.rows.length).toBe(3) // perth, somewhere else (flagged), Canberra (added)
  await expect(cell(page, otherRow.id, list.id).locator('.db-list-missing')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.db-root')).toHaveClass(/is-rows-locked/)
  expect(w.errors).toEqual([])
})

test('deleting the source database keeps the rows, flags them and unlocks new rows', async ({ page }) => {
  await boot(page)
  const cities = await newDb(page, `Source ${uid()}`)
  await addRows(page, cities, [{ Name: 'Adelaide' }])
  const offices = await newDb(page, `Linked ${uid()}`)
  const list = await api(page, 'POST', `${offices.base}/properties`, { name: 'City', type: 'list', config: { sourceModuleId: cities.module.id } })
  await api(page, 'DELETE', `/api/modules/${cities.module.id}`)
  const data = await load(page, offices.module.id)
  expect(list.id in data.rows[0].values).toBe(true)
  expect(data.properties.find((p) => p.id === list.id).config).toEqual({ sourceModuleId: null, sourceDeleted: true })
  await open(page, offices)
  await expect(cell(page, data.rows[0].id, list.id)).toContainText('Adelaide')
  await expect(cell(page, data.rows[0].id, list.id).locator('.db-list-missing')).toBeVisible()
  await expect(page.locator('.db-root')).not.toHaveClass(/is-rows-locked/)
  await api(page, 'POST', `${offices.base}/rows`, { values: {} })
})
