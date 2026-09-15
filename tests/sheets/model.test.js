import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkbookModel, shiftFormula, toTsv, parseTsv, fillLine, shiftSizeMap, normaliseFormat } from '../../web/modules/sheet/model.js'

function fakeApi() {
  const calls = []
  const rec = (method) => async (path, body) => {
    calls.push({ method, path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) })
    return {}
  }
  return { calls, token: 't', post: rec('POST'), patch: rec('PATCH'), put: rec('PUT'), del: rec('DELETE') }
}

function makeModel(sheets = [{ name: 'Sheet1', cells: [] }], opts = {}) {
  const api = fakeApi()
  const events = []
  const data = { module: { id: 'm1', title: opts.title || 'Book' }, sheets: sheets.map((s, i) => ({ id: `s${i + 1}`, col_widths: {}, row_heights: {}, frozen_rows: 0, frozen_cols: 0, ...s })) }
  const model = new WorkbookModel({ data, api, saveDelay: 5, onChange: (e) => events.push(e), loadExternal: opts.loadExternal })
  return { model, api, events }
}
const v = (m, sheet, a1) => {
  const col = a1.charCodeAt(0) - 65
  return m.getValue(sheet, Number(a1.slice(1)) - 1, col)
}

test('shiftFormula moves relative references and keeps absolute ones', () => {
  assert.equal(shiftFormula('=A1+B1', 1, 0), '=A2+B2')
  assert.equal(shiftFormula('=$A$1+A$1+$A1', 1, 1), '=$A$1+B$1+$A2')
  assert.equal(shiftFormula('=SUM(A1:A3)*Sheet2!C4', 2, 0), '=SUM(A3:A5)*Sheet2!C6')
  assert.equal(shiftFormula('=A1', -1, 0), '=#REF!')
  assert.equal(shiftFormula('plain', 3, 3), 'plain')
  assert.equal(shiftFormula('=SUM(B:B)', 5, 1), '=SUM(C:C)')
})

test('TSV stringify and parse are Excel compatible', () => {
  assert.deepEqual(parseTsv('1\t2\n3\t4'), [['1', '2'], ['3', '4']])
  assert.deepEqual(parseTsv('1\t2\r\n3\t4\r\n'), [['1', '2'], ['3', '4']])
  const rows = [['a\tb', 'say "hi"'], ['multi\nline', '']]
  const tsv = toTsv(rows)
  assert.equal(tsv, '"a\tb"\t"say ""hi"""\n"multi\nline"\t')
  assert.deepEqual(parseTsv(tsv), rows)
  assert.deepEqual(parseTsv('5" screen\tx'), [['5" screen', 'x']])
})

test('fillLine continues numeric series and shifts formulas', () => {
  assert.deepEqual(fillLine(['1', '2'], 3, 'row'), ['3', '4', '5'])
  assert.deepEqual(fillLine(['0.1', '0.2'], 2, 'row'), ['0.3', '0.4'])
  assert.deepEqual(fillLine(['10', '20'], 2, 'row', true), ['0', '-10'])
  assert.deepEqual(fillLine(['7'], 2, 'row'), ['7', '7'])
  assert.deepEqual(fillLine(['=A1*2'], 2, 'row'), ['=A2*2', '=A3*2'])
  assert.deepEqual(fillLine(['=A1', 'x'], 3, 'col'), ['=C1', 'x', '=E1'])
  assert.deepEqual(fillLine(['=B2'], 1, 'row', true), ['=B1'])
})

test('shiftSizeMap and normaliseFormat', () => {
  assert.deepEqual(shiftSizeMap({ 0: 50, 2: 80, 5: 90 }, 2, 2, true), { 0: 50, 4: 80, 7: 90 })
  assert.deepEqual(shiftSizeMap({ 0: 50, 2: 80, 5: 90 }, 1, 2, false), { 0: 50, 3: 90 })
  assert.equal(normaliseFormat({ bold: false, numberFormat: 'general' }), null)
  assert.deepEqual(normaliseFormat({ bold: true, fill: '' }), { bold: true })
})

test('recalculation: SUM and cross-sheet references update on edit', () => {
  const { model } = makeModel([{ name: 'Sheet1', cells: [] }, { name: 'Sheet2', cells: [] }])
  model.setCells('s1', [{ row: 0, col: 0, raw: '1' }, { row: 1, col: 0, raw: '2' }, { row: 2, col: 0, raw: '3' }, { row: 3, col: 0, raw: '=SUM(A1:A3)' }])
  model.setCells('s1', [{ row: 0, col: 1, raw: '=Sheet2!A1*2' }])
  assert.equal(v(model, 's1', 'A4'), 6)
  const changed = model.setCells('s1', [{ row: 1, col: 0, raw: '10' }])
  assert.equal(v(model, 's1', 'A4'), 14)
  assert.ok(changed.some((c) => c.row === 3 && c.col === 0), 'dependent reported as changed')
  model.setCells('s2', [{ row: 0, col: 0, raw: '21' }])
  assert.equal(v(model, 's1', 'B1'), 42)
})

test('clearing a cell removes its content but keeps its format', () => {
  const { model } = makeModel()
  model.setCells('s1', [{ row: 0, col: 0, raw: '5', format: { bold: true } }, { row: 1, col: 0, raw: '=A1+1' }])
  model.setCells('s1', [{ row: 0, col: 0, raw: null }])
  assert.equal(model.getRaw('s1', 0, 0), '')
  assert.equal(model.getValue('s1', 0, 0), null)
  assert.deepEqual(model.getFormat('s1', 0, 0), { bold: true })
  assert.equal(model.getValue('s1', 1, 0), 1)
  model.setCells('s1', [{ row: 0, col: 0, format: null }])
  assert.equal(model.getCell('s1', 0, 0), undefined)
})

test('saves are batched: 20 edits of one cell produce a single request', async () => {
  const { model, api } = makeModel()
  for (let i = 0; i < 20; i++) model.setCells('s1', [{ row: 0, col: 0, raw: 'x'.repeat(i + 1) }])
  await new Promise((r) => setTimeout(r, 30))
  await model.chain
  const saves = api.calls.filter((c) => c.path.endsWith('/cells'))
  assert.equal(saves.length, 1)
  assert.deepEqual(saves[0].body.cells, [{ sheet: 's1', row: 0, col: 0, raw: 'x'.repeat(20), format: null }])
})

test('undo and redo cover more than 50 steps including formatting', () => {
  const { model } = makeModel()
  for (let i = 1; i <= 60; i++) model.setCells('s1', [{ row: 0, col: 0, raw: String(i) }])
  model.setCells('s1', [{ row: 0, col: 0, format: { bold: true } }])
  assert.deepEqual(model.getFormat('s1', 0, 0), { bold: true })
  model.undo()
  assert.equal(model.getFormat('s1', 0, 0), null)
  for (let i = 0; i < 55; i++) model.undo()
  assert.equal(v(model, 's1', 'A1'), 5)
  for (let i = 0; i < 10; i++) model.redo()
  assert.equal(v(model, 's1', 'A1'), 15)
  model.setCells('s1', [{ row: 5, col: 5, raw: 'new' }])
  assert.equal(model.redo(), null, 'a new edit clears redo')
})

test('inserting a row inside a range rewrites formulas, persists, and undoes', async () => {
  const { model, api } = makeModel([{ name: 'Sheet1', cells: [] }, { name: 'Other', cells: [] }])
  const cells = []
  for (let r = 0; r < 10; r++) cells.push({ row: r, col: 0, raw: String(r + 1) })
  cells.push({ row: 0, col: 2, raw: '=SUM(A1:A10)' })
  model.setCells('s1', cells)
  model.setCells('s2', [{ row: 0, col: 0, raw: '=Sheet1!A10' }])
  model.setCells('s1', [{ row: 4, col: 0, format: { bold: true } }])
  model.insertRows('s1', 3, 1)
  assert.equal(model.getRaw('s1', 0, 2), '=SUM(A1:A11)')
  assert.equal(model.getRaw('s2', 0, 0), '=Sheet1!A11')
  assert.equal(model.getRaw('s1', 4, 0), '4')
  assert.deepEqual(model.getFormat('s1', 5, 0), { bold: true })
  assert.equal(model.getRaw('s1', 3, 0), '')
  model.setCells('s1', [{ row: 3, col: 0, raw: '100' }])
  assert.equal(v(model, 's1', 'C1'), 155)
  await new Promise((r) => setTimeout(r, 20))
  await model.chain
  const struct = api.calls.find((c) => c.path.endsWith('/structure'))
  assert.equal(struct.body.op, 'insert')
  assert.equal(struct.body.index, 3)
  assert.ok(struct.body.cells.some((c) => c.sheet === 's2' && c.raw === '=Sheet1!A11'))
  const cellSaveBefore = api.calls.findIndex((c) => c.path.endsWith('/cells'))
  assert.ok(cellSaveBefore < api.calls.indexOf(struct), 'pending edits are flushed before the structural change')

  model.undo() // the typed 100
  model.undo() // the insertion
  assert.equal(model.getRaw('s1', 0, 2), '=SUM(A1:A10)')
  assert.equal(model.getRaw('s2', 0, 0), '=Sheet1!A10')
  assert.equal(v(model, 's1', 'C1'), 55)
  model.redo()
  assert.equal(model.getRaw('s1', 0, 2), '=SUM(A1:A11)')
})

test('deleting a column turns references into #REF! and undo restores contents', () => {
  const { model } = makeModel()
  model.setCells('s1', [{ row: 0, col: 0, raw: '2' }, { row: 0, col: 1, raw: '3', format: { italic: true } }, { row: 0, col: 2, raw: '=A1*B1' }])
  model.deleteCols('s1', 1, 1)
  assert.equal(model.getRaw('s1', 0, 1), '=A1*#REF!')
  model.undo()
  assert.equal(model.getRaw('s1', 0, 1), '3')
  assert.deepEqual(model.getFormat('s1', 0, 1), { italic: true })
  assert.equal(model.getRaw('s1', 0, 2), '=A1*B1')
  assert.equal(v(model, 's1', 'C1'), 6)
})

test('renaming a sheet rewrites formulas in other sheets and sends them with the rename', async () => {
  const { model, api } = makeModel([{ name: 'Sheet1', cells: [] }, { name: 'Sheet2', cells: [] }])
  model.setCells('s2', [{ row: 0, col: 0, raw: '4' }])
  model.setCells('s1', [{ row: 0, col: 0, raw: '=Sheet2!A1+1' }])
  model.renameSheet('s2', 'Data Set')
  assert.equal(model.getRaw('s1', 0, 0), "='Data Set'!A1+1")
  assert.equal(v(model, 's1', 'A1'), 5)
  await model.chain
  const patch = api.calls.find((c) => c.method === 'PATCH')
  assert.equal(patch.body.name, 'Data Set')
  assert.deepEqual(patch.body.cells.map((c) => c.raw), ["='Data Set'!A1+1"])
  assert.match(WorkbookModel.validateName('data set', model), /already exists/)
  assert.equal(WorkbookModel.validateName('Fresh', model), null)
})

test('cross-workbook references resolve once the other workbook loads', async () => {
  const other = { module: { id: 'm2', title: 'Rates' }, sheets: [{ id: 'x', name: 'Sheet1', cells: [[0, 0, '7', null], [1, 0, '=A1*3', null]] }] }
  const requested = []
  const { model, events } = makeModel([{ name: 'Sheet1', cells: [[0, 0, '=[Rates]Sheet1!A2+1', null]] }], {
    loadExternal: async (title) => { requested.push(title); return title === 'Rates' ? other : null },
  })
  assert.deepEqual(model.getValue('s1', 0, 0), { error: '#N/A' })
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(requested, ['Rates'])
  assert.equal(model.getValue('s1', 0, 0), 22)
  assert.ok(events.some((e) => e.type === 'cells' && e.cells.some((c) => c.row === 0 && c.col === 0)))
  model.setCells('s1', [{ row: 1, col: 0, raw: '=[Missing]Sheet1!A1' }])
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(model.getValue('s1', 1, 0), { error: '#REF!' })
})

test('sheet add, move and delete keep the engine and requests in sync', async () => {
  const { model, api } = makeModel()
  model.setCells('s1', [{ row: 0, col: 0, raw: '=Later!A1' }])
  assert.deepEqual(model.getValue('s1', 0, 0), { error: '#REF!' })
  const later = model.addSheet('Later')
  model.setCells(later.id, [{ row: 0, col: 0, raw: '9' }])
  assert.equal(model.getValue('s1', 0, 0), 9)
  model.moveSheet(later.id, 0)
  assert.deepEqual(model.sheets.map((s) => s.name), ['Later', 'Sheet1'])
  model.deleteSheet(later.id)
  assert.equal(model.getRaw('s1', 0, 0), '=#REF!')
  await new Promise((r) => setTimeout(r, 20))
  await model.chain
  const kinds = api.calls.map((c) => `${c.method} ${c.path.replace(/\/api\/sheets\/m1/, '')}`)
  const addAt = kinds.findIndex((k) => k === 'POST /sheets')
  const cellsAt = api.calls.findIndex((c) => c.path.endsWith('/cells') && c.body.cells.some((x) => x.sheet === later.id))
  assert.ok(addAt >= 0 && addAt < cellsAt, `sheet created before its cells are saved: ${kinds}`)
  assert.ok(kinds.includes('PUT /order'))
  assert.ok(kinds.some((k) => k.startsWith('DELETE /sheets/')))
})
