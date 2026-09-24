// Workspace API used by the web UI: every module is one versioned JSON document (modules.doc).
//
//   GET  /api/v2/workspace            all modules (legacy ones are converted on first read)
//   GET  /api/v2/modules/:id          one module
//   POST /api/v2/sync                 atomic batch of puts/deletes, each against the version the client last saw
//   GET  /api/v2/changes?since=rev    changes after rev (polling fallback)
//   GET  /api/v2/events?since=rev     the same changes as Server-Sent Events
//
// Concurrency: a put or delete whose baseVersion is not the stored version is refused, and the whole
// batch is rejected with 409 and the current documents, so the client can merge and retry. Nothing is
// ever overwritten silently.
import { httpError } from '../http.js'
import { transaction, MODULE_TYPES } from '../db.js'
import { convertModule } from '../legacy.js'

const MAX_TITLE = 500
const ID = /^[A-Za-z0-9_-]{1,80}$/
const LOG_KEEP = 20000
const HEARTBEAT_MS = 20000

export default function register(router, ctx) {
  const { db } = ctx
  const clients = new Set()
  const q = {
    all: db.prepare('SELECT id, type, title, doc, version FROM modules ORDER BY sort_order, created_at'),
    legacy: db.prepare('SELECT * FROM modules WHERE doc IS NULL'),
    get: db.prepare('SELECT id, type, doc, version FROM modules WHERE id = ?'),
    setDoc: db.prepare('UPDATE modules SET doc = ?, version = ? WHERE id = ?'),
    insert: db.prepare(`INSERT INTO modules (id, type, title, icon, sort_order, data, archived_at, created_at, updated_at, doc, version)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`),
    update: db.prepare(`UPDATE modules SET title = ?, icon = ?, sort_order = ?, archived_at = ?, updated_at = ?, doc = ?, version = ?
      WHERE id = ?`),
    del: db.prepare('DELETE FROM modules WHERE id = ?'),
    attachmentIds: db.prepare('SELECT id FROM attachments WHERE module_id = ?'),
    log: db.prepare('INSERT INTO workspace_log (module_id, version, deleted, client, at) VALUES (?, ?, ?, ?, ?)'),
    rev: db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM workspace_log'),
    since: db.prepare('SELECT rev, module_id AS id, version, deleted, client FROM workspace_log WHERE rev > ? ORDER BY rev LIMIT 5000'),
    trim: db.prepare('DELETE FROM workspace_log WHERE rev <= ?'),
  }
  const now = () => new Date().toISOString()
  const currentRev = () => q.rev.get().rev

  /** Converts any module still held only in the legacy tables. Idempotent; runs inside one transaction. */
  function convertLegacy() {
    const rows = q.legacy.all()
    if (!rows.length) return []
    const report = []
    transaction(db, () => {
      for (const row of rows) {
        const doc = convertModule(db, row, report)
        q.setDoc.run(JSON.stringify(doc), 1, row.id)
        q.log.run(row.id, 1, 0, 'migration', now())
      }
    })
    console.log(`[truss] converted ${rows.length} module${rows.length === 1 ? '' : 's'} to workspace documents`)
    for (const line of report) console.log(`[truss]   ${line}`)
    return report
  }
  convertLegacy()

  const out = (row) => ({ version: row.version, module: JSON.parse(row.doc) })

  function broadcast(changes) {
    if (!changes.length || !clients.size) return
    const payload = changes.map((c) => `id: ${c.rev}\ndata: ${JSON.stringify(c)}\n\n`).join('')
    for (const res of clients) res.write(payload)
  }

  function checkModule(m) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw httpError(400, 'invalid_module', 'module must be an object')
    if (typeof m.id !== 'string' || !ID.test(m.id)) throw httpError(400, 'invalid_module', 'module.id must be an id')
    if (!MODULE_TYPES.includes(m.type)) throw httpError(400, 'invalid_module', `module.type must be one of ${MODULE_TYPES.join(', ')}`)
    if (typeof m.title !== 'string' || m.title.length > MAX_TITLE) throw httpError(400, 'invalid_module', `module.title must be text of at most ${MAX_TITLE} characters`)
  }

  router.get('/api/v2/workspace', () => {
    const migration = convertLegacy()
    return { rev: currentRev(), modules: q.all.all().map(out), migration }
  })

  router.get('/api/v2/modules/:id', ({ params }) => {
    const row = q.get.get(params.id)
    if (!row || row.doc == null) throw httpError(404, 'module_not_found', 'Module not found')
    return out(row)
  })

  router.post('/api/v2/sync', ({ body, res }) => {
    if (!body || typeof body !== 'object') throw httpError(400, 'invalid_body', 'JSON object body required')
    const puts = Array.isArray(body.puts) ? body.puts : []
    const deletes = Array.isArray(body.deletes) ? body.deletes : []
    const client = typeof body.client === 'string' ? body.client.slice(0, 80) : null
    if (!puts.length && !deletes.length) return { rev: currentRev(), versions: {} }
    for (const p of puts) {
      checkModule(p?.module)
      if (!Number.isInteger(p.baseVersion) || p.baseVersion < 0) throw httpError(400, 'invalid_version', 'baseVersion must be a whole number')
    }
    for (const d of deletes) {
      if (typeof d?.id !== 'string' || !ID.test(d.id)) throw httpError(400, 'invalid_id', 'delete needs an id')
      if (!Number.isInteger(d.baseVersion) || d.baseVersion < 0) throw httpError(400, 'invalid_version', 'baseVersion must be a whole number')
    }
    const seen = new Set()
    for (const id of [...puts.map((p) => p.module.id), ...deletes.map((d) => d.id)]) {
      if (seen.has(id)) throw httpError(400, 'duplicate_id', 'A module can appear only once per sync')
      seen.add(id)
    }

    const ts = now()
    const removedAttachments = []
    const result = transaction(db, () => {
      const conflicts = []
      for (const p of puts) {
        const row = q.get.get(p.module.id)
        const version = row ? row.version : 0
        if (row && row.type !== p.module.type) throw httpError(400, 'type_change', 'A module cannot change type')
        if (version !== p.baseVersion) conflicts.push(row ? { id: row.id, version, module: row.doc ? JSON.parse(row.doc) : null } : { id: p.module.id, version: 0, module: null })
      }
      for (const d of deletes) {
        const row = q.get.get(d.id)
        if (row && row.version !== d.baseVersion) conflicts.push({ id: row.id, version: row.version, module: row.doc ? JSON.parse(row.doc) : null })
      }
      if (conflicts.length) return { conflicts }

      const versions = {}
      const changes = []
      for (const p of puts) {
        const m = p.module
        const doc = JSON.stringify(m)
        const version = p.baseVersion + 1
        const sort = Number.isFinite(m.sortOrder) ? m.sortOrder : 0
        const icon = typeof m.icon === 'string' ? m.icon.slice(0, 32) : null
        if (p.baseVersion === 0) q.insert.run(m.id, m.type, m.title, icon, sort, m.archivedAt || null, m.createdAt || ts, m.updatedAt || ts, doc, version)
        else q.update.run(m.title, icon, sort, m.archivedAt || null, m.updatedAt || ts, doc, version, m.id)
        const info = q.log.run(m.id, version, 0, client, ts)
        versions[m.id] = version
        changes.push({ rev: Number(info.lastInsertRowid), id: m.id, version, deleted: 0, client })
      }
      for (const d of deletes) {
        if (!q.get.get(d.id)) continue
        removedAttachments.push(...q.attachmentIds.all(d.id).map((r) => r.id))
        for (const fn of ctx.moduleDeleteHooks) fn(d.id)
        q.del.run(d.id)
        const info = q.log.run(d.id, d.baseVersion + 1, 1, client, ts)
        changes.push({ rev: Number(info.lastInsertRowid), id: d.id, version: d.baseVersion + 1, deleted: 1, client })
      }
      return { versions, changes }
    })

    if (result.conflicts) {
      res.statusCode = 409
      return { error: { code: 'conflict', message: 'Someone else changed this since you loaded it' }, conflicts: result.conflicts }
    }
    if (removedAttachments.length) ctx.attachments.removeFiles(removedAttachments)
    const rev = currentRev()
    if (rev > LOG_KEEP * 2) q.trim.run(rev - LOG_KEEP)
    broadcast(result.changes)
    return { rev, versions: result.versions }
  })

  router.get('/api/v2/changes', ({ query }) => {
    const since = Number(query.since) || 0
    return { rev: currentRev(), changes: q.since.all(since) }
  })

  router.get('/api/v2/events', ({ req, res, query }) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Tells nginx-style proxies not to buffer; harmless elsewhere.
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    // On reconnect EventSource sends Last-Event-ID, which is newer than the since= it first opened with.
    const since = Number(req.headers['last-event-id'] ?? query.since) || 0
    if (since) {
      const missed = q.since.all(since)
      if (missed.length) res.write(missed.map((c) => `id: ${c.rev}\ndata: ${JSON.stringify(c)}\n\n`).join(''))
    }
    clients.add(res)
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
    const done = () => {
      clearInterval(beat)
      clients.delete(res)
    }
    req.on('close', done)
    res.on('close', done)
    return undefined
  })
}
