// Logic tests for the web UI (web/app): conflict merging, date ranges, files, the new block types,
// freeze panes, icons and a render sweep over every screen. Runs in Node with a stubbed DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadApp, fakeEvent } from './client-harness.js'

// Values built inside the vm context have that context's prototypes; compare them as plain JSON.
const deq = (actual, expected, msg) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, msg)

test('merge3 merges objects key by key and id lists item by item', () => {
  const { merge3 } = loadApp()
  const base = { title: 'A', rows: [{ id: 'r1', v: 1 }, { id: 'r2', v: 2 }], cfg: { x: 1, y: 1 } }
  const local = { title: 'A2', rows: [{ id: 'r1', v: 10 }, { id: 'r2', v: 2 }, { id: 'r3', v: 3 }], cfg: { x: 2, y: 1 } }
  const server = { title: 'A', rows: [{ id: 'r1', v: 1 }, { id: 'r2', v: 20 }, { id: 'r4', v: 4 }], cfg: { x: 1, y: 3 } }
  const out = merge3(base, local, server)
  assert.equal(out.title, 'A2')
  deq(out.cfg, { x: 2, y: 3 })
  deq(out.rows.map((r) => [r.id, r.v]), [['r1', 10], ['r2', 20], ['r3', 3], ['r4', 4]])
})

test('merge3 honours deletes on either side unless the other side changed the item', () => {
  const { merge3 } = loadApp()
  const base = [{ id: 'a', t: 1 }, { id: 'b', t: 1 }, { id: 'c', t: 1 }]
  // We deleted b; they edited c and deleted a.
  const out = merge3(base, [{ id: 'a', t: 1 }, { id: 'c', t: 1 }], [{ id: 'b', t: 1 }, { id: 'c', t: 2 }])
  deq(out.map((x) => [x.id, x.t]), [['c', 2]])
  // They deleted a row we changed: ours survives.
  const kept = merge3(base, [{ id: 'a', t: 9 }, { id: 'b', t: 1 }, { id: 'c', t: 1 }], [{ id: 'b', t: 1 }, { id: 'c', t: 1 }])
  assert.ok(kept.some((x) => x.id === 'a' && x.t === 9))
  // A true conflict keeps our value.
  assert.equal(merge3({ v: 1 }, { v: 2 }, { v: 3 }).v, 2)
})

test('merge3 keeps a reorder made only locally', () => {
  const { merge3 } = loadApp()
  const b = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const out = merge3(b, [{ id: 'c' }, { id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b', n: 1 }, { id: 'c' }])
  deq(out.map((x) => x.id), ['c', 'a', 'b'])
  assert.equal(out[2].n, 1)
})

test('runs on browser storage when no server token is present', () => {
  const { Component, TRUSS_REMOTE } = loadApp()
  assert.equal(TRUSS_REMOTE, null)
  const c = new Component({})
  assert.equal(c.remote, null)
  assert.ok(c.ws.modules.length >= 6)
  const v = c.renderVals()
  assert.equal(v.top.hasSync, false)
  assert.equal(v.isLoading, false)
})

test('picks up the server token and CSRF token from meta tags', () => {
  const { TRUSS_REMOTE } = loadApp({ meta: { 'truss-token': 'abc', 'truss-csrf': 'xyz', 'truss-hosted': '1' } })
  assert.equal(TRUSS_REMOTE.token, 'abc')
  assert.equal(TRUSS_REMOTE.csrf, 'xyz')
  assert.equal(TRUSS_REMOTE.hosted, true)
  // An unreplaced placeholder means the page was not served by Truss.
  assert.equal(loadApp({ meta: { 'truss-token': '%TRUSS_TOKEN%' } }).TRUSS_REMOTE, null)
})

test('date cells hold a day or a range', () => {
  const { Component, dateStart, dateEnd, mkDate } = loadApp()
  assert.equal(dateStart('2026-09-01'), '2026-09-01')
  assert.equal(dateEnd('2026-09-01'), null)
  deq(mkDate('2026-09-01', '2026-09-05'), { start: '2026-09-01', end: '2026-09-05' })
  assert.equal(mkDate('2026-09-05', '2026-09-01'), '2026-09-05')
  const c = new Component({})
  const tasks = c.ws.modules.find((m) => m.title === 'Tasks')
  const dp = tasks.props.find((p) => p.type === 'date')
  const row = tasks.rows[0]
  row.cells[dp.id] = { start: '2026-09-01', end: '2026-09-03' }
  assert.equal(c.cellText(tasks, row, dp), '01/09/2026 - 03/09/2026')
  assert.equal(c.cellVal(tasks, row, dp), '2026-09-01')
  // The popover turns the range off and on.
  c.goModule(tasks.id)
  c.openPop(fakeEvent(), 'date', { dbId: tasks.id, rowId: row.id, propId: dp.id })
  let v = c.renderVals()
  assert.equal(v.pop.is_date, true)
  assert.equal(v.pop.d.ranged, true)
  assert.equal(v.pop.d.endValue, '2026-09-03')
  v.pop.d.onEnd({ target: { value: '2026-09-10' } })
  deq(row.cells[dp.id], { start: '2026-09-01', end: '2026-09-10' })
  v = c.renderVals()
  v.pop.d.onRanged({ target: { checked: false } })
  assert.equal(row.cells[dp.id], '2026-09-01')
})

test('dropping a ranged row on the calendar keeps its length', () => {
  const { Component } = loadApp()
  const c = new Component({})
  const tasks = c.ws.modules.find((m) => m.title === 'Tasks')
  const dp = tasks.props.find((p) => p.type === 'date')
  const row = tasks.rows[0]
  row.cells[dp.id] = { start: '2026-09-01', end: '2026-09-04' }
  const cal = tasks.views.find((x) => x.type === 'calendar') || c.addView(tasks, 'calendar')
  cal.dateProp = dp.id
  c.goModule(tasks.id)
  c.setView(tasks, cal.id)
  c.S.calCursor[cal.id] = '2026-09'
  const v = c.renderVals()
  // A range shows on each day it spans.
  for (const iso of ['2026-09-01', '2026-09-04']) assert.ok(v.db.cal.days.find((d) => d.iso === iso).items.length >= 1, iso)
  const day = v.db.cal.days.find((d) => d.iso === '2026-09-15')
  assert.ok(day, 'calendar shows 15/09/2026')
  c.S.drag = { rowId: row.id }
  day.drop(fakeEvent())
  deq(row.cells[dp.id], { start: '2026-09-15', end: '2026-09-18' })
})

test('files property: popover, upload and removal', async () => {
  const { Component } = loadApp()
  const c = new Component({})
  const tasks = c.ws.modules.find((m) => m.title === 'Tasks')
  const fp = c.addProp(tasks, 'files', null, 'Files')
  const row = tasks.rows[0]
  deq(row.cells[fp.id], [])
  // Local mode explains that files need the server.
  c.goModule(tasks.id)
  c.openPop(fakeEvent(), 'files', { dbId: tasks.id, rowId: row.id, propId: fp.id })
  let v = c.renderVals()
  assert.equal(v.pop.is_files, true)
  assert.equal(v.pop.d.local, true)
  // With a server: uploads land in the cell, removal deletes the file.
  const deleted = []
  c.remote = {
    get: async () => [],
    upload: async (p, f) => ({ id: 'att_' + f.name, module_id: tasks.id, page_id: row.id, filename: f.name, size: 12, mime: 'text/plain' }),
    del: async (p) => { deleted.push(p) },
    url: (p) => p,
  }
  c.ver = { [tasks.id]: 3 }
  v = c.renderVals()
  v.pop.d.onPick({ target: { files: [{ name: 'a.txt' }], value: 'x' } })
  await new Promise((r) => setTimeout(r, 20))
  deq(row.cells[fp.id], ['att_a.txt'])
  assert.equal(c.cellText(tasks, row, fp), 'a.txt')
  v = c.renderVals()
  assert.equal(v.pop.d.files[0].name, 'a.txt')
  v.pop.d.files[0].remove()
  await new Promise((r) => setTimeout(r, 20))
  deq(row.cells[fp.id], [])
  assert.equal(deleted.length, 1)
})

test('notebook table, image and file blocks render and export to markdown', () => {
  const { Component, mkBlock } = loadApp()
  const c = new Component({})
  const nb = c.ws.modules.find((m) => m.title === 'Truss docs')
  const page = nb.pages[0]
  page.icon = String.fromCodePoint(0x1f4a1)
  page.blocks.push(
    mkBlock('table', '', { table: { cols: [{ id: 'c1', name: 'Name' }, { id: 'c2', name: 'Qty' }], rows: [{ id: 'r1', cells: { c1: 'Bolts', c2: '4' } }] } }),
    mkBlock('image', '', { att: 'img1', name: 'photo.png' }),
    mkBlock('file', '', { att: null, name: '' }),
    mkBlock('callout', 'Heads up', { icon: String.fromCodePoint(0x26a0) }),
  )
  c.goModule(nb.id, page.id)
  const v = c.renderVals()
  const blocks = v.nb.page.ed.blocks
  const tbl = blocks.find((b) => b.isTableBlk)
  deq(tbl.tg.cols.map((x) => x.name), ['Name', 'Qty'])
  assert.equal(tbl.tg.rows[0].cells[0].value, 'Bolts')
  tbl.tg.addRow()
  assert.equal(page.blocks.find((b) => b.type === 'table').table.rows.length, 2)
  assert.equal(blocks.find((b) => b.isImage).media.has, true)
  assert.equal(blocks.find((b) => b.isFile).media.none, true)
  assert.equal(blocks.find((b) => b.hasCalloutIcon).calloutIcon, String.fromCodePoint(0x26a0))
  assert.equal(v.nb.page.hasIcon, true)
  const md = c.pageMarkdown(page)
  assert.match(md, /\| Name \| Qty \|/)
  assert.match(md, /\| Bolts \| 4 \|/)
  assert.match(md, /!\[photo\.png\]\(attachment:img1\)/)
})

test('slash menu inserts a table; server-only blocks need the server', () => {
  const { Component } = loadApp()
  const c = new Component({})
  const nb = c.ws.modules.find((m) => m.title === 'Truss docs')
  const page = nb.pages[0]
  const ct = { kind: 'page', modId: nb.id, pageId: page.id }
  const b = c.insertAfter(ct, page.blocks[page.blocks.length - 1], 'p', '')
  c.setBlockText(ct, b, '/tab', { selectionStart: 4 })
  const item = c.slashItems(ct, c.S.slash).find((x) => x.key === 'table')
  c.applySlash(ct, b, item)
  assert.equal(b.type, 'table')
  assert.equal(b.table.cols.length, 3)
  const b2 = c.insertAfter(ct, b, 'p', '')
  c.setBlockText(ct, b2, '/image', { selectionStart: 6 })
  c.applySlash(ct, b2, c.slashItems(ct, c.S.slash).find((x) => x.key === 'image'))
  assert.equal(b2.type, 'p')
  assert.ok(c.S.toasts.some((t) => /Truss server/.test(t.text)))
})

test('sheet font colours, new fills and freeze panes', () => {
  const { Component } = loadApp()
  const c = new Component({})
  const wb = c.ws.modules.find((m) => m.title === 'Monthly budget')
  const sh = wb.sheets.find((s) => s.id === wb.activeSheetId) || wb.sheets[0]
  c.goModule(wb.id)
  c.ui(wb).sel[sh.id] = { r: 2, c: 1, r2: 2, c2: 1 }
  c.applyFmt(wb, { fc: 'red', bg: 'pink' })
  sh.frozenRows = 1
  sh.frozenCols = 1
  const v = c.renderVals()
  const cell = v.sh.rows[2].cells[1]
  assert.match(cell.cls, /fc-red/)
  assert.match(cell.cls, /bg-pink/)
  assert.match(v.sh.rows[0].rowStyle, /position: sticky; top: 26px/)
  assert.match(v.sh.rows[5].cells[0].style, /position: sticky; left: 48px/)
  assert.equal(v.sh.rows[5].cells[1].style.indexOf('sticky'), -1)
  assert.match(v.sh.freezeCls, / on/)
})

test('GST matches the previous Truss: the GST to add, 10% by default', () => {
  const { FE } = loadApp()
  const env = { cell: () => null, bounds: () => ({ rows: 1, cols: 1 }) }
  assert.equal(FE.evaluate('GST(100)', env), 10)
  assert.equal(FE.evaluate('GST(200,0.15)', env), 30)
  deq(FE.evaluate('GST(100,-1)', env), { error: '#NUM!' })
})

test('every screen renders without throwing', () => {
  const { Component } = loadApp()
  const c = new Component({})
  const e = fakeEvent()
  const render = (label) => { try { return c.renderVals() } catch (err) { throw new Error(`${label}: ${err.stack}`) } }
  render('home')
  for (const m of c.ws.modules.slice()) {
    c.goModule(m.id)
    render(m.title)
    if (m.type === 'database') {
      for (const view of m.views) { c.setView(m, view.id); render(`${m.title} ${view.type}`) }
      for (const p of m.props) {
        c.openPop(e, 'prop', { dbId: m.id, propId: p.id }); render(`${m.title} prop ${p.type}`)
        if (['select', 'status', 'multi_select'].includes(p.type)) { c.openPop(e, 'opt', { dbId: m.id, rowId: m.rows[0].id, propId: p.id, q: '' }); render('opt') }
        if (p.type === 'date') { c.openPop(e, 'date', { dbId: m.id, rowId: m.rows[0].id, propId: p.id }); render('date') }
      }
      c.S.pop = null
      c.openPeek(m, m.rows[0]); render(`${m.title} peek`); c.S.peek = null
    }
    if (m.type === 'notebook') for (const p of m.pages) { c.goModule(m.id, p.id); render(`${m.title} / ${p.title}`) }
    c.colorMenu(e, m); render('color menu'); c.S.menu = null
  }
  c.go({ name: 'archive' }); render('archive')
  c.modal('settings', { importText: '' }); render('settings')
  c.modal('functions', { q: '' }); render('functions')
  c.S.modal = null
})

test('malformed documents from the server are filled in rather than breaking rendering', () => {
  const { Component, ctx } = loadApp()
  const c = new Component({})
  const bare = [
    { id: 'db1', type: 'database', title: 'Bare db' },
    { id: 'wb1', type: 'sheet', title: 'Bare wb', sheets: [] },
    { id: 'nb1', type: 'notebook', title: 'Bare nb', pages: [{ id: 'p1', title: 'P' }] },
  ]
  c.ws.modules = bare.map((m) => ctx.__T.normModule(m))
  const db = c.ws.modules[0]
  assert.equal(db.props[0].id, 'db1-title')
  assert.equal(db.views[0].id, 'db1-table')
  assert.equal(c.ws.modules[1].activeSheetId, 'wb1-s1')
  assert.equal(c.ws.modules[2].pages[0].blocks.length, 1)
  c.renderVals()
  for (const m of c.ws.modules) { c.goModule(m.id); c.renderVals() }
})
