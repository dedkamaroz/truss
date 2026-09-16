import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRouter, httpError, sendJson, sendError, readJsonBody, mimeFor } from './http.js'
import { launch, createAttachments } from './attachments.js'

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.dirname(SERVER_DIR)
const WEB_DIR = path.join(REPO_DIR, 'web')
const ROUTES_DIR = path.join(SERVER_DIR, 'routes')
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()

export const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'"

if (IS_MAIN) {
  // node:sqlite prints an ExperimentalWarning on load; drop only that one for the CLI.
  const defaults = process.listeners('warning')
  process.removeAllListeners('warning')
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return
    for (const fn of defaults) fn(w)
  })
}

export async function startServer({ port = 4717, dataDir, host = '127.0.0.1', hosted = process.env.TRUSS_HOSTED === '1' } = {}) {
  if (!dataDir) throw new Error('startServer requires dataDir')
  dataDir = path.resolve(dataDir)
  // Imported lazily so the CLI warning filter above is installed before node:sqlite loads.
  const { openDb, MODULE_TYPES } = await import('./db.js')

  const db = openDb(dataDir)
  const token = crypto.randomBytes(24).toString('hex')
  const router = createRouter()
  const templates = new Map() // `${type}:${key}` -> { type, key, name, description, apply }
  const moduleDeleteHooks = [] // fn(moduleId), run inside the delete transaction before the row goes
  const ctx = {
    db,
    dataDir,
    hosted,
    attachments: createAttachments(db, dataDir),
    templates,
    moduleDeleteHooks,
    onModuleDelete(fn) {
      moduleDeleteHooks.push(fn)
    },
    registerTemplate(type, key, { name, description = '', apply } = {}) {
      if (!MODULE_TYPES.includes(type)) throw new Error(`registerTemplate: unknown type "${type}"`)
      if (!key || typeof key !== 'string') throw new Error('registerTemplate: key is required')
      templates.set(`${type}:${key}`, { type, key, name: name || key, description, apply: apply || (() => {}) })
    },
  }
  for (const type of MODULE_TYPES) {
    ctx.registerTemplate(type, 'blank', { name: 'Blank', description: `An empty ${type}` })
  }

  router.get('/api/health', () => ({ ok: true }))

  // server/routes/scripts.js pulls in server/runner.js, which spawns cmd.exe,
  // powershell.exe and taskkill.exe against local paths. On a shared server that
  // is remote code execution for anyone holding the module grant, so it is not
  // registered and runner.js is never imported at all.
  const routeFiles = fs.readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !(hosted && f === 'scripts.js'))
    .sort()
  for (const file of routeFiles) {
    const mod = await import(pathToFileURL(path.join(ROUTES_DIR, file)).href)
    if (typeof mod.default !== 'function') throw new Error(`server/routes/${file} has no default register(router, ctx) export`)
    await mod.default(router, ctx)
  }

  let actualPort = port
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err))
  })

  async function handle(req, res) {
    // The hosted proxy MUST send Host: 127.0.0.1:<port>. This check is what stops
    // a DNS-rebinding page in a browser from reaching a local Truss, and the
    // sidecar binds 127.0.0.1 only, so loosening it buys nothing.
    const hostHeader = (req.headers.host || '').toLowerCase()
    if (hostHeader !== `127.0.0.1:${actualPort}` && hostHeader !== `localhost:${actualPort}`) {
      return sendJson(res, 403, { error: { code: 'forbidden_host', message: 'Invalid Host header' } })
    }
    let url
    try {
      url = new URL(req.url, `http://${hostHeader}`)
    } catch {
      return sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid URL' } })
    }
    const { pathname } = url
    if (pathname === '/api' || pathname.startsWith('/api/')) return handleApi(req, res, url)
    return serveStatic(req, res, pathname)
  }

  async function handleApi(req, res, url) {
    const { pathname } = url
    if (!(req.method === 'GET' && pathname === '/api/health')) {
      const supplied = req.headers['x-truss-token'] ?? (req.method === 'GET' ? url.searchParams.get('token') : null)
      if (!safeEqual(supplied, token)) throw httpError(401, 'unauthorized', 'Missing or invalid token')
    }
    const hit = router.match(req.method, pathname)
    if (!hit) throw httpError(404, 'not_found', 'Unknown API route')
    if (hit.methodNotAllowed) throw httpError(405, 'method_not_allowed', 'Method not allowed')
    const query = Object.fromEntries(url.searchParams)
    const isJson = /^application\/json\b/i.test(req.headers['content-type'] || '')
    // Raw uploads (X-Filename) keep the stream even when the file itself is JSON.
    const body = isJson && !req.headers['x-filename'] ? await readJsonBody(req) : undefined
    const result = await hit.handler({ req, res, params: hit.params, query, body, ctx })
    if (result !== undefined && !res.headersSent) sendJson(res, res.statusCode || 200, result)
  }

  function serveStatic(req, res, pathname) {
    const notFound = () => sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } })
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound()
    let rel
    try {
      rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    } catch {
      return notFound()
    }
    // No backslashes, NULs or colons (drive letters, NTFS streams); then resolve and verify the prefix.
    if (/[\\\0:]/.test(rel)) return notFound()
    const file = path.resolve(WEB_DIR, '.' + rel)
    if (!file.startsWith(WEB_DIR + path.sep)) return notFound()
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return notFound()
    }
    if (!stat.isFile()) return notFound()
    const type = mimeFor(file)
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }
    if (type.startsWith('text/html')) {
      const html = Buffer.from(fs.readFileSync(file, 'utf8').replaceAll('%TRUSS_TOKEN%', token))
      res.writeHead(200, { ...headers, 'Content-Security-Policy': CSP, 'Content-Length': html.length, 'Cache-Control': 'no-store' })
      return res.end(req.method === 'HEAD' ? undefined : html)
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size })
    if (req.method === 'HEAD') return res.end()
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  actualPort = server.address().port
  // Only after the port is ours: a second copy of Truss started on the same port fails above instead of deleting the
  // folder of an upload the running copy has not recorded yet. Runs before any request can be handled.
  const orphans = ctx.attachments.removeOrphans()
  if (orphans) console.log(`[truss] removed ${orphans} orphaned attachment folder${orphans === 1 ? '' : 's'}`)
  const url = `http://127.0.0.1:${actualPort}/`

  return {
    url,
    port: actualPort,
    token,
    hosted,
    ctx,
    server,
    async close() {
      await new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      db.close()
    },
  }
}

function safeEqual(a, b) {
  if (typeof a !== 'string') return false
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function findBrowser() {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
  const candidates = [
    ...bases.map((b) => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ...bases.map((b) => path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ]
  return candidates.find((p) => fs.existsSync(p)) || null
}

export function openAppWindow(url) {
  const browser = findBrowser()
  if (browser) return launch(browser, [`--app=${url}`])
  return launch('explorer.exe', [url]) // default browser
}

if (IS_MAIN) {
  const port = Number(process.env.PORT || 4717)
  const dataDir = process.env.TRUSS_DATA_DIR || path.join(REPO_DIR, 'data')
  try {
    const s = await startServer({ port, dataDir })
    console.log(`Truss running at ${s.url}`)
    if (process.argv.includes('--open') && !s.hosted) openAppWindow(s.url)
    const shutdown = () => s.close().finally(() => process.exit(0))
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : err)
    process.exit(1)
  }
}
