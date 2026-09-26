import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { httpError, mimeFor } from './http.js'

// Launches the command via an argument array, detached. Under TRUSS_DRY_OPEN=1 only logs it.
export function launch(command, args) {
  if (process.env.TRUSS_DRY_OPEN === '1') {
    console.log(`[truss] dry-run open: ${JSON.stringify([command, ...args])}`)
    return { ok: true, dryRun: true, command: [command, ...args] }
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false })
  child.on('error', (err) => console.error(`[truss] failed to launch ${command}:`, err.message))
  child.unref()
  return { ok: true }
}

// The local default. Hosted, this shares a volume with the host's auth database:
// a volume full of attachments locks every user out of the server, not just out
// of Truss, so the deployment sets a far lower ceiling.
export const MAX_UPLOAD_BYTES = Number(process.env.TRUSS_MAX_UPLOAD_BYTES) || 1024 * 1024 * 1024

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

// Drops leading ../ segments and replaces separators with _ (so "report 1/2.pdf" keeps its whole name as
// "report 1_2.pdf"), then strips reserved/control characters and Windows device names.
export function sanitizeFilename(name) {
  let s = String(name ?? '').replace(/^(\.{1,2}[\\/])+/, '').replace(/[\\/]/g, '_')
  s = s.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/, '').replace(/^[. ]+/, '')
  if (RESERVED.test(s.split('.')[0].trim())) s = `_${s}`
  if (s.length > 200) {
    const ext = path.extname(s).slice(0, 20)
    s = s.slice(0, 200 - ext.length) + ext
  }
  return s || 'file'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Removes a folder; a failure (e.g. a file locked by Excel or antivirus) is logged, and removeOrphans retries at the next start.
function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch (err) {
    console.warn(`[truss] could not remove ${dir}: ${err.message}`)
    return false
  }
}

export function createAttachments(db, dataDir) {
  const root = path.join(dataDir, 'attachments')
  const now = () => new Date().toISOString()
  const q = {
    get: db.prepare('SELECT a.*, EXISTS (SELECT 1 FROM attachment_thumbs t WHERE t.attachment_id = a.id) AS has_thumb FROM attachments a WHERE a.id = ?'),
    thumbGet: db.prepare('SELECT data FROM attachment_thumbs WHERE attachment_id = ?'),
    thumbSet: db.prepare('INSERT INTO attachment_thumbs (attachment_id, data, created_at) VALUES (?, ?, ?) ON CONFLICT (attachment_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at'),
    insert: db.prepare(`INSERT INTO attachments (id, module_id, page_id, filename, mime, size, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    del: db.prepare('DELETE FROM attachments WHERE id = ?'),
    moduleExists: db.prepare('SELECT 1 FROM modules WHERE id = ?'),
  }

  function begin({ moduleId, pageId, filename, source = 'upload' }) {
    if (!moduleId || !q.moduleExists.get(moduleId)) throw httpError(404, 'module_not_found', 'Module not found')
    if (source !== 'upload' && source !== 'script-output') throw httpError(400, 'invalid_source', 'Invalid attachment source')
    const id = crypto.randomUUID()
    const safe = sanitizeFilename(filename)
    const dir = path.join(root, id)
    fs.mkdirSync(dir, { recursive: true })
    return { id, safe, dir, file: path.join(dir, safe), moduleId, pageId: pageId || null, source }
  }

  function finish(p) {
    const size = fs.statSync(p.file).size
    q.insert.run(p.id, p.moduleId, p.pageId, p.safe, mimeFor(p.safe), size, p.source, now())
    return q.get.get(p.id)
  }

  function withCleanup(p, fn) {
    try {
      return fn()
    } catch (err) {
      fs.rmSync(p.dir, { recursive: true, force: true })
      throw err
    }
  }

  const api = {
    root,

    // Synchronous for buffer/srcPath so callers may or may not await it.
    // ponytail: copyFileSync blocks the event loop for huge srcPath files; switch to fs.promises.copyFile if that bites.
    create({ moduleId, pageId, filename, source, buffer, srcPath }) {
      if (buffer == null && !srcPath) throw httpError(400, 'invalid_attachment', 'buffer or srcPath is required')
      const p = begin({ moduleId, pageId, filename: filename ?? (srcPath && path.basename(srcPath)), source })
      return withCleanup(p, () => {
        if (buffer != null) fs.writeFileSync(p.file, buffer)
        else fs.copyFileSync(srcPath, p.file)
        return finish(p)
      })
    },

    // Streams a readable (e.g. an HTTP request) to disk with a size cap.
    async createFromStream({ moduleId, pageId, filename, source }, stream, maxBytes = MAX_UPLOAD_BYTES) {
      const p = begin({ moduleId, pageId, filename, source })
      let size = 0
      const limiter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length
          if (size > maxBytes) cb(httpError(413, 'payload_too_large', 'Upload exceeds the maximum size'))
          else cb(null, chunk)
        },
      })
      try {
        await pipeline(stream, limiter, fs.createWriteStream(p.file))
        return finish(p)
      } catch (err) {
        fs.rmSync(p.dir, { recursive: true, force: true })
        throw err
      }
    },

    list({ moduleId, pageId } = {}) {
      const where = []
      const args = []
      if (moduleId) (where.push('module_id = ?'), args.push(moduleId))
      if (pageId) (where.push('page_id = ?'), args.push(pageId))
      const sql = `SELECT a.*, EXISTS (SELECT 1 FROM attachment_thumbs t WHERE t.attachment_id = a.id) AS has_thumb
        FROM attachments a ${where.length ? 'WHERE ' + where.map((w) => 'a.' + w).join(' AND ') : ''} ORDER BY a.created_at, a.rowid`
      return db.prepare(sql).all(...args)
    },

    get(id) {
      return q.get.get(id) ?? null
    },

    // Preview image for an attachment: a JPEG made by the browser (the server has no image codecs).
    thumb(id) {
      const row = q.thumbGet.get(id)
      return row ? row.data : null
    },
    setThumb(id, buffer) {
      q.thumbSet.run(id, buffer, now())
    },

    pathOf(id) {
      const row = q.get.get(id)
      return row ? path.join(root, row.id, row.filename) : null
    },

    remove(id) {
      const row = q.get.get(id)
      if (!row) return false
      q.del.run(id)
      removeDir(path.join(root, row.id))
      return true
    },

    removeFor({ moduleId, pageId } = {}) {
      if (!moduleId && !pageId) throw new Error('removeFor requires moduleId or pageId')
      const rows = api.list({ moduleId, pageId })
      for (const row of rows) api.remove(row.id)
      return rows.length
    },

    // Removes directories of the given attachment ids (rows already gone, e.g. via cascade).
    removeFiles(ids) {
      for (const id of ids) removeDir(path.join(root, id))
    },

    // Deletes attachment folders that no attachment row refers to (left behind when a delete could not remove them).
    // Run at startup, before any upload can have a folder without its row yet. Returns the number removed.
    removeOrphans() {
      if (!fs.existsSync(root)) return 0
      const known = new Set(db.prepare('SELECT id FROM attachments').all().map((r) => r.id))
      let removed = 0
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory() && UUID.test(d.name) && !known.has(d.name) && removeDir(path.join(root, d.name))) removed++
      }
      return removed
    },
  }
  return api
}
