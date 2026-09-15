import { test, expect } from '@playwright/test'
import { watch, boot, api, load, cell, uid, newDb, addRows, open } from './helpers.js'

async function seedProjects(page) {
  const tasks = await newDb(page, `Tasks ${uid()}`, { Hours: ['number'], Done: ['checkbox'], Due: ['date'] })
  const projects = await newDb(page, `Projects ${uid()}`, { Price: ['number', { format: 'aud' }], Qty: ['number'] })
  const [t1, t2, t3, t4] = await addRows(page, tasks, [
    { Name: 'Design', Hours: 4, Done: true, Due: { start: '2026-03-02' } },
    { Name: 'Build', Hours: 10, Done: false, Due: { start: '2026-04-15' } },
    { Name: 'Test', Hours: 7, Done: true, Due: { start: '2026-03-20' } },
    { Name: 'Docs', Hours: 2, Done: false, Due: { start: '2026-01-05' } },
  ])
  projects.P.Tasks = await api(page, 'POST', `${projects.base}/properties`, { name: 'Tasks', type: 'relation', config: { targetModuleId: tasks.module.id, twoWay: true } })
  const roll = async (name, target, fn) => (projects.P[name] = await api(page, 'POST', `${projects.base}/properties`, { name, type: 'rollup', config: { relationPropertyId: projects.P.Tasks.id, targetPropertyId: target?.id ?? null, fn } }))
  await roll('Task count', null, 'count')
  await roll('Total hours', tasks.P.Hours, 'sum')
  await roll('Avg hours', tasks.P.Hours, 'average')
  await roll('Done %', tasks.P.Done, 'percent_checked')
  await roll('Latest due', tasks.P.Due, 'latest_date')
  const [alpha, beta, gamma] = await addRows(page, projects, [
    { Name: 'Alpha', Price: 12.5, Qty: 4, Tasks: [t1.id, t2.id, t3.id] },
    { Name: 'Beta', Price: 100, Qty: 1, Tasks: [t4.id] },
    { Name: 'Gamma', Price: 3, Qty: 30, Tasks: [] },
  ])
  return { tasks, projects, t: [t1, t2, t3, t4], rows: { alpha, beta, gamma } }
}

test('rollups show count, sum, average, percent checked and latest date, and update without a reload', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { tasks, projects, t, rows } = await seedProjects(page)
  const P = projects.P
  await open(page, projects)
  const a = rows.alpha.id
  await expect(cell(page, a, P['Task count'].id)).toHaveText('3')
  await expect(cell(page, a, P['Total hours'].id)).toHaveText('21')
  await expect(cell(page, a, P['Avg hours'].id)).toHaveText('7')
  await expect(cell(page, a, P['Done %'].id)).toHaveText('66.7%')
  await expect(cell(page, a, P['Latest due'].id)).toHaveText('15/04/2026')
  await expect(cell(page, rows.beta.id, P['Done %'].id)).toHaveText('0%')
  await expect(cell(page, rows.gamma.id, P['Task count'].id)).toHaveText('0')
  await expect(cell(page, rows.gamma.id, P['Latest due'].id)).toHaveText('')

  // a related task changes on the server (another window, script or API): the open view catches up
  await api(page, 'PATCH', `${tasks.base}/rows/${t[1].id}`, { values: { [tasks.P.Hours.id]: 16, [tasks.P.Done.id]: true, [tasks.P.Due.id]: { start: '2026-06-30' } } })
  await expect(cell(page, a, P['Total hours'].id)).toHaveText('27', { timeout: 8000 })
  await expect(cell(page, a, P['Avg hours'].id)).toHaveText('9')
  await expect(cell(page, a, P['Done %'].id)).toHaveText('100%')
  await expect(cell(page, a, P['Latest due'].id)).toHaveText('30/06/2026')

  // linking through the picker updates rollups immediately
  await cell(page, rows.gamma.id, P.Tasks.id).click()
  await page.locator(`.db-rel-editor .db-rel-row[data-row-id="${t[3].id}"]`).click()
  await page.keyboard.press('Escape')
  await expect(cell(page, rows.gamma.id, P['Task count'].id)).toHaveText('1')
  await expect(cell(page, rows.gamma.id, P['Total hours'].id)).toHaveText('2')
  await expect(cell(page, rows.gamma.id, P['Latest due'].id)).toHaveText('05/01/2026')

  // the rollup's settings are reachable from its column menu
  await page.locator(`.db-th[data-prop="${P['Total hours'].id}"]`).click()
  await expect(page.locator('.db-prop-menu .db-rollup-fn-item')).toContainText('Sum')
  await page.locator('.db-prop-menu .db-rollup-fn-item').click()
  await page.locator('.db-rollup-fn').selectOption('max')
  await page.locator('.db-modal .db-dialog-confirm').click()
  await expect(cell(page, a, P['Total hours'].id)).toHaveText('16')
  expect((await load(page, projects.module.id)).properties.find((p) => p.id === P['Total hours'].id).config.fn).toBe('max')
  expect(w.errors).toEqual([])
})

test('formula prop("Price") * prop("Qty") computes per row, follows edits, and shows errors distinctly', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { projects, rows } = await seedProjects(page)
  await open(page, projects)
  await page.locator('.db-th-add').click()
  await page.locator('.db-type-item[data-type="formula"]').click()
  const editor = page.locator('.db-formula-modal')
  await editor.locator('.db-formula-input').fill('prop("Price") *')
  await expect(editor.locator('.db-formula-preview')).toHaveClass(/is-error/)
  await expect(editor.locator('.db-formula-preview')).toContainText('Syntax error')
  await editor.locator('.db-formula-input').fill('')
  await editor.locator('.db-formula-chip', { hasText: 'Price' }).click()
  await editor.locator('.db-formula-input').pressSequentially(' * ')
  await editor.locator('.db-formula-chip', { hasText: 'Qty' }).click()
  await expect(editor.locator('.db-formula-input')).toHaveValue('prop("Price") * prop("Qty")')
  await expect(editor.locator('.db-formula-preview-value')).toHaveText('50')
  await editor.locator('.db-dialog-confirm').click()
  await expect(page.locator('.db-prop-menu')).toBeVisible()
  await page.locator('.db-prop-menu .db-prop-name').fill('Total')
  await page.keyboard.press('Enter')
  const total = (await load(page, projects.module.id)).properties.find((p) => p.type === 'formula')
  expect(total.config.expression).toBe('prop("Price") * prop("Qty")')
  await expect(cell(page, rows.alpha.id, total.id)).toHaveText('50')
  await expect(cell(page, rows.beta.id, total.id)).toHaveText('100')
  await expect(cell(page, rows.gamma.id, total.id)).toHaveText('90')

  // editing an input recomputes the row
  await cell(page, rows.beta.id, projects.P.Qty.id).click()
  await page.keyboard.type('7')
  await page.keyboard.press('Enter')
  await expect(cell(page, rows.beta.id, total.id)).toHaveText('700')

  // bad formulas: syntax error and unknown property render as error badges, not values
  const bad = await api(page, 'POST', `${projects.base}/properties`, { name: 'Broken', type: 'formula', config: { expression: 'prop("Price") *' } })
  const missing = await api(page, 'POST', `${projects.base}/properties`, { name: 'Missing', type: 'formula', config: { expression: 'prop("Nope") + 1' } })
  const div = await api(page, 'POST', `${projects.base}/properties`, { name: 'Ratio', type: 'formula', config: { expression: 'prop("Price") / (prop("Qty") - 4)' } })
  await open(page, projects)
  await expect(cell(page, rows.alpha.id, bad.id).locator('.db-formula-error')).toHaveText('Syntax error')
  await expect(cell(page, rows.alpha.id, missing.id).locator('.db-formula-error')).toHaveText('#REF!')
  await expect(cell(page, rows.alpha.id, div.id).locator('.db-formula-error')).toHaveText('#DIV/0!')
  await expect(cell(page, rows.beta.id, div.id).locator('.db-formula-error')).toHaveCount(0)
  const color = await cell(page, rows.alpha.id, bad.id).locator('.db-formula-error').evaluate((e) => getComputedStyle(e).color)
  const normal = await cell(page, rows.alpha.id, total.id).evaluate((e) => getComputedStyle(e).color)
  expect(color).not.toBe(normal)
  expect(w.errors).toEqual([])
})

test('sorting and filtering by formula and rollup values', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { projects, rows } = await seedProjects(page)
  const total = await api(page, 'POST', `${projects.base}/properties`, { name: 'Total', type: 'formula', config: { expression: 'prop("Price") * prop("Qty")' } })
  await open(page, projects)
  const order = () => page.locator('.db-tr').evaluateAll((trs) => trs.map((tr) => tr.dataset.rowId))
  const { alpha, beta, gamma } = rows

  // sort by formula descending through the column menu
  await page.locator(`.db-th[data-prop="${total.id}"]`).click()
  await page.locator('.db-prop-menu .menu-item', { hasText: 'Sort descending' }).click()
  await expect.poll(order).toEqual([beta.id, gamma.id, alpha.id]) // 100, 90, 50
  // sort by rollup (Total hours) ascending
  await page.locator(`.db-th[data-prop="${projects.P['Total hours'].id}"]`).click()
  await page.locator('.db-prop-menu .menu-item', { hasText: 'Sort ascending' }).click()
  await expect.poll(order).toEqual([gamma.id, beta.id, alpha.id]) // 0, 2, 21

  // filter by formula > 60 (number operators are offered for a numeric formula)
  await page.locator(`.db-th[data-prop="${total.id}"]`).click()
  await page.locator('.db-prop-menu .menu-item', { hasText: 'Filter' }).click()
  const rule = page.locator('.db-filter-menu .db-filter-row').last()
  await rule.locator('select[aria-label="Filter operator"]').selectOption('gt')
  await rule.locator('input.db-filter-value').fill('60')
  await expect.poll(order).toEqual([gamma.id, beta.id])
  await rule.locator('input.db-filter-value').fill('40')
  await expect.poll(order).toEqual([gamma.id, beta.id, alpha.id])
  // and by a percent rollup: Done % > 50 (alpha is 66.7%)
  await page.locator('.db-filter-menu > .db-filter-rules > .db-config-foot .db-add-filter').click()
  const rule2 = page.locator('.db-filter-menu > .db-filter-rules > .db-filter-row').last()
  await rule2.locator('select[aria-label="Filter property"]').selectOption(projects.P['Done %'].id)
  await rule2.locator('select[aria-label="Filter operator"]').selectOption('gt')
  await rule2.locator('input.db-filter-value').fill('50')
  await expect.poll(order).toEqual([alpha.id])
  // a date rollup offers date operators: Latest due on or before 01/03/2026 matches only beta (05/01/2026)
  await rule2.locator('select[aria-label="Filter property"]').selectOption(projects.P['Latest due'].id)
  await rule2.locator('select[aria-label="Filter operator"]').selectOption('on_or_before')
  await rule2.locator('input.db-filter-value').fill('01/03/2026')
  await expect.poll(order).toEqual([beta.id])
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await load(page, projects.module.id)).views[0].config.sorts).toEqual([{ property: projects.P['Total hours'].id, direction: 'asc' }])
  expect(w.errors).toEqual([])
})
