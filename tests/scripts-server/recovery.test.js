import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { scriptsServer, tempDir, fixture } from './helpers.js'

test('runs left queued or running are marked failed with a note on server start', async () => {
  const dataDir = tempDir('recovery')
  const first = await scriptsServer(dataDir)
  const target = await first.notebook()
  const script = await first.register(fixture('sleep.bat'))
  const db = first.s.ctx.db
  const now = new Date().toISOString()
  const ins = db.prepare(`INSERT INTO script_runs (id, script_id, module_id, page_id, status, stdout, stderr, created_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const running = crypto.randomUUID()
  const queued = crypto.randomUUID()
  const done = crypto.randomUUID()
  ins.run(running, script.id, target.moduleId, target.pageId, 'running', 'partial output', 'earlier warning', now, now)
  ins.run(queued, script.id, target.moduleId, target.pageId, 'queued', '', '', now, null)
  ins.run(done, script.id, target.moduleId, target.pageId, 'succeeded', 'ok', '', now, now)
  fs.mkdirSync(path.join(dataDir, 'runs', running, 'output'), { recursive: true })
  await first.s.close()

  const second = await scriptsServer(dataDir)
  try {
    const r1 = await second.getRun(running)
    assert.equal(r1.status, 'failed')
    assert.ok(r1.finished_at)
    assert.equal(r1.stdout, 'partial output')
    assert.match(r1.stderr, /^earlier warning\n\[truss\] Run interrupted: the server stopped/)
    const r2 = await second.getRun(queued)
    assert.equal(r2.status, 'failed')
    assert.match(r2.stderr, /^\[truss\] Run interrupted/)
    const r3 = await second.getRun(done)
    assert.equal(r3.status, 'succeeded')
    assert.equal(r3.stderr, '')
    assert.ok(!fs.existsSync(path.join(dataDir, 'runs', running)), 'stale run folder removed')
  } finally {
    await second.s.close()
  }
})
