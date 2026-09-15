import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { boot, raw, tempDir } from './helpers.js'
import { startServer } from '../../server/main.js'

const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'"

describe('process, auth and static serving', () => {
  let t
  before(async () => { t = await boot() })
  after(() => t.s.close())

  test('health needs no token; other API routes need the right token', async () => {
    const health = await raw(t.s.port, 'GET', '/api/health')
    assert.equal(health.status, 200)
    assert.deepEqual(health.json, { ok: true })
    assert.equal((await raw(t.s.port, 'GET', '/api/modules')).status, 401)
    assert.equal((await raw(t.s.port, 'GET', '/api/modules', { headers: { 'X-Truss-Token': 'a'.repeat(48) } })).status, 401)
    assert.equal((await raw(t.s.port, 'GET', `/api/modules?token=${t.s.token}`)).status, 200)
    // query token only accepted for GET
    const post = await raw(t.s.port, 'POST', `/api/modules?token=${t.s.token}`, { headers: { 'Content-Type': 'application/json' }, body: '{"type":"sheet"}' })
    assert.equal(post.status, 401)
    assert.equal(post.json.error.code, 'unauthorized')
  })

  test('Host header guard rejects foreign hosts even with a valid token', async () => {
    const r = await raw(t.s.port, 'GET', '/api/modules', { headers: { Host: `evil.example:${t.s.port}`, 'X-Truss-Token': t.s.token } })
    assert.equal(r.status, 403)
    assert.equal((await raw(t.s.port, 'GET', '/', { headers: { Host: `127.0.0.1:${t.s.port + 1}` } })).status, 403)
    assert.equal((await raw(t.s.port, 'GET', '/api/health', { headers: { Host: `localhost:${t.s.port}` } })).status, 200)
  })

  test('binds to 127.0.0.1 only and token is 48 hex chars', () => {
    assert.equal(t.s.server.address().address, '127.0.0.1')
    assert.match(t.s.token, /^[0-9a-f]{48}$/)
    assert.equal(t.s.url, `http://127.0.0.1:${t.s.port}/`)
  })

  test('GET / injects the token and sends the CSP header', async () => {
    const r = await raw(t.s.port, 'GET', '/')
    assert.equal(r.status, 200)
    assert.match(r.headers['content-type'], /^text\/html/)
    assert.equal(r.headers['content-security-policy'], CSP)
    const m = r.text.match(/<meta name="truss-token" content="([^"]*)"/)
    assert.ok(m, 'meta tag present')
    assert.equal(m[1], t.s.token)
    assert.ok(!r.text.includes('%TRUSS_TOKEN%'))
  })

  test('path traversal never reaches package.json', async () => {
    const pkg = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')
    for (const p of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/web/../package.json', '/..\\package.json',
      '/..%5cpackage.json', '/..%2fpackage.json', '/%2e%2e%2fpackage.json', '/x/..%2f..%2fpackage.json', '/%2e%2e%5cpackage.json', '/../package.json', '/index.html%00.js', '/C:%2fWindows%2fwin.ini']) {
      const r = await raw(t.s.port, 'GET', p)
      assert.notEqual(r.status, 200, p)
      assert.ok(!r.text.includes('"devDependencies"'), `${p} leaked package.json`)
      assert.ok(!r.text.includes(pkg.slice(0, 40)), p)
    }
    assert.equal((await raw(t.s.port, 'GET', '/definitely-missing.js')).status, 404)
  })

  test('static MIME types for js and css', async () => {
    const dir = fs.mkdtempSync(path.join(import.meta.dirname, '..', '..', 'web', '.core-test-'))
    try {
      fs.writeFileSync(path.join(dir, 'a.js'), 'export default 1\n')
      fs.writeFileSync(path.join(dir, 'a.css'), 'body{}\n')
      const base = '/' + path.basename(dir)
      const js = await raw(t.s.port, 'GET', `${base}/a.js`)
      assert.equal(js.status, 200)
      assert.match(js.headers['content-type'], /^text\/javascript/)
      assert.equal(js.text, 'export default 1\n')
      const css = await raw(t.s.port, 'GET', `${base}/a.css`)
      assert.match(css.headers['content-type'], /^text\/css/)
      assert.equal((await raw(t.s.port, 'GET', base)).status, 404, 'directories are not served')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('robustness: invalid JSON, unknown API route', async () => {
    const bad = await t.call('POST', '/api/modules', { headers: { 'Content-Type': 'application/json' }, body: '{"type":' })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error.code, 'invalid_json')
    const unknown = await t.call('GET', '/api/nope/nothing')
    assert.equal(unknown.status, 404)
    assert.equal(typeof unknown.json.error.code, 'string')
  })
})

describe('modules and templates', () => {
  let t
  before(async () => { t = await boot() })
  after(() => t.s.close())

  test('templates list blank for every type', async () => {
    const r = await t.call('GET', '/api/templates')
    assert.equal(r.status, 200)
    for (const type of ['database', 'sheet', 'notebook']) {
      const blank = r.json.find((x) => x.type === type && x.key === 'blank')
      assert.ok(blank, `blank for ${type}`)
      assert.equal(typeof blank.name, 'string')
      assert.ok('description' in blank)
    }
  })

  test('full lifecycle', async () => {
    const created = {}
    for (const type of ['database', 'sheet', 'notebook']) {
      const r = await t.call('POST', '/api/modules', { json: { type, template: 'blank', title: `My ${type}`, icon: 'X' } })
      assert.ok(r.status === 200 || r.status === 201, `create ${type}: ${r.status}`)
      assert.equal(r.json.type, type)
      assert.equal(r.json.title, `My ${type}`)
      assert.match(r.json.id, /^[0-9a-f-]{36}$/)
      assert.deepEqual(r.json.data, {})
      assert.ok(!Number.isNaN(Date.parse(r.json.created_at)))
      created[type] = r.json
    }
    const defaults = await t.call('POST', '/api/modules', { json: { type: 'sheet' } })
    assert.equal(defaults.json.title, 'Untitled')

    const badType = await t.call('POST', '/api/modules', { json: { type: 'spreadsheet' } })
    assert.equal(badType.status, 400)
    assert.equal(typeof badType.json.error.code, 'string')
    assert.equal((await t.call('POST', '/api/modules', { json: { type: 'sheet', template: 'nope' } })).status, 400)

    // order by sort_order
    await t.call('PATCH', `/api/modules/${created.notebook.id}`, { json: { sort_order: -5 } })
    await t.call('PATCH', `/api/modules/${created.database.id}`, { json: { sort_order: 100 } })
    let list = (await t.call('GET', '/api/modules')).json
    assert.equal(list[0].id, created.notebook.id)
    assert.equal(list.at(-1).id, created.database.id)
    const orders = list.map((m) => m.sort_order)
    assert.deepEqual(orders, [...orders].sort((a, b) => a - b))

    // PATCH persists
    const patched = await t.call('PATCH', `/api/modules/${created.sheet.id}`, { json: { title: 'Budget', icon: '$', sort_order: 7.5, data: { a: [1, 2], b: 'x' } } })
    assert.equal(patched.status, 200)
    const again = (await t.call('GET', `/api/modules/${created.sheet.id}`)).json
    assert.equal(again.title, 'Budget')
    assert.equal(again.icon, '$')
    assert.equal(again.sort_order, 7.5)
    assert.deepEqual(again.data, { a: [1, 2], b: 'x' })
    await t.call('PATCH', `/api/modules/${created.sheet.id}`, { json: { data: { c: true } } })
    assert.deepEqual((await t.call('GET', `/api/modules/${created.sheet.id}`)).json.data, { c: true }, 'data replaced whole')

    // archive / restore
    const arch = await t.call('POST', `/api/modules/${created.database.id}/archive`)
    assert.equal(arch.status, 200)
    assert.ok(arch.json.archived_at)
    list = (await t.call('GET', '/api/modules')).json
    assert.ok(!list.some((m) => m.id === created.database.id))
    assert.ok((await t.call('GET', '/api/modules?archived=1')).json.some((m) => m.id === created.database.id))
    assert.ok(!(await t.call('GET', '/api/modules?archived=1')).json.some((m) => m.id === created.sheet.id))
    const rest = await t.call('POST', `/api/modules/${created.database.id}/restore`)
    assert.equal(rest.json.archived_at, null)
    assert.ok((await t.call('GET', '/api/modules')).json.some((m) => m.id === created.database.id))
    assert.ok(!(await t.call('GET', '/api/modules?archived=1')).json.some((m) => m.id === created.database.id))

    // delete
    assert.equal((await t.call('DELETE', `/api/modules/${created.notebook.id}`)).status, 200)
    const gone = await t.call('GET', `/api/modules/${created.notebook.id}`)
    assert.equal(gone.status, 404)
    assert.equal(typeof gone.json.error.code, 'string')
    assert.equal((await t.call('PATCH', `/api/modules/${created.notebook.id}`, { json: { title: 'x' } })).status, 404)
  })
})

describe('route autoloading, templates in transactions, internal errors', () => {
  const routeFile = path.join(import.meta.dirname, '..', '..', 'server', 'routes', `zz-core-test-${process.pid}.js`)
  let t
  before(async () => {
    fs.writeFileSync(routeFile, `
export default function register(router, ctx) {
  router.get('/api/zz-core-test/:a/x/:b', ({ params, query }) => ({ params, query, hasAttachments: typeof ctx.attachments.create === 'function' }))
  router.get('/api/zz-core-test-boom', () => { throw new Error('secret internal detail') })
  ctx.registerTemplate('notebook', 'zz-seeded', { name: 'Seeded', description: 'sets data', apply(db, moduleId) {
    db.prepare("UPDATE modules SET data = ? WHERE id = ?").run(JSON.stringify({ style: 'table' }), moduleId)
  } })
  ctx.registerTemplate('database', 'zz-throws', { name: 'Throws', description: 'fails', apply() { throw new Error('template failure') } })
}
`)
    t = await boot()
  })
  after(async () => {
    await t.s.close()
    fs.rmSync(routeFile, { force: true })
  })

  test('routes file is autoloaded with :params and query', async () => {
    const r = await t.call('GET', '/api/zz-core-test/one/x/t%20wo?q=1')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json, { params: { a: 'one', b: 't wo' }, query: { q: '1' }, hasAttachments: true })
    const tpl = (await t.call('GET', '/api/templates')).json
    assert.ok(tpl.some((x) => x.type === 'notebook' && x.key === 'zz-seeded' && x.name === 'Seeded'))
  })

  test('template apply runs inside create', async () => {
    const r = await t.call('POST', '/api/modules', { json: { type: 'notebook', template: 'zz-seeded' } })
    assert.equal(r.status, 201)
    assert.deepEqual(r.json.data, { style: 'table' })
  })

  test('throwing template leaves no module row', async () => {
    const before = t.s.ctx.db.prepare('SELECT COUNT(*) AS n FROM modules').get().n
    const r = await t.call('POST', '/api/modules', { json: { type: 'database', template: 'zz-throws', title: 'Should not exist' } })
    assert.ok(r.status >= 400)
    assert.equal(t.s.ctx.db.prepare('SELECT COUNT(*) AS n FROM modules').get().n, before)
    assert.equal(t.s.ctx.db.prepare("SELECT COUNT(*) AS n FROM modules WHERE title = 'Should not exist'").get().n, 0)
    // server still healthy and not stuck in a transaction
    assert.equal((await t.call('POST', '/api/modules', { json: { type: 'database' } })).status, 201)
  })

  test('unexpected errors become 500 internal with no details', async () => {
    const r = await t.call('GET', '/api/zz-core-test-boom')
    assert.equal(r.status, 500)
    assert.equal(r.json.error.code, 'internal')
    assert.ok(!r.text.includes('secret internal detail'))
    assert.ok(!/at .*\.js/.test(r.text), 'no stack trace')
  })
})

describe('migrations', () => {
  test('restart does not re-apply migrations; WAL and foreign keys on', async () => {
    const dataDir = tempDir('mig')
    const a = await startServer({ port: 0, dataDir })
    const rows1 = a.ctx.db.prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name').all()
    assert.ok(rows1.some((r) => r.name === '001-core.sql'))
    assert.equal(a.ctx.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
    assert.equal(a.ctx.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    await new Promise((r) => setTimeout(r, 5))
    await a.close()

    const b = await startServer({ port: 0, dataDir })
    const rows2 = b.ctx.db.prepare('SELECT name, applied_at FROM schema_migrations ORDER BY name').all()
    assert.deepEqual(rows2, rows1)
    await b.close()

    const db = new DatabaseSync(path.join(dataDir, 'truss.db'))
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    db.close()
  })
})
