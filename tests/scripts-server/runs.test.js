import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { scriptsServer, fixture, FIXTURES, REPO, sha, sleep, raw } from './helpers.js'

describe('script runs', () => {
  let t
  before(async () => { t = await scriptsServer() })
  after(() => t.s.close())

  async function copyRun(fixtureName) {
    const target = await t.notebook()
    const binary = crypto.randomBytes(200_000)
    const text = Buffer.from('hello from truss\r\nline two\r\n')
    const a1 = await t.upload(target, 'scan image.bin', binary)
    const a2 = await t.upload(target, 'notes.txt', text)
    // A second page on the same module must be left untouched.
    const otherPage = { moduleId: target.moduleId, pageId: crypto.randomUUID() }
    await t.upload(otherPage, 'unrelated.txt', Buffer.from('nope'))

    const script = await t.register(fixture(fixtureName))
    const started = await t.start(script.id, target, [a1.id, a2.id])
    assert.ok(['queued', 'running'].includes(started.status))
    assert.deepEqual(started.input_attachment_ids, [a1.id, a2.id])
    const run = await t.waitRun(started.id)
    return { target, run, a1, a2, binary, text, otherPage }
  }

  async function assertCopied({ target, run, a1, a2, binary, text, otherPage }, resultText) {
    assert.equal(run.status, 'succeeded', run.stderr)
    assert.equal(run.exit_code, 0)
    assert.ok(run.started_at && run.finished_at)
    assert.match(run.stdout, /done/)
    assert.ok(run.stdout.includes(`copied ${a1.id}`) && run.stdout.includes(`copied ${a2.id}`), run.stdout)

    const all = await t.list(target)
    const outputs = all.filter((a) => a.source === 'script-output')
    assert.equal(outputs.length, 3)
    assert.deepEqual([...run.output_attachment_ids].sort(), outputs.map((o) => o.id).sort())
    for (const o of outputs) {
      assert.equal(o.module_id, target.moduleId)
      assert.equal(o.page_id, target.pageId)
    }
    const byName = Object.fromEntries(outputs.map((o) => [o.filename, o]))
    assert.equal(sha(await t.content(byName['scan image.bin'].id)), sha(binary))
    assert.equal(sha(await t.content(byName['notes.txt'].id)), sha(text))
    assert.equal((await t.content(byName['result.txt'].id)).toString('utf8').trim(), resultText)
    // Originals untouched, other page untouched.
    assert.equal(all.filter((a) => a.source === 'upload').length, 2)
    assert.equal((await t.list(otherPage)).length, 1)
    // Run appears in the per-page listing; temp run folder is cleaned up.
    const listed = (await t.call('GET', `/api/runs?moduleId=${target.moduleId}&pageId=${target.pageId}`)).json
    assert.deepEqual(listed.map((r) => r.id), [run.id])
    assert.ok(!fs.existsSync(path.join(t.dataDir, 'runs', run.id)))
  }

  test('batch script copies its inputs to the output folder and outputs attach back', async () => {
    const res = await copyRun('copy-inputs.bat')
    await assertCopied(res, 'batch ok')
  })

  test('PowerShell script behaves the same', async () => {
    const res = await copyRun('copy-inputs.ps1')
    await assertCopied(res, 'powershell ok')
  })

  test('PowerShell is launched with -File and shell false (source check)', () => {
    const src = fs.readFileSync(path.join(REPO, 'server', 'runner.js'), 'utf8')
    assert.match(src, /'powershell\.exe',\s*\n?\s*args: \['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script\.path\]/)
    assert.doesNotMatch(src, /shell:\s*true/)
  })

  test('failing script: exit code 3 with stderr captured', async () => {
    const target = await t.notebook()
    const s = await t.register(fixture('fail.bat'))
    const run = await t.waitRun((await t.start(s.id, target)).id)
    assert.equal(run.status, 'failed')
    assert.equal(run.exit_code, 3)
    assert.match(run.stderr, /something went wrong/)
    assert.match(run.stdout, /about to fail/)
    assert.deepEqual(run.output_attachment_ids, [])
  })

  test('a script registered earlier with a network path fails without touching the path', async () => {
    const target = await t.notebook()
    const s = await t.register(fixture('fail.bat'))
    t.s.ctx.db.prepare('UPDATE scripts SET path = ? WHERE id = ?').run('\\\\192.0.2.1\\share\\fail.bat', s.id)
    const run = await t.waitRun((await t.start(s.id, target)).id, 10000)
    assert.equal(run.status, 'failed')
    assert.match(run.stderr, /local drive, not a network path/)
  })

  test('at most two runs execute at once and all three succeed', async () => {
    const target = await t.notebook()
    const s = await t.register(fixture('sleep.bat'))
    const ids = []
    for (let i = 0; i < 3; i++) ids.push((await t.start(s.id, target)).id)
    let maxRunning = 0
    let sawQueued = false
    for (;;) {
      const runs = await Promise.all(ids.map((id) => t.getRun(id)))
      maxRunning = Math.max(maxRunning, runs.filter((r) => r.status === 'running').length)
      if (runs.some((r) => r.status === 'queued')) sawQueued = true
      if (runs.every((r) => !['queued', 'running'].includes(r.status))) break
      await sleep(100)
    }
    const runs = await Promise.all(ids.map((id) => t.getRun(id)))
    for (const r of runs) assert.equal(r.status, 'succeeded', r.stderr)
    assert.ok(maxRunning <= 2, `saw ${maxRunning} running`)
    assert.ok(sawQueued, 'third run should have waited in the queue')
    // Interval overlap check: at any run's start, how many runs are in progress?
    for (const r of runs) {
      const t0 = Date.parse(r.started_at)
      const overlapping = runs.filter((o) => Date.parse(o.started_at) <= t0 && t0 < Date.parse(o.finished_at))
      assert.ok(overlapping.length <= 2, `run ${r.id} started while ${overlapping.length} were running`)
    }
    const sorted = runs.map((r) => Date.parse(r.started_at)).sort((a, b) => a - b)
    assert.ok(sorted[2] - sorted[0] >= 2000, 'the third run must start only after a slot frees')
  })

  test('hostile attachment names never execute and only appear in the inputs file', async () => {
    const names = ['a&calc&.txt', '$(New-Item marker).txt', '"q".txt']
    const markerSpots = [path.join(FIXTURES, 'marker'), path.join(REPO, 'marker'), path.join(process.cwd(), 'marker'), path.join(t.dataDir, 'marker')]
    for (const m of markerSpots) assert.ok(!fs.existsSync(m), `pre-existing ${m}`)
    const calcBefore = countProcesses(['calc', 'CalculatorApp'])

    for (const fx of ['copy-inputs.bat', 'copy-inputs.ps1']) {
      const target = await t.notebook()
      const atts = []
      for (const n of names) atts.push(await t.upload(target, n, Buffer.from(`content of ${n}`)))
      const s = await t.register(fixture(fx))
      const run = await t.waitRun((await t.start(s.id, target, atts.map((a) => a.id))).id)
      assert.equal(run.status, 'succeeded', `${fx}: ${run.stderr}`)
      const outs = (await t.list(target)).filter((a) => a.source === 'script-output')
      for (const a of atts) {
        const copy = outs.find((o) => o.filename === a.filename)
        assert.ok(copy, `${fx}: missing output copy of ${a.filename}`)
        assert.equal((await t.content(copy.id)).toString(), `content of ${names[atts.indexOf(a)]}`)
      }
    }

    // What the script itself sees: its own and its parent's command line, plus env.
    const target = await t.notebook()
    const atts = []
    for (const n of names) atts.push(await t.upload(target, n, Buffer.from('x')))
    const dump = await t.register(fixture('env-dump.ps1'))
    const run = await t.waitRun((await t.start(dump.id, target, atts.map((a) => a.id))).id)
    assert.equal(run.status, 'succeeded', run.stderr)
    assert.ok(run.stdout.includes(`cwd=${FIXTURES}`), `cwd should be the script folder: ${run.stdout}`)
    const outs = (await t.list(target)).filter((a) => a.source === 'script-output')
    const launch = (await t.content(outs.find((o) => o.filename === 'launch.txt').id)).toString('utf8')
    const inputs = JSON.parse((await t.content(outs.find((o) => o.filename === 'inputs-copy.json').id)).toString('utf8').replace(/^﻿/, ''))
    assert.match(launch, /SELF=.*powershell\.exe.*-File/i)
    assert.match(launch, /^TRUSS_RUN_ID=/m)
    assert.match(launch, /^TRUSS_INPUT_DIR=/m)
    for (const a of atts) {
      assert.ok(!launch.includes(a.filename), `${a.filename} leaked into the command line or environment`)
      const entry = inputs.find((i) => i.id === a.id)
      assert.equal(entry.filename, a.filename)
      assert.equal(path.basename(entry.path), a.filename)
    }

    await sleep(500)
    for (const m of markerSpots) assert.ok(!fs.existsSync(m), `marker file was created at ${m}`)
    assert.ok(countProcesses(['calc', 'CalculatorApp']) <= calcBefore, 'calculator was launched')
  })

  test('stdout is capped at 1 MB with a truncation note and the server stays responsive', async () => {
    const target = await t.notebook()
    const s = await t.register(fixture('bigout.ps1'))
    const started = await t.start(s.id, target)
    let healthyDuringRun = 0
    for (;;) {
      const run = await t.getRun(started.id)
      if (run.status !== 'running' && run.status !== 'queued') break
      const t0 = Date.now()
      const h = await raw(t.s.port, 'GET', '/api/health')
      if (run.status === 'running' && h.status === 200 && Date.now() - t0 < 1000) healthyDuringRun++
      await sleep(100)
    }
    const run = await t.getRun(started.id)
    assert.equal(run.status, 'succeeded', run.stderr)
    const bytes = Buffer.byteLength(run.stdout)
    assert.ok(bytes >= 1024 * 1024, `kept ${bytes} bytes`)
    assert.ok(bytes <= 1024 * 1024 + 200, `kept ${bytes} bytes, more than the cap`)
    assert.match(run.stdout, /\[truss\] Output truncated: \d+ bytes beyond the 1 MB limit were discarded\./)
    const dropped = Number(run.stdout.match(/truncated: (\d+) bytes/)[1])
    assert.ok(dropped > 1.5 * 1024 * 1024, `only ${dropped} bytes reported dropped`)
    assert.ok(healthyDuringRun > 0, '/api/health never answered while the run was in progress')
  })
})

function countProcesses(names) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-Process -Name ${names.join(',')} -ErrorAction SilentlyContinue).Count`], { encoding: 'utf8', windowsHide: true })
  return Number(out.trim())
}
