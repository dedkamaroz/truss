import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { boot, raw } from './helpers.js'
import { sanitizeFilename } from '../../server/attachments.js'

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

describe('attachments over HTTP', () => {
  let t, mod, other
  const root = () => path.join(t.dataDir, 'attachments')
  const upload = (moduleId, pageId, filename, body) =>
    t.call('POST', `/api/attachments?moduleId=${moduleId}${pageId ? `&pageId=${pageId}` : ''}`, {
      headers: { 'X-Filename': encodeURIComponent(filename), 'Content-Type': 'application/octet-stream' },
      body,
    })

  before(async () => {
    process.env.TRUSS_DRY_OPEN = '1'
    t = await boot()
    mod = (await t.call('POST', '/api/modules', { json: { type: 'notebook' } })).json
    other = (await t.call('POST', '/api/modules', { json: { type: 'database' } })).json
  })
  after(() => t.s.close())

  test('large upload round-trips byte-identical with correct MIME', async () => {
    const data = crypto.randomBytes(5 * 1024 * 1024 + 12345)
    const r = await upload(mod.id, 'page-1', 'photo.png', data)
    assert.equal(r.status, 201)
    assert.equal(r.json.size, data.length)
    assert.equal(r.json.filename, 'photo.png')
    assert.equal(r.json.mime, 'image/png')
    assert.equal(r.json.module_id, mod.id)
    assert.equal(r.json.page_id, 'page-1')
    assert.equal(r.json.source, 'upload')
    const onDisk = path.join(root(), r.json.id, 'photo.png')
    assert.equal(sha(fs.readFileSync(onDisk)), sha(data))

    const c = await t.call('GET', `/api/attachments/${r.json.id}/content`)
    assert.equal(c.status, 200)
    assert.equal(c.headers['content-type'], 'image/png')
    assert.match(c.headers['content-disposition'], /^inline/)
    assert.equal(sha(c.body), sha(data))
    // <img src> style access with query token
    const q = await raw(t.s.port, 'GET', `/api/attachments/${r.json.id}/content?token=${t.s.token}`)
    assert.equal(q.status, 200)
    assert.equal(sha(q.body), sha(data))
  })

  test('upload validation', async () => {
    const noName = await t.call('POST', `/api/attachments?moduleId=${mod.id}`, { body: 'x' })
    assert.equal(noName.status, 400)
    const noModule = await upload('00000000-0000-0000-0000-000000000000', null, 'a.txt', 'x')
    assert.equal(noModule.status, 404)
    assert.equal((await t.call('GET', '/api/attachments/nope/content')).status, 404)
  })

  test('unicode filename is decoded from URI encoding', async () => {
    const r = await upload(mod.id, null, 'Résumé 2026 (final).txt', 'hello')
    assert.equal(r.json.filename, 'Résumé 2026 (final).txt')
    assert.equal(r.json.mime.split(';')[0], 'text/plain')
    assert.equal((await t.call('GET', `/api/attachments/${r.json.id}/content`)).text, 'hello')
  })

  test('a JSON file uploaded with Content-Type application/json is stored raw', async () => {
    const body = '{"not": "parsed", "x": [1,2,3]}'
    const r = await t.call('POST', `/api/attachments?moduleId=${mod.id}`, {
      headers: { 'X-Filename': 'data.json', 'Content-Type': 'application/json' },
      body,
    })
    assert.equal(r.status, 201)
    assert.equal((await t.call('GET', `/api/attachments/${r.json.id}/content`)).text, body)
  })

  test('list filters by moduleId and pageId', async () => {
    const a = (await upload(other.id, 'p1', 'a.txt', 'a')).json
    const b = (await upload(other.id, 'p2', 'b.txt', 'b')).json
    const c = (await upload(other.id, null, 'c.txt', 'c')).json
    const all = (await t.call('GET', `/api/attachments?moduleId=${other.id}`)).json.map((x) => x.id).sort()
    assert.deepEqual(all, [a.id, b.id, c.id].sort())
    const p1 = (await t.call('GET', `/api/attachments?moduleId=${other.id}&pageId=p1`)).json
    assert.deepEqual(p1.map((x) => x.id), [a.id])
    const p2 = (await t.call('GET', `/api/attachments?moduleId=${other.id}&pageId=p2`)).json
    assert.deepEqual(p2.map((x) => x.id), [b.id])
    const modList = (await t.call('GET', `/api/attachments?moduleId=${mod.id}`)).json
    assert.ok(modList.length > 0 && modList.every((x) => x.module_id === mod.id))
  })

  test('DELETE removes row and file', async () => {
    const r = (await upload(mod.id, null, 'gone.bin', crypto.randomBytes(100))).json
    const dir = path.join(root(), r.id)
    assert.ok(fs.existsSync(path.join(dir, 'gone.bin')))
    assert.equal((await t.call('DELETE', `/api/attachments/${r.id}`)).status, 200)
    assert.ok(!fs.existsSync(dir))
    assert.equal((await t.call('GET', `/api/attachments/${r.id}/content`)).status, 404)
    assert.equal((await t.call('DELETE', `/api/attachments/${r.id}`)).status, 404)
  })

  test('deleting the module removes its attachment files', async () => {
    const m = (await t.call('POST', '/api/modules', { json: { type: 'sheet' } })).json
    const x = (await upload(m.id, null, 'x.txt', 'x')).json
    const y = (await upload(m.id, 'pg', 'y.txt', 'y')).json
    const keep = (await upload(other.id, null, 'keep.txt', 'k')).json
    assert.equal((await t.call('DELETE', `/api/modules/${m.id}`)).status, 200)
    assert.ok(!fs.existsSync(path.join(root(), x.id)))
    assert.ok(!fs.existsSync(path.join(root(), y.id)))
    assert.ok(fs.existsSync(path.join(root(), keep.id, 'keep.txt')))
    assert.deepEqual((await t.call('GET', `/api/attachments?moduleId=${m.id}`)).json, [])
  })

  test('hostile filenames are stored safely inside attachments/<id>/', async () => {
    const cases = ['..\\..\\evil.bat', 'CON.txt', '../../../evil2.cmd', 'a<b>c:d"e|f?g*.txt', 'nul', 'COM1.log', '...', 'trail. . ']
    const before = new Set(fs.readdirSync(t.dataDir))
    for (const name of cases) {
      const r = await upload(mod.id, null, name, 'payload')
      assert.equal(r.status, 201, name)
      const { id, filename } = r.json
      assert.ok(!/[\\/<>:"|?*]/.test(filename), `${name} -> ${filename}`)
      assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(filename), `${name} -> ${filename}`)
      const entries = fs.readdirSync(path.join(root(), id))
      assert.deepEqual(entries, [filename])
      assert.equal(fs.readFileSync(path.join(root(), id, filename), 'utf8'), 'payload')
      assert.equal((await t.call('GET', `/api/attachments/${id}/content`)).text, 'payload')
    }
    assert.deepEqual(new Set(fs.readdirSync(t.dataDir)), before, 'nothing written outside attachments/')
    assert.ok(!fs.existsSync(path.join(t.dataDir, '..', 'evil.bat')))
    assert.equal(sanitizeFilename('..\\..\\evil.bat'), 'evil.bat')
    assert.equal(sanitizeFilename('CON.txt'), '_CON.txt')
  })

  test('open and reveal in dry-run mode', async () => {
    const r = (await upload(mod.id, null, 'open me.txt', 'x')).json
    const open = await t.call('POST', `/api/attachments/${r.id}/open`)
    assert.equal(open.status, 200)
    assert.equal(open.json.ok, true)
    assert.equal(open.json.dryRun, true)
    assert.deepEqual(open.json.command, ['explorer.exe', path.join(root(), r.id, 'open me.txt')])
    const reveal = await t.call('POST', `/api/attachments/${r.id}/reveal`)
    assert.equal(reveal.json.dryRun, true)
    assert.deepEqual(reveal.json.command, ['explorer.exe', '/select,', path.join(root(), r.id, 'open me.txt')])
    assert.equal((await t.call('POST', '/api/attachments/missing/open')).status, 404)
  })
})

describe('ctx.attachments API', () => {
  let t, mod
  before(async () => {
    t = await boot()
    mod = (await t.call('POST', '/api/modules', { json: { type: 'notebook' } })).json
  })
  after(() => t.s.close())

  test('create from buffer and srcPath, list, get, pathOf, remove, removeFor', async () => {
    const att = t.s.ctx.attachments
    const a = att.create({ moduleId: mod.id, pageId: 'p1', filename: 'a.json', buffer: Buffer.from('{"a":1}') })
    assert.equal(a.module_id, mod.id)
    assert.equal(a.page_id, 'p1')
    assert.equal(a.size, 7)
    assert.equal(a.source, 'upload')
    assert.match(a.mime, /^application\/json/)

    const src = path.join(t.dataDir, 'src-output.csv')
    fs.writeFileSync(src, 'x,y\n1,2\n')
    const b = await att.create({ moduleId: mod.id, pageId: 'p1', filename: 'out/../CON.csv', source: 'script-output', srcPath: src })
    assert.equal(b.source, 'script-output')
    assert.equal(b.filename, '_CON.csv')
    assert.ok(fs.existsSync(src), 'srcPath is copied, not moved')
    const c = att.create({ moduleId: mod.id, pageId: 'p2', filename: 'c.txt', buffer: 'text' })

    // HTTP sees the same row shape
    const httpRow = (await t.call('GET', `/api/attachments?moduleId=${mod.id}&pageId=p1`)).json.find((x) => x.id === b.id)
    assert.deepEqual(httpRow, { ...att.get(b.id) })

    assert.deepEqual(att.list({ moduleId: mod.id, pageId: 'p1' }).map((x) => x.id).sort(), [a.id, b.id].sort())
    assert.equal(att.list({ moduleId: mod.id }).length, 3)
    assert.equal(att.get('missing'), null)
    assert.equal(att.pathOf(b.id), path.join(t.dataDir, 'attachments', b.id, '_CON.csv'))
    assert.equal(fs.readFileSync(att.pathOf(b.id), 'utf8'), 'x,y\n1,2\n')
    assert.equal(att.pathOf('missing'), null)

    assert.equal(att.remove(a.id), true)
    assert.equal(att.get(a.id), null)
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'attachments', a.id)))
    assert.equal(att.remove(a.id), false)

    assert.equal(att.removeFor({ moduleId: mod.id, pageId: 'p1' }), 1)
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'attachments', b.id)))
    assert.ok(att.get(c.id), 'other page untouched')
    assert.equal(att.removeFor({ moduleId: mod.id }), 1)
    assert.deepEqual(att.list({ moduleId: mod.id }), [])

    assert.throws(() => att.create({ moduleId: 'nope', filename: 'x', buffer: 'x' }), /Module not found/)
    assert.throws(() => att.create({ moduleId: mod.id, filename: 'x', source: 'bogus', buffer: 'x' }))
  })
})
