import { test, expect } from '@playwright/test'
import { watch, boot, api, uid, newDb, addRows, open, cell, shot, layoutProblems } from './helpers.js'

async function seed(page) {
  const tasks = await newDb(page, `Onboarding tasks ${uid()}`, { Hours: ['number'], Done: ['checkbox'], Due: ['date'] })
  const t = await addRows(page, tasks, [
    { Name: 'Collect ASIC extract', Hours: 1.5, Done: true, Due: { start: '2026-09-02' } },
    { Name: 'Verify director IDs', Hours: 3, Done: true, Due: { start: '2026-09-09' } },
    { Name: 'Sign engagement letter', Hours: 0.5, Done: false, Due: { start: '2026-09-18' } },
    { Name: 'Screen PEP and sanctions', Hours: 2, Done: false, Due: { start: '2026-09-25' } },
    { Name: 'Upload source of funds', Hours: 4, Done: true, Due: { start: '2026-10-01' } },
    { Name: 'Close out file review', Hours: 1, Done: false, Due: { start: '2026-10-08' } },
  ])
  const clients = await newDb(page, `Client onboarding ${uid()}`, { Fee: ['number', { format: 'aud' }], Seats: ['number'] })
  const P = clients.P
  await api(page, 'PATCH', `${clients.base}/properties/${P.Name.id}`, { width: 190 })
  P.Tasks = await api(page, 'POST', `${clients.base}/properties`, { name: 'Tasks', type: 'relation', width: 195, config: { targetModuleId: tasks.module.id, twoWay: true } })
  const roll = async (name, target, fn, width) => (P[name] = await api(page, 'POST', `${clients.base}/properties`, { name, type: 'rollup', width, config: { relationPropertyId: P.Tasks.id, targetPropertyId: target?.id ?? null, fn } }))
  await roll('Tasks done', tasks.P.Done, 'percent_checked', 105)
  await roll('Hours', tasks.P.Hours, 'sum', 80)
  await roll('Next due', tasks.P.Due, 'latest_date', 110)
  P.Total = await api(page, 'POST', `${clients.base}/properties`, { name: 'Total', type: 'formula', width: 100, config: { expression: 'prop("Fee") * prop("Seats")' } })
  P.Check = await api(page, 'POST', `${clients.base}/properties`, { name: 'Check', type: 'formula', width: 90, config: { expression: 'prop("Fee") / prop("Seats")' } })
  for (const [name, w] of [['Fee', 100], ['Seats', 70]]) await api(page, 'PATCH', `${clients.base}/properties/${P[name].id}`, { width: w })
  const rows = await addRows(page, clients, [
    { Name: 'Harbour Logistics', Fee: 1250, Seats: 3, Tasks: [t[0].id, t[1].id, t[2].id] },
    { Name: 'Blue Gum Advisory', Fee: 480, Seats: 2, Tasks: [t[3].id] },
    { Name: 'Southern Paper Co', Fee: 3200, Seats: 0, Tasks: [t[4].id, t[5].id] },
    { Name: 'Wattle Street Cafe', Fee: 150, Seats: 1 },
  ])
  return { tasks, clients, rows, t }
}

for (const theme of ['light', 'dark']) {
  test(`visual ${theme}: relation, rollup and formula columns, relation picker, relation and formula dialogs, import page`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
    const page = await context.newPage()
    const w = await watch(page)
    await boot(page)
    await page.evaluate((th) => localStorage.setItem('truss.theme', th), theme)
    const { clients, rows } = await seed(page)
    await open(page, clients)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(cell(page, rows[0].id, clients.P.Tasks.id).locator('.db-rel-chip')).toHaveCount(3)
    expect(await page.locator('.db-table').evaluate((s) => s.scrollWidth - s.clientWidth)).toBeLessThanOrEqual(0)
    expect(await layoutProblems(page)).toEqual([])
    await page.mouse.move(700, 850)
    await shot(page, `${theme}-table-computed`)

    // relation picker
    await cell(page, rows[1].id, clients.P.Tasks.id).click()
    await expect(page.locator('.db-rel-editor')).toBeVisible()
    await page.locator('.db-rel-editor .db-rel-row').nth(2).hover()
    expect(await layoutProblems(page)).toEqual([])
    await shot(page, `${theme}-relation-picker`)
    await page.locator('.db-rel-search').fill('ver')
    await shot(page, `${theme}-relation-picker-search`)
    await page.keyboard.press('Escape')

    // peek shows relation chips wrapped
    await page.locator(`.db-tr[data-row-id="${rows[0].id}"]`).hover()
    await page.locator(`.db-tr[data-row-id="${rows[0].id}"] .db-open-btn`).click()
    await expect(page.locator('.db-peek')).toBeVisible()
    await page.mouse.move(300, 850)
    await shot(page, `${theme}-peek-computed`)
    await page.keyboard.press('Escape')

    // relation dialog
    await page.locator('.db-th-add').click()
    await page.locator('.db-type-item[data-type="relation"]').click()
    await page.locator(`.db-rel-db[data-module-id="${clients.module.id}"]`).click()
    expect(await layoutProblems(page)).toEqual([])
    await shot(page, `${theme}-relation-dialog`)
    await page.keyboard.press('Escape')

    // formula dialog
    await page.locator(`.db-th[data-prop="${clients.P.Total.id}"]`).click()
    await page.locator('.db-prop-menu .db-formula-edit').click()
    await expect(page.locator('.db-formula-modal')).toBeVisible()
    await shot(page, `${theme}-formula-dialog`)
    await page.keyboard.press('Escape')

    // rollup dialog
    await page.locator(`.db-th[data-prop="${clients.P.Hours.id}"]`).click()
    await page.locator('.db-prop-menu .db-rollup-fn-item').click()
    await shot(page, `${theme}-rollup-dialog`)
    await page.keyboard.press('Escape')

    // import page
    await page.locator('.sidebar-link', { hasText: 'Import' }).click()
    await expect(page.locator('.db-import-drop')).toBeVisible()
    await shot(page, `${theme}-import-page`)
    expect(w.errors).toEqual([])
    await context.close()
  })
}
