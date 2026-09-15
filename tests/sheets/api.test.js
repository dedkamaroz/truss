import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from '../server-core/helpers.js'

let t
before(async () => { t = await boot() })
after(async () => { await t.s.close() })

const newWorkbook = async (template = 'blank', title) => (await t.call('POST', '/api/modules', { json: { type: 'sheet', template, title } })).json
const load = async (id) => (await t.call('GET', `/api/sheets/${id}`)).json
const cellMap = (sheet) => new Map(sheet.cells.map(([r, c, raw, format]) => [`${r},${c}`, { raw, format }]))

test('templates: blank and monthly budget are listed', async () => {
  const list = (await t.call('GET', '/api/templates')).json.filter((x) => x.type === 'sheet').map((x) => x.key)
  assert.deepEqual(list.sort(), ['blank', 'monthly-budget'])
})

test('blank workbook loads with a single empty Sheet1', async () => {
  const m = await newWorkbook()
  const data = await load(m.id)
  assert.equal(data.module.id, m.id)
  assert.equal(data.sheets.length, 1)
  assert.equal(data.sheets[0].name, 'Sheet1')
  assert.deepEqual(data.sheets[0].cells, [])
  assert.deepEqual(data.sheets[0].col_widths, {})
  assert.equal(data.sheets[0].frozen_rows, 0)
})

test('monthly budget: Income, Expenses, Summary with cross-sheet SUM and AUD currency', async () => {
  const m = await newWorkbook('monthly-budget')
  const data = await load(m.id)
  assert.deepEqual(data.sheets.map((s) => s.name), ['Income', 'Expenses', 'Summary'])
  const summary = cellMap(data.sheets[2])
  const totalIncome = [...summary.values()].find((c) => /^=SUM\(Income!/i.test(c.raw || ''))
  const totalExp = [...summary.values()].find((c) => /^=SUM\(Expenses!/i.test(c.raw || ''))
  assert.ok(totalIncome && totalExp, 'summary has cross-sheet SUM formulas')
  assert.equal(totalIncome.format.numberFormat, 'currency')
  assert.equal(cellMap(data.sheets[0]).get('1,1').format.numberFormat, 'currency')
})

test('batch cell upsert, format update and delete', async () => {
  const m = await newWorkbook()
  const sheet = (await load(m.id)).sheets[0].id
  let r = await t.call('POST', `/api/sheets/${m.id}/cells`, { json: { cells: [
    { sheet, row: 0, col: 0, raw: '1' },
    { sheet, row: 1, col: 0, raw: '=A1*2', format: { bold: true } },
    { sheet, row: 2, col: 3, raw: null, format: { fill: 'yellow' } },
  ] } })
  assert.equal(r.status, 200)
  let cells = cellMap((await load(m.id)).sheets[0])
  assert.equal(cells.size, 3)
  assert.equal(cells.get('1,0').raw, '=A1*2')
  assert.deepEqual(cells.get('1,0').format, { bold: true })
  assert.equal(cells.get('2,3').raw, null)

  r = await t.call('POST', `/api/sheets/${m.id}/cells`, { json: { cells: [
    { sheet, row: 0, col: 0, raw: '5' },
    { sheet, row: 2, col: 3, raw: null, format: null },
  ] } })
  cells = cellMap((await load(m.id)).sheets[0])
  assert.equal(cells.get('0,0').raw, '5')
  assert.equal(cells.has('2,3'), false)
})

test('cell validation rejects foreign sheets and bad coordinates atomically', async () => {
  const a = await newWorkbook()
  const b = await newWorkbook()
  const sa = (await load(a.id)).sheets[0].id
  const sb = (await load(b.id)).sheets[0].id
  let r = await t.call('POST', `/api/sheets/${a.id}/cells`, { json: { cells: [{ sheet: sa, row: 0, col: 0, raw: 'x' }, { sheet: sb, row: 0, col: 0, raw: 'y' }] } })
  assert.equal(r.status, 400)
  r = await t.call('POST', `/api/sheets/${a.id}/cells`, { json: { cells: [{ sheet: sa, row: -1, col: 0, raw: 'x' }] } })
  assert.equal(r.status, 400)
  assert.equal((await load(a.id)).sheets[0].cells.length, 0)
  r = await t.call('GET', '/api/sheets/does-not-exist')
  assert.equal(r.status, 404)
})

test('sheet CRUD: add, rename with rewrites, duplicate names, reorder, delete', async () => {
  const m = await newWorkbook()
  const s1 = (await load(m.id)).sheets[0]
  let r = await t.call('POST', `/api/sheets/${m.id}/sheets`, { json: {} })
  assert.equal(r.status, 201)
  const s2 = r.json
  assert.equal(s2.name, 'Sheet2')
  r = await t.call('POST', `/api/sheets/${m.id}/sheets`, { json: { name: 'sheet2' } })
  assert.equal(r.status, 409)
  r = await t.call('POST', `/api/sheets/${m.id}/sheets`, { json: { name: 'Bad[name]' } })
  assert.equal(r.status, 400)

  r = await t.call('PATCH', `/api/sheets/${m.id}/sheets/${s2.id}`, { json: { name: 'Data', frozen_rows: 1, col_widths: { 0: 180 }, cells: [{ sheet: s1.id, row: 0, col: 0, raw: '=Data!A1*2' }] } })
  assert.equal(r.status, 200)
  assert.equal(r.json.name, 'Data')
  assert.equal(r.json.frozen_rows, 1)
  assert.deepEqual(r.json.col_widths, { 0: 180 })

  r = await t.call('PUT', `/api/sheets/${m.id}/order`, { json: { ids: [s2.id, s1.id] } })
  assert.equal(r.status, 200)
  let data = await load(m.id)
  assert.deepEqual(data.sheets.map((s) => s.name), ['Data', 'Sheet1'])
  assert.equal(cellMap(data.sheets[1]).get('0,0').raw, '=Data!A1*2')

  r = await t.call('PUT', `/api/sheets/${m.id}/order`, { json: { ids: [s2.id] } })
  assert.equal(r.status, 400)

  // Node only sends a DELETE body with an explicit Content-Length (browsers always set it).
  const delBody = { cells: [{ sheet: s1.id, row: 0, col: 0, raw: '=#REF!*2' }] }
  r = await t.call('DELETE', `/api/sheets/${m.id}/sheets/${s2.id}`, { json: delBody, headers: { 'Content-Length': Buffer.byteLength(JSON.stringify(delBody)) } })
  assert.equal(r.status, 200)
  data = await load(m.id)
  assert.deepEqual(data.sheets.map((s) => s.name), ['Sheet1'])
  assert.equal(cellMap(data.sheets[0]).get('0,0').raw, '=#REF!*2')
  r = await t.call('DELETE', `/api/sheets/${m.id}/sheets/${s1.id}`)
  assert.equal(r.status, 409)
})

test('structure: inserting and deleting rows and columns shifts stored cells', async () => {
  const m = await newWorkbook()
  const sheet = (await load(m.id)).sheets[0].id
  const cells = []
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) cells.push({ sheet, row: r, col: c, raw: `${r}-${c}` })
  await t.call('POST', `/api/sheets/${m.id}/cells`, { json: { cells } })

  let r = await t.call('POST', `/api/sheets/${m.id}/sheets/${sheet}/structure`, { json: { axis: 'row', op: 'insert', index: 2, count: 2, row_heights: { 5: 40 }, cells: [{ sheet, row: 0, col: 5, raw: '=SUM(A1:A7)' }] } })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.row_heights, { 5: 40 })
  let map = cellMap((await load(m.id)).sheets[0])
  assert.equal(map.get('1,0').raw, '1-0')
  assert.equal(map.has('2,0'), false)
  assert.equal(map.has('3,0'), false)
  assert.equal(map.get('4,0').raw, '2-0')
  assert.equal(map.get('6,2').raw, '4-2')
  assert.equal(map.get('0,5').raw, '=SUM(A1:A7)')

  r = await t.call('POST', `/api/sheets/${m.id}/sheets/${sheet}/structure`, { json: { axis: 'col', op: 'delete', index: 1, count: 1 } })
  assert.equal(r.status, 200)
  map = cellMap((await load(m.id)).sheets[0])
  assert.equal(map.get('0,0').raw, '0-0')
  assert.equal(map.get('0,1').raw, '0-2')
  assert.equal(map.has('0,2'), false)
  assert.equal(map.get('0,4').raw, '=SUM(A1:A7)')

  r = await t.call('POST', `/api/sheets/${m.id}/sheets/${sheet}/structure`, { json: { axis: 'row', op: 'delete', index: 0, count: 2 } })
  map = cellMap((await load(m.id)).sheets[0])
  assert.equal(map.has('0,0'), false)
  assert.equal(map.get('2,0').raw, '2-0')

  r = await t.call('POST', `/api/sheets/${m.id}/sheets/${sheet}/structure`, { json: { axis: 'diag', op: 'insert', index: 0 } })
  assert.equal(r.status, 400)
})

test('deleting the module cascades worksheets and cells', async () => {
  const m = await newWorkbook('monthly-budget')
  await t.call('DELETE', `/api/modules/${m.id}`)
  const left = t.s.ctx.db.prepare('SELECT COUNT(*) AS n FROM worksheets WHERE module_id = ?').get(m.id).n
  assert.equal(left, 0)
  const orphanCells = t.s.ctx.db.prepare('SELECT COUNT(*) AS n FROM cells WHERE sheet_id NOT IN (SELECT id FROM worksheets)').get().n
  assert.equal(orphanCells, 0)
})

test('bulk save of 36,000 cells is fast', async () => {
  const m = await newWorkbook()
  const sheet = (await load(m.id)).sheets[0].id
  const cells = []
  for (let r = 0; r < 1000; r++) for (let c = 0; c < 36; c++) cells.push({ sheet, row: r, col: c, raw: String(r * c) })
  const t0 = performance.now()
  const r = await t.call('POST', `/api/sheets/${m.id}/cells`, { json: { cells } })
  assert.equal(r.status, 200)
  const data = await load(m.id)
  const ms = performance.now() - t0
  assert.equal(data.sheets[0].cells.length, 36000)
  assert.ok(ms < 3000, `save + load took ${ms} ms`)
})
