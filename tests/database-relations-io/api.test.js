import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { boot } from '../server-core/helpers.js'

let t
before(async () => { t = await boot() })
after(() => t.s.close())

async function ok(method, path, json, status = [200, 201]) {
  const r = await t.call(method, path, json === undefined ? {} : { json })
  assert.ok([].concat(status).includes(r.status), `${method} ${path} -> ${r.status} ${r.text}`)
  return r.json
}
async function fail(method, path, json, status = 400) {
  const r = await t.call(method, path, json === undefined ? {} : { json })
  assert.equal(r.status, status, `${method} ${path} expected ${status}, got ${r.status} ${r.text}`)
  return r.json
}
async function newDb(title) {
  const m = await ok('POST', '/api/modules', { type: 'database', title })
  const base = `/api/databases/${m.id}`
  const d = await ok('GET', base)
  return { m, base, titleId: d.properties[0].id, load: () => ok('GET', base) }
}
const rowsOf = (d) => new Map(d.rows.map((r) => [r.id, r]))

describe('two-way relations', () => {
  test('deleting the target database unlinks relations pointing at it and clears their values', async () => {
    const projects = await newDb('Projects')
    const tasks = await newDb('Tasks')
    const rel = await ok('POST', `${projects.base}/properties`, { name: 'Tasks', type: 'relation', config: { targetModuleId: tasks.m.id, twoWay: true } })
    const self = await ok('POST', `${projects.base}/properties`, { name: 'Parent', type: 'relation', config: { targetModuleId: projects.m.id } })
    const t1 = await ok('POST', `${tasks.base}/rows`, { values: { [tasks.titleId]: 'A' } })
    const p1 = await ok('POST', `${projects.base}/rows`, { values: { [projects.titleId]: 'Launch', [rel.id]: [t1.id] } })

    await ok('DELETE', `/api/modules/${tasks.m.id}`)
    const d = await projects.load()
    const after = d.properties.find((p) => p.id === rel.id)
    assert.deepEqual([after.config.targetModuleId, after.config.twoWay, after.config.reversePropertyId], [null, false, null])
    assert.equal(rowsOf(d).get(p1.id).values[rel.id], undefined)
    assert.equal(d.properties.find((p) => p.id === self.id).config.targetModuleId, projects.m.id, 'unrelated relations are untouched')
    await ok('DELETE', `/api/modules/${projects.m.id}`)
  })

  test('module titles are unique (case-insensitive) on create, rename and import', async () => {
    const base = `Budget ${Date.now()}`
    const a = await ok('POST', '/api/modules', { type: 'sheet', title: base })
    const b = await ok('POST', '/api/modules', { type: 'database', title: base.toUpperCase() })
    assert.equal(a.title, base)
    assert.equal(b.title, `${base.toUpperCase()} 2`)
    assert.equal((await ok('PATCH', `/api/modules/${a.id}`, { title: base })).title, base, 'renaming to its own title keeps it')
    assert.equal((await ok('PATCH', `/api/modules/${b.id}`, { title: base })).title, `${base} 2`)
    const imp = await ok('POST', '/api/databases/import', { truss: 1, database: { title: base, properties: [{ id: 't', name: 'Name', type: 'title' }], rows: [] } })
    assert.equal(imp.module.title, `${base} 3`)
    for (const id of [a.id, b.id, imp.module.id]) await ok('DELETE', `/api/modules/${id}`)

    // a duplicate saved before uniqueness was enforced keeps its title when resaved with other fields
    const legacy = `Legacy ${Date.now()}`
    const c = await ok('POST', '/api/modules', { type: 'sheet', title: legacy })
    const d = await ok('POST', '/api/modules', { type: 'sheet', title: 'placeholder' })
    t.s.ctx.db.prepare('UPDATE modules SET title = ? WHERE id = ?').run(legacy, d.id)
    const resaved = await ok('PATCH', `/api/modules/${d.id}`, { title: legacy, icon: '📒' })
    assert.equal(resaved.title, legacy)
    await fail('PATCH', `/api/modules/${d.id}`, { title: 'x'.repeat(501) })
    for (const id of [c.id, d.id]) await ok('DELETE', `/api/modules/${id}`)
  })

  test('module icons longer than 32 characters are rejected on create, patch and import', async () => {
    const long = 'x'.repeat(33)
    await fail('POST', '/api/modules', { type: 'database', icon: long })
    const m = await ok('POST', '/api/modules', { type: 'database', icon: '👨‍👩‍👧‍👦' })
    await fail('PATCH', `/api/modules/${m.id}`, { icon: long })
    await fail('POST', '/api/databases/import', { truss: 1, database: { title: 'Long icon', icon: long, properties: [{ id: 't', name: 'Name', type: 'title' }], rows: [] } })
    await ok('DELETE', `/api/modules/${m.id}`)
  })

  test('creating a two-way relation creates the reverse property; linking and unlinking sync both sides', async () => {
    const projects = await newDb('Projects')
    const tasks = await newDb('Tasks')
    const rel = await ok('POST', `${projects.base}/properties`, { name: 'Tasks', type: 'relation', config: { targetModuleId: tasks.m.id, twoWay: true } })
    assert.equal(rel.config.targetModuleId, tasks.m.id)
    assert.equal(rel.config.twoWay, true)
    const td = await tasks.load()
    const reverse = td.properties.find((p) => p.id === rel.config.reversePropertyId)
    assert.ok(reverse, 'reverse property exists in Tasks')
    assert.equal(reverse.type, 'relation')
    assert.equal(reverse.name, 'Projects')
    assert.deepEqual(reverse.config, { targetModuleId: projects.m.id, twoWay: true, reversePropertyId: rel.id })

    const { created: [t1, t2, t3] } = await ok('POST', `${tasks.base}/rows/batch`, { create: ['A', 'B', 'C'].map((n) => ({ values: { [tasks.titleId]: n } })) })
    const p1 = await ok('POST', `${projects.base}/rows`, { values: { [projects.titleId]: 'Launch', [rel.id]: [t1.id, t2.id] } })
    assert.deepEqual(p1.values[rel.id], [t1.id, t2.id])
    let tr = rowsOf(await tasks.load())
    assert.deepEqual(tr.get(t1.id).values[reverse.id], [p1.id])
    assert.deepEqual(tr.get(t2.id).values[reverse.id], [p1.id])
    assert.equal(tr.get(t3.id).values[reverse.id], undefined)

    // unlink t1 and link t3 from the Projects side
    await ok('PATCH', `${projects.base}/rows/${p1.id}`, { values: { [rel.id]: [t2.id, t3.id] } })
    tr = rowsOf(await tasks.load())
    assert.equal(tr.get(t1.id).values[reverse.id], undefined)
    assert.deepEqual(tr.get(t3.id).values[reverse.id], [p1.id])

    // edit from the Tasks side
    const p2 = await ok('POST', `${projects.base}/rows`, { values: { [projects.titleId]: 'Audit' } })
    await ok('PATCH', `${tasks.base}/rows/${t1.id}`, { values: { [reverse.id]: [p2.id, p1.id] } })
    let pr = rowsOf(await projects.load())
    assert.deepEqual(pr.get(p2.id).values[rel.id], [t1.id])
    assert.deepEqual(pr.get(p1.id).values[rel.id], [t2.id, t3.id, t1.id])

    // deleting a Task removes its id from Projects relation values (single delete and batch delete)
    await ok('DELETE', `${tasks.base}/rows/${t2.id}`)
    pr = rowsOf(await projects.load())
    assert.deepEqual(pr.get(p1.id).values[rel.id], [t3.id, t1.id])
    await ok('POST', `${tasks.base}/rows/batch`, { delete: [t1.id] })
    pr = rowsOf(await projects.load())
    assert.deepEqual(pr.get(p1.id).values[rel.id], [t3.id])
    assert.equal(pr.get(p2.id).values[rel.id], undefined)

    // unknown ids are dropped, non-arrays are rejected, rollups/formulas are read-only
    const cleaned = await ok('PATCH', `${projects.base}/rows/${p2.id}`, { values: { [rel.id]: [t3.id, 'nope'] } })
    assert.deepEqual(cleaned.values[rel.id], [t3.id])
    await fail('PATCH', `${projects.base}/rows/${p2.id}`, { values: { [rel.id]: 'x' } })

    // deleting the relation property removes the reverse property and its values
    const del = await ok('DELETE', `${projects.base}/properties/${rel.id}`)
    assert.deepEqual(del.deleted.sort(), [rel.id, reverse.id].sort())
    const after = await tasks.load()
    assert.ok(!after.properties.some((p) => p.id === reverse.id))
    assert.ok(after.rows.every((r) => !(reverse.id in r.values)))
  })

  test('a same-database two-way relation links rows inside one database, including self links', async () => {
    const people = await newDb('People')
    const rel = await ok('POST', `${people.base}/properties`, { name: 'Manager', type: 'relation', config: { targetModuleId: people.m.id, twoWay: true } })
    const d = await people.load()
    const reverse = d.properties.find((p) => p.id === rel.config.reversePropertyId)
    assert.equal(reverse.name, 'Related to Manager')
    const { created: [boss, a, b] } = await ok('POST', `${people.base}/rows/batch`, { create: ['Boss', 'A', 'B'].map((n) => ({ values: { [people.titleId]: n } })) })
    const updated = await ok('PATCH', `${people.base}/rows/${a.id}`, { values: { [rel.id]: [boss.id] } })
    assert.deepEqual(updated.values[rel.id], [boss.id])
    await ok('PATCH', `${people.base}/rows/${b.id}`, { values: { [rel.id]: [boss.id, b.id] } })
    const r = rowsOf(await people.load())
    assert.deepEqual(r.get(boss.id).values[reverse.id], [a.id, b.id])
    assert.deepEqual(r.get(b.id).values[reverse.id], [b.id])
    // turning two-way off deletes the reverse property; turning it on again backfills it
    await ok('PATCH', `${people.base}/properties/${rel.id}`, { config: { twoWay: false } })
    let again = await people.load()
    assert.ok(!again.properties.some((p) => p.id === reverse.id))
    const { property } = await ok('PATCH', `${people.base}/properties/${rel.id}`, { config: { twoWay: true } })
    again = await people.load()
    const rev2 = again.properties.find((p) => p.id === property.config.reversePropertyId)
    assert.ok(rev2 && rev2.id !== reverse.id)
    assert.deepEqual(rowsOf(again).get(boss.id).values[rev2.id], [a.id, b.id])
  })

  test('relation configs are validated; rollup and formula configs are normalised and values read-only', async () => {
    const x = await newDb('X')
    await fail('POST', `${x.base}/properties`, { type: 'relation', config: { targetModuleId: 'missing' } })
    const sheet = await ok('POST', '/api/modules', { type: 'notebook', title: 'Not a db' })
    await fail('POST', `${x.base}/properties`, { type: 'relation', config: { targetModuleId: sheet.id } })
    await fail('POST', `${x.base}/properties`, { type: 'rollup', config: { fn: 'bogus' } })
    const roll = await ok('POST', `${x.base}/properties`, { type: 'rollup', config: { fn: 'sum' } })
    assert.deepEqual(roll.config, { relationPropertyId: null, targetPropertyId: null, fn: 'sum' })
    const f = await ok('POST', `${x.base}/properties`, { name: 'Total', type: 'formula', config: { expression: 'prop("Price") * prop("Qty")' } })
    assert.equal(f.config.expression, 'prop("Price") * prop("Qty")')
    const { property } = await ok('PATCH', `${x.base}/properties/${roll.id}`, { config: { fn: 'average' } })
    assert.equal(property.config.fn, 'average')
    const row = await ok('POST', `${x.base}/rows`, {})
    await fail('PATCH', `${x.base}/rows/${row.id}`, { values: { [f.id]: 3 } })
    await fail('PATCH', `${x.base}/rows/${row.id}`, { values: { [roll.id]: 3 } })
  })

  test('stamp changes when rows or properties change', async () => {
    const x = await newDb('Stamp')
    const s1 = (await ok('GET', `${x.base}/stamp`)).stamp
    assert.equal((await ok('GET', `${x.base}/stamp`)).stamp, s1)
    const row = await ok('POST', `${x.base}/rows`, {})
    const s2 = (await ok('GET', `${x.base}/stamp`)).stamp
    assert.notEqual(s2, s1)
    await new Promise((r) => setTimeout(r, 5))
    await ok('PATCH', `${x.base}/rows/${row.id}`, { values: { [x.titleId]: 'changed' } })
    const s3 = (await ok('GET', `${x.base}/stamp`)).stamp
    assert.notEqual(s3, s2)
    await ok('POST', `${x.base}/properties`, { type: 'text' })
    assert.notEqual((await ok('GET', `${x.base}/stamp`)).stamp, s3)
  })
})

describe('JSON import', () => {
  test('round trip of every property type keeps names, types, configs, views and values', async () => {
    const tasks = await newDb('Import target')
    const { created: [ta, tb] } = await ok('POST', `${tasks.base}/rows/batch`, { create: [{ values: { [tasks.titleId]: 'TA' } }, { values: { [tasks.titleId]: 'TB' } }] })
    const src = await newDb('Source')
    const P = { Name: { id: src.titleId } }
    const mk = async (name, type, config) => (P[name] = await ok('POST', `${src.base}/properties`, { name, type, config }))
    await mk('Notes', 'text')
    await mk('Price', 'number', { format: 'aud' })
    await mk('Kind', 'select', { options: [{ name: 'A', color: 'red' }, { name: 'B' }] })
    await mk('Tags', 'multi_select', { options: [{ name: 'x' }, { name: 'y' }] })
    await mk('State', 'status')
    await mk('When', 'date')
    await mk('Done', 'checkbox')
    await mk('Site', 'url')
    await mk('Mail', 'email')
    await mk('Phone', 'phone')
    await mk('Files', 'files')
    await mk('Created', 'created_time')
    await mk('Edited', 'last_edited_time')
    await mk('Tasks', 'relation', { targetModuleId: tasks.m.id, twoWay: true })
    await mk('Parent', 'relation', { targetModuleId: src.m.id, twoWay: true })
    await mk('Task count', 'rollup', { relationPropertyId: P.Tasks.id, targetPropertyId: tasks.titleId, fn: 'count' })
    await mk('Total', 'formula', { expression: 'prop("Price") * 2' })
    const srcData = await src.load()
    const childName = srcData.properties.find((p) => p.id === P.Parent.config.reversePropertyId)
    const { created: [r1, r2] } = await ok('POST', `${src.base}/rows/batch`, { create: [
      { values: { [P.Name.id]: 'One', [P.Notes.id]: 'n, "q"', [P.Price.id]: 12.5, [P.Kind.id]: P.Kind.config.options[1].id, [P.Tags.id]: P.Tags.config.options.map((o) => o.id),
        [P.State.id]: P.State.config.options[2].id, [P.When.id]: { start: '2026-05-14', end: '2026-05-20' }, [P.Done.id]: true, [P.Site.id]: 'https://example.com',
        [P.Mail.id]: 'a@b.co', [P.Phone.id]: '+61 412 345 678', [P.Tasks.id]: [ta.id, tb.id] }, notes: 'Hello' },
      { values: { [P.Name.id]: 'Two' } },
    ] })
    await ok('PATCH', `${src.base}/rows/${r2.id}`, { values: { [P.Parent.id]: [r1.id] } })
    await ok('PATCH', `${src.base}/views/${srcData.views[0].id}`, { name: 'Main', config: { hidden: [P.Notes.id], sorts: [{ property: P.Price.id, direction: 'desc' }], filter: { op: 'and', rules: [{ property: P.Done.id, operator: 'checked' }] }, widths: { [P.Price.id]: 150 } } })
    await ok('POST', `${src.base}/views`, { name: 'Board', type: 'board', config: { group_by: P.Kind.id } })
    const before = await src.load()
    const doc = { truss: 1, database: { id: src.m.id, title: before.module.title, properties: before.properties, views: before.views, rows: before.rows } }

    const imported = await ok('POST', '/api/databases/import', JSON.parse(JSON.stringify(doc)), 201)
    const after = await ok('GET', `/api/databases/${imported.module.id}`)
    assert.equal(after.module.title, 'Source 2', 'the source still exists, so the copy gets a unique title')
    const idMap = new Map(before.properties.map((p) => [p.id, after.properties.find((q) => q.name === p.name)?.id]))
    assert.deepEqual(after.properties.map((p) => [p.name, p.type]), before.properties.map((p) => [p.name, p.type]))
    const rowMap = new Map(before.rows.map((r, i) => [r.id, after.rows[i].id]))
    const mapIds = (v) => v.map((id) => rowMap.get(id) ?? idMap.get(id) ?? id)
    for (const p of before.properties) {
      const q = after.properties.find((x) => x.id === idMap.get(p.id))
      const expected = { ...p.config }
      if (p.type === 'relation') {
        if (expected.targetModuleId === src.m.id) expected.targetModuleId = imported.module.id
        if (p.id === P.Tasks.id) {
          assert.ok(q.config.reversePropertyId && q.config.reversePropertyId !== p.config.reversePropertyId, 'external two-way relation gets its own reverse property')
          expected.reversePropertyId = q.config.reversePropertyId
        } else expected.reversePropertyId = idMap.get(p.config.reversePropertyId)
      }
      if (p.type === 'rollup') expected.relationPropertyId = idMap.get(p.config.relationPropertyId)
      assert.deepEqual(q.config, expected, `config of ${p.name}`)
      assert.equal(q.width, p.width)
    }
    assert.equal(childName.name, after.properties.find((p) => p.id === idMap.get(childName.id)).name)
    for (const [i, r] of before.rows.entries()) {
      const a = after.rows[i]
      const expected = Object.fromEntries(Object.entries(r.values).map(([k, v]) => [idMap.get(k), Array.isArray(v) && (k === P.Parent.id || k === childName.id) ? mapIds(v) : v]))
      assert.deepEqual(a.values, expected, `values of row ${i + 1}`)
      assert.equal(a.notes, r.notes)
      assert.equal(a.created_at, r.created_at)
    }
    assert.deepEqual(after.views.map((v) => [v.name, v.type]), before.views.map((v) => [v.name, v.type]))
    const main = after.views[0].config
    assert.deepEqual(main.hidden, [idMap.get(P.Notes.id)])
    assert.deepEqual(main.sorts, [{ property: idMap.get(P.Price.id), direction: 'desc' }])
    assert.equal(main.filter.rules[0].property, idMap.get(P.Done.id))
    assert.deepEqual(main.widths, { [idMap.get(P.Price.id)]: 150 })
    assert.equal(after.views[1].config.group_by, idMap.get(P.Kind.id))
    // the external target got links back to the imported rows
    const tr = rowsOf(await tasks.load())
    const importedTasks = after.properties.find((p) => p.name === 'Tasks')
    assert.ok(tr.get(ta.id).values[importedTasks.config.reversePropertyId].includes(after.rows[0].id))
  })

  test('malformed documents are rejected and create nothing', async () => {
    const count = async () => (await ok('GET', '/api/modules')).length
    const n = await count()
    await fail('POST', '/api/databases/import', { truss: 2, database: {} })
    await fail('POST', '/api/databases/import', { truss: 1, database: { properties: [{ type: 'nope' }] } })
    await fail('POST', '/api/databases/import', { truss: 1, database: { properties: [{ id: 'a', name: 'N', type: 'title' }, { id: 'b', name: 'Qty', type: 'number' }], rows: [{ values: { a: 'ok' } }, { values: { b: 'not a number' } }] } })
    const r = await t.call('POST', '/api/databases/import', { headers: { 'Content-Type': 'application/json' }, body: '{"truss":1,' })
    assert.equal(r.status, 400)
    assert.equal(await count(), n)
  })
})

describe('lookup properties', () => {
  test('config is validated, the target must be a database, and it resets when the target is deleted', async () => {
    const details = await newDb('Lookup details')
    const orders = await newDb('Lookup orders')
    const notebook = await ok('POST', '/api/modules', { type: 'notebook' })
    const text = await ok('POST', `${orders.base}/properties`, { name: 'Code', type: 'text' })
    const config = { sourcePropertyId: text.id, targetModuleId: details.m.id, matchPropertyId: details.titleId, returnPropertyId: details.titleId }
    const look = await ok('POST', `${orders.base}/properties`, { name: 'Label', type: 'lookup', config })
    assert.deepEqual(look.config, config)
    await fail('POST', `${orders.base}/properties`, { name: 'Bad', type: 'lookup', config: { ...config, matchPropertyId: 42 } })
    await fail('POST', `${orders.base}/properties`, { name: 'Bad', type: 'lookup', config: { ...config, targetModuleId: notebook.id } })
    await fail('PATCH', `${orders.base}/properties/${look.id}`, { config: { targetModuleId: notebook.id } })
    // columns must belong to the right database
    await fail('POST', `${orders.base}/properties`, { name: 'Bad', type: 'lookup', config: { ...config, sourcePropertyId: details.titleId } })
    await fail('POST', `${orders.base}/properties`, { name: 'Bad', type: 'lookup', config: { ...config, returnPropertyId: text.id } })
    await fail('POST', `${orders.base}/properties`, { name: 'Bad', type: 'lookup', config: { ...config, targetModuleId: null } })
    // values are computed in the browser: writing one is refused
    const row = await ok('POST', `${orders.base}/rows`, { values: { [text.id]: 'x' } })
    await fail('PATCH', `${orders.base}/rows/${row.id}`, { values: { [look.id]: 'y' } })

    await ok('DELETE', `/api/modules/${details.m.id}`)
    const after = (await orders.load()).properties.find((p) => p.id === look.id)
    assert.deepEqual(after.config, { sourcePropertyId: text.id, targetModuleId: null, matchPropertyId: null, returnPropertyId: null })
    for (const id of [orders.m.id, notebook.id]) await ok('DELETE', `/api/modules/${id}`)
  })

  test('JSON import keeps lookups: ids are remapped for this database, kept for another one', async () => {
    const details = await newDb('Lookup import target')
    const doc = {
      truss: 1,
      database: {
        id: 'src', title: 'Lookup import',
        properties: [
          { id: 'n', name: 'Name', type: 'title' },
          { id: 'c', name: 'Code', type: 'text' },
          { id: 'l1', name: 'Other', type: 'lookup', config: { sourcePropertyId: 'c', targetModuleId: details.m.id, matchPropertyId: details.titleId, returnPropertyId: details.titleId } },
          { id: 'l0', name: 'Chained', type: 'lookup', config: { sourcePropertyId: 'l2', targetModuleId: 'src', matchPropertyId: 'n', returnPropertyId: 'l3' } },
          { id: 'l2', name: 'Self', type: 'lookup', config: { sourcePropertyId: 'c', targetModuleId: 'src', matchPropertyId: 'n', returnPropertyId: 'c' } },
          { id: 'l3', name: 'Gone', type: 'lookup', config: { sourcePropertyId: 'c', targetModuleId: 'missing', matchPropertyId: 'x', returnPropertyId: 'y' } },
        ],
        rows: [{ values: { n: 'A', c: 'B', l1: 'ignored' } }],
      },
    }
    const imported = await ok('POST', '/api/databases/import', doc, 201)
    const d = await ok('GET', `/api/databases/${imported.module.id}`)
    const by = (name) => d.properties.find((p) => p.name === name)
    assert.deepEqual(by('Other').config, { sourcePropertyId: by('Code').id, targetModuleId: details.m.id, matchPropertyId: details.titleId, returnPropertyId: details.titleId })
    assert.deepEqual(by('Self').config, { sourcePropertyId: by('Code').id, targetModuleId: imported.module.id, matchPropertyId: by('Name').id, returnPropertyId: by('Code').id })
    assert.deepEqual(by('Chained').config, { sourcePropertyId: by('Self').id, targetModuleId: imported.module.id, matchPropertyId: by('Name').id, returnPropertyId: by('Gone').id }, 'refers to lookups defined later')
    assert.deepEqual(by('Gone').config, { sourcePropertyId: by('Code').id, targetModuleId: null, matchPropertyId: null, returnPropertyId: null })
    assert.equal(d.rows.length, 1)
    for (const id of [details.m.id, imported.module.id]) await ok('DELETE', `/api/modules/${id}`)
  })
})

describe('list properties', () => {
  const titles = (d) => d.rows.map((r) => r.values[d.properties.find((p) => p.type === 'title').id])

  test('rows follow the source: added, renamed (title follows unless edited), deleted rows kept; creation and in-source deletes refused', async () => {
    const cities = await newDb('List cities')
    const { created: [syd, mel, dar] } = await ok('POST', `${cities.base}/rows/batch`, { create: ['Sydney', 'Melbourne', 'Darwin'].map((n) => ({ values: { [cities.titleId]: n } })) })
    const offices = await newDb('List offices')
    const note = await ok('POST', `${offices.base}/properties`, { name: 'Note', type: 'text' })
    const list = await ok('POST', `${offices.base}/properties`, { name: 'City', type: 'list', config: { sourceModuleId: cities.m.id } })
    assert.deepEqual(list.config, { sourceModuleId: cities.m.id, sourceDeleted: false })
    let d = await offices.load()
    assert.deepEqual(titles(d), ['Sydney', 'Melbourne', 'Darwin'])
    const row = (srcId) => d.rows.find((r) => r.values[list.id]?.id === srcId)
    assert.deepEqual(row(syd.id).values[list.id], { id: syd.id, text: 'Sydney' })

    // other columns are editable; the list column and new rows are not
    await ok('PATCH', `${offices.base}/rows/${row(syd.id).id}`, { values: { [note.id]: 'HQ' } })
    await fail('PATCH', `${offices.base}/rows/${row(syd.id).id}`, { values: { [list.id]: { id: mel.id, text: 'x' } } })
    const refused = await fail('POST', `${offices.base}/rows`, {})
    assert.equal(refused.error.code, 'rows_from_list')
    await fail('POST', `${offices.base}/rows/batch`, { create: [{}] })

    // source changes reach the list database the next time it is read
    await ok('POST', `${cities.base}/rows`, { values: { [cities.titleId]: 'Hobart' } })
    await ok('PATCH', `/api/databases/${offices.m.id}/rows/${row(mel.id).id}`, { values: { [offices.titleId]: 'Melbourne office' } })
    await ok('PATCH', `${cities.base}/rows/${syd.id}`, { values: { [cities.titleId]: 'Sydney CBD' } })
    await ok('PATCH', `${cities.base}/rows/${mel.id}`, { values: { [cities.titleId]: 'Naarm' } })
    d = await offices.load()
    assert.deepEqual(titles(d), ['Sydney CBD', 'Melbourne office', 'Darwin', 'Hobart'], 'renamed title follows; edited title is kept')
    assert.equal(row(mel.id).values[list.id].text, 'Naarm')
    assert.equal(row(syd.id).values[note.id], 'HQ')

    // a deleted source row: its row stays and can now be deleted; rows still in the source can't be
    await ok('DELETE', `${cities.base}/rows/${dar.id}`)
    d = await offices.load()
    assert.ok(row(dar.id), 'row kept after its source row was deleted')
    const inSource = await fail('DELETE', `${offices.base}/rows/${row(syd.id).id}`)
    assert.equal(inSource.error.code, 'row_in_list')
    await ok('DELETE', `${offices.base}/rows/${row(dar.id).id}`)
    assert.deepEqual(titles(await offices.load()), ['Sydney CBD', 'Melbourne office', 'Hobart'])

    // a refused batch delete changes nothing, including attachment files of rows earlier in the batch
    const gone = (await offices.load()).rows.find((r) => r.values[offices.titleId] === 'Hobart')
    await ok('DELETE', `${cities.base}/rows/${gone.values[list.id].id}`)
    const upload = await t.call('POST', `/api/attachments?moduleId=${offices.m.id}&pageId=${gone.id}`, { headers: { 'X-Filename': 'note.txt', 'Content-Type': 'application/octet-stream' }, body: 'kept' })
    assert.equal(upload.status, 201)
    await fail('POST', `${offices.base}/rows/batch`, { delete: [gone.id, row(syd.id).id] })
    assert.equal((await t.call('GET', `/api/attachments/${upload.json.id}/content`)).text, 'kept')
    assert.ok((await offices.load()).rows.some((r) => r.id === gone.id))

    // the stamp endpoint syncs too, so polling clients see new source rows
    const before = (await ok('GET', `${offices.base}/stamp`)).stamp
    await ok('POST', `${cities.base}/rows`, { values: { [cities.titleId]: 'Perth' } })
    assert.notEqual((await ok('GET', `${offices.base}/stamp`)).stamp, before)
    for (const id of [offices.m.id, cities.m.id]) await ok('DELETE', `/api/modules/${id}`)
  })

  test('validation, matching existing rows by title, changing source, deleting the source, JSON import', async () => {
    const a = await newDb('List source A')
    const b = await newDb('List source B')
    await ok('POST', `${a.base}/rows/batch`, { create: ['Canberra', 'Perth'].map((n) => ({ values: { [a.titleId]: n } })) })
    await ok('POST', `${b.base}/rows/batch`, { create: ['Perth', 'Brisbane'].map((n) => ({ values: { [b.titleId]: n } })) })
    const target = await newDb('List target')
    await ok('POST', `${target.base}/rows/batch`, { create: ['perth', 'Elsewhere'].map((n) => ({ values: { [target.titleId]: n } })) })
    const notebook = await ok('POST', '/api/modules', { type: 'notebook' })
    await fail('POST', `${target.base}/properties`, { name: 'L', type: 'list', config: {} })
    await fail('POST', `${target.base}/properties`, { name: 'L', type: 'list', config: { sourceModuleId: target.m.id } })
    await fail('POST', `${target.base}/properties`, { name: 'L', type: 'list', config: { sourceModuleId: notebook.id } })

    const list = await ok('POST', `${target.base}/properties`, { name: 'City', type: 'list', config: { sourceModuleId: a.m.id } })
    await fail('POST', `${target.base}/properties`, { name: 'Second', type: 'list', config: { sourceModuleId: b.m.id } }, 400)
    let d = await target.load()
    assert.deepEqual(titles(d), ['perth', 'Elsewhere', 'Canberra'], 'perth matched (title kept), Canberra added, Elsewhere left unlinked')
    assert.equal(d.rows[0].values[list.id].text, 'Perth')
    assert.equal(d.rows[1].values[list.id], undefined)

    // a new source: rows are matched again by title
    await ok('PATCH', `${target.base}/properties/${list.id}`, { config: { sourceModuleId: b.m.id } })
    d = await target.load()
    assert.deepEqual(titles(d), ['perth', 'Elsewhere', 'Canberra', 'Brisbane'])
    assert.equal(d.rows.find((r) => r.values[target.titleId] === 'Canberra').values[list.id], undefined, 'no longer linked')

    // JSON import keeps the list's text as a plain text column
    const exported = { truss: 1, database: { title: 'List copy', properties: d.properties, rows: d.rows, views: d.views } }
    const copy = await ok('POST', '/api/databases/import', JSON.parse(JSON.stringify(exported)), 201)
    const cd = await ok('GET', `/api/databases/${copy.module.id}`)
    const city = cd.properties.find((p) => p.name === 'City')
    assert.equal(city.type, 'text')
    assert.equal(cd.rows[0].values[city.id], 'Perth')

    // no chains or cycles: a list database can't be a source, and a source can't get a list
    const third = await newDb('List third')
    await fail('POST', `${third.base}/properties`, { name: 'L', type: 'list', config: { sourceModuleId: target.m.id } })
    await fail('POST', `${b.base}/properties`, { name: 'L', type: 'list', config: { sourceModuleId: a.m.id } })

    // deleting the source keeps rows and unlocks new ones; the orphaned column can still be renamed
    await ok('DELETE', `/api/modules/${b.m.id}`)
    d = await target.load()
    assert.deepEqual(d.properties.find((p) => p.id === list.id).config, { sourceModuleId: null, sourceDeleted: true })
    assert.equal(d.rows.length, 4)
    await ok('POST', `${target.base}/rows`, {})
    assert.equal((await ok('PATCH', `${target.base}/properties/${list.id}`, { name: 'Old city', width: 240 })).property.name, 'Old city')
    await ok('DELETE', `/api/modules/${third.m.id}`)
    for (const id of [a.m.id, target.m.id, copy.module.id, notebook.id]) await ok('DELETE', `/api/modules/${id}`)
  })
})
