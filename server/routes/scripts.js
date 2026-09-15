import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { httpError } from '../http.js'
import { createRunner, isNetworkPath } from '../runner.js'

const BATCH_FORBIDDEN = /["%^&|<>!]/
const KINDS = { '.bat': 'bat', '.cmd': 'bat', '.ps1': 'ps1' }

// Fixed script, no user input. -STA is required for WinForms dialogs; the TopMost owner keeps it above the app window.
export const BROWSE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
  "$dialog.Title = 'Choose a script'",
  "$dialog.Filter = 'Scripts (*.bat;*.cmd;*.ps1)|*.bat;*.cmd;*.ps1'",
  "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }",
  '$owner.Dispose()',
].join('; ')

// Returns { path, kind } or throws a 400.
export function validateScriptPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw httpError(400, 'invalid_path', 'path is required')
  const raw = input.trim()
  if (isNetworkPath(raw)) throw httpError(400, 'network_path', 'Scripts must be on a local drive, not a network path')
  // Drive-absolute (C:\...) only; rejects relative and root-relative (\foo) paths.
  if (!/^[a-zA-Z]:[\\/]/.test(raw)) throw httpError(400, 'invalid_path', 'path must be absolute')
  const p = path.win32.normalize(raw)
  const kind = KINDS[path.extname(p).toLowerCase()]
  if (!kind) throw httpError(400, 'invalid_extension', 'Only .bat, .cmd and .ps1 scripts are supported')
  if (kind === 'bat' && BATCH_FORBIDDEN.test(p)) {
    throw httpError(400, 'unsafe_path', 'Batch script paths must not contain any of " % ^ & | < > !')
  }
  let stat
  try {
    stat = fs.statSync(p)
  } catch {
    throw httpError(400, 'file_not_found', 'Script file does not exist')
  }
  if (!stat.isFile()) throw httpError(400, 'file_not_found', 'Script path is not a file')
  return { path: p, kind }
}

function toScript(row) {
  if (!row) return null
  let config
  try { config = JSON.parse(row.config) } catch { config = {} }
  return { ...row, config }
}

function toRun(row) {
  if (!row) return null
  return { ...row, input_attachment_ids: JSON.parse(row.input_attachment_ids), output_attachment_ids: JSON.parse(row.output_attachment_ids) }
}

function parseName(value) {
  if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'invalid_name', 'name must be a non-empty string')
  return value.trim().slice(0, 200)
}

function parseConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'invalid_config', 'config must be an object')
  return JSON.stringify(value)
}

function parseTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 7 * 24 * 3600) throw httpError(400, 'invalid_timeout', 'timeout_sec must be a whole number of seconds (1 to 604800)')
  return value
}

export default function register(router, ctx) {
  const { db, attachments } = ctx
  const runner = createRunner(ctx)
  runner.recover()

  const RUN_COLS = 'r.*, s.name AS script_name'
  const q = {
    list: db.prepare('SELECT * FROM scripts ORDER BY name COLLATE NOCASE, created_at'),
    get: db.prepare('SELECT * FROM scripts WHERE id = ?'),
    insert: db.prepare(`INSERT INTO scripts (id, name, path, kind, config, timeout_sec, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    del: db.prepare('DELETE FROM scripts WHERE id = ?'),
    moduleExists: db.prepare('SELECT 1 FROM modules WHERE id = ?'),
    insertRun: db.prepare(`INSERT INTO script_runs (id, script_id, module_id, page_id, status, input_attachment_ids, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)`),
    run: db.prepare(`SELECT ${RUN_COLS} FROM script_runs r LEFT JOIN scripts s ON s.id = r.script_id WHERE r.id = ?`),
  }

  const loadScript = (id) => {
    const row = q.get.get(id)
    if (!row) throw httpError(404, 'script_not_found', 'Script not found')
    return row
  }
  const loadRun = (id) => {
    const row = q.run.get(id)
    if (!row) throw httpError(404, 'run_not_found', 'Run not found')
    return row
  }
  const requireObject = (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'JSON object body required')
    return body
  }

  router.get('/api/scripts', () => q.list.all().map(toScript))

  router.post('/api/scripts', ({ body, res }) => {
    requireObject(body)
    const { path: p, kind } = validateScriptPath(body.path)
    const name = body.name == null ? path.win32.basename(p, path.win32.extname(p)) : parseName(body.name)
    const config = body.config == null ? '{}' : parseConfig(body.config)
    const timeout = body.timeout_sec == null ? 1800 : parseTimeout(body.timeout_sec)
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    q.insert.run(id, name, p, kind, config, timeout, now, now)
    res.statusCode = 201
    return toScript(q.get.get(id))
  })

  router.patch('/api/scripts/:id', ({ params, body }) => {
    loadScript(params.id)
    requireObject(body)
    const sets = []
    const args = []
    if ('name' in body) sets.push('name = ?'), args.push(parseName(body.name))
    if ('path' in body) {
      const { path: p, kind } = validateScriptPath(body.path)
      sets.push('path = ?', 'kind = ?'), args.push(p, kind)
    }
    if ('config' in body) sets.push('config = ?'), args.push(parseConfig(body.config))
    if ('timeout_sec' in body) sets.push('timeout_sec = ?'), args.push(parseTimeout(body.timeout_sec))
    if (sets.length) {
      sets.push('updated_at = ?'), args.push(new Date().toISOString())
      db.prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE id = ?`).run(...args, params.id)
    }
    return toScript(q.get.get(params.id))
  })

  router.delete('/api/scripts/:id', ({ params }) => {
    loadScript(params.id)
    q.del.run(params.id)
    return { ok: true }
  })

  router.post('/api/scripts/browse', async () => {
    if (process.env.TRUSS_DRY_OPEN === '1') return { path: null }
    const stdout = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', BROWSE_SCRIPT],
        { windowsHide: true, shell: false, encoding: 'utf8' },
        (err, out) => (err ? reject(httpError(500, 'browse_failed', 'Could not open the file dialog')) : resolve(out)))
    })
    const chosen = stdout.trim()
    return { path: chosen || null }
  })

  router.post('/api/scripts/:id/run', ({ params, body, res }) => {
    const script = loadScript(params.id)
    requireObject(body)
    const { moduleId, pageId = null, attachmentIds = [] } = body
    if (typeof moduleId !== 'string' || !q.moduleExists.get(moduleId)) throw httpError(404, 'module_not_found', 'Module not found')
    if (pageId !== null && typeof pageId !== 'string') throw httpError(400, 'invalid_page', 'pageId must be a string')
    if (!Array.isArray(attachmentIds) || attachmentIds.some((id) => typeof id !== 'string')) {
      throw httpError(400, 'invalid_attachments', 'attachmentIds must be an array of attachment ids')
    }
    const ids = [...new Set(attachmentIds)]
    for (const id of ids) {
      const att = attachments.get(id)
      if (!att || att.module_id !== moduleId) throw httpError(400, 'invalid_attachments', `Attachment ${id} does not belong to this module`)
    }
    const id = crypto.randomUUID()
    q.insertRun.run(id, script.id, moduleId, pageId || null, JSON.stringify(ids), new Date().toISOString())
    runner.enqueue(id)
    res.statusCode = 201
    return toRun(q.run.get(id))
  })

  router.get('/api/runs', ({ query }) => {
    const where = []
    const args = []
    if (query.moduleId) where.push('r.module_id = ?'), args.push(query.moduleId)
    if (query.pageId) where.push('r.page_id = ?'), args.push(query.pageId)
    if (query.scriptId) where.push('r.script_id = ?'), args.push(query.scriptId)
    const sql = `SELECT ${RUN_COLS} FROM script_runs r LEFT JOIN scripts s ON s.id = r.script_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at DESC, r.rowid DESC LIMIT 500`
    return db.prepare(sql).all(...args).map(toRun)
  })

  router.get('/api/runs/:id', ({ params }) => toRun(loadRun(params.id)))

  router.post('/api/runs/:id/cancel', async ({ params }) => {
    const run = loadRun(params.id)
    if (runner.isTerminal(run.status)) throw httpError(409, 'run_finished', 'This run has already finished')
    // Wait for the tree to die, but never hang the request if taskkill misbehaves.
    await Promise.race([runner.cancel(run.id), new Promise((r) => setTimeout(r, 15000).unref())])
    return toRun(q.run.get(run.id))
  })
}
