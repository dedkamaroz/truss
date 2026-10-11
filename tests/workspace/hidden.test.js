import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { boot } from '../server-core/helpers.js'

// The hidden-database feature: titles in TRUSS_HIDDEN_TITLES stay readable as
// referenced data (their documents still ship in the workspace) but are hidden
// from every listing, route and write for anyone without X-Truss-Admin. A
// non-hosted server has no proxy and no header, so its single user is always
// an admin - covered by the last test.

const mod = (id, type = 'notebook', extra = {}) => ({ id, type, title: `T ${id}`, color: 'teal', createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z', ...extra })

const ADMIN = { 'X-Truss-Admin': '1' }

async function withHidden(fn) {
  process.env.TRUSS_HIDDEN_TITLES = 'FI Names'
  process.env.TRUSS_HOSTED = '1'
  const b = await boot()
  try {
    await fn(b)
  } finally {
    delete process.env.TRUSS_HIDDEN_TITLES
    delete process.env.TRUSS_HOSTED
    await b.s.close()
    fs.rmSync(b.dataDir, { recursive: true, force: true })
  }
}

async function seed({ call }) {
  const r = await call('POST', '/api/v2/sync', {
    headers: ADMIN,
    json: { client: 'seed', puts: [{ module: mod('hid', 'notebook', { title: 'FI Names' }), baseVersion: 0 }, { module: mod('pub', 'notebook', { title: 'Public' }), baseVersion: 0 }] },
  })
  assert.equal(r.status, 200, r.text)
}

test('the workspace flags hidden modules for non-admins and never for admins', async () => {
  await withHidden(async (b) => {
    await seed(b)
    const user = await b.call('GET', '/api/v2/workspace')
    assert.equal(user.status, 200)
    const flagged = Object.fromEntries(user.json.modules.map((m) => [m.module.id, !!m.hidden]))
    assert.deepEqual(flagged, { hid: true, pub: false })
    // The document still ships: referenced data must stay computable.
    assert.equal(user.json.modules.find((m) => m.module.id === 'hid').module.title, 'FI Names')
    const boss = await b.call('GET', '/api/v2/workspace', { headers: ADMIN })
    assert.equal(boss.json.modules.some((m) => m.hidden), false)
  })
})

test('a hidden module 404s for non-admins and opens for admins', async () => {
  await withHidden(async (b) => {
    await seed(b)
    assert.equal((await b.call('GET', '/api/v2/modules/hid')).status, 404)
    assert.equal((await b.call('GET', '/api/v2/modules/hid', { headers: ADMIN })).status, 200)
    assert.equal((await b.call('GET', '/api/v2/modules/pub')).status, 200)
  })
})

test('non-admins cannot create, edit, delete or take the title of a hidden module', async () => {
  await withHidden(async (b) => {
    await seed(b)
    const edit = await b.call('POST', '/api/v2/sync', { json: { client: 'u', puts: [{ module: mod('hid', 'notebook', { title: 'Mine now' }), baseVersion: 1 }] } })
    assert.equal(edit.status, 403)
    // 403 wins even over a stale baseVersion: authorisation before versioning.
    const stale = await b.call('POST', '/api/v2/sync', { json: { client: 'u', puts: [{ module: mod('hid', 'notebook', { title: 'Mine now' }), baseVersion: 0 }] } })
    assert.equal(stale.status, 403)
    const del = await b.call('POST', '/api/v2/sync', { json: { client: 'u', deletes: [{ id: 'hid', baseVersion: 1 }] } })
    assert.equal(del.status, 403)
    const take = await b.call('POST', '/api/v2/sync', { json: { client: 'u', puts: [{ module: mod('new1', 'notebook', { title: 'FI Names' }), baseVersion: 0 }] } })
    assert.equal(take.status, 403)
    const rename = await b.call('POST', '/api/v2/sync', { json: { client: 'u', puts: [{ module: mod('pub', 'notebook', { title: 'FI Names' }), baseVersion: 1 }] } })
    assert.equal(rename.status, 403)
    // The admin can do all of it.
    const boss = await b.call('POST', '/api/v2/sync', { headers: ADMIN, json: { client: 'a', puts: [{ module: mod('hid', 'notebook', { title: 'FI Names v2' }), baseVersion: 1 }] } })
    assert.equal(boss.status, 200, boss.text)
  })
})

test('changes and the change log omit hidden modules for non-admins but keep rev advancing', async () => {
  await withHidden(async (b) => {
    await seed(b)
    await b.call('POST', '/api/v2/sync', { headers: ADMIN, json: { client: 'a', puts: [{ module: mod('hid', 'notebook', { title: 'FI Names', pages: [] }), baseVersion: 1 }] } })
    const user = await b.call('GET', '/api/v2/changes?since=0')
    assert.equal(user.status, 200)
    assert.equal(user.json.changes.some((c) => c.id === 'hid'), false)
    assert.equal(user.json.changes.some((c) => c.id === 'pub'), true)
    assert.ok(user.json.rev > 0)
    const boss = await b.call('GET', '/api/v2/changes?since=0', { headers: ADMIN })
    assert.equal(boss.json.changes.some((c) => c.id === 'hid'), true)
  })
})

test('the legacy listing hides the module and refuses writes for non-admins', async () => {
  await withHidden(async (b) => {
    await seed(b)
    const list = await b.call('GET', '/api/modules')
    assert.deepEqual(list.json.map((m) => m.id), ['pub'])
    const archived = await b.call('GET', '/api/modules?archived=1')
    assert.equal(archived.json.some((m) => m.id === 'hid'), false)
    assert.equal((await b.call('GET', '/api/modules/hid')).status, 404)
    const create = await b.call('POST', '/api/modules', { json: { type: 'notebook', title: 'FI Names' } })
    assert.equal(create.status, 403)
    const rename = await b.call('PATCH', '/api/modules/pub', { json: { title: 'FI Names' } })
    assert.equal(rename.status, 403)
    const del = await b.call('DELETE', '/api/modules/hid')
    assert.equal(del.status, 404)
    const boss = await b.call('GET', '/api/modules', { headers: ADMIN })
    assert.deepEqual(boss.json.map((m) => m.id).sort(), ['hid', 'pub'])
  })
})

test('a local (non-hosted) server hides nothing: its single user is an admin', async () => {
  const b = await boot()
  try {
    const r = await b.call('POST', '/api/v2/sync', { json: { client: 'a', puts: [{ module: mod('hid', 'notebook', { title: 'FI Names' }), baseVersion: 0 }] } })
    assert.equal(r.status, 200, r.text)
    const w = await b.call('GET', '/api/v2/workspace')
    assert.equal(w.json.modules.some((m) => m.hidden), false)
    assert.equal((await b.call('GET', '/api/v2/modules/hid')).status, 200)
  } finally {
    await b.s.close()
    fs.rmSync(b.dataDir, { recursive: true, force: true })
  }
})
