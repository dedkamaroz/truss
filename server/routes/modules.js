import crypto from 'node:crypto'
import { httpError } from '../http.js'
import { transaction, MODULE_TYPES } from '../db.js'
import { hiddenTitle, isAdmin } from '../access.js'

// An emoji (ZWJ sequences included) or an icon name; long text would break the sidebar and header layout.
export const MAX_ICON = 32
export const MAX_TITLE = 500

/**
 * Module titles are unique (case-insensitive) so the sidebar and [Workbook]Sheet!A1 references are unambiguous.
 * Returns base, or "base 2", "base 3", ... Call inside the write transaction.
 */
export function uniqueTitle(db, base, exceptId = null) {
  const taken = new Set(db.prepare('SELECT title FROM modules WHERE id IS NOT ?').all(exceptId).map((r) => r.title.toLowerCase()))
  let title = base
  for (let n = 2; taken.has(title.toLowerCase()); n++) title = `${base} ${n}`
  return title
}

export function rowToModule(row) {
  if (!row) return null
  let data
  try {
    data = JSON.parse(row.data)
  } catch {
    data = {}
  }
  return { ...row, data }
}

export default function register(router, ctx) {
  const { db } = ctx
  const q = {
    get: db.prepare('SELECT * FROM modules WHERE id = ?'),
    listActive: db.prepare('SELECT * FROM modules WHERE archived_at IS NULL ORDER BY sort_order, created_at'),
    listArchived: db.prepare('SELECT * FROM modules WHERE archived_at IS NOT NULL ORDER BY sort_order, created_at'),
    maxOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM modules'),
    insert: db.prepare(`INSERT INTO modules (id, type, title, icon, sort_order, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`),
    archive: db.prepare('UPDATE modules SET archived_at = ?, updated_at = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM modules WHERE id = ?'),
    attachmentIds: db.prepare('SELECT id FROM attachments WHERE module_id = ?'),
  }

  const load = (id) => {
    const row = q.get.get(id)
    if (!row) throw httpError(404, 'module_not_found', 'Module not found')
    return row
  }

  // The admin/non-admin split for the hidden-database feature. Non-admins are
  // refused everything that would reveal or change a hidden module; the same
  // 404 a missing module gets hides its existence.
  const denyHidden = (req, row) => {
    if (!isAdmin(req, ctx.hosted) && hiddenTitle(row?.title)) throw httpError(404, 'module_not_found', 'Module not found')
  }

  router.get('/api/templates', () =>
    [...ctx.templates.values()].map(({ type, key, name, description }) => ({ type, key, name, description })))

  router.get('/api/modules', ({ req, query }) =>
    (query.archived === '1' ? q.listArchived : q.listActive).all()
      .filter((row) => isAdmin(req, ctx.hosted) || !hiddenTitle(row.title))
      .map(rowToModule))

  router.post('/api/modules', ({ req, body, res }) => {
    const { type, template = 'blank', title, icon } = body ?? {}
    if (!MODULE_TYPES.includes(type)) throw httpError(400, 'invalid_type', `type must be one of ${MODULE_TYPES.join(', ')}`)
    const tpl = ctx.templates.get(`${type}:${template}`)
    if (!tpl) throw httpError(400, 'unknown_template', `No "${template}" template for ${type}`)
    if (title != null && (typeof title !== 'string' || title.length > MAX_TITLE)) throw httpError(400, 'invalid_title', `title must be a string of at most ${MAX_TITLE} characters`)
    if (!isAdmin(req, ctx.hosted) && hiddenTitle(title)) throw httpError(403, 'hidden_module', 'You do not have access to this module')
    if (icon != null && (typeof icon !== 'string' || icon.length > MAX_ICON)) throw httpError(400, 'invalid_icon', `icon must be a string of at most ${MAX_ICON} characters`)

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const created = transaction(db, () => {
      q.insert.run(id, type, uniqueTitle(db, title?.trim() || 'Untitled'), icon || null, q.maxOrder.get().m + 1, now, now)
      tpl.apply(db, id, rowToModule(q.get.get(id)))
      return rowToModule(q.get.get(id))
    })
    res.statusCode = 201
    return created
  })

  router.get('/api/modules/:id', ({ req, params }) => {
    const row = load(params.id)
    denyHidden(req, row)
    return rowToModule(row)
  })

  router.patch('/api/modules/:id', ({ req, params, body }) => transaction(db, () => {
    const current = load(params.id)
    denyHidden(req, current)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'JSON object body required')
    // A rename is the one way an existing module can become hidden, so the new
    // title is checked too.
    if (!isAdmin(req, ctx.hosted) && 'title' in body && hiddenTitle(body.title)) throw httpError(403, 'hidden_module', 'You do not have access to this module')
    const sets = []
    const args = []
    if ('title' in body) {
      if (typeof body.title !== 'string' || body.title.length > MAX_TITLE) throw httpError(400, 'invalid_title', `title must be a string of at most ${MAX_TITLE} characters`)
      const wanted = body.title.trim() || 'Untitled'
      // Resaving the current title keeps it, even if it duplicates a title saved before uniqueness was enforced.
      sets.push('title = ?'), args.push(wanted === current.title ? wanted : uniqueTitle(db, wanted, params.id))
    }
    if ('icon' in body) {
      if (body.icon !== null && (typeof body.icon !== 'string' || body.icon.length > MAX_ICON)) throw httpError(400, 'invalid_icon', `icon must be null or a string of at most ${MAX_ICON} characters`)
      sets.push('icon = ?'), args.push(body.icon || null)
    }
    if ('sort_order' in body) {
      if (typeof body.sort_order !== 'number' || !Number.isFinite(body.sort_order)) throw httpError(400, 'invalid_sort_order', 'sort_order must be a number')
      sets.push('sort_order = ?'), args.push(body.sort_order)
    }
    if ('data' in body) {
      if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw httpError(400, 'invalid_data', 'data must be an object')
      sets.push('data = ?'), args.push(JSON.stringify(body.data))
    }
    if (sets.length) {
      sets.push('updated_at = ?'), args.push(new Date().toISOString())
      db.prepare(`UPDATE modules SET ${sets.join(', ')} WHERE id = ?`).run(...args, params.id)
    }
    return rowToModule(q.get.get(params.id))
  }))

  router.post('/api/modules/:id/archive', ({ req, params }) => {
    const row = load(params.id)
    denyHidden(req, row)
    const now = new Date().toISOString()
    q.archive.run(row.archived_at || now, now, params.id)
    return rowToModule(q.get.get(params.id))
  })

  router.post('/api/modules/:id/restore', ({ req, params }) => {
    denyHidden(req, load(params.id))
    q.archive.run(null, new Date().toISOString(), params.id)
    return rowToModule(q.get.get(params.id))
  })

  router.delete('/api/modules/:id', ({ req, params }) => {
    denyHidden(req, load(params.id))
    const ids = q.attachmentIds.all(params.id).map((r) => r.id)
    transaction(db, () => {
      for (const fn of ctx.moduleDeleteHooks) fn(params.id)
      q.del.run(params.id)
    })
    ctx.attachments.removeFiles(ids)
    return { ok: true }
  })
}
