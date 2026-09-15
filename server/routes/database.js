// Database content type: properties, rows, views, value validation, type conversion, relations and templates.

import crypto from 'node:crypto'
import { httpError } from '../http.js'
import { transaction } from '../db.js'

export const VIEW_TYPES = ['table', 'board', 'list', 'gallery', 'calendar']
export const OPTION_COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']
export const NUMBER_FORMATS = ['number', 'number_with_commas', 'percent', 'aud']
export const ROLLUP_FNS = ['count', 'count_values', 'count_unique', 'sum', 'average', 'min', 'max', 'median', 'range',
  'percent_checked', 'percent_empty', 'earliest_date', 'latest_date', 'show_original']
const OPTION_TYPES = new Set(['select', 'multi_select', 'status'])
const STRING_TYPES = new Set(['title', 'text', 'url', 'email', 'phone'])
const READ_ONLY = new Set(['created_time', 'last_edited_time', 'rollup', 'formula'])
const MAX_TEXT = 100_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

const bad = (code, message) => httpError(400, code, message)
const uuid = () => crypto.randomUUID()
const now = () => new Date().toISOString()
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v)

export function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v ?? fallback
  } catch {
    return fallback
  }
}

function validIsoDate(s) {
  const m = typeof s === 'string' && ISO_DATE.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

/* ------------------------------------------------------------------ per-type value rules */

const existingIdsStmt = new WeakMap() // db -> statement
function existingRowIds(db, moduleId, ids) {
  if (!existingIdsStmt.has(db)) existingIdsStmt.set(db, db.prepare('SELECT id FROM db_rows WHERE module_id = ? AND id IN (SELECT value FROM json_each(?))'))
  return new Set(existingIdsStmt.get(db).all(moduleId, JSON.stringify(ids)).map((r) => r.id))
}

// Each entry: validate(value, prop, ctx) -> normalised value, or undefined for "empty". Throws 400 when invalid.
// New property types add one entry here (and one in web/modules/database/types.js).
export const VALUE_TYPES = {
  title: { validate: validString },
  text: { validate: validString },
  url: {
    validate(v, prop) {
      const s = validString(v, prop)
      if (s === undefined) return undefined
      if (/\s/.test(s)) throw bad('invalid_value', `"${prop.name}" must be a URL without spaces`)
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)
      if (scheme && !['http', 'https', 'mailto'].includes(scheme[1].toLowerCase()) && !/^[a-z0-9.-]+:\d+/i.test(s)) {
        throw bad('invalid_value', `"${prop.name}" must be an http(s) URL`)
      }
      return s
    },
  },
  email: {
    validate(v, prop) {
      const s = validString(v, prop)
      if (s !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('invalid_value', `"${prop.name}" must be an email address`)
      return s
    },
  },
  phone: {
    validate(v, prop) {
      const s = validString(v, prop)
      if (s !== undefined && (!/^[+\d\s().-]{3,40}$/.test(s) || (s.match(/\d/g) || []).length < 3)) {
        throw bad('invalid_value', `"${prop.name}" must be a phone number`)
      }
      return s
    },
  },
  number: {
    validate(v, prop) {
      if (v == null || v === '') return undefined
      if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('invalid_value', `"${prop.name}" must be a number`)
      return v
    },
  },
  checkbox: {
    validate(v, prop) {
      if (v == null) return undefined
      if (typeof v !== 'boolean') throw bad('invalid_value', `"${prop.name}" must be true or false`)
      return v || undefined
    },
  },
  select: { validate: validOption },
  status: { validate: validOption },
  multi_select: {
    validate(v, prop) {
      if (v == null) return undefined
      if (!Array.isArray(v)) throw bad('invalid_value', `"${prop.name}" must be an array of option ids`)
      const ids = new Set(prop.config.options?.map((o) => o.id))
      const out = [...new Set(v)]
      for (const id of out) if (!ids.has(id)) throw bad('invalid_option', `Unknown option for "${prop.name}"`)
      return out.length ? out : undefined
    },
  },
  date: {
    validate(v, prop) {
      if (v == null || v === '') return undefined
      if (typeof v === 'string') v = { start: v }
      if (!isObj(v) || !validIsoDate(v.start)) throw bad('invalid_value', `"${prop.name}" must be a date { start: "YYYY-MM-DD", end? }`)
      if (v.end == null || v.end === '') return { start: v.start }
      if (!validIsoDate(v.end) || v.end < v.start) throw bad('invalid_value', `"${prop.name}" end date must be a date on or after the start`)
      return { start: v.start, end: v.end }
    },
  },
  files: {
    validate(v, prop, ctx) {
      if (v == null) return undefined
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('invalid_value', `"${prop.name}" must be an array of attachment ids`)
      const out = [...new Set(v)]
      for (const id of out) {
        const a = ctx.attachments.get(id)
        if (!a || a.module_id !== prop.module_id) throw bad('invalid_attachment', `Unknown attachment for "${prop.name}"`)
      }
      return out.length ? out : undefined
    },
  },
  // Array of row ids in the target database. Ids that no longer exist are dropped silently.
  relation: {
    validate(v, prop, ctx) {
      if (v == null) return undefined
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('invalid_value', `"${prop.name}" must be an array of row ids`)
      const ids = [...new Set(v)]
      if (!ids.length) return undefined
      const target = prop.config.targetModuleId
      if (!target) throw bad('invalid_value', `"${prop.name}" is not linked to a database yet`)
      const existing = existingRowIds(ctx.db, target, ids)
      const out = ids.filter((id) => existing.has(id))
      return out.length ? out : undefined
    },
  },
  rollup: { readOnly: true },
  formula: { readOnly: true },
  created_time: { readOnly: true },
  last_edited_time: { readOnly: true },
}

function validString(v, prop) {
  if (v == null || v === '') return undefined
  if (typeof v !== 'string') throw bad('invalid_value', `"${prop.name}" must be text`)
  if (v.length > MAX_TEXT) throw bad('invalid_value', `"${prop.name}" is too long`)
  return v
}

function validOption(v, prop) {
  if (v == null || v === '') return undefined
  if (typeof v !== 'string' || !prop.config.options?.some((o) => o.id === v)) throw bad('invalid_option', `Unknown option for "${prop.name}"`)
  return v
}

/* ------------------------------------------------------------------ config */

const DEFAULT_STATUS = () => [
  { id: uuid(), name: 'Not started', color: 'gray', group: 'todo' },
  { id: uuid(), name: 'In progress', color: 'blue', group: 'in_progress' },
  { id: uuid(), name: 'Done', color: 'green', group: 'complete' },
]

const optId = (v) => (v == null || v === '' ? null : typeof v === 'string' ? v : undefined)

function normaliseConfig(type, config, prev = {}) {
  if (config != null && !isObj(config)) throw bad('invalid_config', 'config must be an object')
  // Computed and relation configs merge partial patches; other types replace the config whole.
  const merge = type === 'relation' || type === 'rollup' || type === 'formula'
  const c = merge ? { ...prev, ...config } : { ...(config ?? prev) }
  if (OPTION_TYPES.has(type)) {
    if (c.options == null) c.options = type === 'status' ? DEFAULT_STATUS() : []
    if (!Array.isArray(c.options)) throw bad('invalid_config', 'options must be an array')
    const seen = new Set()
    c.options = c.options.map((o, i) => {
      if (!isObj(o) || typeof o.name !== 'string' || !o.name.trim()) throw bad('invalid_config', 'each option needs a name')
      const id = typeof o.id === 'string' && o.id ? o.id : uuid()
      if (seen.has(id)) throw bad('invalid_config', 'duplicate option id')
      seen.add(id)
      const color = OPTION_COLORS.includes(o.color) ? o.color : OPTION_COLORS[(i % (OPTION_COLORS.length - 1)) + 1]
      const opt = { id, name: o.name.trim().slice(0, 200), color }
      if (type === 'status') opt.group = ['todo', 'in_progress', 'complete'].includes(o.group) ? o.group : 'todo'
      return opt
    })
  }
  if (type === 'number') {
    if (c.format == null) c.format = 'number'
    if (!NUMBER_FORMATS.includes(c.format)) throw bad('invalid_config', `format must be one of ${NUMBER_FORMATS.join(', ')}`)
    if (c.decimals != null && (!Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 6)) throw bad('invalid_config', 'decimals must be 0 to 6')
  }
  if (type === 'relation') {
    // targetModuleId and twoWay are checked by the relation logic; reversePropertyId is managed by the server.
    const target = optId(c.targetModuleId)
    if (target === undefined) throw bad('invalid_config', 'targetModuleId must be a database id')
    return { targetModuleId: target, twoWay: c.twoWay === true, reversePropertyId: optId(prev.reversePropertyId) ?? null }
  }
  if (type === 'rollup') {
    const out = { relationPropertyId: optId(c.relationPropertyId), targetPropertyId: optId(c.targetPropertyId), fn: c.fn ?? 'count' }
    if (out.relationPropertyId === undefined || out.targetPropertyId === undefined) throw bad('invalid_config', 'relationPropertyId and targetPropertyId must be property ids')
    if (!ROLLUP_FNS.includes(out.fn)) throw bad('invalid_config', `fn must be one of ${ROLLUP_FNS.join(', ')}`)
    return out
  }
  if (type === 'formula') {
    const expression = c.expression ?? ''
    if (typeof expression !== 'string' || expression.length > 10_000) throw bad('invalid_config', 'expression must be text up to 10,000 characters')
    return { expression }
  }
  return c
}

/* ------------------------------------------------------------------ type conversion */

const pad = (n) => String(n).padStart(2, '0')
const fmtDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')

function valueToText(type, v, config, ctx) {
  if (v == null) return ''
  switch (type) {
    case 'number': return String(v)
    case 'checkbox': return v ? 'Yes' : ''
    case 'select':
    case 'status': return config.options?.find((o) => o.id === v)?.name ?? ''
    case 'multi_select': return v.map((id) => config.options?.find((o) => o.id === id)?.name).filter(Boolean).join(', ')
    case 'date': return v.end ? `${fmtDate(v.start)} - ${fmtDate(v.end)}` : fmtDate(v.start)
    case 'files': return v.map((id) => ctx.attachments.get(id)?.filename).filter(Boolean).join(', ')
    default: return typeof v === 'string' ? v : ''
  }
}

function parseDateText(s) {
  s = s.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m && validIsoDate(`${m[1]}-${m[2]}-${m[3]}`)) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s)
  if (m) {
    const iso = `${m[3]}-${pad(m[2])}-${pad(m[1])}`
    if (validIsoDate(iso)) return iso
  }
  return null
}

function findOrAddOption(config, name) {
  const n = name.trim()
  if (!n) return undefined
  let opt = config.options.find((o) => o.name.toLowerCase() === n.toLowerCase())
  if (!opt) {
    opt = { id: uuid(), name: n.slice(0, 200), color: OPTION_COLORS[(config.options.length % (OPTION_COLORS.length - 1)) + 1] }
    if (config.options.every((o) => 'group' in o) && config.options.length) opt.group = 'todo'
    config.options.push(opt)
  }
  return opt.id
}

// Converts one value between property types. newConfig may gain options (select targets).
function convertValue(from, to, v, oldConfig, newConfig, ctx) {
  if (v == null) return undefined
  if (from === to) return v
  if (from === 'relation' || to === 'relation') return undefined // row ids have no meaning in other types
  if (OPTION_TYPES.has(from) && OPTION_TYPES.has(to)) {
    const ids = (Array.isArray(v) ? v : [v]).filter((id) => newConfig.options.some((o) => o.id === id))
    if (to === 'multi_select') return ids.length ? ids : undefined
    return ids[0]
  }
  if (to === 'files' || READ_ONLY.has(to)) return undefined
  if (to === 'checkbox') {
    if (from === 'number') return v !== 0 || undefined
    return /^(true|yes|y|1|x|checked|done)$/i.test(valueToText(from, v, oldConfig, ctx).trim()) || undefined
  }
  if (to === 'number') {
    if (from === 'checkbox') return v ? 1 : 0
    const s = valueToText(from, v, oldConfig, ctx).trim().replace(/[$,\s]/g, '').replace(/%$/, '')
    return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : undefined
  }
  if (to === 'date') {
    if (from === 'created_time' || from === 'last_edited_time') return undefined
    const iso = parseDateText(valueToText(from, v, oldConfig, ctx))
    return iso ? { start: iso } : undefined
  }
  const text = valueToText(from, v, oldConfig, ctx)
  if (OPTION_TYPES.has(to)) {
    if (to === 'multi_select') {
      const ids = [...new Set(text.split(',').map((p) => findOrAddOption(newConfig, p)).filter(Boolean))]
      return ids.length ? ids : undefined
    }
    return findOrAddOption(newConfig, text)
  }
  if (STRING_TYPES.has(to)) {
    try {
      return VALUE_TYPES[to].validate(text, { name: '', config: newConfig })
    } catch {
      return undefined // e.g. "hello" cannot become an email
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ service (shared by routes and import) */

const services = new WeakMap() // ctx -> service

export function databaseService(ctx) {
  if (!services.has(ctx)) services.set(ctx, createService(ctx))
  return services.get(ctx)
}

function createService(ctx) {
  const { db } = ctx
  const q = {
    module: db.prepare('SELECT * FROM modules WHERE id = ?'),
    props: db.prepare('SELECT * FROM db_properties WHERE module_id = ? ORDER BY sort_order, rowid'),
    prop: db.prepare('SELECT * FROM db_properties WHERE id = ? AND module_id = ?'),
    propAny: db.prepare('SELECT * FROM db_properties WHERE id = ?'),
    relationsTo: db.prepare("SELECT * FROM db_properties WHERE type = 'relation' AND json_extract(config, '$.targetModuleId') = ?"),
    insertProp: db.prepare('INSERT INTO db_properties (id, module_id, name, type, config, sort_order, width) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    setPropConfig: db.prepare('UPDATE db_properties SET config = ? WHERE id = ?'),
    maxPropOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM db_properties WHERE module_id = ?'),
    deleteProp: db.prepare('DELETE FROM db_properties WHERE id = ?'),
    rows: db.prepare('SELECT * FROM db_rows WHERE module_id = ? ORDER BY sort_order, rowid'),
    rowsWithKey: db.prepare(`SELECT id, "values" FROM db_rows WHERE module_id = ? AND json_type("values", '$."' || ? || '"') IS NOT NULL`),
    row: db.prepare('SELECT * FROM db_rows WHERE id = ? AND module_id = ?'),
    insertRow: db.prepare('INSERT INTO db_rows (id, module_id, sort_order, "values", notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    updateRow: db.prepare('UPDATE db_rows SET "values" = ?, notes = ?, sort_order = ?, updated_at = ? WHERE id = ?'),
    setRowValues: db.prepare('UPDATE db_rows SET "values" = ? WHERE id = ?'),
    touchRowValues: db.prepare('UPDATE db_rows SET "values" = ?, updated_at = ? WHERE id = ?'),
    maxRowOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM db_rows WHERE module_id = ?'),
    deleteRow: db.prepare('DELETE FROM db_rows WHERE id = ?'),
    views: db.prepare('SELECT * FROM db_views WHERE module_id = ? ORDER BY sort_order, rowid'),
    view: db.prepare('SELECT * FROM db_views WHERE id = ? AND module_id = ?'),
    insertView: db.prepare('INSERT INTO db_views (id, module_id, name, type, sort_order, config) VALUES (?, ?, ?, ?, ?, ?)'),
    maxViewOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM db_views WHERE module_id = ?'),
    deleteView: db.prepare('DELETE FROM db_views WHERE id = ?'),
    countViews: db.prepare('SELECT COUNT(*) AS n FROM db_views WHERE module_id = ?'),
    stampRows: db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS u, TOTAL(sort_order) AS s FROM db_rows WHERE module_id = ?'),
    stampProps: db.prepare("SELECT group_concat(id || ':' || name || ':' || type || ':' || config || ':' || sort_order, '|') AS p FROM db_properties WHERE module_id = ?"),
  }

  const propOut = (r) => ({ ...r, config: parseJson(r.config, {}) })
  const rowOut = (r) => ({ id: r.id, module_id: r.module_id, sort_order: r.sort_order, values: parseJson(r.values, {}), notes: r.notes, created_at: r.created_at, updated_at: r.updated_at })
  const viewOut = (r) => ({ ...r, config: parseJson(r.config, {}) })

  function loadModule(id) {
    const m = q.module.get(id)
    if (!m) throw httpError(404, 'module_not_found', 'Module not found')
    if (m.type !== 'database') throw bad('not_a_database', 'Module is not a database')
    return m
  }
  const loadProp = (moduleId, id) => {
    const r = q.prop.get(id, moduleId)
    if (!r) throw httpError(404, 'property_not_found', 'Property not found')
    return propOut(r)
  }
  const loadRow = (moduleId, id) => {
    const r = q.row.get(id, moduleId)
    if (!r) throw httpError(404, 'row_not_found', 'Row not found')
    return rowOut(r)
  }
  const loadView = (moduleId, id) => {
    const r = q.view.get(id, moduleId)
    if (!r) throw httpError(404, 'view_not_found', 'View not found')
    return viewOut(r)
  }
  const nameOf = (v, fallback) => {
    if (v == null) return fallback
    if (typeof v !== 'string') throw bad('invalid_name', 'name must be a string')
    return v.trim().slice(0, 200) || fallback
  }

  function uniqueName(moduleId, base) {
    const props = q.props.all(moduleId)
    let name = base.slice(0, 200)
    for (let i = 2; props.some((p) => p.name === name); i++) name = `${base.slice(0, 190)} ${i}`
    return name
  }

  /* ---- relations */

  function checkTarget(targetModuleId) {
    if (!targetModuleId) return
    const m = q.module.get(targetModuleId)
    if (!m || m.type !== 'database') throw bad('invalid_config', 'targetModuleId must be an existing database')
  }

  /** Creates the reverse property for relation prop (a propOut) and links both. Backfills reverse values from prop's values. */
  function createReverse(prop, { name } = {}) {
    const target = prop.config.targetModuleId
    const source = q.module.get(prop.module_id)
    const id = uuid()
    const base = name || (target === prop.module_id ? `Related to ${prop.name}` : source?.title || 'Related')
    const config = { targetModuleId: prop.module_id, twoWay: true, reversePropertyId: prop.id }
    q.insertProp.run(id, target, uniqueName(target, base), 'relation', JSON.stringify(config), q.maxPropOrder.get(target).m + 1, 200)
    q.setPropConfig.run(JSON.stringify({ ...prop.config, twoWay: true, reversePropertyId: id }), prop.id)
    const ts = now()
    const reverse = propOut(q.propAny.get(id))
    for (const r of q.rowsWithKey.all(prop.module_id, prop.id)) {
      const ids = parseJson(r.values, {})[prop.id]
      if (Array.isArray(ids)) linkReverse(reverse, r.id, ids, [], ts)
    }
    return id
  }

  /** Removes a property's values from every row and deletes it. */
  function dropProperty(prop) {
    for (const r of q.rowsWithKey.all(prop.module_id, prop.id)) {
      const values = parseJson(r.values, {})
      delete values[prop.id]
      q.setRowValues.run(JSON.stringify(values), r.id)
    }
    q.deleteProp.run(prop.id)
  }

  /** The linked reverse property of a two-way relation, if it still points back. */
  function reverseOf(prop) {
    const id = prop.config?.reversePropertyId
    if (prop.type !== 'relation' || !prop.config.twoWay || !id) return null
    const r = q.propAny.get(id)
    if (!r || r.type !== 'relation') return null
    const rev = propOut(r)
    return rev.config.reversePropertyId === prop.id ? rev : null
  }

  /** Edits one relation value in place (no further sync). fn(ids) -> new ids, or null for no change. */
  function editRelation(moduleId, rowId, propId, fn, ts) {
    const r = q.row.get(rowId, moduleId)
    if (!r) return
    const values = parseJson(r.values, {})
    const cur = Array.isArray(values[propId]) ? values[propId] : []
    const next = fn(cur)
    if (!next) return
    if (next.length) values[propId] = next
    else delete values[propId]
    q.touchRowValues.run(JSON.stringify(values), ts, rowId)
  }

  /** For relation prop in row sourceRowId: added/removed target ids get sourceRowId added to/removed from the reverse. */
  function linkReverse(reverse, sourceRowId, added, removed, ts) {
    for (const id of added) editRelation(reverse.module_id, id, reverse.id, (ids) => (ids.includes(sourceRowId) ? null : [...ids, sourceRowId]), ts)
    for (const id of removed) editRelation(reverse.module_id, id, reverse.id, (ids) => (ids.includes(sourceRowId) ? ids.filter((x) => x !== sourceRowId) : null), ts)
  }

  function syncRelations(props, rowId, before, after, ts) {
    for (const prop of props.values()) {
      if (prop.type !== 'relation') continue
      const a = before[prop.id] || []
      const b = after[prop.id] || []
      if (a === b) continue
      const reverse = reverseOf(prop)
      if (!reverse) continue
      const added = b.filter((id) => !a.includes(id))
      const removed = a.filter((id) => !b.includes(id))
      if (added.length || removed.length) linkReverse(reverse, rowId, added, removed, ts)
    }
  }

  /** Removes deleted row ids from every relation value that points at moduleId. */
  function removeLinksTo(moduleId, deleted, ts) {
    for (const prop of q.relationsTo.all(moduleId)) {
      for (const r of q.rowsWithKey.all(prop.module_id, prop.id)) {
        const values = parseJson(r.values, {})
        const ids = values[prop.id]
        if (!Array.isArray(ids) || !ids.some((id) => deleted.has(id))) continue
        const next = ids.filter((id) => !deleted.has(id))
        if (next.length) values[prop.id] = next
        else delete values[prop.id]
        q.touchRowValues.run(JSON.stringify(values), ts, r.id)
      }
    }
  }

  /* ---- properties */

  function createProperty(moduleId, { name, type, config, width, sort_order, reverseName } = {}) {
    if (!VALUE_TYPES[type]) throw bad('invalid_type', `type must be one of ${Object.keys(VALUE_TYPES).join(', ')}`)
    const props = q.props.all(moduleId)
    if (type === 'title' && props.some((p) => p.type === 'title')) throw bad('duplicate_title', 'A database has exactly one title property')
    if (width != null && (!Number.isFinite(width) || width < 60 || width > 2000)) throw bad('invalid_width', 'width must be 60 to 2000')
    if (sort_order != null && !Number.isFinite(sort_order)) throw bad('invalid_sort_order', 'sort_order must be a number')
    const id = uuid()
    const cfg = normaliseConfig(type, config)
    if (type === 'relation') checkTarget(cfg.targetModuleId)
    const twoWay = type === 'relation' && cfg.twoWay && cfg.targetModuleId
    if (type === 'relation') cfg.twoWay = false // enabled by createReverse
    q.insertProp.run(id, moduleId, nameOf(name, defaultName(type, props)), type, JSON.stringify(cfg), sort_order ?? q.maxPropOrder.get(moduleId).m + 1,
      Math.round(width ?? (type === 'title' ? 280 : 200)))
    if (twoWay) createReverse(propOut(q.prop.get(id, moduleId)), { name: typeof reverseName === 'string' ? reverseName.trim() : '' })
    return propOut(q.prop.get(id, moduleId))
  }

  function defaultName(type, props) {
    const base = { title: 'Name', multi_select: 'Tags', created_time: 'Created', last_edited_time: 'Last edited' }[type] ||
      type.charAt(0).toUpperCase() + type.slice(1)
    let name = base
    for (let i = 2; props.some((p) => p.name === name); i++) name = `${base} ${i}`
    return name
  }

  function updateProperty(moduleId, propId, body) {
    const prop = loadProp(moduleId, propId)
    const type = body.type ?? prop.type
    if (!VALUE_TYPES[type]) throw bad('invalid_type', 'Unknown property type')
    if (type !== prop.type && (type === 'title' || prop.type === 'title')) throw bad('title_type_locked', 'The title property type cannot change')
    if (body.width != null && (!Number.isFinite(body.width) || body.width < 60 || body.width > 2000)) throw bad('invalid_width', 'width must be 60 to 2000')
    if (body.sort_order != null && !Number.isFinite(body.sort_order)) throw bad('invalid_sort_order', 'sort_order must be a number')
    const carryOptions = OPTION_TYPES.has(prop.type) && OPTION_TYPES.has(type)
    let config
    if (type === prop.type) config = normaliseConfig(type, body.config, prop.config)
    else config = normaliseConfig(type, body.config ?? (carryOptions ? { options: prop.config.options } : OPTION_TYPES.has(type) ? { options: type === 'status' ? undefined : [] } : {}))
    if (type === 'status' && prop.type !== 'status' && !body.config && carryOptions) {
      config.options = config.options.map((o) => ({ ...o, group: o.group || 'todo' }))
    }
    const changedRows = []
    const rows = q.rows.all(moduleId)
    const oldReverse = reverseOf(prop)
    let wantReverse = false
    if (type === 'relation') {
      const sameTarget = prop.type === 'relation' && prop.config.targetModuleId === config.targetModuleId
      if (!sameTarget) checkTarget(config.targetModuleId)
      const targetExists = !!config.targetModuleId && q.module.get(config.targetModuleId)?.type === 'database'
      if (!targetExists) config.twoWay = false
      wantReverse = config.twoWay
      if (sameTarget && oldReverse && wantReverse) {
        config.reversePropertyId = oldReverse.id // unchanged link
        wantReverse = false
      } else config.reversePropertyId = null
      if (!sameTarget && prop.type === 'relation') {
        for (const r of rows) {
          const values = parseJson(r.values, {})
          if (!(prop.id in values)) continue
          delete values[prop.id]
          q.setRowValues.run(JSON.stringify(values), r.id)
          changedRows.push({ ...rowOut(r), values })
        }
      }
      if (wantReverse) config.twoWay = false
    }
    if (oldReverse && config.reversePropertyId !== oldReverse.id) dropProperty(oldReverse)
    if (type !== prop.type) {
      for (const r of rows) {
        const values = parseJson(r.values, {})
        if (!(prop.id in values)) continue
        const nv = convertValue(prop.type, type, values[prop.id], prop.config, config, ctx)
        if (nv === undefined) delete values[prop.id]
        else values[prop.id] = nv
        q.setRowValues.run(JSON.stringify(values), r.id)
        changedRows.push({ ...rowOut(r), values })
      }
    } else if (OPTION_TYPES.has(type)) {
      // Removed options disappear from row values.
      const valid = new Set(config.options.map((o) => o.id))
      for (const r of rows) {
        const values = parseJson(r.values, {})
        const v = values[prop.id]
        if (v == null) continue
        const nv = Array.isArray(v) ? v.filter((id) => valid.has(id)) : valid.has(v) ? v : undefined
        if (Array.isArray(v) ? nv.length === v.length : nv === v) continue
        if (nv === undefined || (Array.isArray(nv) && !nv.length)) delete values[prop.id]
        else values[prop.id] = nv
        q.setRowValues.run(JSON.stringify(values), r.id)
        changedRows.push({ ...rowOut(r), values })
      }
    }
    db.prepare('UPDATE db_properties SET name = ?, type = ?, config = ?, width = ?, sort_order = ? WHERE id = ?')
      .run(nameOf(body.name, prop.name), type, JSON.stringify(config), Math.round(body.width ?? prop.width), body.sort_order ?? prop.sort_order, prop.id)
    if (wantReverse) createReverse(loadProp(moduleId, prop.id), { name: typeof body.reverseName === 'string' ? body.reverseName.trim() : '' })
    return { property: loadProp(moduleId, prop.id), rows: changedRows }
  }

  function deleteProperty(moduleId, propId) {
    const prop = loadProp(moduleId, propId)
    if (prop.type === 'title') throw bad('title_required', 'The title property cannot be deleted')
    const reverse = reverseOf(prop)
    dropProperty(prop)
    if (reverse) dropProperty(reverse)
    return { ok: true, deleted: reverse ? [prop.id, reverse.id] : [prop.id] }
  }

  function createView(moduleId, { name, type, config, sort_order } = {}) {
    if (!VIEW_TYPES.includes(type)) throw bad('invalid_view_type', `type must be one of ${VIEW_TYPES.join(', ')}`)
    if (config != null && !isObj(config)) throw bad('invalid_config', 'config must be an object')
    if (sort_order != null && !Number.isFinite(sort_order)) throw bad('invalid_sort_order', 'sort_order must be a number')
    const cfg = { ...config }
    const props = q.props.all(moduleId)
    if (type === 'board' && !cfg.group_by) cfg.group_by = (props.find((p) => p.type === 'status') || props.find((p) => p.type === 'select'))?.id ?? null
    if (type === 'calendar' && !cfg.date_property) cfg.date_property = props.find((p) => p.type === 'date')?.id ?? null
    const id = uuid()
    const label = { table: 'Table', board: 'Board', list: 'List', gallery: 'Gallery', calendar: 'Calendar' }[type]
    q.insertView.run(id, moduleId, nameOf(name, label), type, sort_order ?? q.maxViewOrder.get(moduleId).m + 1, JSON.stringify(cfg))
    return viewOut(q.view.get(id, moduleId))
  }

  function ensureInitialised(moduleId) {
    if (q.props.all(moduleId).length === 0) createProperty(moduleId, { name: 'Name', type: 'title' })
    if (q.countViews.get(moduleId).n === 0) createView(moduleId, { name: 'Table', type: 'table' })
  }

  /* ---- rows */

  function cleanValues(moduleId, input, props, base = {}) {
    if (input == null) return base
    if (!isObj(input)) throw bad('invalid_values', 'values must be an object keyed by property id')
    const out = { ...base }
    for (const [pid, raw] of Object.entries(input)) {
      const prop = props.get(pid)
      if (!prop) throw bad('unknown_property', `Unknown property ${pid}`)
      const rule = VALUE_TYPES[prop.type]
      if (!rule || rule.readOnly) throw bad('read_only', `"${prop.name}" is read-only`)
      const v = rule.validate(raw, prop, ctx)
      if (v === undefined) delete out[pid]
      else out[pid] = v
    }
    return out
  }

  const propMap = (moduleId) => new Map(q.props.all(moduleId).map((r) => [r.id, propOut(r)]))
  const hasTwoWay = (props) => [...props.values()].some((p) => p.type === 'relation' && p.config.twoWay)

  function checkNotes(notes) {
    if (notes != null && (typeof notes !== 'string' || notes.length > MAX_TEXT * 10)) throw bad('invalid_notes', 'notes must be text')
  }

  function insertRow(moduleId, props, input, order, ts, { createdAt, updatedAt } = {}) {
    if (!isObj(input)) throw bad('invalid_row', 'each row must be an object')
    checkNotes(input.notes)
    if (input.sort_order != null && !Number.isFinite(input.sort_order)) throw bad('invalid_sort_order', 'sort_order must be a number')
    const values = cleanValues(moduleId, input.values, props)
    const id = uuid()
    q.insertRow.run(id, moduleId, input.sort_order ?? order, JSON.stringify(values), input.notes ?? '', createdAt ?? ts, updatedAt ?? ts)
    if (hasTwoWay(props)) {
      syncRelations(props, id, {}, values, ts)
      return rowOut(q.row.get(id, moduleId))
    }
    return { id, module_id: moduleId, sort_order: input.sort_order ?? order, values, notes: input.notes ?? '', created_at: createdAt ?? ts, updated_at: updatedAt ?? ts }
  }

  function patchRow(moduleId, props, id, input, ts) {
    if (!isObj(input)) throw bad('invalid_row', 'row patch must be an object')
    const row = loadRow(moduleId, id)
    checkNotes(input.notes)
    if (input.sort_order != null && !Number.isFinite(input.sort_order)) throw bad('invalid_sort_order', 'sort_order must be a number')
    const values = cleanValues(moduleId, input.values, props, row.values)
    const out = { ...row, values, notes: input.notes ?? row.notes, sort_order: input.sort_order ?? row.sort_order, updated_at: ts }
    q.updateRow.run(JSON.stringify(values), out.notes, out.sort_order, ts, id)
    if (input.values != null && hasTwoWay(props)) {
      syncRelations(props, id, row.values, values, ts)
      return loadRow(moduleId, id) // a same-database link may have changed this row too
    }
    return out
  }

  function deleteRows(moduleId, ids) {
    if (!ids.length) return
    for (const id of ids) {
      loadRow(moduleId, id)
      q.deleteRow.run(id)
      ctx.attachments.removeFor({ moduleId, pageId: id })
    }
    removeLinksTo(moduleId, new Set(ids), now())
  }

  // Reassigns the existing sort_order slots of the given ids in the given order.
  function reorder(table, moduleId, ids, load) {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw bad('invalid_ids', 'ids must be a non-empty array of unique ids')
    const items = ids.map((id) => load(moduleId, id))
    const slots = items.map((x) => x.sort_order).sort((a, b) => a - b)
    for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1e-6 // ties
    const stmt = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`)
    ids.forEach((id, i) => stmt.run(slots[i], id))
    return ids.map((id, i) => ({ id, sort_order: slots[i] }))
  }

  /** Cheap change fingerprint for polling clients (rows, properties and title). */
  function stamp(moduleId) {
    const m = loadModule(moduleId)
    const r = q.stampRows.get(moduleId)
    const p = q.stampProps.get(moduleId)
    return crypto.createHash('sha1').update(`${m.title}|${r.n}|${r.u}|${r.s}|${p.p}`).digest('hex')
  }

  function snapshot(moduleId) {
    const module = loadModule(moduleId)
    transaction(db, () => ensureInitialised(module.id))
    return {
      module: { ...module, data: parseJson(module.data, {}) },
      properties: q.props.all(module.id).map(propOut),
      rows: q.rows.all(module.id).map(rowOut),
      views: q.views.all(module.id).map(viewOut),
    }
  }

  return {
    q, db, propOut, rowOut, viewOut, loadModule, loadProp, loadRow, loadView, nameOf, uniqueName, propMap,
    createProperty, updateProperty, deleteProperty, createView, ensureInitialised, createReverse, reverseOf,
    cleanValues, insertRow, patchRow, deleteRows, reorder, stamp, snapshot, checkTarget,
  }
}

/* ------------------------------------------------------------------ routes */

export default function register(router, ctx) {
  const svc = databaseService(ctx)
  const { db } = ctx
  const { q, loadModule, loadProp, loadRow, loadView, nameOf, propMap, createProperty, createView, ensureInitialised, insertRow, patchRow } = svc
  const requireBody = (body) => {
    if (!isObj(body)) throw bad('invalid_body', 'JSON object body required')
    return body
  }

  const base = '/api/databases/:moduleId'

  router.get(base, ({ params }) => svc.snapshot(params.moduleId))

  router.get(`${base}/stamp`, ({ params }) => ({ stamp: svc.stamp(params.moduleId) }))

  router.post(`${base}/properties`, ({ params, body, res }) => {
    loadModule(params.moduleId)
    const p = transaction(db, () => createProperty(params.moduleId, requireBody(body)))
    res.statusCode = 201
    return p
  })

  router.post(`${base}/properties/reorder`, ({ params, body }) => {
    loadModule(params.moduleId)
    return transaction(db, () => svc.reorder('db_properties', params.moduleId, requireBody(body).ids, loadProp))
  })

  router.patch(`${base}/properties/:propId`, ({ params, body }) => {
    loadModule(params.moduleId)
    requireBody(body)
    return transaction(db, () => svc.updateProperty(params.moduleId, params.propId, body))
  })

  router.delete(`${base}/properties/:propId`, ({ params }) => {
    loadModule(params.moduleId)
    return transaction(db, () => svc.deleteProperty(params.moduleId, params.propId))
  })

  router.post(`${base}/rows`, ({ params, body, res }) => {
    loadModule(params.moduleId)
    const row = transaction(db, () => insertRow(params.moduleId, propMap(params.moduleId), body ?? {}, q.maxRowOrder.get(params.moduleId).m + 1, now()))
    res.statusCode = 201
    return row
  })

  // { create|rows: [{ values, notes, sort_order }], update: [{ id, values, notes, sort_order }], delete: [ids] }
  router.post(`${base}/rows/batch`, ({ params, body }) => {
    loadModule(params.moduleId)
    requireBody(body)
    const create = body.create ?? body.rows ?? []
    const update = body.update ?? []
    const del = body.delete ?? []
    if (![create, update, del].every(Array.isArray)) throw bad('invalid_batch', 'create, update and delete must be arrays')
    if (create.length + update.length + del.length > 50_000) throw bad('batch_too_large', 'At most 50,000 operations per batch')
    return transaction(db, () => {
      const props = propMap(params.moduleId)
      const ts = now()
      let order = q.maxRowOrder.get(params.moduleId).m
      const created = create.map((input) => insertRow(params.moduleId, props, input, ++order, ts))
      const updated = update.map((input) => patchRow(params.moduleId, props, input?.id, input, ts))
      svc.deleteRows(params.moduleId, del)
      return { created, updated, deleted: del.length }
    })
  })

  router.post(`${base}/rows/reorder`, ({ params, body }) => {
    loadModule(params.moduleId)
    return transaction(db, () => svc.reorder('db_rows', params.moduleId, requireBody(body).ids, loadRow))
  })

  router.get(`${base}/rows/:rowId`, ({ params }) => {
    loadModule(params.moduleId)
    return loadRow(params.moduleId, params.rowId)
  })

  router.patch(`${base}/rows/:rowId`, ({ params, body }) => {
    loadModule(params.moduleId)
    return transaction(db, () => patchRow(params.moduleId, propMap(params.moduleId), params.rowId, requireBody(body), now()))
  })

  router.delete(`${base}/rows/:rowId`, ({ params }) => {
    loadModule(params.moduleId)
    transaction(db, () => svc.deleteRows(params.moduleId, [params.rowId]))
    return { ok: true }
  })

  router.post(`${base}/views`, ({ params, body, res }) => {
    loadModule(params.moduleId)
    const v = transaction(db, () => createView(params.moduleId, requireBody(body)))
    res.statusCode = 201
    return v
  })

  router.post(`${base}/views/reorder`, ({ params, body }) => {
    loadModule(params.moduleId)
    return transaction(db, () => svc.reorder('db_views', params.moduleId, requireBody(body).ids, loadView))
  })

  router.patch(`${base}/views/:viewId`, ({ params, body }) => {
    loadModule(params.moduleId)
    requireBody(body)
    const view = loadView(params.moduleId, params.viewId)
    if (body.type != null && !VIEW_TYPES.includes(body.type)) throw bad('invalid_view_type', `type must be one of ${VIEW_TYPES.join(', ')}`)
    if (body.config != null && !isObj(body.config)) throw bad('invalid_config', 'config must be an object')
    if (body.sort_order != null && !Number.isFinite(body.sort_order)) throw bad('invalid_sort_order', 'sort_order must be a number')
    db.prepare('UPDATE db_views SET name = ?, type = ?, config = ?, sort_order = ? WHERE id = ?')
      .run(nameOf(body.name, view.name), body.type ?? view.type, JSON.stringify(body.config ?? view.config), body.sort_order ?? view.sort_order, view.id)
    return loadView(params.moduleId, view.id)
  })

  router.delete(`${base}/views/:viewId`, ({ params }) => {
    loadModule(params.moduleId)
    return transaction(db, () => {
      loadView(params.moduleId, params.viewId)
      if (q.countViews.get(params.moduleId).n <= 1) throw bad('last_view', 'A database needs at least one view')
      q.deleteView.run(params.viewId)
      return { ok: true }
    })
  })

  /* ---- templates */

  ctx.registerTemplate('database', 'blank', {
    name: 'Blank',
    description: 'An empty database with a table view.',
    apply: (_db, moduleId) => ensureInitialised(moduleId),
  })

  ctx.registerTemplate('database', 'task_tracker', {
    name: 'Task tracker',
    description: 'Tasks with status, assignee, due date and priority, on a table and a board.',
    apply(_db, moduleId) {
      const name = createProperty(moduleId, { name: 'Name', type: 'title' })
      const status = createProperty(moduleId, { name: 'Status', type: 'status' })
      const assignee = createProperty(moduleId, { name: 'Assignee', type: 'text' })
      const due = createProperty(moduleId, { name: 'Due', type: 'date', width: 160 })
      const priority = createProperty(moduleId, {
        name: 'Priority', type: 'select', width: 140,
        config: { options: [{ name: 'Low', color: 'gray' }, { name: 'Medium', color: 'yellow' }, { name: 'High', color: 'red' }] },
      })
      const [notStarted, inProgress, done] = status.config.options.map((o) => o.id)
      const [low, medium, high] = priority.config.options.map((o) => o.id)
      const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10)
      const props = propMap(moduleId)
      const ts = now()
      const samples = [
        ['Draft onboarding checklist', inProgress, 'Alex', 2, high],
        ['Review supplier contracts', notStarted, 'Sam', 6, medium],
        ['Book quarterly planning session', done, 'Priya', -3, low],
        ['Update identity verification guide', notStarted, 'Jordan', 10, medium],
        ['Reconcile March expenses', inProgress, 'Alex', 4, low],
      ]
      samples.forEach(([title, st, who, off, pr], i) => insertRow(moduleId, props, {
        values: { [name.id]: title, [status.id]: st, [assignee.id]: who, [due.id]: { start: day(off) }, [priority.id]: pr },
      }, i + 1, ts))
      createView(moduleId, { name: 'Table', type: 'table' })
      createView(moduleId, { name: 'Board', type: 'board', config: { group_by: status.id } })
    },
  })

  ctx.registerTemplate('database', 'contacts', {
    name: 'Contacts',
    description: 'People with email, phone, company and tags.',
    apply(_db, moduleId) {
      const name = createProperty(moduleId, { name: 'Name', type: 'title', width: 220 })
      const company = createProperty(moduleId, { name: 'Company', type: 'text', width: 180 })
      const email = createProperty(moduleId, { name: 'Email', type: 'email', width: 220 })
      const phone = createProperty(moduleId, { name: 'Phone', type: 'phone', width: 160 })
      const tags = createProperty(moduleId, {
        name: 'Tags', type: 'multi_select',
        config: { options: [{ name: 'Client', color: 'blue' }, { name: 'Supplier', color: 'orange' }, { name: 'Partner', color: 'green' }] },
      })
      const website = createProperty(moduleId, { name: 'Website', type: 'url' })
      const photo = createProperty(moduleId, { name: 'Photo', type: 'files', width: 160 })
      const [client, supplier, partner] = tags.config.options.map((o) => o.id)
      const props = propMap(moduleId)
      const ts = now()
      const samples = [
        ['Casey Nguyen', 'Harbour Logistics', 'casey@example.com', '+61 412 345 678', [client], 'https://example.com'],
        ['Morgan Lee', 'Southern Paper Co', 'morgan@example.org', '+61 423 456 789', [supplier], 'https://example.org'],
        ['Riley Patel', 'Blue Gum Advisory', 'riley@example.net', '+61 434 567 890', [partner, client], 'https://example.net'],
      ]
      samples.forEach(([n, c, e, p, t, w], i) => insertRow(moduleId, props, {
        values: { [name.id]: n, [company.id]: c, [email.id]: e, [phone.id]: p, [tags.id]: t, [website.id]: w },
      }, i + 1, ts))
      createView(moduleId, { name: 'All contacts', type: 'table' })
      createView(moduleId, { name: 'Gallery', type: 'gallery', config: { cover_property: photo.id } })
    },
  })
}
