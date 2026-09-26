import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { boot } from '../server-core/helpers.js'

const mod = (id, type = 'notebook', extra = {}) => ({ id, type, title: `T ${id}`, color: 'teal', createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z', ...extra })

async function withServer(fn) {
  const b = await boot()
  try {
    await fn(b)
  } finally {
    await b.s.close()
    fs.rmSync(b.dataDir, { recursive: true, force: true })
  }
}

test('a new workspace is empty and reports rev 0', async () => {
  await withServer(async ({ call }) => {
    const r = await call('GET', '/api/v2/workspace')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.modules, [])
    assert.equal(r.json.rev, 0)
  })
})

test('sync creates, versions and returns modules', async () => {
  await withServer(async ({ call }) => {
    const r = await call('POST', '/api/v2/sync', { json: { client: 'a', puts: [{ module: mod('m1', 'notebook', { pages: [] }), baseVersion: 0 }] } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.versions.m1, 1)
    const w = await call('GET', '/api/v2/workspace')
    assert.equal(w.json.modules.length, 1)
    assert.equal(w.json.modules[0].version, 1)
    assert.deepEqual(w.json.modules[0].module.pages, [])
    const one = await call('GET', '/api/v2/modules/m1')
    assert.equal(one.json.module.title, 'T m1')
    // The legacy listing sees the same module row, so attachments can hang off it.
    const legacy = await call('GET', '/api/modules')
    assert.equal(legacy.json[0].id, 'm1')
  })
})

test('a stale baseVersion is refused with 409 and the current document, and nothing in the batch applies', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/api/v2/sync', { json: { client: 'a', puts: [{ module: mod('m1'), baseVersion: 0 }] } })
    await call('POST', '/api/v2/sync', { json: { client: 'a', puts: [{ module: mod('m1', 'notebook', { title: 'Second' }), baseVersion: 1 }] } })
    const r = await call('POST', '/api/v2/sync', {
      json: { client: 'b', puts: [{ module: mod('m2'), baseVersion: 0 }, { module: mod('m1', 'notebook', { title: 'Stale' }), baseVersion: 1 }] },
    })
    assert.equal(r.status, 409)
    assert.equal(r.json.conflicts.length, 1)
    assert.equal(r.json.conflicts[0].id, 'm1')
    assert.equal(r.json.conflicts[0].version, 2)
    assert.equal(r.json.conflicts[0].module.title, 'Second')
    const w = await call('GET', '/api/v2/workspace')
    assert.deepEqual(w.json.modules.map((m) => m.module.id), ['m1'])
  })
})

test('creating an id that already exists is a conflict, not an overwrite', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/api/v2/sync', { json: { puts: [{ module: mod('m1'), baseVersion: 0 }] } })
    const r = await call('POST', '/api/v2/sync', { json: { puts: [{ module: mod('m1', 'notebook', { title: 'Other' }), baseVersion: 0 }] } })
    assert.equal(r.status, 409)
  })
})

test('delete removes the module and its attachment files, and is versioned', async () => {
  await withServer(async ({ call, dataDir }) => {
    await call('POST', '/api/v2/sync', { json: { puts: [{ module: mod('m1'), baseVersion: 0 }] } })
    const up = await call('POST', '/api/attachments?moduleId=m1&pageId=p1', { headers: { 'X-Filename': 'a.txt' }, body: 'hello' })
    assert.equal(up.status, 201, up.text)
    const stale = await call('POST', '/api/v2/sync', { json: { deletes: [{ id: 'm1', baseVersion: 0 }] } })
    assert.equal(stale.status, 409)
    const ok = await call('POST', '/api/v2/sync', { json: { deletes: [{ id: 'm1', baseVersion: 1 }] } })
    assert.equal(ok.status, 200, ok.text)
    assert.equal((await call('GET', '/api/v2/modules/m1')).status, 404)
    assert.equal(fs.existsSync(`${dataDir}/attachments/${up.json.id}`), false)
  })
})

test('invalid documents are rejected', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('POST', '/api/v2/sync', { json: { puts: [{ module: { id: 'x', type: 'weird', title: 'a' }, baseVersion: 0 }] } })).status, 400)
    assert.equal((await call('POST', '/api/v2/sync', { json: { puts: [{ module: { id: '../x', type: 'sheet', title: 'a' }, baseVersion: 0 }] } })).status, 400)
    assert.equal((await call('POST', '/api/v2/sync', { json: { puts: [{ module: mod('a'), baseVersion: -1 }] } })).status, 400)
    await call('POST', '/api/v2/sync', { json: { puts: [{ module: mod('a'), baseVersion: 0 }] } })
    assert.equal((await call('POST', '/api/v2/sync', { json: { puts: [{ module: mod('a', 'sheet'), baseVersion: 1 }] } })).status, 400)
  })
})

test('the API needs the token', async () => {
  await withServer(async ({ s }) => {
    const r = await fetch(`${s.url}api/v2/workspace`)
    assert.equal(r.status, 401)
  })
})

test('changes since a rev, and the event stream, report other clients\' writes', async () => {
  await withServer(async ({ s, call }) => {
    const events = []
    const req = http.get({ host: '127.0.0.1', port: s.port, path: `/api/v2/events?token=${s.token}`, headers: { Host: `127.0.0.1:${s.port}` } })
    const ready = new Promise((resolve) => req.on('response', (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        for (const m of chunk.matchAll(/data: (.*)\n/g)) events.push(JSON.parse(m[1]))
      })
      resolve()
    }))
    await ready
    await call('POST', '/api/v2/sync', { json: { client: 'A', puts: [{ module: mod('m1'), baseVersion: 0 }] } })
    await call('POST', '/api/v2/sync', { json: { client: 'B', puts: [{ module: mod('m1', 'notebook', { title: 'x' }), baseVersion: 1 }] } })
    for (let i = 0; i < 50 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    req.destroy()
    assert.deepEqual(events.map((e) => [e.id, e.version, e.client]), [['m1', 1, 'A'], ['m1', 2, 'B']])
    const ch = await call('GET', '/api/v2/changes?since=1')
    assert.deepEqual(ch.json.changes.map((c) => c.version), [2])
  })
})

test('attachment thumbnails: stored once as JPEG, listed, served cacheably, removed with the file', async () => {
  await withServer(async ({ call }) => {
    await call('POST', '/api/v2/sync', { json: { client: 'a', puts: [{ module: mod('m9', 'database', { props: [], rows: [], views: [] }), baseVersion: 0 }] } })
    const up = await call('POST', '/api/attachments?moduleId=m9', { headers: { 'X-Filename': 'photo.jpg', 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(5000, 7) })
    assert.equal(up.status, 201, up.text)
    const id = up.json.id
    assert.equal(up.json.has_thumb, 0)
    assert.equal((await call('GET', `/api/attachments/${id}/thumb`)).status, 404)
    // Only JPEG bytes are accepted, and only small ones.
    assert.equal((await call('PUT', `/api/attachments/${id}/thumb`, { headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('<svg/>') })).status, 400)
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200 * 1024), Buffer.from([0xff, 0xd9])])
    assert.equal((await call('PUT', `/api/attachments/${id}/thumb`, { headers: { 'Content-Type': 'image/jpeg' }, body: big })).status, 413)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1), Buffer.from([0xff, 0xd9])])
    const put = await call('PUT', `/api/attachments/${id}/thumb`, { headers: { 'Content-Type': 'image/jpeg' }, body: jpeg })
    assert.equal(put.status, 200, put.text)
    const list = await call('GET', '/api/attachments?moduleId=m9')
    assert.equal(list.json[0].has_thumb, 1)
    assert.equal(list.json[0].data, undefined)
    const got = await call('GET', `/api/attachments/${id}/thumb`)
    assert.equal(got.status, 200)
    assert.equal(got.headers['content-type'], 'image/jpeg')
    assert.match(got.headers['cache-control'], /max-age=31536000/)
    assert.deepEqual(got.body, jpeg)
    assert.equal((await call('DELETE', `/api/attachments/${id}`)).status, 200)
    assert.equal((await call('GET', `/api/attachments/${id}/thumb`)).status, 404)
  })
})
