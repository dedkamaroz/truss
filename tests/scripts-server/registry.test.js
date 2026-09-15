import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { scriptsServer, tempDir, fixture } from './helpers.js'
import { BROWSE_SCRIPT } from '../../server/routes/scripts.js'
import { commandFor } from '../../server/runner.js'

describe('script registry', () => {
  let t
  let dir
  const touch = (rel) => {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '@echo off\r\n')
    return p
  }
  before(async () => {
    t = await scriptsServer()
    dir = tempDir('registry')
  })
  after(() => t.s.close())

  const expect400 = async (body, code) => {
    const r = await t.call('POST', '/api/scripts', { json: body })
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${r.status} ${r.text}`)
    assert.match(r.headers['content-type'], /application\/json/)
    assert.equal(typeof r.json.error.message, 'string')
    if (code) assert.equal(r.json.error.code, code)
  }

  test('rejects relative, missing, wrong extension and unsafe batch paths', async () => {
    await expect400({ path: 'scripts\\run.bat' }, 'invalid_path')
    await expect400({ path: '.\\run.bat' }, 'invalid_path')
    await expect400({ path: '\\rooted\\run.bat' }, 'invalid_path')
    await expect400({ path: path.join(dir, 'does-not-exist.bat') }, 'file_not_found')
    await expect400({ path: touch('tool.exe') }, 'invalid_extension')
    await expect400({ path: touch('a&b\\x.bat') }, 'unsafe_path')
    await expect400({ path: touch('100%\\x.bat') }, 'unsafe_path')
    await expect400({ path: touch('bang!\\x.cmd') }, 'unsafe_path')
    await expect400({ path: touch('caret^\\x.bat') }, 'unsafe_path')
    await expect400({})
    // A directory named like a script is not a file.
    fs.mkdirSync(path.join(dir, 'folder.bat'))
    await expect400({ path: path.join(dir, 'folder.bat') }, 'file_not_found')
    assert.deepEqual((await t.call('GET', '/api/scripts')).json, [])
  })

  test('a PowerShell path may contain characters that are unsafe for batch', async () => {
    const s = await t.register(touch('a&b\\ok.ps1'))
    assert.equal(s.kind, 'ps1')
    assert.equal((await t.call('DELETE', `/api/scripts/${s.id}`)).status, 200)
  })

  test('accepts .bat, .cmd and .ps1 with the right kind, then PATCH and DELETE', async () => {
    const bat = await t.register(touch('good.bat'))
    const cmd = await t.register(touch('Good.CMD'), { name: 'Command file', timeout_sec: 60, config: { mode: 'fast' } })
    const ps1 = await t.register(touch('good.ps1'))
    assert.equal(bat.kind, 'bat')
    assert.equal(cmd.kind, 'bat')
    assert.equal(ps1.kind, 'ps1')
    assert.equal(bat.name, 'good')
    assert.equal(bat.timeout_sec, 1800)
    assert.deepEqual(bat.config, {})
    assert.equal(cmd.name, 'Command file')
    assert.equal(cmd.timeout_sec, 60)
    assert.deepEqual(cmd.config, { mode: 'fast' })
    assert.equal(ps1.path, path.join(dir, 'good.ps1'))

    const listed = (await t.call('GET', '/api/scripts')).json
    assert.deepEqual(listed.map((s) => s.id).sort(), [bat.id, cmd.id, ps1.id].sort())

    const patched = await t.call('PATCH', `/api/scripts/${bat.id}`, { json: { name: 'Renamed', timeout_sec: 5, config: { a: 1 }, path: ps1.path } })
    assert.equal(patched.status, 200)
    assert.equal(patched.json.name, 'Renamed')
    assert.equal(patched.json.timeout_sec, 5)
    assert.deepEqual(patched.json.config, { a: 1 })
    assert.equal(patched.json.kind, 'ps1', 'changing the path re-derives kind')

    const badPatch = await t.call('PATCH', `/api/scripts/${bat.id}`, { json: { path: touch('x&y\\z.bat') } })
    assert.equal(badPatch.status, 400)
    assert.equal((await t.call('PATCH', `/api/scripts/${bat.id}`, { json: { timeout_sec: 0 } })).status, 400)
    assert.equal((await t.call('PATCH', `/api/scripts/${bat.id}`, { json: { config: [1] } })).status, 400)
    assert.equal((await t.call('GET', '/api/scripts')).json.find((s) => s.id === bat.id).kind, 'ps1', 'failed patch changed nothing')

    assert.equal((await t.call('DELETE', `/api/scripts/${cmd.id}`)).status, 200)
    assert.equal((await t.call('DELETE', `/api/scripts/${cmd.id}`)).status, 404)
    assert.equal((await t.call('PATCH', `/api/scripts/${cmd.id}`, { json: { name: 'x' } })).status, 404)
    assert.ok(!(await t.call('GET', '/api/scripts')).json.some((s) => s.id === cmd.id))
  })

  test('deleting a script keeps its runs with script_id null', async () => {
    const target = await t.notebook()
    const s = await t.register(fixture('fail.bat'))
    const run = await t.start(s.id, target)
    await t.waitRun(run.id)
    assert.equal((await t.call('DELETE', `/api/scripts/${s.id}`)).status, 200)
    const after = await t.getRun(run.id)
    assert.equal(after.script_id, null)
    assert.equal(after.status, 'failed')
  })

  test('run validation: unknown script, module and foreign attachments are rejected', async () => {
    const a = await t.notebook()
    const b = await t.notebook()
    const s = await t.register(fixture('fail.bat'))
    const att = await t.upload(b, 'other.txt', Buffer.from('x'))
    assert.equal((await t.call('POST', '/api/scripts/nope/run', { json: { ...a, attachmentIds: [] } })).status, 404)
    assert.equal((await t.call('POST', `/api/scripts/${s.id}/run`, { json: { moduleId: 'nope', attachmentIds: [] } })).status, 404)
    const foreign = await t.call('POST', `/api/scripts/${s.id}/run`, { json: { ...a, attachmentIds: [att.id] } })
    assert.equal(foreign.status, 400)
    assert.equal((await t.call('POST', `/api/scripts/${s.id}/run`, { json: { ...a, attachmentIds: 'x' } })).status, 400)
    assert.equal((await t.call('GET', `/api/runs?moduleId=${a.moduleId}`)).json.length, 0)
  })

  test('browse returns { path: null } under TRUSS_DRY_OPEN=1 and the dialog script is fixed and parses', async () => {
    const prev = process.env.TRUSS_DRY_OPEN
    process.env.TRUSS_DRY_OPEN = '1'
    try {
      const r = await t.call('POST', '/api/scripts/browse', { json: {} })
      assert.equal(r.status, 200)
      assert.deepEqual(r.json, { path: null })
    } finally {
      if (prev === undefined) delete process.env.TRUSS_DRY_OPEN
      else process.env.TRUSS_DRY_OPEN = prev
    }
    assert.match(BROWSE_SCRIPT, /OpenFileDialog/)
    const errors = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT_UNDER_TEST, [ref]$null, [ref]$e); $e.Count'],
    { env: { ...process.env, SCRIPT_UNDER_TEST: BROWSE_SCRIPT }, encoding: 'utf8', windowsHide: true }).trim()
    assert.equal(errors, '0')
    const src = fs.readFileSync(new URL('../../server/routes/scripts.js', import.meta.url), 'utf8')
    assert.match(src, /'-STA'/)
  })

  test('command construction keeps the path as the only argument and never uses a shell', () => {
    const bat = commandFor({ kind: 'bat', path: 'C:\\x y\\run.bat' })
    assert.equal(bat.command, 'cmd.exe')
    assert.deepEqual(bat.args, ['/d', '/s', '/c', '"C:\\x y\\run.bat"'])
    assert.equal(bat.options.windowsVerbatimArguments, true)
    assert.equal(bat.options.shell, false)
    const ps = commandFor({ kind: 'ps1', path: 'C:\\x y\\run.ps1' })
    assert.equal(ps.command, 'powershell.exe')
    assert.deepEqual(ps.args, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\x y\\run.ps1'])
    assert.equal(ps.options.shell, false)
  })
})
