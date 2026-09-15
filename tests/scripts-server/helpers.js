import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { boot, raw, tempDir, REPO } from '../server-core/helpers.js'

export { boot, raw, tempDir, REPO }
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
export const fixture = (name) => path.join(FIXTURES, name)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// Boots a server and adds convenience calls around it.
export async function scriptsServer(dataDir) {
  const t = await boot(dataDir ?? tempDir('scripts'))
  const { call } = t

  t.notebook = async () => {
    const r = await call('POST', '/api/modules', { json: { type: 'notebook', title: 'Runs' } })
    if (r.status !== 201) throw new Error(`module create failed: ${r.text}`)
    return { moduleId: r.json.id, pageId: crypto.randomUUID() }
  }
  t.upload = async ({ moduleId, pageId }, filename, buffer) => {
    const r = await call('POST', `/api/attachments?moduleId=${moduleId}&pageId=${pageId}`, {
      headers: { 'X-Filename': encodeURIComponent(filename), 'Content-Type': 'application/octet-stream' },
      body: buffer,
    })
    if (r.status !== 201) throw new Error(`upload failed: ${r.text}`)
    return r.json
  }
  t.register = async (scriptPath, extra = {}) => {
    const r = await call('POST', '/api/scripts', { json: { path: scriptPath, ...extra } })
    if (r.status !== 201) throw new Error(`register failed: ${r.text}`)
    return r.json
  }
  t.start = async (scriptId, target, attachmentIds = []) => {
    const r = await call('POST', `/api/scripts/${scriptId}/run`, { json: { ...target, attachmentIds } })
    if (r.status !== 201) throw new Error(`run failed to start: ${r.text}`)
    return r.json
  }
  t.getRun = async (id) => (await call('GET', `/api/runs/${id}`)).json
  t.waitRun = async (id, timeoutMs = 60000) => {
    const end = Date.now() + timeoutMs
    for (;;) {
      const run = await t.getRun(id)
      if (!['queued', 'running'].includes(run.status)) return run
      if (Date.now() > end) throw new Error(`run ${id} still ${run.status} after ${timeoutMs} ms`)
      await sleep(150)
    }
  }
  t.content = async (attachmentId) => (await call('GET', `/api/attachments/${attachmentId}/content`)).body
  t.list = async ({ moduleId, pageId }) => (await call('GET', `/api/attachments?moduleId=${moduleId}&pageId=${pageId}`)).json
  return t
}

// Live processes (excluding the query itself) whose command line contains marker. The marker is passed via env
// so the querying PowerShell's own command line never matches.
export function processesWithMarker(marker) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:TRUSS_TEST_MARKER) } | Select-Object ProcessId, ParentProcessId, CommandLine) | ConvertTo-Json -Compress'],
  { env: { ...process.env, TRUSS_TEST_MARKER: marker }, encoding: 'utf8', windowsHide: true }).trim()
  if (!out) return []
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

// Is any of these PIDs still alive?
export function alivePids(pids) {
  if (!pids.length) return []
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { @(${pids.map(Number).join(',')}) -contains $_.ProcessId } | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`],
  { encoding: 'utf8', windowsHide: true }).trim()
  if (!out) return []
  return [].concat(JSON.parse(out))
}

// All descendants of the given root PIDs (pid -> command line).
export function descendants(rootPids) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine) | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const all = JSON.parse(out)
  const found = new Map()
  let frontier = new Set(rootPids)
  while (frontier.size) {
    const next = new Set()
    for (const p of all) {
      if (frontier.has(p.ParentProcessId) && !found.has(p.ProcessId) && !rootPids.includes(p.ProcessId)) {
        found.set(p.ProcessId, p.CommandLine)
        next.add(p.ProcessId)
      }
    }
    frontier = next
  }
  return found
}

// Copies a fixture into a fresh folder whose name carries a unique marker.
export function markedCopy(fixtureName) {
  const marker = `trussmark${crypto.randomBytes(6).toString('hex')}`
  const dir = fs.mkdtempSync(path.join(tempDir('marker'), `${marker}-`))
  const dest = path.join(dir, fixtureName)
  fs.copyFileSync(fixture(fixtureName), dest)
  return { marker, dir, path: dest }
}
