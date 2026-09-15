import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { parse } from '../../web/lib/csv.js'
import { watch, boot, api, load, uid, newDb, addRows, open, scratch, apiCall } from './helpers.js'

async function download(page, label) {
  await page.locator('.db-more-btn').click()
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.menu-item', { hasText: label }).click()])
  const file = await dl.path()
  return { name: dl.suggestedFilename(), bytes: fs.readFileSync(file) }
}

async function seedExport(page) {
  const clients = await newDb(page, `Clients ${uid()}`)
  const [acme, blue] = await addRows(page, clients, [{ Name: 'Acme, Pty Ltd' }, { Name: 'Blue "Gum"' }])
  const db = await newDb(page, `Jobs ${uid()}`, {
    Notes: ['text'],
    Fee: ['number', { format: 'aud' }],
    Stage: ['select', { options: [{ name: 'Lead', color: 'gray' }, { name: 'Won', color: 'green' }] }],
    Tags: ['multi_select', { options: [{ name: 'KYC' }, { name: 'Urgent' }, { name: 'Renewal' }] }],
    Due: ['date'],
    Paid: ['checkbox'],
    Client: ['relation', { targetModuleId: clients.module.id }],
  })
  const P = db.P
  const opt = (p, n) => p.config.options.find((o) => o.name === n).id
  const rows = await addRows(page, db, [
    { Name: 'Onboard Acme', Notes: 'line one\nline two', Fee: 1250.5, Stage: opt(P.Stage, 'Won'), Tags: [opt(P.Tags, 'KYC'), opt(P.Tags, 'Urgent')], Due: { start: '2026-05-14' }, Paid: true, Client: [acme.id, blue.id] },
    { Name: 'Audit Blue Gum', Notes: 'hidden', Fee: 480, Stage: opt(P.Stage, 'Lead'), Tags: [opt(P.Tags, 'Renewal')], Due: { start: '2026-07-01' }, Paid: false, Client: [blue.id] },
    { Name: 'Renew licence', Notes: '', Fee: 3200, Stage: opt(P.Stage, 'Won'), Tags: [], Due: { start: '2026-12-25', end: '2026-12-31' }, Paid: true },
    { Name: 'Tiny job', Fee: 20, Stage: opt(P.Stage, 'Won'), Paid: true },
  ])
  for (const [name, width] of [['Name', 180], ['Fee', 110], ['Stage', 100], ['Tags', 150], ['Due', 190], ['Paid', 80], ['Client', 200]]) await api(page, 'PATCH', `${db.base}/properties/${P[name].id}`, { width })
  // view: only Won, fee descending, Notes hidden
  await api(page, 'PATCH', `${db.base}/views/${db.view.id}`, { config: {
    hidden: [P.Notes.id],
    sorts: [{ property: P.Fee.id, direction: 'desc' }],
    filter: { op: 'and', rules: [{ property: P.Stage.id, operator: 'is', value: opt(P.Stage, 'Won') }, { property: P.Fee.id, operator: 'gt', value: 100 }] },
  } })
  return { db, clients, rows }
}

for (const theme of ['light', 'dark']) {
  test(`export menu (${theme}): CSV of the filtered, sorted view with hidden properties, and JSON of the whole database`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, acceptDownloads: true })
    const page = await context.newPage()
    const w = await watch(page)
    await boot(page)
    await page.evaluate((t) => localStorage.setItem('truss.theme', t), theme)
    const { db, rows } = await seedExport(page)
    await open(page, db)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator('.db-tr')).toHaveCount(2)
    await page.locator('.db-more-btn').click()
    await expect(page.locator('.popover-menu .menu-item')).toHaveText(['Export this view as CSV', 'Export all rows as CSV', 'Export database as JSON', 'Import CSV into this database', 'Import as a new database'])
    fs.mkdirSync('test-results/database-relations-io', { recursive: true })
    await page.screenshot({ path: `test-results/database-relations-io/${theme}-export-menu.png` })
    await page.keyboard.press('Escape')

    const csv = await download(page, 'Export this view as CSV')
    expect(csv.name).toMatch(/^Jobs .* - Table\.csv$/)
    expect([...csv.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = csv.bytes.toString('utf8')
    expect(text).toContain('\r\n')
    const table = parse(text)
    expect(table).toEqual([
      ['Name', 'Fee', 'Stage', 'Tags', 'Due', 'Paid', 'Client'],
      ['Renew licence', '3200', 'Won', '', '25/12/2026 - 31/12/2026', 'true', ''],
      ['Onboard Acme', '1250.5', 'Won', 'KYC, Urgent', '14/05/2026', 'true', 'Acme, Pty Ltd, Blue "Gum"'],
    ])

    const all = parse((await download(page, 'Export all rows as CSV')).bytes.toString('utf8'))
    expect(all[0]).toEqual(['Name', 'Notes', 'Fee', 'Stage', 'Tags', 'Due', 'Paid', 'Client'])
    expect(all.length).toBe(5)
    expect(all[1][1]).toBe('line one\nline two')

    const json = await download(page, 'Export database as JSON')
    expect(json.name).toMatch(/\.json$/)
    const doc = JSON.parse(json.bytes.toString('utf8'))
    const server = await load(page, db.module.id)
    expect(doc.truss).toBe(1)
    expect(Object.keys(doc.database)).toEqual(expect.arrayContaining(['title', 'properties', 'views', 'rows']))
    expect(doc.database.title).toBe(db.module.title)
    expect(doc.database.properties.map((p) => [p.id, p.name, p.type, p.config])).toEqual(server.properties.map((p) => [p.id, p.name, p.type, p.config]))
    expect(doc.database.views.map((v) => [v.id, v.type, v.config])).toEqual(server.views.map((v) => [v.id, v.type, v.config]))
    expect(doc.database.rows.map((r) => [r.id, r.values])).toEqual(server.rows.map((r) => [r.id, r.values]))
    expect(doc.database.rows.find((r) => r.id === rows[0].id).values[db.P.Due.id]).toEqual({ start: '2026-05-14' })
    expect(doc.database.rows.every((r) => /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(r.created_at))).toBe(true)
    expect(w.errors).toEqual([])
    await context.close()
  })
}

test('JSON round trip: every property type, relations to existing targets, views and row values come back identical', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const target = await newDb(page, `Suppliers ${uid()}`)
  const [s1, s2] = await addRows(page, target, [{ Name: 'Harbour Paper' }, { Name: 'Wattle Print' }])
  const src = await newDb(page, `Everything ${uid()}`, {
    Notes: ['text'], Amount: ['number', { format: 'aud', decimals: 2 }], Kind: ['select', { options: [{ name: 'A', color: 'red' }, { name: 'B', color: 'blue' }] }],
    Tags: ['multi_select', { options: [{ name: 'x', color: 'green' }, { name: 'y', color: 'pink' }] }], Stage: ['status'], When: ['date'], Done: ['checkbox'],
    Site: ['url'], Mail: ['email'], Phone: ['phone'], Files: ['files'], Created: ['created_time'], Edited: ['last_edited_time'],
    Supplier: ['relation', { targetModuleId: target.module.id, twoWay: true }],
  })
  const P = src.P
  P.Parent = await api(page, 'POST', `${src.base}/properties`, { name: 'Parent', type: 'relation', config: { targetModuleId: src.module.id, twoWay: true } })
  P.Count = await api(page, 'POST', `${src.base}/properties`, { name: 'Supplier count', type: 'rollup', config: { relationPropertyId: P.Supplier.id, targetPropertyId: target.P.Name.id, fn: 'count' } })
  P.Double = await api(page, 'POST', `${src.base}/properties`, { name: 'Double', type: 'formula', config: { expression: 'prop("Amount") * 2' } })
  const [r1, r2] = await addRows(page, src, [
    { Name: 'First', Notes: 'Commas, "quotes"\nand lines', Amount: 99.95, Kind: P.Kind.config.options[1].id, Tags: P.Tags.config.options.map((o) => o.id), Stage: P.Stage.config.options[1].id,
      When: { start: '2026-02-28', end: '2026-03-03' }, Done: true, Site: 'https://example.com/a?b=c', Mail: 'ops@example.com.au', Phone: '+61 412 345 678', Supplier: [s2.id, s1.id] },
    { Name: 'Second' },
  ])
  const att = await page.evaluate(async ({ url }) => {
    const token = document.querySelector('meta[name="truss-token"]').content
    return (await fetch(url, { method: 'POST', headers: { 'X-Truss-Token': token, 'X-Filename': 'contract.txt' }, body: 'signed' })).json()
  }, { url: `/api/attachments?moduleId=${src.module.id}&pageId=${r1.id}` })
  await api(page, 'PATCH', `${src.base}/rows/${r1.id}`, { values: { [P.Files.id]: [att.id] } })
  await api(page, 'PATCH', `${src.base}/rows/${r2.id}`, { values: { [P.Parent.id]: [r1.id] }, notes: 'Some notes' })
  await api(page, 'PATCH', `${src.base}/views/${src.view.id}`, { name: 'Everything', config: { hidden: [P.Notes.id], sorts: [{ property: P.Amount.id, direction: 'asc' }], filter: { op: 'or', rules: [{ property: P.Done.id, operator: 'checked' }] } } })
  await api(page, 'POST', `${src.base}/views`, { name: 'By kind', type: 'board', config: { group_by: P.Kind.id } })
  await api(page, 'POST', `${src.base}/views`, { name: 'Dates', type: 'calendar', config: { date_property: P.When.id } })
  const before = await load(page, src.module.id)

  await open(page, src)
  await page.locator('.db-more-btn').click()
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.menu-item', { hasText: 'Export database as JSON' }).click()])
  const file = scratch(`roundtrip-${uid()}.json`, fs.readFileSync(await dl.path()))

  // import through the sidebar Import page
  const modulesBefore = (await apiCall(page, 'GET', '/api/modules')).body.length
  await page.locator('.sidebar-link', { hasText: 'Import' }).click()
  await expect(page.locator('.db-import-drop')).toBeVisible()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.db-import-drop').click()])
  await chooser.setFiles(file)
  await expect(page.locator('.toast-success', { hasText: 'Imported 2 rows' })).toBeVisible()
  await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1)
  const modules = (await apiCall(page, 'GET', '/api/modules')).body
  expect(modules.length).toBe(modulesBefore + 1)
  const newId = page.url().split('/m/')[1]
  expect(newId).not.toBe(src.module.id)
  await expect(page.locator(`.sidebar-item[data-id="${newId}"]`)).toBeVisible()
  const after = await load(page, newId)

  // properties: same names, types and configs (ids of this database mapped to their new ids)
  const pmap = new Map(before.properties.map((p, i) => [p.id, after.properties[i].id]))
  const rmap = new Map(before.rows.map((r, i) => [r.id, after.rows[i].id]))
  const mapId = (id) => pmap.get(id) ?? rmap.get(id) ?? id
  expect(after.properties.map((p) => [p.name, p.type, p.width])).toEqual(before.properties.map((p) => [p.name, p.type, p.width]))
  for (const [i, p] of before.properties.entries()) {
    const q = after.properties[i]
    const expected = JSON.parse(JSON.stringify(p.config))
    if (p.type === 'relation') {
      if (expected.targetModuleId === src.module.id) expected.targetModuleId = newId
      expected.reversePropertyId = p.id === P.Supplier.id ? q.config.reversePropertyId : mapId(p.config.reversePropertyId)
    }
    if (p.type === 'rollup') expected.relationPropertyId = mapId(p.config.relationPropertyId)
    expect(q.config, p.name).toEqual(expected)
  }
  const supplier = after.properties.find((p) => p.name === 'Supplier')
  expect(supplier.config.targetModuleId).toBe(target.module.id)
  // views
  const mapConfig = (c) => JSON.parse(JSON.stringify(c), (k, v) => (typeof v === 'string' && pmap.has(v) ? pmap.get(v) : v))
  expect(after.views.map((v) => [v.name, v.type, v.config])).toEqual(before.views.map((v) => [v.name, v.type, mapConfig(v.config)]))
  // rows
  for (const [i, r] of before.rows.entries()) {
    const a = after.rows[i]
    const expected = {}
    for (const [k, v] of Object.entries(r.values)) {
      if (k === P.Files.id) continue
      expected[mapId(k)] = Array.isArray(v) && (k === P.Parent.id || before.properties.find((p) => p.id === k).config.targetModuleId === src.module.id) ? v.map(mapId) : v
    }
    const { [pmap.get(P.Files.id)]: files, ...rest } = a.values
    expect(rest, `row ${i + 1}`).toEqual(expected)
    if (r.values[P.Files.id]) expect(files).toHaveLength(1)
    expect([a.notes, a.created_at, a.updated_at]).toEqual([r.notes, r.created_at, r.updated_at])
  }
  const copied = (await apiCall(page, 'GET', `/api/attachments?moduleId=${newId}`)).body
  expect(copied.map((x) => x.filename)).toEqual(['contract.txt'])
  // the UI of the imported copy computes the rollup and formula again
  await expect(page.locator(`.db-td[data-prop="${pmap.get(P.Double.id)}"]`, { hasText: '199.9' })).toHaveCount(1)
  expect(w.errors).toEqual([])
})
