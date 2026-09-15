import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot } from '../server-core/helpers.js'

let t
before(async () => { t = await boot() })
after(async () => { await t.s.close() })

const json = (r) => r.json
async function notebook(template = 'blank') {
  const r = await t.call('POST', '/api/modules', { json: { type: 'notebook', template } })
  assert.equal(r.status, 201)
  return r.json
}
const P = (m, rest = '') => `/api/notebooks/${m.id}/pages${rest}`

test('templates: text and table notebooks set the style and seed pages', async () => {
  const list = json(await t.call('GET', '/api/templates'))
  assert.ok(list.some((x) => x.type === 'notebook' && x.key === 'text'))
  assert.ok(list.some((x) => x.type === 'notebook' && x.key === 'table'))

  const text = await notebook('text')
  assert.equal(text.data.style, 'text')
  const pages = json(await t.call('GET', P(text)))
  const welcome = pages.find((p) => p.title === 'Welcome')
  assert.ok(welcome)
  assert.equal(welcome.content, undefined, 'list omits content')
  assert.ok(pages.some((p) => p.parent_id === welcome.id), 'welcome has a subpage')
  const full = json(await t.call('GET', P(text, `/${welcome.id}`)))
  const types = new Set(full.content.map((b) => b.type))
  for (const type of ['heading1', 'heading2', 'heading3', 'paragraph', 'bulleted', 'numbered', 'todo', 'quote', 'callout', 'code', 'divider', 'toggle', 'table']) {
    assert.ok(types.has(type), `welcome page demonstrates ${type}`)
  }
  for (const b of full.content) assert.ok(b.id && typeof b.html === 'string' && b.props && typeof b.props === 'object')

  const tbl = await notebook('table')
  assert.equal(tbl.data.style, 'table')
  const [sample] = json(await t.call('GET', P(tbl)))
  const sc = json(await t.call('GET', P(tbl, `/${sample.id}`))).content
  assert.ok(sc.columns.length >= 3 && sc.rows.length >= 2)
  assert.ok(Object.values(sc.rows[0].cells).some((v) => /\d{2}\/\d{2}\/\d{4}/.test(v)))
  // new pages in a table notebook default to a table
  const np = await t.call('POST', P(tbl), { json: { title: 'New' } })
  assert.equal(np.status, 201)
  assert.ok(Array.isArray(np.json.content.columns))
})

test('pages CRUD, validation and 404s', async () => {
  const m = await notebook()
  const a = json(await t.call('POST', P(m), { json: { title: '  Alpha ', icon: '🦘' } }))
  assert.equal(a.title, 'Alpha')
  assert.equal(a.icon, '🦘')
  assert.deepEqual(a.content, [])
  const sub = json(await t.call('POST', P(m), { json: { parent_id: a.id, title: 'Child' } }))
  assert.equal(sub.parent_id, a.id)

  const blocks = [{ id: 'b1', type: 'heading1', html: 'Hi <b>there</b>', props: {} }]
  const patched = await t.call('PATCH', P(m, `/${a.id}`), { json: { title: 'Renamed', icon: null, content: blocks } })
  assert.equal(patched.status, 200)
  assert.equal(patched.json.title, 'Renamed')
  assert.equal(patched.json.icon, null)
  const got = json(await t.call('GET', P(m, `/${a.id}`)))
  assert.deepEqual(got.content, blocks)

  assert.equal((await t.call('PATCH', P(m, `/${a.id}`), { json: { content: 'nope' } })).status, 400)
  assert.equal((await t.call('PATCH', P(m, `/${a.id}`), { json: { title: 5 } })).status, 400)
  assert.equal((await t.call('POST', P(m), { json: { parent_id: 'missing' } })).status, 400)
  assert.equal((await t.call('POST', P(m, `/${a.id}/move`), { json: null })).status, 400)
  assert.equal((await t.call('POST', P(m), { json: null })).status, 201, 'null body creates an untitled page')
  assert.equal((await t.call('GET', P(m, '/missing'))).status, 404)
  assert.equal((await t.call('GET', '/api/notebooks/missing/pages')).status, 404)
  const sheet = json(await t.call('POST', '/api/modules', { json: { type: 'sheet' } }))
  assert.equal((await t.call('GET', `/api/notebooks/${sheet.id}/pages`)).status, 404)
  // a page from another notebook is not reachable through this one
  const other = await notebook()
  assert.equal((await t.call('GET', `/api/notebooks/${other.id}/pages/${a.id}`)).status, 404)
})

test('move reorders siblings, nests, un-nests and rejects cycles', async () => {
  const m = await notebook()
  const mk = async (title, parent_id) => json(await t.call('POST', P(m), { json: { title, parent_id } }))
  const a = await mk('A')
  const b = await mk('B')
  const c = await mk('C')
  const order = async (parent = null) => json(await t.call('GET', P(m))).filter((p) => p.parent_id === parent).map((p) => p.title)
  assert.deepEqual(await order(), ['A', 'B', 'C'])

  assert.equal((await t.call('POST', P(m, `/${c.id}/move`), { json: { parent_id: null, before_id: a.id } })).status, 200)
  assert.deepEqual(await order(), ['C', 'A', 'B'])

  await t.call('POST', P(m, `/${b.id}/move`), { json: { parent_id: a.id, before_id: null } })
  assert.deepEqual(await order(), ['C', 'A'])
  assert.deepEqual(await order(a.id), ['B'])
  const d = await mk('D', a.id)
  await t.call('POST', P(m, `/${d.id}/move`), { json: { parent_id: a.id, before_id: b.id } })
  assert.deepEqual(await order(a.id), ['D', 'B'])

  const cyc = await t.call('POST', P(m, `/${a.id}/move`), { json: { parent_id: b.id } })
  assert.equal(cyc.status, 400)
  assert.equal((await t.call('POST', P(m, `/${a.id}/move`), { json: { parent_id: a.id } })).status, 400)
  assert.equal((await t.call('POST', P(m, `/${a.id}/move`), { json: { parent_id: null, before_id: b.id } })).status, 400)

  await t.call('POST', P(m, `/${b.id}/move`), { json: { parent_id: null, before_id: null } })
  assert.deepEqual(await order(), ['C', 'A', 'B'])
})

test('archive and restore; restoring under an archived parent moves the page to the top level', async () => {
  const m = await notebook()
  const parent = json(await t.call('POST', P(m), { json: { title: 'Parent' } }))
  const child = json(await t.call('POST', P(m), { json: { title: 'Child', parent_id: parent.id } }))
  const arch = json(await t.call('POST', P(m, `/${parent.id}/archive`)))
  assert.ok(arch.archived_at)
  const again = json(await t.call('POST', P(m, `/${parent.id}/archive`)))
  assert.equal(again.archived_at, arch.archived_at, 'archiving twice keeps the first timestamp')

  await t.call('POST', P(m, `/${child.id}/archive`))
  const restoredChild = json(await t.call('POST', P(m, `/${child.id}/restore`)))
  assert.equal(restoredChild.archived_at, null)
  assert.equal(restoredChild.parent_id, null)

  const restored = json(await t.call('POST', P(m, `/${parent.id}/restore`)))
  assert.equal(restored.archived_at, null)
  const grand = json(await t.call('POST', P(m), { json: { title: 'G', parent_id: parent.id } }))
  await t.call('POST', P(m, `/${grand.id}/archive`))
  const g2 = json(await t.call('POST', P(m, `/${grand.id}/restore`)))
  assert.equal(g2.parent_id, parent.id, 'parent is visible so the page stays nested')
})

test('delete cascades to subpages and removes their attachment files from disk', async () => {
  const m = await notebook()
  const keep = json(await t.call('POST', P(m), { json: { title: 'Keep' } }))
  const top = json(await t.call('POST', P(m), { json: { title: 'Top' } }))
  const mid = json(await t.call('POST', P(m), { json: { title: 'Mid', parent_id: top.id } }))
  const leaf = json(await t.call('POST', P(m), { json: { title: 'Leaf', parent_id: mid.id } }))
  const files = []
  for (const [page, name] of [[top, 'a.txt'], [mid, 'b.txt'], [leaf, 'c.png'], [keep, 'keep.txt']]) {
    const r = await t.call('POST', `/api/attachments?moduleId=${m.id}&pageId=${page.id}`, { headers: { 'X-Filename': name }, body: Buffer.from('data ' + name) })
    assert.equal(r.status, 201)
    files.push({ page, row: r.json, path: t.s.ctx.attachments.pathOf(r.json.id) })
  }
  for (const f of files) assert.ok(fs.existsSync(f.path))

  const del = await t.call('DELETE', P(m, `/${top.id}`))
  assert.equal(del.status, 200)
  assert.equal(del.json.attachmentsRemoved, 3)
  const left = json(await t.call('GET', P(m))).map((p) => p.title)
  assert.deepEqual(left, ['Keep'])
  for (const f of files.slice(0, 3)) {
    assert.equal(fs.existsSync(f.path), false, `${f.row.filename} removed from disk`)
    assert.equal((await t.call('GET', `/api/attachments/${f.row.id}/content`)).status, 404)
  }
  assert.ok(fs.existsSync(files[3].path), 'other pages keep their attachments')
  assert.equal((await t.call('DELETE', P(m, `/${top.id}`))).status, 404)
})

test('search finds pages by title and by body text, not by markup or ids', async () => {
  const m = await notebook()
  await t.call('POST', P(m), { json: { title: 'Quarterly kangaroo census' } })
  await t.call('POST', P(m), { json: { title: 'Plain', content: [
    { id: 'strongid', type: 'paragraph', html: 'The <b>wombat</b> burrow &amp; tunnels', props: {} },
    { id: 'x2', type: 'table', html: '', props: { columns: [{ id: 'c1', name: 'Species' }], rows: [{ id: 'r1', cells: { c1: 'Echidna' } }] } },
  ] } })
  await t.call('POST', P(m), { json: { title: 'Other', content: [{ id: 'z', type: 'paragraph', html: 'nothing here', props: {} }] } })

  const s = async (q) => json(await t.call('GET', `/api/notebooks/${m.id}/search?q=${encodeURIComponent(q)}`))
  const byTitle = await s('KANGAROO')
  assert.deepEqual(byTitle.map((r) => r.title), ['Quarterly kangaroo census'])
  assert.equal(byTitle[0].match, 'title')
  const byBody = await s('wombat burrow & tun')
  assert.deepEqual(byBody.map((r) => r.title), ['Plain'])
  assert.equal(byBody[0].match, 'content')
  assert.match(byBody[0].snippet, /wombat burrow & tunnels/)
  assert.equal(byBody[0].content, undefined)
  assert.deepEqual((await s('echidna')).map((r) => r.title), ['Plain'])
  assert.deepEqual(await s('strong'), [], 'tag names and ids are not searchable')
  assert.deepEqual(await s('   '), [])
})

test('deleting the module cascades its pages', async () => {
  const m = await notebook('text')
  assert.ok(json(await t.call('GET', P(m))).length > 0)
  await t.call('DELETE', `/api/modules/${m.id}`)
  const n = t.s.ctx.db.prepare('SELECT COUNT(*) AS n FROM nb_pages WHERE module_id = ?').get(m.id).n
  assert.equal(n, 0)
})
