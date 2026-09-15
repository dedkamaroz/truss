import { test, expect } from '@playwright/test'
import { watch, boot, api, load, cell, uid, newDb, addRows, open, shot } from './helpers.js'

test('lookup returns the matched value, blank for an empty search, #N/A for no match, and follows changes', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const details = await newDb(page, `City details ${uid()}`, { State: ['text'], Population: ['number', { format: 'number_with_commas' }], Founded: ['date'], Capital: ['checkbox'] })
  const [sydney, hobart] = await addRows(page, details, [
    { Name: 'Sydney', State: 'NSW', Population: 5450496, Founded: { start: '1788-01-26' }, Capital: true },
    { Name: 'Hobart', State: 'TAS', Population: 251047, Founded: { start: '1804-02-20' }, Capital: true },
    { Name: 'sydney', State: 'Duplicate (second match)' },
  ])
  const visits = await newDb(page, `Visits ${uid()}`, { City: ['text'] })
  const look = async (name, ret) => (visits.P[name] = await api(page, 'POST', `${visits.base}/properties`, {
    name, type: 'lookup', config: { sourcePropertyId: visits.P.City.id, targetModuleId: details.module.id, matchPropertyId: details.P.Name.id, returnPropertyId: ret.id },
  }))
  await look('State', details.P.State)
  await look('Population', details.P.Population)
  await look('Founded', details.P.Founded)
  await look('Capital', details.P.Capital)
  const [a, b, c] = await addRows(page, visits, [{ Name: 'Trip 1', City: '  SYDNEY ' }, { Name: 'Trip 2', City: 'Perth' }, { Name: 'Trip 3' }])
  await open(page, visits)
  const P = visits.P

  await expect(cell(page, a.id, P.State.id)).toHaveText('NSW') // first match wins, case and spaces ignored
  await expect(cell(page, a.id, P.Population.id)).toHaveText('5,450,496')
  await expect(cell(page, a.id, P.Founded.id)).toHaveText('26/01/1788')
  await expect(cell(page, a.id, P.Capital.id).locator('.db-checkbox.is-checked')).toHaveCount(1)
  await expect(cell(page, b.id, P.State.id)).toHaveText('#N/A')
  await expect(cell(page, c.id, P.State.id)).toHaveText('')

  // editing the search value recomputes at once
  await api(page, 'PATCH', `${visits.base}/rows/${b.id}`, { values: { [P.City.id]: 'Hobart' } })
  await open(page, visits)
  await expect(cell(page, b.id, P.State.id)).toHaveText('TAS')

  // the other database changes on the server: the open view catches up
  await api(page, 'POST', `${details.base}/rows`, { values: { [details.P.Name.id]: 'Perth', [details.P.State.id]: 'WA' } })
  await api(page, 'PATCH', `${details.base}/rows/${hobart.id}`, { values: { [details.P.State.id]: 'Tasmania' } })
  await api(page, 'PATCH', `${visits.base}/rows/${c.id}`, { values: { [P.City.id]: 'Perth' } })
  await open(page, visits)
  await expect(cell(page, c.id, P.State.id)).toHaveText('WA')
  await api(page, 'PATCH', `${details.base}/rows/${sydney.id}`, { values: { [details.P.State.id]: 'New South Wales' } })
  await expect(cell(page, a.id, P.State.id)).toHaveText('New South Wales', { timeout: 8000 })
  await expect(cell(page, b.id, P.State.id)).toHaveText('Tasmania')

  // editing the search value in the table recomputes without a reload
  await cell(page, c.id, P.City.id).click()
  await page.locator('.db-inline-input').fill('hobart')
  await page.keyboard.press('Enter')
  await expect(cell(page, c.id, P.State.id)).toHaveText('Tasmania')
  await expect(cell(page, c.id, P.Population.id)).toHaveText('251,047')

  // sorting uses the looked-up numbers (Hobart 251,047 twice, then Sydney 5,450,496)
  await page.locator(`.db-th[data-prop="${P.Population.id}"]`).click()
  await expect(page.locator('.db-prop-menu .db-lookup-return-item')).toContainText('Population')
  await shot(page, 'lookup-menu')
  await page.locator('.db-prop-menu .menu-item', { hasText: 'Sort descending' }).click()
  await expect(page.locator('.db-tr').first()).toHaveAttribute('data-row-id', a.id)
  expect(w.errors).toEqual([])
})

test('lookup is created through the type picker and its settings dialog', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const details = await newDb(page, `Codes ${uid()}`, { Label: ['text'] })
  await addRows(page, details, [{ Name: 'AU', Label: 'Australia' }])
  const orders = await newDb(page, `Orders ${uid()}`, { Country: ['text'] })
  const [row] = await addRows(page, orders, [{ Name: 'Order 1', Country: 'au' }])
  await open(page, orders)
  await page.locator('.db-th-add').click()
  await page.locator('.db-type-item[data-type="lookup"]').click()
  const dialog = page.locator('.db-lookup-modal')
  await expect(dialog).toBeVisible()
  await dialog.locator('.db-lookup-source').selectOption(orders.P.Country.id)
  await dialog.locator('.db-lookup-target').selectOption(details.module.id)
  await expect(dialog.locator('.db-lookup-match')).toHaveValue(details.P.Name.id)
  await dialog.locator('.db-lookup-return').selectOption(details.P.Label.id)
  await shot(page, 'lookup-setup')
  await dialog.locator('.db-dialog-confirm').click()
  await expect(dialog).toHaveCount(0)
  const prop = (await load(page, orders.module.id)).properties.find((p) => p.type === 'lookup')
  expect(prop.config).toEqual({ sourcePropertyId: orders.P.Country.id, targetModuleId: details.module.id, matchPropertyId: details.P.Name.id, returnPropertyId: details.P.Label.id })
  await page.keyboard.press('Escape')
  await expect(cell(page, row.id, prop.id)).toHaveText('Australia')
  expect(w.errors).toEqual([])
})

test('lookup matches numbers regardless of display format, and reports cycles instead of hanging', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const prices = await newDb(page, `Prices ${uid()}`, { Code: ['number', { format: 'number_with_commas' }], Label: ['text'] })
  await addRows(page, prices, [{ Name: 'Big', Code: 1000, Label: 'One thousand' }])
  const orders = await newDb(page, `Coded orders ${uid()}`, { Code: ['number'] })
  const [row] = await addRows(page, orders, [{ Name: 'Order', Code: 1000 }])
  const look = await api(page, 'POST', `${orders.base}/properties`, {
    name: 'Label', type: 'lookup', config: { sourcePropertyId: orders.P.Code.id, targetModuleId: prices.module.id, matchPropertyId: prices.P.Code.id, returnPropertyId: prices.P.Label.id },
  })
  // a lookup in Prices that searches with a lookup in Orders that searches with it: a cycle
  const back = await api(page, 'POST', `${prices.base}/properties`, {
    name: 'Back', type: 'lookup', config: { sourcePropertyId: prices.P.Label.id, targetModuleId: orders.module.id, matchPropertyId: look.id, returnPropertyId: orders.P.Name.id },
  })
  await api(page, 'PATCH', `${orders.base}/properties/${look.id}`, { config: { matchPropertyId: back.id } })
  await open(page, orders)
  await expect(cell(page, row.id, look.id)).toHaveText(/#CYCLE!|#N\/A/)
  await api(page, 'PATCH', `${orders.base}/properties/${look.id}`, { config: { matchPropertyId: prices.P.Code.id } })
  await open(page, orders)
  await expect(cell(page, row.id, look.id)).toHaveText('One thousand')
  expect(w.errors).toEqual([])
})
