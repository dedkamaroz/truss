import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../../server/main.js'

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-hosted-'))
  const s = await startServer({ port: 0, dataDir, ...opts })
  try {
    await fn(s)
  } finally {
    await s.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

const call = (s, method, p) =>
  fetch(new URL(p, s.url), { method, headers: { 'X-Truss-Token': s.token } })

test('hosted mode does not register the script runner', async () => {
  await withServer({ hosted: true }, async (s) => {
    assert.equal((await call(s, 'GET', '/api/scripts')).status, 404)
    assert.equal((await call(s, 'GET', '/api/scripts/browse')).status, 404)
    assert.equal((await call(s, 'GET', '/api/runs')).status, 404)
  })
})

test('hosted mode does not register the local-shell attachment actions', async () => {
  await withServer({ hosted: true }, async (s) => {
    // The id does not exist; a registered route would 404 from load() with
    // attachment_not_found, an unregistered one from the router with not_found.
    const res = await call(s, 'POST', '/api/attachments/nope/open')
    assert.equal(res.status, 404)
    assert.equal((await res.json()).error.code, 'not_found')
    const res2 = await call(s, 'POST', '/api/attachments/nope/reveal')
    assert.equal((await res2.json()).error.code, 'not_found')
  })
})

test('hosted mode keeps the content modules', async () => {
  await withServer({ hosted: true }, async (s) => {
    assert.equal((await call(s, 'GET', '/api/modules')).status, 200)
    assert.equal((await call(s, 'GET', '/api/templates')).status, 200)
    assert.equal(s.hosted, true)
  })
})

test('local mode still registers everything', async () => {
  await withServer({}, async (s) => {
    assert.equal((await call(s, 'GET', '/api/scripts')).status, 200)
    const res = await call(s, 'POST', '/api/attachments/nope/open')
    assert.equal((await res.json()).error.code, 'attachment_not_found')
    assert.equal(s.hosted, false)
  })
})
