import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from '../server-core/helpers.js'

let t
before(async () => { t = await boot() })
after(() => t.s.close())

const call = (method, path, json) => t.call(method, path, json === undefined ? {} : { json })
async function ok(method, path, json, status = [200, 201]) {
  const r = await call(method, path, json)
  assert.ok([].concat(status).includes(r.status), `${method} ${path} -> ${r.status} ${r.text}`)
  return r.json
}
async function newDb(template = 'blank', title = 'Test db') {
  const m = await ok('POST', '/api/modules', { type: 'database', template, title })
  return { m, base: `/api/databases/${m.id}`, load: () => ok('GET', `/api/databases/${m.id}`) }
}

describe('templates', () => {
  test('blank, task tracker and contacts are registered', async () => {
    const list = (await call('GET', '/api/templates')).json.filter((x) => x.type === 'database').map((x) => x.key)
    for (const k of ['blank', 'task_tracker', 'contacts']) assert.ok(list.includes(k), k)
  })

  test('blank creates a title property and a table view', async () => {
    const { load } = await newDb()
    const d = await load()
    assert.deepEqual(d.properties.map((p) => [p.name, p.type]), [['Name', 'title']])
    assert.deepEqual(d.views.map((v) => v.type), ['table'])
    assert.equal(d.rows.length, 0)
  })

  test('task tracker has the required schema, sample rows and a board grouped by Status', async () => {
    const { load } = await newDb('task_tracker')
    const d = await load()
    const by = Object.fromEntries(d.properties.map((p) => [p.name, p]))
    assert.equal(by.Name.type, 'title')
    assert.equal(by.Status.type, 'status')
    assert.deepEqual(by.Status.config.options.map((o) => o.name), ['Not started', 'In progress', 'Done'])
    assert.equal(by.Assignee.type, 'text')
    assert.equal(by.Due.type, 'date')
    assert.equal(by.Priority.type, 'select')
    assert.ok(d.rows.length >= 3)
    assert.ok(d.rows.every((r) => typeof r.values[by.Name.id] === 'string' && by.Status.config.options.some((o) => o.id === r.values[by.Status.id])))
    const table = d.views.find((v) => v.type === 'table')
    const board = d.views.find((v) => v.type === 'board')
    assert.ok(table && board)
    assert.equal(board.config.group_by, by.Status.id)
  })

  test('contacts has email/phone properties with valid sample values', async () => {
    const { load } = await newDb('contacts')
    const d = await load()
    const types = d.properties.map((p) => p.type)
    for (const ty of ['title', 'email', 'phone', 'multi_select', 'url', 'files']) assert.ok(types.includes(ty), ty)
    const email = d.properties.find((p) => p.type === 'email')
    assert.ok(d.rows.length >= 2 && d.rows.every((r) => /@/.test(r.values[email.id])))
  })

  test('a failing module GET for other module types is rejected', async () => {
    const nb = await ok('POST', '/api/modules', { type: 'notebook' })
    assert.equal((await call('GET', `/api/databases/${nb.id}`)).status, 400)
    assert.equal((await call('GET', '/api/databases/nope')).status, 404)
  })
})

describe('properties', () => {
  test('create, rename, reorder, delete removes values', async () => {
    const { base, load } = await newDb()
    const title = (await load()).properties[0]
    const a = await ok('POST', `${base}/properties`, { name: 'Notes', type: 'text' })
    const b = await ok('POST', `${base}/properties`, { type: 'number', config: { format: 'aud', decimals: 2 } })
    assert.equal(b.name, 'Number')
    assert.equal(b.config.format, 'aud')
    const renamed = await ok('PATCH', `${base}/properties/${a.id}`, { name: 'Comments' })
    assert.equal(renamed.property.name, 'Comments')

    await ok('POST', `${base}/properties/reorder`, { ids: [b.id, title.id, a.id] })
    assert.deepEqual((await load()).properties.map((p) => p.id), [b.id, title.id, a.id])

    const row = await ok('POST', `${base}/rows`, { values: { [title.id]: 'x', [a.id]: 'keep?', [b.id]: 5 } })
    await ok('DELETE', `${base}/properties/${a.id}`)
    const d = await load()
    assert.ok(!d.properties.some((p) => p.id === a.id))
    const saved = d.rows.find((r) => r.id === row.id)
    assert.ok(!(a.id in saved.values))
    assert.equal(saved.values[b.id], 5)

    assert.equal((await call('DELETE', `${base}/properties/${title.id}`)).status, 400, 'title cannot be deleted')
    assert.equal((await call('POST', `${base}/properties`, { type: 'title' })).status, 400, 'only one title')
    assert.equal((await call('POST', `${base}/properties`, { type: 'bogus' })).status, 400)
  })

  test('type conversion: text -> number, select -> text, text -> select, number -> checkbox', async () => {
    const { base, load } = await newDb()
    const prop = await ok('POST', `${base}/properties`, { name: 'Qty', type: 'text' })
    const { created } = await ok('POST', `${base}/rows/batch`, { create: [
      { values: { [prop.id]: '42' } }, { values: { [prop.id]: 'forty two' } }, { values: { [prop.id]: '$1,250.50' } }, { values: {} },
    ] })
    const conv = await ok('PATCH', `${base}/properties/${prop.id}`, { type: 'number' })
    assert.equal(conv.property.type, 'number')
    let rows = new Map((await load()).rows.map((r) => [r.id, r.values]))
    assert.equal(rows.get(created[0].id)[prop.id], 42)
    assert.ok(!(prop.id in rows.get(created[1].id)), 'non-numeric becomes empty')
    assert.equal(rows.get(created[2].id)[prop.id], 1250.5)

    await ok('PATCH', `${base}/properties/${prop.id}`, { type: 'checkbox' })
    rows = new Map((await load()).rows.map((r) => [r.id, r.values]))
    assert.equal(rows.get(created[0].id)[prop.id], true)

    const sel = await ok('POST', `${base}/properties`, { name: 'Stage', type: 'select', config: { options: [{ name: 'Lead', color: 'blue' }, { name: 'Won', color: 'green' }] } })
    const [lead, won] = sel.config.options
    await ok('PATCH', `${base}/rows/${created[0].id}`, { values: { [sel.id]: won.id } })
    await ok('PATCH', `${base}/rows/${created[1].id}`, { values: { [sel.id]: lead.id } })
    await ok('PATCH', `${base}/properties/${sel.id}`, { type: 'text' })
    rows = new Map((await load()).rows.map((r) => [r.id, r.values]))
    assert.equal(rows.get(created[0].id)[sel.id], 'Won')
    assert.equal(rows.get(created[1].id)[sel.id], 'Lead')

    // text back to select creates options by label; multi_select keeps the ids
    const back = await ok('PATCH', `${base}/properties/${sel.id}`, { type: 'select' })
    assert.deepEqual(back.property.config.options.map((o) => o.name).sort(), ['Lead', 'Won'])
    const toMulti = await ok('PATCH', `${base}/properties/${sel.id}`, { type: 'multi_select' })
    const wonId = toMulti.property.config.options.find((o) => o.name === 'Won').id
    rows = new Map((await load()).rows.map((r) => [r.id, r.values]))
    assert.deepEqual(rows.get(created[0].id)[sel.id], [wonId])

    // date text parsed from DD/MM/YYYY
    const when = await ok('POST', `${base}/properties`, { name: 'When', type: 'text' })
    await ok('PATCH', `${base}/rows/${created[0].id}`, { values: { [when.id]: '14/05/2026' } })
    await ok('PATCH', `${base}/properties/${when.id}`, { type: 'date' })
    rows = new Map((await load()).rows.map((r) => [r.id, r.values]))
    assert.deepEqual(rows.get(created[0].id)[when.id], { start: '2026-05-14' })

    const title = (await load()).properties.find((p) => p.type === 'title')
    assert.equal((await call('PATCH', `${base}/properties/${title.id}`, { type: 'text' })).status, 400)
  })

  test('removing a select option clears it from rows', async () => {
    const { base, load } = await newDb()
    const sel = await ok('POST', `${base}/properties`, { type: 'select', config: { options: [{ name: 'A' }, { name: 'B' }] } })
    const row = await ok('POST', `${base}/rows`, { values: { [sel.id]: sel.config.options[1].id } })
    await ok('PATCH', `${base}/properties/${sel.id}`, { config: { options: [sel.config.options[0]] } })
    assert.ok(!(sel.id in (await load()).rows.find((r) => r.id === row.id).values))
  })
})

describe('rows', () => {
  test('create, partial patch, delete, reorder', async () => {
    const { base, load } = await newDb()
    const title = (await load()).properties[0]
    const num = await ok('POST', `${base}/properties`, { name: 'n', type: 'number' })
    const r1 = await ok('POST', `${base}/rows`, { values: { [title.id]: 'one', [num.id]: 1 } })
    const r2 = await ok('POST', `${base}/rows`, { values: { [title.id]: 'two' } })
    const r3 = await ok('POST', `${base}/rows`, {})
    assert.ok(r2.sort_order > r1.sort_order && r3.sort_order > r2.sort_order)

    const p = await ok('PATCH', `${base}/rows/${r1.id}`, { values: { [num.id]: 7 } })
    assert.equal(p.values[title.id], 'one', 'partial patch keeps other values')
    assert.equal(p.values[num.id], 7)
    assert.ok(p.updated_at >= r1.updated_at)
    const cleared = await ok('PATCH', `${base}/rows/${r1.id}`, { values: { [num.id]: null }, notes: 'Some notes' })
    assert.ok(!(num.id in cleared.values))
    assert.equal(cleared.notes, 'Some notes')

    await ok('POST', `${base}/rows/reorder`, { ids: [r3.id, r1.id, r2.id] })
    assert.deepEqual((await load()).rows.map((r) => r.id), [r3.id, r1.id, r2.id])
    // subset reorder keeps the rest in place
    await ok('POST', `${base}/rows/reorder`, { ids: [r2.id, r1.id] })
    assert.deepEqual((await load()).rows.map((r) => r.id), [r3.id, r2.id, r1.id])

    await ok('DELETE', `${base}/rows/${r2.id}`)
    assert.deepEqual((await load()).rows.map((r) => r.id), [r3.id, r1.id])
    assert.equal((await call('PATCH', `${base}/rows/${r2.id}`, { values: {} })).status, 404)
  })

  test('batch create 1,000 rows, batch update and delete', async () => {
    const { base, load } = await newDb()
    const title = (await load()).properties[0]
    const { created } = await ok('POST', `${base}/rows/batch`, { create: Array.from({ length: 1000 }, (_, i) => ({ values: { [title.id]: `Row ${i}` } })) })
    assert.equal(created.length, 1000)
    let d = await load()
    assert.equal(d.rows.length, 1000)
    assert.equal(d.rows[999].values[title.id], 'Row 999')
    const res = await ok('POST', `${base}/rows/batch`, { update: [{ id: created[0].id, values: { [title.id]: 'First' } }], delete: [created[1].id, created[2].id] })
    assert.equal(res.updated[0].values[title.id], 'First')
    d = await load()
    assert.equal(d.rows.length, 998)
    // a bad row rolls back the whole batch
    const r = await call('POST', `${base}/rows/batch`, { create: [{ values: { [title.id]: 'ok' } }, { values: { nope: 1 } }] })
    assert.equal(r.status, 400)
    assert.equal((await load()).rows.length, 998)
  })

  test('invalid values are rejected with 400', async () => {
    const { base, load } = await newDb()
    const mk = (type, config) => ok('POST', `${base}/properties`, { type, config })
    const num = await mk('number')
    const sel = await mk('select', { options: [{ name: 'A' }] })
    const multi = await mk('multi_select', { options: [{ name: 'A' }] })
    const status = await mk('status')
    const date = await mk('date')
    const box = await mk('checkbox')
    const email = await mk('email')
    const url = await mk('url')
    const phone = await mk('phone')
    const files = await mk('files')
    const created = await mk('created_time')
    const cases = [
      [num.id, 'abc'], [num.id, '42'], [sel.id, 'unknown-option'], [multi.id, ['unknown']], [multi.id, 'x'], [status.id, 'nope'],
      [date.id, '31/02/2026'], [date.id, { start: '2026-02-30' }], [date.id, { start: '2026-05-10', end: '2026-05-01' }],
      [box.id, 'yes'], [email.id, 'not-an-email'], [url.id, 'javascript:alert(1)'], [phone.id, 'call me'], [files.id, ['missing']],
      [created.id, '2026-01-01T00:00:00Z'], ['no-such-property', 'x'],
    ]
    for (const [pid, v] of cases) {
      const r = await call('POST', `${base}/rows`, { values: { [pid]: v } })
      assert.equal(r.status, 400, `${pid} ${JSON.stringify(v)} -> ${r.status}`)
    }
    const okRow = await ok('POST', `${base}/rows`, { values: {
      [num.id]: -3.5, [sel.id]: sel.config.options[0].id, [multi.id]: [multi.config.options[0].id], [status.id]: status.config.options[2].id,
      [date.id]: { start: '2026-05-14', end: '2026-05-16' }, [box.id]: true, [email.id]: 'a@b.com.au', [url.id]: 'https://example.com', [phone.id]: '+61 412 345 678',
    } })
    assert.equal(okRow.values[num.id], -3.5)
    assert.equal((await load()).rows.length, 1)
  })

  test('files values reference attachments and row delete removes them', async () => {
    const { m, base, load } = await newDb()
    const files = await ok('POST', `${base}/properties`, { type: 'files' })
    const row = await ok('POST', `${base}/rows`, {})
    const up = await t.call('POST', `/api/attachments?moduleId=${m.id}&pageId=${row.id}`, { headers: { 'X-Filename': 'a.txt' }, body: Buffer.from('hi') })
    assert.equal(up.status, 201)
    const patched = await ok('PATCH', `${base}/rows/${row.id}`, { values: { [files.id]: [up.json.id] } })
    assert.deepEqual(patched.values[files.id], [up.json.id])
    await ok('DELETE', `${base}/rows/${row.id}`)
    assert.equal((await call('GET', `/api/attachments?moduleId=${m.id}&pageId=${row.id}`)).json.length, 0)
    assert.equal((await load()).rows.length, 0)
  })
})

describe('views', () => {
  test('create all five types with config persisted, rename, reorder, delete', async () => {
    const { base, load } = await newDb('task_tracker')
    const d0 = await load()
    const status = d0.properties.find((p) => p.type === 'status')
    const due = d0.properties.find((p) => p.type === 'date')
    const made = {}
    for (const type of ['table', 'board', 'list', 'gallery', 'calendar']) {
      const config = { sorts: [{ property: status.id, direction: 'desc' }], filter: { op: 'or', rules: [{ property: status.id, operator: 'is_empty' }] }, marker: type }
      made[type] = await ok('POST', `${base}/views`, { name: `My ${type}`, type, config })
      assert.equal(made[type].type, type)
    }
    assert.equal(made.board.config.group_by, status.id, 'board defaults group_by to status')
    assert.equal(made.calendar.config.date_property, due.id, 'calendar defaults to the date property')
    const d = await load()
    for (const type of Object.keys(made)) {
      const v = d.views.find((x) => x.id === made[type].id)
      assert.equal(v.config.marker, type)
      assert.equal(v.config.filter.op, 'or')
    }
    const renamed = await ok('PATCH', `${base}/views/${made.list.id}`, { name: 'Renamed', config: { hidden: ['x'] } })
    assert.equal(renamed.name, 'Renamed')
    assert.deepEqual(renamed.config, { hidden: ['x'] })
    assert.equal((await call('POST', `${base}/views`, { type: 'timeline' })).status, 400)
    const ids = (await load()).views.map((v) => v.id).reverse()
    await ok('POST', `${base}/views/reorder`, { ids })
    assert.deepEqual((await load()).views.map((v) => v.id), ids)
    for (const v of (await load()).views.slice(1)) await ok('DELETE', `${base}/views/${v.id}`)
    const last = (await load()).views
    assert.equal(last.length, 1)
    assert.equal((await call('DELETE', `${base}/views/${last[0].id}`)).status, 400, 'last view is kept')
  })
})
