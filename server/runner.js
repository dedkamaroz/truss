// Script run queue and process spawning (spec section 8). No user-controlled data ever reaches a command line:
// attachment names and config travel only through env vars and the inputs JSON file.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export const MAX_CONCURRENT = 2
export const OUTPUT_CAP = 1024 * 1024
const FLUSH_MS = 1000
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])

// Every live child across all runners, so a dying Node process can take its script trees with it.
const liveChildren = new Set()
let exitHookInstalled = false
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const child of liveChildren) killTree(child.pid, true)
  })
}

export function killTree(pid, sync = false) {
  if (!pid) return
  const args = ['/T', '/F', '/PID', String(pid)]
  const opts = { windowsHide: true, stdio: 'ignore', shell: false }
  try {
    // sync is only used from the process 'exit' hook, where async work never runs.
    if (sync) return spawnSync('taskkill.exe', args, opts)
    const p = spawn('taskkill.exe', args, opts)
    p.on('error', (err) => console.error('[truss] taskkill failed:', err.message))
  } catch (err) {
    console.error('[truss] taskkill failed:', err.message)
  }
}

// Network and device paths (\\server\share, \\?\, \\.\): touching one makes Windows connect over SMB and send the
// user's NTLM credentials to that host, so they are refused before any file access.
export const isNetworkPath = (p) => /^[\\/]{2}/.test(String(p))

// Builds the spawn command for a script. Exported for tests; the path is validated at registration.
export function commandFor(script) {
  if (script.kind === 'bat') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${script.path}"`], options: { windowsVerbatimArguments: true, shell: false } }
  }
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script.path],
    options: { shell: false },
  }
}

function capture() {
  let chunks = []
  let kept = 0
  let dropped = 0
  return {
    push(buf) {
      const room = OUTPUT_CAP - kept
      if (room >= buf.length) {
        chunks.push(buf)
        kept += buf.length
      } else {
        if (room > 0) {
          chunks.push(buf.subarray(0, room))
          kept = OUTPUT_CAP
        }
        dropped += buf.length - Math.max(room, 0)
      }
    },
    text() {
      if (chunks.length > 1) chunks = [Buffer.concat(chunks)]
      let s = chunks.length ? chunks[0].toString('utf8') : ''
      if (dropped) s += `\n[truss] Output truncated: ${dropped} bytes beyond the 1 MB limit were discarded.`
      return s
    },
  }
}

function uniqueName(name, used) {
  const ext = path.extname(name)
  const base = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`
  used.add(candidate.toLowerCase())
  return candidate
}

export function createRunner({ db, dataDir, attachments }) {
  installExitHook()
  const runsRoot = path.join(dataDir, 'runs')
  const now = () => new Date().toISOString()
  const q = {
    run: db.prepare('SELECT * FROM script_runs WHERE id = ?'),
    script: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    start: db.prepare("UPDATE script_runs SET status = 'running', started_at = ? WHERE id = ?"),
    output: db.prepare('UPDATE script_runs SET stdout = ?, stderr = ? WHERE id = ?'),
    finish: db.prepare(`UPDATE script_runs SET status = ?, exit_code = ?, stdout = ?, stderr = ?, output_attachment_ids = ?, finished_at = ?
      WHERE id = ?`),
    recover: db.prepare(`UPDATE script_runs SET status = 'failed', finished_at = ?,
      stderr = stderr || CASE WHEN stderr = '' THEN '' ELSE char(10) END || ?
      WHERE status IN ('queued', 'running')`),
  }

  const queue = [] // run ids waiting for a slot, FIFO
  const active = new Map() // runId -> { child, reason, done: Promise }

  // Server start: nothing can still be running for a fresh process, so stale rows are failed.
  function recover() {
    const note = '[truss] Run interrupted: the server stopped before this run finished.'
    const { changes } = q.recover.run(now(), note)
    fs.rmSync(runsRoot, { recursive: true, force: true })
    return changes
  }

  function enqueue(runId) {
    queue.push(runId)
    pump()
  }

  function pump() {
    while (active.size < MAX_CONCURRENT && queue.length) start(queue.shift())
  }

  function start(runId) {
    const state = { child: null, reason: null }
    state.done = new Promise((resolve) => (state.resolve = resolve))
    active.set(runId, state)
    q.start.run(now(), runId)
    execute(runId, state)
      .catch((err) => {
        console.error('[truss] run failed unexpectedly:', err)
        return finalize(runId, state, { status: 'failed', exitCode: null, stdout: '', stderr: `[truss] Internal error: ${err.message}`, outputDir: null })
      })
      .catch((err) => console.error('[truss] could not record run result:', err))
      .finally(() => {
        active.delete(runId)
        state.resolve()
        pump()
      })
  }

  async function execute(runId, state) {
    const run = q.run.get(runId)
    const script = run.script_id ? q.script.get(run.script_id) : null
    const fail = (msg) => finalize(runId, state, { status: 'failed', exitCode: null, stdout: '', stderr: `[truss] ${msg}`, outputDir: null })
    if (!script) return fail('The script was deleted before this run started.')
    // Scripts registered before network paths were refused.
    if (isNetworkPath(script.path)) return fail(`Scripts must be on a local drive, not a network path: ${script.path}`)
    if (!fs.existsSync(script.path)) return fail(`Script file not found: ${script.path}`)

    const runDir = path.join(runsRoot, runId)
    const inputDir = path.join(runDir, 'input')
    const outputDir = path.join(runDir, 'output')
    await fs.promises.mkdir(inputDir, { recursive: true })
    await fs.promises.mkdir(outputDir, { recursive: true })

    const inputs = []
    const used = new Set()
    for (const id of JSON.parse(run.input_attachment_ids)) {
      const row = attachments.get(id)
      if (!row) return fail(`Input attachment ${id} no longer exists.`)
      const dest = path.join(inputDir, uniqueName(row.filename, used))
      await fs.promises.copyFile(attachments.pathOf(id), dest)
      inputs.push({ id, filename: row.filename, path: dest })
    }
    const inputsFile = path.join(runDir, 'inputs.json')
    await fs.promises.writeFile(inputsFile, JSON.stringify(inputs, null, 2))
    if (state.reason) return finalize(runId, state, { status: state.reason, exitCode: null, stdout: '', stderr: '', outputDir })

    const { command, args, options } = commandFor(script)
    const env = {
      ...process.env,
      TRUSS_RUN_ID: runId,
      TRUSS_INPUTS_FILE: inputsFile,
      TRUSS_INPUT_DIR: inputDir,
      TRUSS_OUTPUT_DIR: outputDir,
      TRUSS_CONFIG: script.config || '{}',
    }
    const out = capture()
    const err = capture()
    const result = await new Promise((resolve) => {
      let spawnError = null
      let exitTimer = null
      const child = spawn(command, args, { ...options, cwd: path.dirname(script.path), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      state.child = child
      liveChildren.add(child)
      if (state.reason) killTree(child.pid) // cancelled between the check above and spawn
      let dirty = false
      child.stdout.on('data', (b) => { out.push(b); dirty = true })
      child.stderr.on('data', (b) => { err.push(b); dirty = true })
      const flush = setInterval(() => {
        if (!dirty) return
        dirty = false
        try { q.output.run(out.text(), err.text(), runId) } catch {}
      }, FLUSH_MS)
      const timeout = setTimeout(() => {
        if (state.reason) return
        state.reason = 'timed_out'
        killTree(child.pid)
      }, Math.max(1, script.timeout_sec) * 1000)
      child.on('error', (e) => {
        spawnError = e
        // 'close' may not follow a failed spawn.
        if (child.pid == null) done(null)
      })
      // A stray grandchild holding our pipes must not keep the run open forever.
      child.on('exit', () => {
        exitTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy() }, 2000)
      })
      child.on('close', (code) => done(code))
      let settled = false
      function done(code) {
        if (settled) return
        settled = true
        clearInterval(flush)
        clearTimeout(timeout)
        clearTimeout(exitTimer)
        liveChildren.delete(child)
        resolve({ code, spawnError })
      }
    })

    let stderr = err.text()
    let status = state.reason
    if (!status) status = result.spawnError || result.code !== 0 ? 'failed' : 'succeeded'
    if (result.spawnError) stderr += `${stderr ? '\n' : ''}[truss] Could not start the script: ${result.spawnError.message}`
    if (state.reason === 'timed_out') stderr += `${stderr ? '\n' : ''}[truss] Timed out after ${script.timeout_sec} s; the process tree was stopped.`
    if (state.reason === 'cancelled') stderr += `${stderr ? '\n' : ''}[truss] Cancelled; the process tree was stopped.`
    return finalize(runId, state, { status, exitCode: result.code, stdout: out.text(), stderr, outputDir })
  }

  async function finalize(runId, state, { status, exitCode, stdout, stderr, outputDir }) {
    const run = q.run.get(runId)
    const outputIds = []
    if (outputDir) {
      try {
        const entries = await fs.promises.readdir(outputDir, { recursive: true, withFileTypes: true })
        const used = new Set()
        const files = entries
          .filter((d) => d.isFile())
          .map((d) => path.join(d.parentPath, d.name))
          .sort()
        for (const file of files) {
          const flat = path.relative(outputDir, file).split(path.sep).join('_')
          try {
            const row = attachments.create({ moduleId: run.module_id, pageId: run.page_id, filename: uniqueName(flat, used), source: 'script-output', srcPath: file })
            outputIds.push(row.id)
          } catch (e) {
            stderr += `${stderr ? '\n' : ''}[truss] Could not attach output ${flat}: ${e.message}`
          }
        }
      } catch (e) {
        stderr += `${stderr ? '\n' : ''}[truss] Could not read the output folder: ${e.message}`
      }
    }
    if (db.isOpen === false) return
    q.finish.run(status, exitCode ?? null, stdout, stderr, JSON.stringify(outputIds), now(), runId)
    fs.promises.rm(path.join(runsRoot, runId), { recursive: true, force: true }).catch(() => {})
  }

  // Resolves once the run is terminal. Returns false when it was already finished or unknown.
  async function cancel(runId) {
    const idx = queue.indexOf(runId)
    if (idx >= 0) {
      queue.splice(idx, 1)
      q.finish.run('cancelled', null, '', '[truss] Cancelled before it started.', '[]', now(), runId)
      return true
    }
    const state = active.get(runId)
    if (!state) return false
    if (!state.reason) {
      state.reason = 'cancelled'
      if (state.child) killTree(state.child.pid)
    }
    await state.done
    return true
  }

  return { recover, enqueue, cancel, isTerminal: (status) => TERMINAL.has(status), activeCount: () => active.size }
}
