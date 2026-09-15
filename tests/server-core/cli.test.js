import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO, tempDir, raw } from './helpers.js'

function runCli(args, env) {
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'main.js'), ...args], {
    env: { ...process.env, PORT: '0', TRUSS_DATA_DIR: tempDir('cli'), ...env },
  })
  const out = { stdout: '', stderr: '' }
  child.stdout.on('data', (d) => (out.stdout += d))
  child.stderr.on('data', (d) => (out.stderr += d))
  const started = Date.now()
  const ready = new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const m = out.stdout.match(/http:\/\/127\.0\.0\.1:(\d+)\//)
      if (m) (clearInterval(timer), resolve(Number(m[1])))
    }, 10)
    child.on('exit', (code) => (clearInterval(timer), reject(new Error(`exited ${code}: ${out.stderr}`))))
  })
  return { child, out, ready, started }
}

test('CLI starts quickly, prints URL, hides the sqlite ExperimentalWarning, --open is dry-run logged', async () => {
  const { child, out, ready, started } = runCli(['--open'], { TRUSS_DRY_OPEN: '1' })
  try {
    const port = await ready
    const health = await raw(port, 'GET', '/api/health')
    assert.equal(health.status, 200)
    assert.ok(Date.now() - started < 1500, `answered health in ${Date.now() - started} ms`)
    await new Promise((r) => setTimeout(r, 100))
    assert.ok(!/ExperimentalWarning|SQLite is an experimental/.test(out.stderr), out.stderr)
    assert.match(out.stdout, /dry-run open: \[.*--app=http:\/\/127\.0\.0\.1:\d+\//)
  } finally {
    child.kill()
  }
})

test('truss.cmd launches main.js with --open', () => {
  const cmd = fs.readFileSync(path.join(REPO, 'truss.cmd'), 'utf8')
  assert.match(cmd, /node "%~dp0server\\main\.js" --open/)
})

test('server imports only node: builtins or relative paths', () => {
  const files = fs.readdirSync(path.join(REPO, 'server'), { recursive: true }).filter((f) => f.endsWith('.js'))
  assert.ok(files.length >= 6)
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO, 'server', f), 'utf8')
    for (const m of src.matchAll(/(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2]
      assert.ok(spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'), `${f} imports ${spec}`)
    }
  }
})

test('real launch path uses spawn with an argument array, detached, no shell', () => {
  const src = fs.readFileSync(path.join(REPO, 'server', 'attachments.js'), 'utf8')
  assert.match(src, /spawn\(command, args, \{ detached: true, stdio: 'ignore', shell: false \}\)/)
  assert.ok(!/exec(Sync)?\(|shell:\s*true/.test(fs.readFileSync(path.join(REPO, 'server', 'main.js'), 'utf8') + src))
})
