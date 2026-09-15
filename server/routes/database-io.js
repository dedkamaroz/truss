// Database import: creates a new database from a Truss JSON document in one transaction.
// Format: { truss: 1, database: { id?, title, icon?, properties: [{ id, name, type, config, width? }], views: [{ name, type, config }],
//           rows: [{ id?, values: { [propertyId]: value }, notes?, created_at?, updated_at? }] } }
// The CSV import in the browser builds the same document, so there is a single import path.

import crypto from 'node:crypto'
import fs from 'node:fs'
import { httpError } from '../http.js'
import { transaction } from '../db.js'
import { databaseService, VALUE_TYPES, VIEW_TYPES } from './database.js'
import { MAX_ICON } from './modules.js'

const bad = (code, message) => httpError(400, code, message)
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v)
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
const isoOrNull = (v) => (typeof v === 'string' && ISO_TS.test(v) && !Number.isNaN(Date.parse(v)) ? v : null)

export default function register(router, ctx) {
  const svc = databaseService(ctx)
  const { db, q } = svc
  const insertModule = db.prepare(`INSERT INTO modules (id, type, title, icon, sort_order, data, created_at, updated_at)
    VALUES (?, 'database', ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM modules), '{}', ?, ?)`)
  const setValues = db.prepare('UPDATE db_rows SET "values" = ? WHERE id = ?')

  router.post('/api/databases/import', ({ body, res }) => {
    if (!isObj(body) || body.truss !== 1 || !isObj(body.database)) throw bad('invalid_import', 'Not a Truss database file (expected { truss: 1, database })')
    const d = body.database
    const properties = d.properties ?? []
    const rows = d.rows ?? []
    const views = d.views ?? []
    if (!Array.isArray(properties) || !Array.isArray(rows) || !Array.isArray(views)) throw bad('invalid_import', 'properties, views and rows must be arrays')
    if (properties.length > 500) throw bad('invalid_import', 'At most 500 properties')
    if (rows.length > 200_000) throw bad('invalid_import', 'At most 200,000 rows')
    properties.forEach((p, i) => {
      if (!isObj(p) || typeof p.type !== 'string' || !VALUE_TYPES[p.type]) throw bad('invalid_import', `Property ${i + 1} has an unknown type`)
      if (p.name != null && typeof p.name !== 'string') throw bad('invalid_import', `Property ${i + 1} has an invalid name`)
    })
    if (properties.filter((p) => p.type === 'title').length > 1) throw bad('invalid_import', 'A database has exactly one title property')
    if (d.title != null && typeof d.title !== 'string') throw bad('invalid_import', 'title must be text')
    if (d.icon != null && (typeof d.icon !== 'string' || d.icon.length > MAX_ICON)) throw bad('invalid_import', `icon must be text of at most ${MAX_ICON} characters`)

    const { moduleId, files, propIds } = transaction(db, () => importDatabase(d, properties, rows, views))
    copyFiles(moduleId, files)
    res.statusCode = 201
    const m = q.module.get(moduleId)
    return { module: { ...m, data: {} }, rowCount: rows.length, propertyIds: Object.fromEntries(propIds) }
  })

  function importDatabase(d, properties, rows, views) {
    const moduleId = crypto.randomUUID()
    const ts = new Date().toISOString()
    insertModule.run(moduleId, d.title?.trim().slice(0, 500) || 'Imported database', d.icon || null, ts, ts)
    const srcId = typeof d.id === 'string' ? d.id : null
    const propIds = new Map() // file property id -> new id
    const srcById = new Map(properties.filter((p) => typeof p.id === 'string').map((p) => [p.id, p]))
    const width = (w) => (Number.isFinite(w) && w >= 60 && w <= 2000 ? w : undefined)

    if (!properties.some((p) => p.type === 'title')) svc.createProperty(moduleId, { name: 'Name', type: 'title', sort_order: 0 })
    const relationTarget = new Map() // new relation property id -> target module id
    properties.forEach((p, i) => {
      if (p.type === 'rollup') return
      let type = p.type
      let config = isObj(p.config) ? p.config : undefined
      if (type === 'relation') {
        const target = config?.targetModuleId
        const mapped = target && target === srcId ? moduleId : target
        const exists = mapped === moduleId || (typeof mapped === 'string' && q.module.get(mapped)?.type === 'database')
        if (exists) config = { targetModuleId: mapped, twoWay: false }
        else (type = 'text', config = undefined) // the related database is not here: keep the column, drop the links
      }
      const np = svc.createProperty(moduleId, { name: p.name, type, config, width: width(p.width), sort_order: i + 1 })
      if (typeof p.id === 'string') propIds.set(p.id, np.id)
      if (type === 'relation') relationTarget.set(np.id, config.targetModuleId)
    })
    properties.forEach((p, i) => {
      if (p.type !== 'rollup') return
      const c = isObj(p.config) ? p.config : {}
      const relationPropertyId = propIds.get(c.relationPropertyId) ?? null
      const selfTarget = relationTarget.get(relationPropertyId) === moduleId
      const targetPropertyId = typeof c.targetPropertyId === 'string' ? (selfTarget ? propIds.get(c.targetPropertyId) ?? null : c.targetPropertyId) : null
      const np = svc.createProperty(moduleId, { name: p.name, type: 'rollup', config: { relationPropertyId, targetPropertyId, fn: c.fn }, width: width(p.width), sort_order: i + 1 })
      if (typeof p.id === 'string') propIds.set(p.id, np.id)
    })

    /* rows: plain values first, same-database links once every row id is known */
    const props = svc.propMap(moduleId)
    const rowIds = new Map()
    const selfLinks = [] // { rowId, propId, ids }
    const files = [] // { rowId, propId, ids }
    rows.forEach((r, i) => {
      if (!isObj(r)) throw bad('invalid_import', `Row ${i + 1} must be an object`)
      if (r.values != null && !isObj(r.values)) throw bad('invalid_import', `Row ${i + 1}: values must be an object`)
      const values = {}
      const later = []
      for (const [k, v] of Object.entries(r.values || {})) {
        const np = props.get(propIds.get(k))
        if (!np || np.type !== srcById.get(k)?.type || VALUE_TYPES[np.type].readOnly) continue
        if (np.type === 'files' || (np.type === 'relation' && relationTarget.get(np.id) === moduleId)) later.push({ propId: np.id, type: np.type, ids: v })
        else values[np.id] = v
      }
      let row
      try {
        row = svc.insertRow(moduleId, props, { values, notes: typeof r.notes === 'string' ? r.notes : '' }, i + 1, ts,
          { createdAt: isoOrNull(r.created_at) ?? undefined, updatedAt: isoOrNull(r.updated_at) ?? undefined })
      } catch (err) {
        if (err.status === 400) throw bad(err.code, `Row ${i + 1}: ${err.message}`)
        throw err
      }
      if (typeof r.id === 'string') rowIds.set(r.id, row.id)
      for (const l of later) {
        if (!Array.isArray(l.ids)) throw bad('invalid_value', `Row ${i + 1}: expected an array of ids`)
        ;(l.type === 'files' ? files : selfLinks).push({ rowId: row.id, propId: l.propId, ids: l.ids })
      }
    })
    const valuesOf = new Map()
    const rowValues = (id) => {
      if (!valuesOf.has(id)) valuesOf.set(id, JSON.parse(q.row.get(id, moduleId).values))
      return valuesOf.get(id)
    }
    for (const l of selfLinks) {
      const ids = [...new Set(l.ids.map((x) => rowIds.get(x)).filter(Boolean))]
      if (ids.length) rowValues(l.rowId)[l.propId] = ids
    }
    for (const [id, values] of valuesOf) setValues.run(JSON.stringify(values), id)

    /* two-way relations: pairs inside the file are linked as they are; others get a new reverse property */
    const linked = new Set()
    for (const p of properties) {
      const newId = propIds.get(p.id)
      if (p.type !== 'relation' || !relationTarget.has(newId) || p.config?.twoWay !== true || linked.has(newId)) continue
      const partner = propIds.get(p.config.reversePropertyId)
      const partnerSrc = srcById.get(p.config.reversePropertyId)
      if (relationTarget.get(newId) === moduleId && partner && partner !== newId && relationTarget.get(partner) === moduleId && partnerSrc?.config?.reversePropertyId === p.id) {
        const a = props.get(newId)
        const b = props.get(partner)
        q.setPropConfig.run(JSON.stringify({ ...a.config, twoWay: true, reversePropertyId: partner }), newId)
        q.setPropConfig.run(JSON.stringify({ ...b.config, twoWay: true, reversePropertyId: newId }), partner)
        linked.add(newId).add(partner)
      } else {
        svc.createReverse(svc.loadProp(moduleId, newId))
        linked.add(newId)
      }
    }

    /* views */
    const map = (pid) => (typeof pid === 'string' ? propIds.get(pid) ?? null : null)
    const remapFilter = (f) => ({
      ...f,
      rules: (Array.isArray(f.rules) ? f.rules : []).filter(isObj).map((r) => (r.rules ? remapFilter(r) : { ...r, property: map(r.property) })).filter((r) => r.rules || r.property),
    })
    views.forEach((v, i) => {
      if (!isObj(v) || !VIEW_TYPES.includes(v.type)) throw bad('invalid_import', `View ${i + 1} has an unknown type`)
      const c = isObj(v.config) ? { ...v.config } : {}
      if (Array.isArray(c.hidden)) c.hidden = c.hidden.map(map).filter(Boolean)
      if (Array.isArray(c.sorts)) c.sorts = c.sorts.filter(isObj).map((s) => ({ ...s, property: map(s.property) })).filter((s) => s.property)
      if (isObj(c.filter)) c.filter = remapFilter(c.filter)
      for (const k of ['group_by', 'date_property', 'cover_property']) if (typeof c[k] === 'string' && c[k] !== 'none') c[k] = map(c[k])
      if (isObj(c.widths)) c.widths = Object.fromEntries(Object.entries(c.widths).map(([k, w]) => [map(k), w]).filter(([k]) => k))
      svc.createView(moduleId, { name: typeof v.name === 'string' ? v.name : undefined, type: v.type, config: c, sort_order: i + 1 })
    })
    svc.ensureInitialised(moduleId)
    return { moduleId, files, propIds }
  }

  // Attachments are copied after the commit so a failed import never leaves files on disk.
  function copyFiles(moduleId, files) {
    if (!files.length) return
    transaction(db, () => {
      for (const f of files) {
        const ids = []
        for (const src of f.ids) {
          const a = typeof src === 'string' && ctx.attachments.get(src)
          const from = a && ctx.attachments.pathOf(src)
          if (!from || !fs.existsSync(from)) continue
          try {
            ids.push(ctx.attachments.create({ moduleId, pageId: f.rowId, filename: a.filename, source: a.source, srcPath: from }).id)
          } catch (err) {
            console.warn('[truss] import: could not copy attachment', err.message)
          }
        }
        if (!ids.length) continue
        const values = JSON.parse(q.row.get(f.rowId, moduleId).values)
        values[f.propId] = ids
        setValues.run(JSON.stringify(values), f.rowId)
      }
    })
  }
}
