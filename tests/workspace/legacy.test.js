import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot } from '../server-core/helpers.js'
import { htmlToMarkup } from '../../server/legacy.js'
import { startServer } from '../../server/main.js'

async function ok(call, method, path, json) {
  const r = await call(method, path, json === undefined ? {} : { json })
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${r.text}`)
  return r.json
}

test('legacy rich text becomes inline markup', () => {
  assert.equal(htmlToMarkup('Select <b>bold</b>, <i>italic</i>, <s>gone</s>, <code>x &lt; y</code>'), 'Select **bold**, *italic*, ~~gone~~, `x < y`')
  assert.equal(htmlToMarkup('<a href="https://example.com">site</a> and <a href="https://a.io">https://a.io</a>'), 'site (https://example.com) and https://a.io')
  assert.equal(htmlToMarkup('line one<br>line two&nbsp;&amp; more'), 'line one\nline two & more')
  assert.equal(htmlToMarkup('<b> padded </b>'), ' **padded** ')
})

test('legacy databases, workbooks and notebooks convert into workspace documents and the legacy tables stay intact', async () => {
  const b = await boot()
  const { call } = b
  try {
    const tasks = await ok(call, 'POST', '/api/modules', { type: 'database', template: 'task_tracker', title: 'Tasks' })
    const projects = await ok(call, 'POST', '/api/modules', { type: 'database', title: 'Projects' })
    const pdata = await ok(call, 'GET', `/api/databases/${projects.id}`)
    const p1 = await ok(call, 'POST', `/api/databases/${projects.id}/rows`, { values: { [pdata.properties.find((p) => p.type === 'title').id]: 'Hosting' }, notes: 'First paragraph.\n\nSecond paragraph.' })
    const rel = await ok(call, 'POST', `/api/databases/${tasks.id}/properties`, { name: 'Project', type: 'relation', config: { targetModuleId: projects.id, twoWay: true } })
    const dateProp = await ok(call, 'POST', `/api/databases/${tasks.id}/properties`, { name: 'Window', type: 'date' })
    const tdata = await ok(call, 'GET', `/api/databases/${tasks.id}`)
    const row = tdata.rows[0]
    await ok(call, 'PATCH', `/api/databases/${tasks.id}/rows/${row.id}`, { values: { [rel.id]: [p1.id], [dateProp.id]: { start: '2026-09-01', end: '2026-09-30' } } })

    const wb = await ok(call, 'POST', '/api/modules', { type: 'sheet', template: 'blank', title: 'Budget' })
    const sheets = await ok(call, 'GET', `/api/sheets/${wb.id}`)
    const sid = sheets.sheets[0].id
    await ok(call, 'POST', `/api/sheets/${wb.id}/cells`, { cells: [
      { sheet: sid, row: 0, col: 0, raw: 'Item', format: { bold: true } },
      { sheet: sid, row: 1, col: 1, raw: '12.5', format: { numberFormat: 'currency', fill: 'yellow', color: 'red' } },
      { sheet: sid, row: 2, col: 1, raw: '=B2*2' },
    ] })

    const nb = await ok(call, 'POST', '/api/modules', { type: 'notebook', template: 'text', title: 'Notes' })
    const tnb = await ok(call, 'POST', '/api/modules', { type: 'notebook', template: 'table', title: 'Tables' })

    const before = await ok(call, 'GET', `/api/databases/${tasks.id}`)
    const w = await ok(call, 'GET', '/api/v2/workspace')
    const by = Object.fromEntries(w.modules.map((m) => [m.module.id, m]))
    assert.equal(w.modules.length, 5)
    for (const m of w.modules) assert.equal(m.version, 1)

    const T = by[tasks.id].module
    assert.equal(T.type, 'database')
    assert.ok(T.props.some((p) => p.type === 'title'))
    const tStatus = T.props.find((p) => p.type === 'status')
    assert.ok(tStatus.config.options.length >= 3)
    const tRel = T.props.find((p) => p.id === rel.id)
    assert.equal(tRel.config.targetId, projects.id)
    assert.ok(tRel.config.reversePropId, 'two-way relation keeps its reverse property')
    assert.equal(T.rows.length, tdata.rows.length)
    const tRow = T.rows.find((r) => r.id === row.id)
    assert.deepEqual(tRow.cells[rel.id], [p1.id])
    assert.deepEqual(tRow.cells[dateProp.id], { start: '2026-09-01', end: '2026-09-30' })
    const board = T.views.find((v) => v.type === 'board')
    assert.equal(board.groupBy, tStatus.id)

    const P = by[projects.id].module
    const reverse = P.props.find((p) => p.id === tRel.config.reversePropId)
    assert.equal(reverse.config.targetId, tasks.id)
    const pRow = P.rows.find((r) => r.id === p1.id)
    assert.deepEqual(pRow.body.map((x) => x.text), ['First paragraph.', 'Second paragraph.'])
    assert.deepEqual(pRow.cells[reverse.id], [row.id])

    const W = by[wb.id].module
    assert.equal(W.sheets[0].cells['0,0'], 'Item')
    assert.equal(W.sheets[0].cells['2,1'], '=B2*2')
    assert.deepEqual(W.sheets[0].fmt['0,0'], { b: true })
    assert.deepEqual(W.sheets[0].fmt['1,1'], { bg: 'yellow', fc: 'red', f: 'currency', dp: 2 })

    const N = by[nb.id].module
    assert.equal(N.style, 'text')
    const welcome = N.pages.find((p) => !p.parentId)
    assert.ok(N.pages.some((p) => p.parentId === welcome.id), 'sub-pages keep their parent')
    const types = new Set(welcome.blocks.map((x) => x.type))
    for (const t of ['h1', 'p', 'callout', 'ul', 'ol', 'todo', 'quote', 'toggle', 'code', 'divider', 'table']) assert.ok(types.has(t), `block type ${t}`)
    const callout = welcome.blocks.find((x) => x.type === 'callout')
    assert.match(callout.text, /\*\*bold\*\*/)
    const table = welcome.blocks.find((x) => x.type === 'table')
    assert.equal(table.table.cols.length, 3)
    assert.equal(table.table.rows[0].cells[table.table.cols[0].id], 'Review onboarding checklist')

    const TN = by[tnb.id].module
    assert.equal(TN.style, 'table')
    assert.ok(TN.pages[0].table.cols.length > 0)

    // Converted once: a second read changes nothing, and the legacy API still serves the old data.
    const again = await ok(call, 'GET', '/api/v2/workspace')
    assert.equal(again.rev, w.rev)
    const after = await ok(call, 'GET', `/api/databases/${tasks.id}`)
    for (const k of ['properties', 'rows', 'views']) assert.deepEqual(after[k], before[k])
  } finally {
    await b.s.close()
    fs.rmSync(b.dataDir, { recursive: true, force: true })
  }
})

test('conversion also runs at server start', async () => {
  const b = await boot()
  const nb = await ok(b.call, 'POST', '/api/modules', { type: 'notebook', template: 'text', title: 'Notes' })
  await b.s.close()
  const s = await startServer({ port: 0, dataDir: b.dataDir })
  try {
    const row = s.ctx.db.prepare('SELECT doc, version FROM modules WHERE id = ?').get(nb.id)
    assert.equal(row.version, 1)
    assert.equal(JSON.parse(row.doc).title, 'Notes')
  } finally {
    await s.close()
    fs.rmSync(b.dataDir, { recursive: true, force: true })
  }
})
