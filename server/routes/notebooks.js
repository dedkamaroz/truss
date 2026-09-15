// Notebook pages: nested pages with block (text) or table content, archive/restore/delete and search.
import crypto from 'node:crypto'
import { httpError } from '../http.js'
import { transaction } from '../db.js'

const META_COLS = 'id, module_id, parent_id, title, icon, sort_order, archived_at, created_at, updated_at'
const bid = () => crypto.randomUUID().slice(0, 8)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function defaultTable() {
  const columns = ['Name', 'Notes', 'Status'].map((name, i) => ({ id: bid(), name, width: i === 1 ? 280 : 180 }))
  return { columns, rows: [0, 1, 2].map(() => ({ id: bid(), cells: {} })) }
}

function table(names, rows, widths = []) {
  const columns = names.map((name, i) => ({ id: bid(), name, width: widths[i] || 180 }))
  return { columns, rows: rows.map((r) => ({ id: bid(), cells: Object.fromEntries(columns.map((c, i) => [c.id, r[i] ?? ''])) })) }
}

const block = (type, html = '', props = {}) => ({ id: bid(), type, html, props })

function welcomeBlocks() {
  return [
    block('heading1', 'Welcome to your notebook'),
    block('paragraph', 'Notebooks hold nested pages of notes. Type <code>/</code> on an empty line to insert any kind of block, or use markdown shortcuts such as <code>#</code> followed by a space for a heading.'),
    block('callout', 'Select some text to make it <b>bold</b>, <i>italic</i>, <u>underlined</u>, <s>struck through</s>, <code>inline code</code> or a <a href="https://example.com">link</a>.', { icon: '💡' }),
    block('heading2', 'Lists'),
    block('bulleted', 'Drag the handle to the left of any block to reorder it'),
    block('bulleted', 'Press Enter to split a block and Backspace at the start to merge it'),
    block('numbered', 'Add a subpage from the page tree on the left'),
    block('numbered', 'Drop files anywhere on a page to attach them'),
    block('todo', 'Open this notebook', { checked: true }),
    block('todo', 'Write your first page', { checked: false }),
    block('heading3', 'More blocks'),
    block('quote', 'Simplicity is prerequisite for reliability. - Edsger W. Dijkstra'),
    block('toggle', 'Click the arrow to expand this toggle', { open: false, body: 'Toggles keep details tucked away until you need them.' }),
    block('code', esc("function greet(name) {\n  return `G'day, ${name}!`\n}")),
    block('divider'),
    block('table', '', table(['Task', 'Owner', 'Due'], [
      ['Review onboarding checklist', 'Priya', '14/05/2026'],
      ['Update supplier contacts', 'Liam', '21/05/2026'],
    ], [260, 160, 140])),
    block('paragraph', ''),
  ]
}

// Collects searchable text from any content shape (blocks or tables), ignoring ids and markup.
export function contentText(value, key = '') {
  if (typeof value === 'string') {
    if (key === 'id' || key === 'type' || key === 'attachmentId' || key === 'icon') return ''
    return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  }
  if (Array.isArray(value)) return value.map((v) => contentText(v)).filter(Boolean).join(' ')
  if (value && typeof value === 'object') return Object.entries(value).map(([k, v]) => contentText(v, k)).filter(Boolean).join(' ')
  return ''
}

export default function register(router, ctx) {
  const { db } = ctx
  const now = () => new Date().toISOString()
  const q = {
    module: db.prepare('SELECT * FROM modules WHERE id = ?'),
    list: db.prepare(`SELECT ${META_COLS} FROM nb_pages WHERE module_id = ? ORDER BY sort_order, created_at`),
    get: db.prepare('SELECT * FROM nb_pages WHERE id = ? AND module_id = ?'),
    meta: db.prepare(`SELECT ${META_COLS} FROM nb_pages WHERE id = ?`),
    maxOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM nb_pages WHERE module_id = ? AND parent_id IS ?'),
    insert: db.prepare(`INSERT INTO nb_pages (id, module_id, parent_id, title, icon, sort_order, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    siblings: db.prepare('SELECT id FROM nb_pages WHERE module_id = ? AND parent_id IS ? AND id != ? ORDER BY sort_order, created_at'),
    setOrder: db.prepare('UPDATE nb_pages SET sort_order = ? WHERE id = ?'),
    move: db.prepare('UPDATE nb_pages SET parent_id = ?, updated_at = ? WHERE id = ?'),
    archive: db.prepare('UPDATE nb_pages SET archived_at = ?, updated_at = ? WHERE id = ?'),
    del: db.prepare('DELETE FROM nb_pages WHERE id = ?'),
    subtree: db.prepare(`WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT p.id FROM nb_pages p JOIN t ON p.parent_id = t.id)
      SELECT id FROM t`),
    ancestors: db.prepare(`WITH RECURSIVE a(id, parent_id, archived_at) AS (
        SELECT id, parent_id, archived_at FROM nb_pages WHERE id = ?
        UNION ALL SELECT p.id, p.parent_id, p.archived_at FROM nb_pages p JOIN a ON p.id = a.parent_id)
      SELECT id, archived_at FROM a`),
    searchRows: db.prepare('SELECT id, parent_id, title, icon, archived_at, content FROM nb_pages WHERE module_id = ? ORDER BY sort_order, created_at'),
  }

  const loadModule = (id) => {
    const m = q.module.get(id)
    if (!m || m.type !== 'notebook') throw httpError(404, 'module_not_found', 'Notebook not found')
    let data = {}
    try { data = JSON.parse(m.data) } catch {}
    return { ...m, data }
  }
  const loadPage = (moduleId, pageId) => {
    const row = q.get.get(pageId, moduleId)
    if (!row) throw httpError(404, 'page_not_found', 'Page not found')
    return row
  }
  const toPage = (row) => {
    const { content, ...rest } = row
    let parsed = []
    try { parsed = JSON.parse(content) } catch {}
    return { ...rest, content: parsed }
  }
  const checkContent = (c) => {
    if (c === null || typeof c !== 'object') throw httpError(400, 'invalid_content', 'content must be an array of blocks or a table object')
    return JSON.stringify(c)
  }
  const checkTitle = (t) => {
    if (typeof t !== 'string') throw httpError(400, 'invalid_title', 'title must be a string')
    return t.trim().slice(0, 500)
  }
  const checkIcon = (i) => {
    if (i !== null && typeof i !== 'string') throw httpError(400, 'invalid_icon', 'icon must be a string or null')
    return i || null
  }
  const checkParent = (moduleId, parentId) => {
    if (parentId == null) return null
    if (typeof parentId !== 'string' || !q.get.get(parentId, moduleId)) throw httpError(400, 'invalid_parent', 'parent_id must be a page in this notebook')
    return parentId
  }

  function insertPage(moduleId, { parentId = null, title = '', icon = null, content }) {
    const id = crypto.randomUUID()
    const ts = now()
    q.insert.run(id, moduleId, parentId, title, icon, q.maxOrder.get(moduleId, parentId).m + 1, JSON.stringify(content), ts, ts)
    return id
  }

  ctx.registerTemplate('notebook', 'text', {
    name: 'Text notebook',
    description: 'Nested pages with a rich block editor and a welcome page.',
    apply(tdb, moduleId, module) {
      tdb.prepare('UPDATE modules SET data = ? WHERE id = ?').run(JSON.stringify({ ...(module?.data || {}), style: 'text' }), moduleId)
      const welcome = insertPage(moduleId, { title: 'Welcome', icon: '👋', content: welcomeBlocks() })
      insertPage(moduleId, { parentId: welcome, title: 'Meeting notes', icon: '📝', content: [
        block('heading2', 'Weekly catch-up'),
        block('paragraph', 'Held on 12/05/2026 at 10:00 am AEST.'),
        block('bulleted', 'Agreed to review the onboarding checklist'),
        block('todo', 'Circulate the minutes', { checked: false }),
      ] })
    },
  })

  ctx.registerTemplate('notebook', 'table', {
    name: 'Table notebook',
    description: 'Every page is a full-page table, with a sample register.',
    apply(tdb, moduleId, module) {
      tdb.prepare('UPDATE modules SET data = ? WHERE id = ?').run(JSON.stringify({ ...(module?.data || {}), style: 'table' }), moduleId)
      insertPage(moduleId, { title: 'Supplier register', icon: '📋', content: table(
        ['Supplier', 'Contact', 'Phone', 'Next review', 'Notes'],
        [
          ['Harbour Office Supplies', 'Mia Nguyen', '+61 412 345 678', '14/05/2026', 'Stationery and printer paper'],
          ['Southern Cross IT', 'Jack Thompson', '+61 423 456 789', '02/06/2026', 'Laptop leases, renew in June'],
          ['Wattle Catering', 'Olivia Brown', '+61 434 567 890', '30/06/2026', 'Quarterly team lunches'],
        ],
        [200, 150, 150, 120, 200],
      ) })
    },
  })

  const base = '/api/notebooks/:moduleId'

  router.get(`${base}/pages`, ({ params }) => {
    loadModule(params.moduleId)
    return q.list.all(params.moduleId)
  })

  router.post(`${base}/pages`, ({ params, body, res }) => {
    const m = loadModule(params.moduleId)
    body ??= {}
    if (typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'JSON object body required')
    const parentId = checkParent(m.id, body.parent_id)
    const title = body.title == null ? '' : checkTitle(body.title)
    const icon = body.icon == null ? null : checkIcon(body.icon)
    let content = m.data.style === 'table' ? defaultTable() : []
    if (body.content != null) content = JSON.parse(checkContent(body.content))
    const id = transaction(db, () => insertPage(m.id, { parentId, title, icon, content }))
    res.statusCode = 201
    return toPage(q.get.get(id, m.id))
  })

  router.get(`${base}/pages/:pageId`, ({ params }) => {
    loadModule(params.moduleId)
    return toPage(loadPage(params.moduleId, params.pageId))
  })

  router.patch(`${base}/pages/:pageId`, ({ params, body }) => {
    loadModule(params.moduleId)
    loadPage(params.moduleId, params.pageId)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'JSON object body required')
    const sets = []
    const args = []
    if ('title' in body) sets.push('title = ?'), args.push(checkTitle(body.title))
    if ('icon' in body) sets.push('icon = ?'), args.push(checkIcon(body.icon))
    if ('content' in body) sets.push('content = ?'), args.push(checkContent(body.content))
    if (sets.length) {
      sets.push('updated_at = ?'), args.push(now())
      db.prepare(`UPDATE nb_pages SET ${sets.join(', ')} WHERE id = ?`).run(...args, params.pageId)
    }
    return q.meta.get(params.pageId)
  })

  // Body { parent_id: string|null, before_id: string|null }: re-parents and places before a sibling (null = last).
  router.post(`${base}/pages/:pageId/move`, ({ params, body }) => {
    loadModule(params.moduleId)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'invalid_body', 'JSON object body required')
    const page = loadPage(params.moduleId, params.pageId)
    const parentId = checkParent(page.module_id, body.parent_id)
    if (parentId && q.subtree.all(page.id).some((r) => r.id === parentId)) {
      throw httpError(400, 'invalid_parent', 'A page cannot be moved inside itself')
    }
    transaction(db, () => {
      const ids = q.siblings.all(page.module_id, parentId, page.id).map((r) => r.id)
      let at = body.before_id == null ? ids.length : ids.indexOf(body.before_id)
      if (at < 0) throw httpError(400, 'invalid_before', 'before_id must be a sibling under the new parent')
      ids.splice(at, 0, page.id)
      if (page.parent_id !== parentId) q.move.run(parentId, now(), page.id)
      ids.forEach((id, i) => q.setOrder.run(i + 1, id))
    })
    return q.meta.get(page.id)
  })

  router.post(`${base}/pages/:pageId/archive`, ({ params }) => {
    loadModule(params.moduleId)
    const page = loadPage(params.moduleId, params.pageId)
    q.archive.run(page.archived_at || now(), now(), page.id)
    return q.meta.get(page.id)
  })

  // Restoring a page whose ancestor is still archived moves it to the top level so it becomes visible.
  router.post(`${base}/pages/:pageId/restore`, ({ params }) => {
    loadModule(params.moduleId)
    const page = loadPage(params.moduleId, params.pageId)
    transaction(db, () => {
      q.archive.run(null, now(), page.id)
      const hidden = q.ancestors.all(page.id).some((a) => a.id !== page.id && a.archived_at)
      if (hidden) {
        q.move.run(null, now(), page.id)
        q.setOrder.run(q.maxOrder.get(page.module_id, null).m + 1, page.id)
      }
    })
    return q.meta.get(page.id)
  })

  router.delete(`${base}/pages/:pageId`, ({ params }) => {
    loadModule(params.moduleId)
    const page = loadPage(params.moduleId, params.pageId)
    const ids = q.subtree.all(page.id).map((r) => r.id)
    let attachments = 0
    for (const id of ids) attachments += ctx.attachments.removeFor({ moduleId: page.module_id, pageId: id })
    q.del.run(page.id) // subpages cascade via parent_id
    return { ok: true, deleted: ids, attachmentsRemoved: attachments }
  })

  // ponytail: scans every page's JSON per query; add an FTS table if notebooks grow past a few thousand pages.
  router.get(`${base}/search`, ({ params, query }) => {
    loadModule(params.moduleId)
    const needle = String(query.q || '').trim().toLowerCase()
    if (!needle) return []
    const out = []
    for (const row of q.searchRows.iterate(params.moduleId)) {
      const { content, ...meta } = row
      const inTitle = row.title.toLowerCase().includes(needle)
      let text = ''
      try { text = contentText(JSON.parse(content)).replace(/\s+/g, ' ') } catch {}
      const at = text.toLowerCase().indexOf(needle)
      if (!inTitle && at < 0) continue
      const snippet = at < 0 ? '' : (at > 40 ? '...' : '') + text.slice(Math.max(0, at - 40), at + needle.length + 60) + (at + needle.length + 60 < text.length ? '...' : '')
      out.push({ ...meta, match: inTitle ? 'title' : 'content', snippet })
      if (out.length >= 50) break
    }
    return out
  })
}
