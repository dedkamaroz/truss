// Converts a module stored in the legacy per-type tables (db_properties/db_rows/db_views,
// worksheets/cells, nb_pages) into the single JSON document the workspace UI edits.
// Read-only against the legacy tables: they are never modified, so they stay usable as a fallback.

const TILES = ['slate', 'clay', 'teal', 'blue', 'violet', 'rose', 'amber', 'green']
const OPT_COLORS = new Set(['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'])
const BLOCK_MAP = {
  paragraph: 'p', heading1: 'h1', heading2: 'h2', heading3: 'h3', bulleted: 'ul', numbered: 'ol', todo: 'todo',
  quote: 'quote', callout: 'callout', code: 'code', divider: 'divider', toggle: 'toggle', table: 'table', image: 'image', file: 'file',
}
const NUMBER_FORMAT = { number: 'number', number_with_commas: 'commas', percent: 'percent', aud: 'currency' }
const ROLLUP_FN = { earliest_date: 'earliest', latest_date: 'latest', show_original: 'show' }
const SHEET_NUMBER_FORMAT = { number: 'number', currency: 'currency', percent: 'percent', date: 'date', text: 'text' }

const parse = (s, fallback) => {
  try {
    const v = JSON.parse(s)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

function colourFor(id, type) {
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const preferred = { database: ['teal', 'blue', 'violet', 'green'], sheet: ['amber', 'green', 'slate'], notebook: ['clay', 'rose', 'slate'] }[type] || TILES
  return preferred[h % preferred.length]
}

/* ---------------------------------------------------------------- rich text */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const stripTags = (s) => String(s).replace(/<[^>]*>/g, '')

function wrap(mark, inner) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)
  return m[2] ? m[1] + mark + m[2] + mark + m[3] : inner
}

/** Legacy sanitised HTML (b, strong, i, em, u, s, code, a, br, span) to the workspace's inline markup. */
export function htmlToMarkup(html) {
  let s = String(html ?? '')
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>\s*<(p|div)[^>]*>/gi, '\n')
  s = s.replace(/<a\b[^>]*?href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
    const h = decodeEntities(href)
    const t = stripTags(text)
    return !t.trim() || decodeEntities(t).trim() === h ? h : `${t} (${h})`
  })
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (m, t) => wrap('`', stripTags(t)))
  s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, t) => wrap('**', t))
  s = s.replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, t) => wrap('~~', t))
  s = s.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, t) => wrap('*', t))
  return decodeEntities(stripTags(s))
}

const plain = (html) => decodeEntities(stripTags(String(html ?? '').replace(/<br\s*\/?>/gi, '\n')))

function convertTable(t) {
  const cols = (t?.columns || []).map((c) => ({ id: String(c.id), name: plain(c.name ?? ''), ...(c.width ? { w: c.width } : {}) }))
  const rows = (t?.rows || []).map((r) => {
    const cells = {}
    for (const c of cols) {
      const v = r.cells?.[c.id]
      if (v != null && v !== '') cells[c.id] = plain(v)
    }
    return { id: String(r.id), cells }
  })
  return { cols: cols.length ? cols : [{ id: 'c1', name: 'Name' }], rows }
}

function convertBlock(b) {
  const type = BLOCK_MAP[b.type] || 'p'
  const props = b.props || {}
  const out = { id: String(b.id || Math.random().toString(36).slice(2, 10)), type, text: '' }
  switch (type) {
    case 'code': out.text = plain(b.html); break
    case 'divider': break
    case 'table': out.table = convertTable(props); break
    case 'image': out.att = props.attachmentId || null; out.name = props.name || 'Image'; break
    case 'file': out.att = props.attachmentId || null; out.name = props.name || 'File'; out.size = props.size || 0; break
    default: out.text = htmlToMarkup(b.html)
  }
  if (type === 'todo') out.checked = !!props.checked
  if (type === 'toggle') { out.open = !!props.open; out.body = htmlToMarkup(props.body || '') }
  if (type === 'callout' && props.icon) out.icon = String(props.icon)
  return out
}

/* ---------------------------------------------------------------- modules */

function baseModule(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title || 'Untitled',
    icon: row.icon || null,
    color: colourFor(row.id, row.type),
    favorite: false,
    archivedAt: row.archived_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortOrder: row.sort_order || 0,
  }
}

function filterKind(type) {
  if (type === 'number' || type === 'rollup') return 'number'
  if (type === 'select' || type === 'status') return 'select'
  if (type === 'multi_select') return 'multi'
  if (type === 'date' || type === 'created_time' || type === 'last_edited_time') return 'date'
  if (type === 'checkbox') return 'checkbox'
  return 'text'
}

function mapOperator(op, kind) {
  const m = {
    contains: kind === 'multi' ? 'has' : 'contains', does_not_contain: kind === 'multi' ? 'has_not' : 'not_contains',
    starts_with: 'starts', is_empty: 'empty', is_not_empty: 'not_empty', neq: 'ne', gte: 'ge', lte: 'le',
    on_or_before: 'on_before', on_or_after: 'on_after',
  }
  return m[op] || op
}

function convertDatabase(db, row, report) {
  const m = baseModule(row)
  m.description = ''
  const propRows = db.prepare('SELECT * FROM db_properties WHERE module_id = ? ORDER BY sort_order').all(row.id)
  const props = propRows.map((p) => {
    const cfg = parse(p.config, {})
    const out = { id: p.id, type: p.type, name: p.name, config: {}, w: p.width || undefined }
    switch (p.type) {
      case 'select': case 'multi_select': case 'status':
        out.config.options = (cfg.options || []).map((o) => ({ id: o.id, name: o.name, color: OPT_COLORS.has(o.color) ? o.color : 'gray', ...(o.group ? { group: o.group } : {}) }))
        break
      case 'number':
        out.config.format = NUMBER_FORMAT[cfg.format] || 'number'
        if (Number.isInteger(cfg.decimals)) out.config.decimals = cfg.decimals
        break
      case 'relation':
        out.config = { targetId: cfg.targetModuleId || null, reversePropId: cfg.twoWay ? cfg.reversePropertyId || null : null }
        break
      case 'rollup':
        out.config = { relationPropId: cfg.relationPropertyId || null, targetPropId: cfg.targetPropertyId || null, fn: ROLLUP_FN[cfg.fn] || cfg.fn || 'count' }
        break
      case 'formula':
        out.config = { expr: cfg.expression || '', format: 'auto' }
        break
      case 'lookup':
        out.config = { sourcePropId: cfg.sourcePropertyId || null, targetId: cfg.targetModuleId || null, matchPropId: cfg.matchPropertyId || null, returnPropId: cfg.returnPropertyId || null }
        break
      case 'list':
        // The synced "list from database" column has no equivalent yet; its last known text is kept.
        out.type = 'text'
        out.config = { legacyListSource: cfg.sourceModuleId || null }
        report.push(`${row.title}: "${p.name}" (list from another database) became a text column holding each row's last known value`)
        break
      default:
        out.config = cfg && typeof cfg === 'object' ? cfg : {}
    }
    if (!out.w) delete out.w
    return out
  })
  if (!props.some((p) => p.type === 'title')) props.unshift({ id: `${row.id}-title`, type: 'title', name: 'Name', config: {} })
  const byId = new Map(props.map((p) => [p.id, p]))
  const legacyType = new Map(propRows.map((p) => [p.id, p.type]))

  m.props = props
  m.rows = db.prepare('SELECT * FROM db_rows WHERE module_id = ? ORDER BY sort_order, created_at').all(row.id).map((r) => {
    const values = parse(r.values, {})
    const cells = {}
    for (const [pid, v] of Object.entries(values)) {
      const p = byId.get(pid)
      if (!p || v == null) continue
      const t = legacyType.get(pid)
      if (t === 'date') cells[pid] = v && typeof v === 'object' ? (v.end ? { start: v.start, end: v.end } : v.start) : v
      else if (t === 'list') cells[pid] = typeof v?.text === 'string' ? v.text : ''
      else if (t === 'checkbox') cells[pid] = !!v
      else cells[pid] = v
    }
    const notes = String(r.notes || '').trim()
    const body = notes ? notes.split(/\n{2,}/).map((para, i) => ({ id: `${r.id}-n${i}`, type: 'p', text: para })) : []
    return { id: r.id, cells, body, createdAt: r.created_at, updatedAt: r.updated_at }
  })

  let dropped = 0
  m.views = db.prepare('SELECT * FROM db_views WHERE module_id = ? ORDER BY sort_order').all(row.id).map((v) => {
    const c = parse(v.config, {})
    const filters = []
    for (const rule of c.filter?.rules || []) {
      if (rule.rules) { dropped++; continue }
      const p = byId.get(rule.property)
      if (!p) continue
      filters.push({ id: `${v.id}-f${filters.length}`, propId: p.id, op: mapOperator(rule.operator, filterKind(legacyType.get(p.id) || p.type)), value: rule.value ?? '' })
    }
    return {
      id: v.id, type: v.type, name: v.name,
      filters, filterMode: c.filter?.op === 'or' ? 'or' : 'and',
      sorts: (c.sorts || []).filter((s) => byId.has(s.property)).map((s, i) => ({ id: `${v.id}-s${i}`, propId: s.property, dir: s.direction === 'desc' ? 'desc' : 'asc' })),
      groupBy: byId.has(c.group_by) ? c.group_by : null,
      hideEmptyGroups: false,
      hidden: (c.hidden || []).filter((id) => byId.has(id)),
      calcs: {},
      dateProp: byId.has(c.date_property) ? c.date_property : null,
      coverProp: c.cover_property && c.cover_property !== 'none' && byId.has(c.cover_property) ? c.cover_property : null,
    }
  })
  if (dropped) report.push(`${row.title}: ${dropped} nested filter group(s) were not carried over`)
  if (!m.views.length) m.views = [{ id: `${row.id}-table`, type: 'table', name: 'Table', filters: [], filterMode: 'and', sorts: [], groupBy: null, hideEmptyGroups: false, hidden: [], calcs: {}, dateProp: null }]
  m.activeViewId = m.views[0].id
  return m
}

function convertSheetFormat(f) {
  if (!f) return null
  const out = {}
  if (f.bold) out.b = true
  if (f.italic) out.i = true
  if (f.align) out.al = f.align
  if (f.fill) out.bg = f.fill
  if (f.color) out.fc = f.color
  const nf = SHEET_NUMBER_FORMAT[f.numberFormat]
  if (nf) {
    out.f = nf
    if (nf === 'number' || nf === 'currency' || nf === 'percent') out.dp = 2
  }
  return Object.keys(out).length ? out : null
}

function convertWorkbook(db, row) {
  const m = baseModule(row)
  const sheets = db.prepare('SELECT * FROM worksheets WHERE module_id = ? ORDER BY sort_order, created_at').all(row.id)
  const cellsQ = db.prepare('SELECT row, col, raw, format FROM cells WHERE sheet_id = ?')
  m.sheets = sheets.map((s) => {
    const cells = {}
    const fmt = {}
    let maxR = 0
    let maxC = 0
    for (const c of cellsQ.all(s.id)) {
      const k = `${c.row},${c.col}`
      if (c.raw != null && c.raw !== '') cells[k] = c.raw
      const f = convertSheetFormat(parse(c.format, null))
      if (f) fmt[k] = f
      maxR = Math.max(maxR, c.row)
      maxC = Math.max(maxC, c.col)
    }
    const colW = {}
    for (const [k, v] of Object.entries(parse(s.col_widths, {}))) colW[k] = v
    const out = { id: s.id, name: s.name, cells, fmt, rowsN: Math.max(60, maxR + 21), colsN: Math.max(14, maxC + 3), colW }
    const rowH = parse(s.row_heights, {})
    if (Object.keys(rowH).length) out.rowH = rowH
    if (s.frozen_rows) out.frozenRows = s.frozen_rows
    if (s.frozen_cols) out.frozenCols = s.frozen_cols
    return out
  })
  if (!m.sheets.length) m.sheets = [{ id: `${row.id}-s1`, name: 'Sheet1', cells: {}, fmt: {}, rowsN: 60, colsN: 14, colW: {} }]
  m.activeSheetId = m.sheets[0].id
  return m
}

function convertNotebook(db, row) {
  const m = baseModule(row)
  const data = parse(row.data, {})
  m.style = data.style === 'table' ? 'table' : 'text'
  m.pages = db.prepare('SELECT * FROM nb_pages WHERE module_id = ? ORDER BY sort_order, created_at').all(row.id).map((p) => {
    const content = parse(p.content, [])
    const page = {
      id: p.id, parentId: p.parent_id || null, title: p.title || '', icon: p.icon || null,
      blocks: [], table: null, favorite: false, archivedAt: p.archived_at || null, createdAt: p.created_at, updatedAt: p.updated_at,
    }
    if (Array.isArray(content)) page.blocks = content.map(convertBlock)
    else if (content && Array.isArray(content.columns)) page.table = convertTable(content)
    if (!page.table && !page.blocks.length) page.blocks = [{ id: `${p.id}-b0`, type: 'p', text: '' }]
    return page
  })
  return m
}

/** Builds the workspace document for one legacy module row. `report` collects anything that could not be carried over exactly. */
export function convertModule(db, row, report = []) {
  if (row.type === 'database') return convertDatabase(db, row, report)
  if (row.type === 'sheet') return convertWorkbook(db, row)
  return convertNotebook(db, row)
}
