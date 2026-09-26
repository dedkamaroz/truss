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

test('tab-separated clipboard text round-trips, including tabs, quotes and newlines inside cells', () => {
  const { tsvParse, tsvStringify } = loadApp()
  const rows = [['a', 'b\tc'], ['say "hi"', 'two\nlines'], ['', 'x']]
  deq(tsvParse(tsvStringify(rows)), rows)
  deq(tsvParse('1\t2\r\n3\t4\r\n'), [['1', '2'], ['3', '4']])
})

// A table with three text columns and three rows, rendered once so the grid is known.
function rangeFixture() {
  const app = loadApp()
  const c = new app.Component({})
  c.createModule('database', 'blank', 'Range test')
  const db = c.ws.modules.find((m) => m.title === 'Range test')
  const a = c.addProp(db, 'text', null, 'A'), b = c.addProp(db, 'text', null, 'B')
  const tp = db.props[0]
  for (let i = 1; i <= 3; i++) { const r = c.addRow(db, {}); r.cells[tp.id] = 'r' + i; r.cells[a.id] = 'a' + i; r.cells[b.id] = 'b' + i }
  c.goModule(db.id)
  c.renderVals()
  const g = c.tableGrid(db)
  const at = (r, col) => ({ rowId: g.rowIds[r], propId: g.colIds[col] })
  const grid = () => db.rows.map((r) => db.props.map((p) => r.cells[p.id] ?? '').join('|'))
  return { app, c, db, a, b, tp, at, grid }
}

test('a dragged range highlights its cells and copies as tab-separated text', () => {
  const { c, db, at } = rangeFixture()
  c.setCellSel(db, at(0, 1), at(1, 2))
  const v = c.renderVals()
  const rows = v.db.groups[0].rows
  assert.equal(rows.flatMap((r) => r.cells).filter((x) => / csel/.test(x.cls)).length, 4)
  assert.match(rows[0].cells[1].style, /box-shadow/)
  const R = c.selRange(db)
  assert.equal(c.rangeText(db, R), 'a1\tb1\r\na2\tb2')
})

test('delete clears the range and Undo restores it', () => {
  const { c, db, at, grid } = rangeFixture()
  const before = grid()
  c.setCellSel(db, at(0, 1), at(2, 2))
  c.clearRange(db, c.selRange(db))
  deq(grid(), ['r1||', 'r2||', 'r3||'])
  const toast = c.S.toasts[c.S.toasts.length - 1]
  assert.equal(toast.action.label, 'Undo')
  toast.action.run.call(c)
  const db2 = c.ws.modules.find((m) => m.id === db.id)
  deq(db2.rows.map((r) => db2.props.map((p) => r.cells[p.id] ?? '').join('|')), JSON.parse(JSON.stringify(before)))
})

test('paste fills from the active cell, adds rows as needed, and a single value fills the range', () => {
  const { c, db, at, grid } = rangeFixture()
  c.setCellSel(db, at(2, 1))
  c.renderVals()
  c.pasteGrid(db, c.selRange(db), 'x1\ty1\r\nx2\ty2')
  deq(grid(), ['r1|a1|b1', 'r2|a2|b2', 'r3|x1|y1', '|x2|y2'])
  c.renderVals()
  c.setCellSel(db, at(0, 1), at(1, 2))
  c.pasteGrid(db, c.selRange(db), 'z')
  deq(grid().slice(0, 2), ['r1|z|z', 'r2|z|z'])
})

test('pasted text is converted to each property type', () => {
  const { c, db } = rangeFixture()
  const n = c.addProp(db, 'number', null, 'N'), d = c.addProp(db, 'date', null, 'D'), s = c.addProp(db, 'select', null, 'S'), k = c.addProp(db, 'checkbox', null, 'K')
  assert.equal(c.textToCell(db, n, '$1,250.50'), 1250.5)
  assert.equal(c.textToCell(db, d, '14/05/2026'), '2026-05-14')
  deq(c.textToCell(db, d, '01/09/2026 - 03/09/2026'), { start: '2026-09-01', end: '2026-09-03' })
  const id = c.textToCell(db, s, 'Urgent')
  assert.equal(s.config.options.find((o) => o.id === id).name, 'Urgent')
  assert.equal(c.textToCell(db, k, 'Yes'), true)
  assert.equal(c.textToCell(db, c.addProp(db, 'files', null, 'F'), 'x.pdf'), undefined)
})

test('selected columns move together when a header is dragged', () => {
  const { c, db, a, b, tp } = rangeFixture()
  const g = c.tableGrid(db)
  c.setCellSel(db, { rowId: g.rowIds[0], propId: a.id }, { rowId: g.rowIds[2], propId: b.id })
  assert.equal(c.selRange(db).full, true)
  c.moveColumns(db, [a.id, b.id], tp.id, 'before')
  deq(db.props.map((p) => p.name), ['A', 'B', 'Name'])
  c.moveColumns(db, [a.id], b.id, 'after')
  deq(db.props.map((p) => p.name), ['B', 'A', 'Name'])
})

test('table cells render exactly as wide as their headers', () => {
  const { c, db } = rangeFixture()
  const v = c.renderVals()
  const cols = v.db.cols.map((x) => x.style)
  const cells = v.db.groups[0].rows[0].cells.map((x) => x.style.replace(/ box-shadow.*$/, ''))
  deq(cells, JSON.parse(JSON.stringify(cols)))
  // The type class must not collide with the inner .cell-text span's class.
  for (const x of v.db.groups[0].rows[0].cells) assert.doesNotMatch(x.cls, /\bcell-text\b/)
})

test('file thumbnails: images and PDFs preview, other files stay as tags', () => {
  const { Component } = loadApp()
  const c = new Component({})
  c.remote = { url: (p) => p, get: async () => [] }
  c.attLoaded = {}
  c.attMeta = {
    i1: { id: 'i1', filename: 'id.png', mime: 'image/png', size: 10, has_thumb: 1 },
    p1: { id: 'p1', filename: 'statement.pdf', mime: 'application/pdf', size: 10 },
    d1: { id: 'd1', filename: 'notes.docx', mime: 'application/octet-stream', size: 10 },
  }
  c.thumbs = { p1: { state: 'ok', src: 'data:image/jpeg;base64,xx' } }
  const t = c.fileThumbs(['i1', 'p1', 'd1'], 'table')
  deq(t.thumbs.map((x) => [x.name, x.hasSrc, x.cls]), [['id.png', true, 'thumb'], ['statement.pdf', true, 'thumb pdf']])
  // A stored thumbnail is used, never the original file.
  assert.equal(t.thumbs[0].src, '/api/attachments/i1/thumb')
  deq(t.tags.map((x) => x.text), ['notes.docx'])
  t.thumbs[1].open()
  assert.equal(c.S.viewer.i, 1)
  deq(c.S.viewer.ids, ['i1', 'p1', 'd1'])
})

test('the viewer frame is 1280 x 720, or 9:16 for portrait files, within the window', () => {
  const { Component, ctx } = loadApp()
  const c = new Component({})
  ctx.window.innerWidth = 1920; ctx.window.innerHeight = 1080
  deq(c.viewerFrame(false), { w: 1280, h: 720 })
  const p = c.viewerFrame(true)
  assert.equal(p.w, Math.round(p.h * 9 / 16))
  assert.ok(p.h <= 1080 - 48)
  ctx.window.innerWidth = 1000; ctx.window.innerHeight = 700
  const small = c.viewerFrame(false)
  assert.ok(small.w <= 1000 && Math.abs(small.w / small.h - 16 / 9) < 0.01)
})

test('viewer keys: arrows change file, Page Down changes page, + and 0 zoom, Escape closes', () => {
  const { Component } = loadApp()
  const c = new Component({})
  c.remote = { url: (p) => p, get: async () => [] }
  c.attMeta = { a: { id: 'a', filename: 'a.pdf', mime: 'application/pdf' }, b: { id: 'b', filename: 'b.png', mime: 'image/png' } }
  c.openViewer(['a', 'b'], 'a')
  c.S.viewer.pdf.a = { pages: 3 }
  const key = (k) => c.viewerKey({ key: k, preventDefault() {} })
  key('PageDown'); assert.equal(c.S.viewer.page, 2)
  key('PageDown'); key('PageDown'); assert.equal(c.S.viewer.page, 3)
  key('+'); assert.equal(c.S.viewer.zoom, 1.25)
  key('0'); assert.equal(c.S.viewer.zoom, 1)
  key('ArrowRight'); assert.equal(c.S.viewer.i, 1); assert.equal(c.S.viewer.page, 1)
  key('ArrowRight'); assert.equal(c.S.viewer.i, 0)
  key('Escape'); assert.equal(c.S.viewer, null)
})

test('Tab moves right and wraps to the next row; Enter returns to where the Tab run started, one row down', () => {
  const { c, db, at } = rangeFixture()
  const g = c.tableGrid(db)
  const pos = (f) => [g.rowIds.indexOf(f.rowId), g.colIds.indexOf(f.propId)]
  deq(pos(c.stepFrom(db, at(0, 0).rowId, at(0, 0).propId, 'Tab', false)), [0, 1])
  deq(pos(c.stepFrom(db, at(0, 1).rowId, at(0, 1).propId, 'Tab', false)), [0, 2])
  // Enter after Tab, Tab goes back to column 0 of the next row.
  deq(pos(c.stepFrom(db, at(0, 2).rowId, at(0, 2).propId, 'Enter', false)), [1, 0])
  // The last cell of a row wraps to the first cell of the next; Shift+Tab wraps back.
  c.S.tabRun = null
  deq(pos(c.stepFrom(db, at(1, 2).rowId, at(1, 2).propId, 'Tab', false)), [2, 0])
  deq(pos(c.stepFrom(db, at(2, 0).rowId, at(2, 0).propId, 'Tab', true)), [1, 2])
  // The very last cell stays put.
  deq(pos(c.stepFrom(db, at(2, 2).rowId, at(2, 2).propId, 'Tab', false)), [2, 2])
})

test('typing into a cell then Tab saves it and moves to the next cell, ready to type again', () => {
  const { c, db, at, grid } = rangeFixture()
  const g = c.tableGrid(db)
  const row = db.rows.find((r) => r.id === g.rowIds[0]), a = db.props.find((p) => p.id === g.colIds[1])
  c.editCellAt(db, row, a, 'x')                    // type-to-edit replaces the value
  c.S.cellEdit.draft = 'xyz'
  c.leaveEdit(db, 'Tab', false)
  assert.equal(c.S.cellEdit, null)
  deq(grid()[0], 'r1|xyz|b1')
  deq(c.S.cellSel.f, JSON.parse(JSON.stringify(at(0, 2))))
  // Arrow keys also finish an edit that was started by typing.
  const b = db.props.find((p) => p.id === g.colIds[2])
  c.editCellAt(db, row, b, 'q')
  assert.equal(c.S.cellEdit.enter, true)
  c.leaveEdit(db, 'ArrowDown', false)
  deq(grid()[0], 'r1|xyz|q')
  deq(c.S.cellSel.f, JSON.parse(JSON.stringify(at(1, 2))))
})

test('large tables render a window of rows, keyed by row id, with a spacer for the rest', () => {
  const { Component } = loadApp()
  const c = new Component({})
  const db = c.ws.modules.find((m) => m.title === 'Tasks')
  const base = db.rows.slice()
  while (db.rows.length < 300) { const r = JSON.parse(JSON.stringify(base[db.rows.length % base.length])); r.id = 'big' + db.rows.length; db.rows.push(r) }
  c.goModule(db.id)
  const v = c.renderVals()
  const g = v.db.groups[0]
  assert.ok(g.rows.length <= 60, 'first paint renders at most 60 rows, got ' + g.rows.length)
  assert.match(g.padBottom, /^height: \d+px;$/)
  assert.equal(g.rows[0].$key, c.tableGrid(db).rowIds[0])
  // The keyboard grid still covers every row, so selection and paste work beyond the window.
  assert.equal(c.tableGrid(db).rowIds.length, 300)
  // Small tables are not windowed.
  const small = c.ws.modules.find((m) => m.title === 'Projects')
  c.goModule(small.id)
  const v2 = c.renderVals()
  assert.equal(v2.db.groups[0].rows.length, small.rows.length)
  assert.equal(v2.db.groups[0].padBottom, '')
})

test('typing in a cell editor does not re-render the page on every keystroke', () => {
  const { c, db } = rangeFixture()
  const g = c.tableGrid(db)
  const row = db.rows.find((r) => r.id === g.rowIds[0]), a = db.props.find((p) => p.id === g.colIds[1])
  c.editCellAt(db, row, a, null)
  const v = c.renderVals()
  const cell = v.db.groups[0].rows[0].cells[1]
  let bumps = 0
  const bump = c.bump; c.bump = () => { bumps++ }
  for (const ch of 'hello') cell.onDraft({ target: { value: (c.S.cellEdit.draft || '') + ch } })
  c.bump = bump
  assert.equal(bumps, 0)
  assert.equal(c.S.cellEdit.draft, 'a1hello')
})

test('thumbnails are made once, two at a time, stored on the server, and never use the original', async () => {
  const { Component } = loadApp()
  const c = new Component({})
  const puts = []
  c.remote = { url: (p) => p, get: async () => [], putBlob: async (p, b) => { puts.push([p, b.type, b.size]); return { ok: true } } }
  c.attLoaded = {}
  c.attMeta = {}
  for (let i = 0; i < 5; i++) c.attMeta['p' + i] = { id: 'p' + i, filename: 'photo' + i + '.jpg', mime: 'image/jpeg', size: 5e6 }
  let running = 0, peak = 0, made = 0
  const release = []
  c.makeThumb = (id) => { running++; peak = Math.max(peak, running); made++; return new Promise((res) => release.push(() => { running--; res('data:image/jpeg;base64,/9j/2Q==') })) }
  const ids = Object.keys(c.attMeta)
  for (const id of ids) assert.equal(c.thumbSrc(id), '')          // nothing to show until made
  for (const id of ids) c.thumbSrc(id)                              // asking again does not queue again
  assert.equal(peak, 2)
  while (release.length) { release.shift()(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)) }
  assert.equal(made, 5)
  assert.equal(puts.length, 5)
  assert.match(puts[0][0], /^\/api\/attachments\/p\d\/thumb$/)
  assert.equal(puts[0][1], 'image/jpeg')
  for (const id of ids) { assert.match(c.thumbSrc(id), /^data:image\/jpeg/); assert.equal(c.attMeta[id].has_thumb, 1) }
})
