import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { scriptsServer, markedCopy, processesWithMarker, descendants, alivePids, sleep } from './helpers.js'

// Waits until the hang fixture's tree is up: the marker-carrying processes plus the ping grandchild.
async function waitForTree(marker) {
  const end = Date.now() + 20000
  for (;;) {
    const procs = processesWithMarker(marker)
    const kids = descendants(procs.map((p) => p.ProcessId))
    const ping = [...kids].find(([, cmd]) => /ping/i.test(cmd || ''))
    if (procs.length >= 2 && ping) return { pids: [...procs.map((p) => p.ProcessId), ...kids.keys()], ping: ping[0] }
    if (Date.now() > end) throw new Error(`process tree for ${marker} never appeared: ${JSON.stringify(procs)}`)
    await sleep(250)
  }
}

async function assertTreeGone(marker, pids) {
  const end = Date.now() + 5000
  for (;;) {
    const left = processesWithMarker(marker)
    const alive = alivePids(pids)
    if (!left.length && !alive.length) return
    if (Date.now() > end) assert.fail(`still alive 5 s later: ${JSON.stringify(left)} pids ${alive}`)
    await sleep(250)
  }
}

describe('cancel and timeout kill the whole process tree', () => {
  let t
  before(async () => { t = await scriptsServer() })
  after(() => t.s.close())

  test('cancel', async () => {
    const target = await t.notebook()
    const copy = markedCopy('hang.bat')
    const s = await t.register(copy.path)
    const run = await t.start(s.id, target)
    const tree = await waitForTree(copy.marker)
    assert.equal((await t.getRun(run.id)).status, 'running')

    const r = await t.call('POST', `/api/runs/${run.id}/cancel`, { json: {} })
    const cancelledAt = Date.now()
    assert.equal(r.status, 200)
    assert.equal(r.json.status, 'cancelled')
    assert.ok(r.json.finished_at)
    await assertTreeGone(copy.marker, tree.pids)
    assert.ok(Date.now() - cancelledAt < 5000)

    const again = await t.call('POST', `/api/runs/${run.id}/cancel`, { json: {} })
    assert.equal(again.status, 409)
    assert.equal((await t.getRun(run.id)).status, 'cancelled')
  })

  test('timeout', async () => {
    const target = await t.notebook()
    const copy = markedCopy('hang.bat')
    const s = await t.register(copy.path, { timeout_sec: 2 })
    const started = Date.now()
    const run = await t.start(s.id, target)
    const tree = await waitForTree(copy.marker)
    const done = await t.waitRun(run.id, 20000)
    assert.equal(done.status, 'timed_out')
    assert.match(done.stderr, /Timed out after 2 s/)
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 1900 && elapsed < 12000, `took ${elapsed} ms`)
    await assertTreeGone(copy.marker, tree.pids)
  })

  test('cancelling a queued run never starts it', async () => {
    const target = await t.notebook()
    const blockers = [markedCopy('hang.bat'), markedCopy('hang.bat')]
    const blockerRuns = []
    for (const b of blockers) blockerRuns.push(await t.start((await t.register(b.path)).id, target))
    const queuedCopy = markedCopy('hang.bat')
    const queued = await t.start((await t.register(queuedCopy.path)).id, target)
    await sleep(300)
    assert.equal((await t.getRun(queued.id)).status, 'queued')
    const r = await t.call('POST', `/api/runs/${queued.id}/cancel`, { json: {} })
    assert.equal(r.json.status, 'cancelled')
    assert.equal(r.json.started_at, null)
    for (const b of blockerRuns) assert.equal((await t.call('POST', `/api/runs/${b.id}/cancel`, { json: {} })).json.status, 'cancelled')
    await sleep(500)
    assert.equal(processesWithMarker(queuedCopy.marker).length, 0)
    for (const b of blockers) await assertTreeGone(b.marker, [])
  })
})
