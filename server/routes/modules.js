import crypto from 'node:crypto'
import { httpError } from '../http.js'
import { transaction, MODULE_TYPES } from '../db.js'

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

  router.get('/api/templates', () =>
    [...ctx.templates.values()].map(({ type, key, name, description }) => ({ type, key, name, description })))

  router.get('/api/modules', ({ query }) =>
    (query.archived === '1' ? q.listArchived : q.listActive).all().map(rowToModule))

  router.post('/api/modules', ({ body, res }) => {
    const { type, template = 'blank', title, icon } = body ?? {}
    if (!MODULE_TYPES.includes(type)) throw httpError(400, 'invalid_type', `type must be one of ${MODULE_TYPES.join(', ')}`)
    const tpl = ctx.templates.get(`${type}:${template}`)
    if (!tpl) throw httpError(400, 'unknown_template', `No "${template}" template for ${type}`)
    if (title != null && typeof title !== 'string') throw httpError(400, 'invalid_title', 'title must be a string')
    if (icon != null && typeof icon !== 'string') throw httpError(400, 'invalid_icon', 'icon must be a string')

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const created = transaction(db, () => {
      q.insert.run(id, type, title?.trim() || 'Untitled', icon || null, q.maxOrder.get().m + 1, now, now)
      tpl.apply(db, id, rowToModule(q.get.get(id)))
      return rowToModule(q.get.get(id))
    })
    res.statusCode = 201
    return created
  })

  router.get('/api/modules/:id', ({ params }) => rowToModule(load(params.id)))

  router.patch('/api/modules/:id', ({ params, body }) => {
    load(params.id)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'JSON object body required')
    const sets = []
    const args = []
    if ('title' in body) {
      if (typeof body.title !== 'string') throw httpError(400, 'invalid_title', 'title must be a string')
      sets.push('title = ?'), args.push(body.title.trim() || 'Untitled')
    }
    if ('icon' in body) {
      if (body.icon !== null && typeof body.icon !== 'string') throw httpError(400, 'invalid_icon', 'icon must be a string or null')
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
  })

  router.post('/api/modules/:id/archive', ({ params }) => {
    const row = load(params.id)
    const now = new Date().toISOString()
    q.archive.run(row.archived_at || now, now, params.id)
    return rowToModule(q.get.get(params.id))
  })

  router.post('/api/modules/:id/restore', ({ params }) => {
    load(params.id)
    q.archive.run(null, new Date().toISOString(), params.id)
    return rowToModule(q.get.get(params.id))
  })

  router.delete('/api/modules/:id', ({ params }) => {
    load(params.id)
    const ids = q.attachmentIds.all(params.id).map((r) => r.id)
    q.del.run(params.id)
    ctx.attachments.removeFiles(ids)
    return { ok: true }
  })
}
