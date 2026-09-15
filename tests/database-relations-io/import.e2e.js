import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { stringify } from '../../web/lib/csv.js'
import { watch, boot, api, load, uid, newDb, addRows, open, scratch, apiCall, layoutProblems } from './helpers.js'

const BOM = String.fromCharCode(0xfeff)

/** A CSV the way Excel saves "CSV UTF-8": BOM, CRLF, quoted fields only where needed. */
function excelCsv(rows) {
  return BOM + stringify(rows, { eol: '\r\n' })
}

async function chooseImportFile(page, file) {
  await page.goto('/#/import')
  await expect(page.locator('.db-import-drop')).toBeVisible()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.db-import-drop').click()])
  await chooser.setFiles(file)
}

const moduleCount = async (page) => (await apiCall(page, 'GET', '/api/modules')).body.length

for (const theme of ['light', 'dark']) {
  test(`CSV import (${theme}): preview infers types from an Excel CSV, types can be overridden, values land correctly`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
    const page = await context.newPage()
    const w = await watch(page)
    await boot(page)
    await page.evaluate((t) => localStorage.setItem('truss.theme', t), theme)
    const name = `Clients ${uid()}`
    const file = scratch(`${name}.csv`, excelCsv([
      ['Client', 'Fee', 'Verified', 'Due', 'Stage', 'Website', 'Email', 'Notes', 'Code'],
      ['Harbour Logistics', '$1,250.50', 'TRUE', '14/05/2026', 'Won', 'https://harbour.example.com', 'ops@harbour.com.au', 'Director ID, ASIC "extract"', '1001'],
      ['Blue Gum Advisory', '$480.00', 'FALSE', '02/09/2026', 'Lead', 'https://bluegum.example.com', 'hi@bluegum.com.au', 'Call back\r\nafter 3 pm', '1002'],
      ['Southern Paper Co', '$3,200.00', 'TRUE', '31/12/2026', 'Won', 'https://southern.example.com', 'am@southern.com.au', '', '1003'],
      ['Coastal Dental', '', 'FALSE', '1/2/2027', 'Lost', 'https://coastal.example.com', 'desk@coastal.com.au', 'Plain', '1004'],
      ['Wattle Cafe', '$150.00', 'TRUE', '28/02/2027', 'Won', 'https://wattle.example.com', 'cafe@wattle.com.au', 'Unique note', '1005'],
    ]))
    expect(fs.readFileSync(file).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    const before = await moduleCount(page)
    await chooseImportFile(page, file)
    const dialog = page.locator('.db-import-modal')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.db-import-summary')).toContainText('5 rows')
    const typeOf = (col) => dialog.locator(`.db-import-col[data-column="${col}"] select.db-import-type`)
    const expected = { Client: 'title', Fee: 'number', Verified: 'checkbox', Due: 'date', Stage: 'select', Website: 'url', Email: 'email', Notes: 'text', Code: 'number' }
    for (const [col, type] of Object.entries(expected)) await expect(typeOf(col), col).toHaveValue(type)
    await expect(dialog.locator('.db-import-col[data-column="Fee"] .db-import-sample').first()).toHaveText('$1,250.50')
    // override: Code is an identifier, keep it as text; rename Client to Name
    await typeOf('Code').selectOption('text')
    await dialog.locator('.db-import-col[data-column="Client"] .db-import-col-name').fill('Name')
    expect(await layoutProblems(page)).toEqual([])
    await page.mouse.move(10, 890)
    await page.screenshot({ path: `test-results/database-relations-io/${theme}-import-preview.png` })
    await dialog.locator('.db-import-confirm').click()
    await expect(page.locator('.toast-success', { hasText: 'Imported 5 rows' })).toBeVisible()
    await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1)
    expect(await moduleCount(page)).toBe(before + 1)

    const id = page.url().split('/m/')[1]
    const d = await load(page, id)
    expect(d.module.title).toBe(name)
    const P = Object.fromEntries(d.properties.map((p) => [p.name, p]))
    expect(d.properties.map((p) => [p.name, p.type])).toEqual([['Name', 'title'], ['Fee', 'number'], ['Verified', 'checkbox'], ['Due', 'date'], ['Stage', 'select'], ['Website', 'url'], ['Email', 'email'], ['Notes', 'text'], ['Code', 'text']])
    expect(P.Fee.config.format).toBe('aud')
    expect(P.Stage.config.options.map((o) => o.name)).toEqual(['Won', 'Lead', 'Lost'])
    const opt = (n) => P.Stage.config.options.find((o) => o.name === n).id
    const v = (i) => d.rows[i].values
    expect(v(0)).toEqual({ [P.Name.id]: 'Harbour Logistics', [P.Fee.id]: 1250.5, [P.Verified.id]: true, [P.Due.id]: { start: '2026-05-14' }, [P.Stage.id]: opt('Won'), [P.Website.id]: 'https://harbour.example.com', [P.Email.id]: 'ops@harbour.com.au', [P.Notes.id]: 'Director ID, ASIC "extract"', [P.Code.id]: '1001' })
    expect(v(1)[P.Notes.id]).toBe('Call back\r\nafter 3 pm')
    expect(v(1)[P.Verified.id]).toBeUndefined()
    expect(v(3)[P.Fee.id]).toBeUndefined()
    expect(v(3)[P.Due.id]).toEqual({ start: '2027-02-01' })
    expect(d.rows.length).toBe(5)
    await expect(page.locator('.db-tr')).toHaveCount(5)
    expect(w.errors).toEqual([])
    await context.close()
  })
}

test('CSV into an existing database: columns map to properties, rows are appended, missing options are created', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const db = await newDb(page, `Scores ${uid()}`, { Score: ['number'], Tag: ['select', { options: [{ name: 'Gold', color: 'yellow' }] }], Joined: ['date'], Formula: ['formula', { expression: 'prop("Score") * 10' }] })
  await addRows(page, db, [{ Name: 'Existing', Score: 1 }])
  const file = scratch(`scores-${uid()}.csv`, excelCsv([
    ['Full name', 'Points', 'tag', 'Joined', 'Ignored'],
    ['Riley', '12', 'Gold', '03/04/2026', 'x'],
    ['Casey', '7.5', 'Silver', '2026-04-05', 'y'],
    ['Jordan', 'n/a', '', '', 'z'],
  ]))
  await open(page, db)
  await page.locator('.db-more-btn').click()
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.menu-item', { hasText: 'Import CSV into this database' }).click()])
  await chooser.setFiles(file)
  const dialog = page.locator('.db-import-modal')
  await expect(dialog).toBeVisible()
  const map = (col) => dialog.locator(`.db-import-col[data-column="${col}"] select.db-import-map`)
  await expect(map('tag')).toHaveValue(db.P.Tag.id) // matched by name, case-insensitive
  await expect(map('Joined')).toHaveValue(db.P.Joined.id)
  await expect(map('Full name')).toHaveValue('')
  await expect(map('Full name').locator('option')).toHaveText(['Do not import', 'Name', 'Score', 'Tag', 'Joined']) // read-only formula is not offered
  await map('Full name').selectOption(db.P.Name.id)
  await map('Points').selectOption(db.P.Score.id)
  await dialog.locator('.db-import-confirm').click()
  await expect(page.locator('.toast-success', { hasText: 'Added 3 rows' })).toBeVisible()
  await expect(page.locator('.db-tr')).toHaveCount(4)
  await expect(page.locator(`.db-td[data-prop="${db.P.Formula.id}"]`, { hasText: '120' })).toHaveCount(1)
  const d = await load(page, db.module.id)
  const tag = d.properties.find((p) => p.id === db.P.Tag.id)
  expect(tag.config.options.map((o) => o.name)).toEqual(['Gold', 'Silver'])
  const vals = d.rows.map((r) => r.values)
  expect(vals).toEqual([
    { [db.P.Name.id]: 'Existing', [db.P.Score.id]: 1 },
    { [db.P.Name.id]: 'Riley', [db.P.Score.id]: 12, [db.P.Tag.id]: tag.config.options[0].id, [db.P.Joined.id]: { start: '2026-04-03' } },
    { [db.P.Name.id]: 'Casey', [db.P.Score.id]: 7.5, [db.P.Tag.id]: tag.config.options[1].id, [db.P.Joined.id]: { start: '2026-04-05' } },
    { [db.P.Name.id]: 'Jordan' },
  ])
  expect(w.errors).toEqual([])
})

test('a 10,000-row CSV imports into a new database in under 5 seconds', async ({ page }) => {
  await boot(page)
  const stages = ['Lead', 'Won', 'Lost', 'Paused']
  const rows = [['Name', 'Amount', 'Paid', 'Due', 'Stage', 'Email', 'Notes']]
  for (let i = 0; i < 10_000; i++) {
    rows.push([`Client ${i + 1}`, `$${(i * 13.7).toFixed(2)}`, i % 3 ? 'TRUE' : 'FALSE', `${String((i % 28) + 1).padStart(2, '0')}/${String((i % 12) + 1).padStart(2, '0')}/2026`, stages[i % 4], `c${i}@example.com`, `Note ${i}, with a comma`])
  }
  const file = scratch(`big-${uid()}.csv`, excelCsv(rows))
  const started = Date.now()
  await chooseImportFile(page, file)
  await page.locator('.db-import-confirm').click()
  await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1, { timeout: 15_000 })
  const elapsed = Date.now() - started
  console.log(`10,000-row CSV: preview, import and open took ${elapsed} ms`)
  expect(elapsed).toBeLessThan(5000)
  const id = page.url().split('/m/')[1]
  const d = await load(page, id)
  expect(d.rows.length).toBe(10_000)
  expect(d.properties.map((p) => p.type)).toEqual(['title', 'number', 'checkbox', 'date', 'select', 'email', 'text'])
  expect(d.rows[9999].values[d.properties[0].id]).toBe('Client 10000')
})

test('malformed files show an error toast and create nothing', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const before = await moduleCount(page)
  const cases = [
    ['broken.csv', `${BOM}Name,Notes\r\n"Unclosed,quote\r\nnext,row\r\n`, /Unterminated quoted field/],
    ['junk-after-quote.csv', 'Name,Amount\n"Acme"x,1\n', /Unexpected text after a closing quote/],
    ['header-only.csv', 'Name,Amount\r\n', /no rows to import/],
    ['binary.csv', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), /not CSV text/],
    ['broken.json', '{"truss": 1, "database": {', /not valid JSON/],
    ['other.json', '{"hello": "world"}', /not a Truss database export/],
    ['bad-values.json', JSON.stringify({ truss: 1, database: { title: 'Bad', properties: [{ id: 'n', name: 'N', type: 'title' }, { id: 'q', name: 'Qty', type: 'number' }], rows: [{ values: { n: 'a', q: 'NaN' } }] } }), /Row 1/],
  ]
  for (const [name, content, message] of cases) {
    await chooseImportFile(page, scratch(`${uid()}-${name}`, content))
    await expect(page.locator('.toast-error', { hasText: message })).toBeVisible()
    await expect(page.locator('.db-import-modal')).toHaveCount(0)
    await page.locator('.toast-error .toast-close').first().click()
  }
  expect(await moduleCount(page)).toBe(before)
  expect(w.errors.filter((e) => !/status of 400/.test(e))).toEqual([])
})
