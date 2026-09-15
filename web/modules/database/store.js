// Client-side database state with optimistic mutations. Views subscribe to change events.

import { toast } from '../../lib/ui.js'
import { typeOf } from './types.js'
import { registerDb, unregisterDb, invalidate } from './relations.js'

const enc = encodeURIComponent
const POLL_MS = 2000
const isRelation = (p) => !!typeOf(p).relation
const locksRows = (p) => !!typeOf(p).locksRows?.(p)
const hasComputed = (props) => props.some((p) => typeOf(p).computed)

export function createStore(api, moduleId) {
  const base = `/api/databases/${enc(moduleId)}`
  const listeners = new Set()
  const pendingViewSaves = new Map() // viewId -> timer
  let pollTimer = null
  let destroyed = false

  const s = {
    moduleId,
    module: null,
    properties: [],
    propById: new Map(),
    rows: [],
    rowById: new Map(),
    views: [],
    attachments: new Map(), // id -> attachment row
    schemaVersion: 0,
    related: new Map(), // moduleId -> loaded related database { moduleId, module, properties, propById, rows, rowById, stamp }

    /** The list column that decides this database's rows, or null. */
    rowSource: () => s.properties.find(locksRows) || null,

    on(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    async load() {
      const [data, atts] = await Promise.all([api.get(base), api.get(`/api/attachments?moduleId=${enc(moduleId)}`)])
      s.module = data.module
      setProperties(data.properties)
      s.rows = data.rows
      for (const r of s.rows) r._v = 1
      s.rowById = new Map(s.rows.map((r) => [r.id, r]))
      s.views = data.views
      s.attachments = new Map(atts.map((a) => [a.id, a]))
      registerDb(s)
      await s.ensureRelated().catch((err) => console.warn('[database] related data failed to load', err))
      if (!pollTimer && !destroyed) pollTimer = setInterval(pollRelated, POLL_MS)
    },

    /** Re-reads everything (after relation schema changes that the server fans out). */
    async reload() {
      const data = await api.get(base)
      s.module = data.module
      setProperties(data.properties)
      const old = s.rowById
      s.rows = data.rows.map((r) => {
        r._v = (old.get(r.id)?._v || 0) + 1
        return r
      })
      s.rowById = new Map(s.rows.map((r) => [r.id, r]))
      s.views = data.views
      registerDb(s)
      await s.ensureRelated().catch(() => {})
      emit({ kind: 'views' })
      emit({ kind: 'schema' })
    },

    /** Loads databases that relation properties point at (and theirs, when they compute values further). */
    async ensureRelated() {
      const queue = [s]
      const seen = new Set([moduleId])
      let loaded = false
      while (queue.length) {
        const db = queue.shift()
        for (const p of db.properties) {
          const target = typeOf(p).target?.(p)
          if (!target || seen.has(target)) continue
          seen.add(target)
          let rdb = s.related.get(target)
          if (!rdb) {
            rdb = await fetchRelated(target)
            if (!rdb) continue
            loaded = true
          }
          if (hasComputed(rdb.properties)) queue.push(rdb)
        }
      }
      if (loaded) {
        touchAll()
        emit({ kind: 'related' })
      }
    },

    /** Re-reads one related database if it changed on the server. */
    async refreshRelated(targetId) {
      const rdb = s.related.get(targetId)
      if (!rdb) return
      let gone = false
      const { stamp } = await api.get(`/api/databases/${enc(targetId)}/stamp`).catch((err) => ((gone = err?.status === 404), {}))
      if (destroyed) return
      if (gone) {
        // The related database was deleted: pick up the server's unlinked relation config, then stop polling it.
        // If the reload fails, the entry stays so the next poll tries again.
        try {
          await s.reload()
        } catch (err) {
          console.warn('[database] reload after related database deletion failed', err?.message)
          return
        }
        s.related.delete(targetId)
        unregisterDb(rdb)
        return
      }
      if (!stamp || stamp === rdb.stamp) return
      if (await fetchRelated(targetId, stamp)) {
        // the list's source changed: the server adds or renames rows here when this database is read
        if (s.properties.some((p) => locksRows(p) && typeOf(p).target(p) === targetId)) await s.reload().catch(() => {})
        await s.ensureRelated().catch(() => {})
        touchAll()
        emit({ kind: 'related' })
      }
    },

    async createRelatedRow(targetId, values) {
      try {
        const row = await api.post(`/api/databases/${enc(targetId)}/rows`, { values })
        const rdb = s.related.get(targetId)
        if (rdb) {
          rdb.rows.push(row)
          rdb.rowById.set(row.id, row)
          invalidate()
        }
        return row
      } catch (err) {
        fail(err, 'Could not add the row')
        throw err
      }
    },

    /** Appends many rows in batches (CSV import into this database). onProgress(done, total). */
    async importRows(valuesList, onProgress) {
      const BATCH = 2000
      const created = []
      for (let i = 0; i < valuesList.length; i += BATCH) {
        const res = await api.post(`${base}/rows/batch`, { create: valuesList.slice(i, i + BATCH).map((values) => ({ values })) })
        for (const r of res.created) (r._v = 1, created.push(r))
        onProgress?.(Math.min(valuesList.length, i + BATCH), valuesList.length)
      }
      for (const r of created) (s.rows.push(r), s.rowById.set(r.id, r))
      sortRowsByOrder()
      emit({ kind: 'rows' })
      return created
    },

    destroy() {
      destroyed = true
      clearInterval(pollTimer)
      unregisterDb(s)
      for (const rdb of s.related.values()) unregisterDb(rdb)
    },

    /* ---- rows */

    async updateValues(rowId, values) {
      const row = s.rowById.get(rowId)
      if (!row) return
      const before = { ...row.values }
      for (const [k, v] of Object.entries(values)) {
        if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) delete row.values[k]
        else row.values[k] = v
      }
      touch(row)
      emit({ kind: 'row', rowId })
      try {
        const saved = await api.patch(`${base}/rows/${enc(rowId)}`, { values })
        row.updated_at = saved.updated_at
        syncLinked(values, before, saved).catch((err) => console.warn('[database] link refresh failed', err))
      } catch (err) {
        row.values = before
        touch(row)
        emit({ kind: 'row', rowId })
        fail(err, 'Could not save the change')
        throw err
      }
    },

    async updateNotes(rowId, notes) {
      const row = s.rowById.get(rowId)
      if (!row) return
      row.notes = notes
      try {
        const saved = await api.patch(`${base}/rows/${enc(rowId)}`, { notes })
        row.updated_at = saved.updated_at
        touch(row)
        emit({ kind: 'row', rowId, notesOnly: true })
      } catch (err) {
        fail(err, 'Could not save notes')
      }
    },

    async createRow({ values = {}, afterRowId } = {}) {
      let sort_order
      if (afterRowId && s.rowById.has(afterRowId)) {
        const i = s.rows.indexOf(s.rowById.get(afterRowId))
        const a = s.rows[i].sort_order
        const b = s.rows[i + 1]?.sort_order ?? a + 2
        sort_order = (a + b) / 2
      }
      const row = await api.post(`${base}/rows`, { values, sort_order }).catch((err) => {
        fail(err, 'Could not add a row')
        throw err
      })
      row._v = 1
      s.rowById.set(row.id, row)
      s.rows.push(row)
      sortRowsByOrder()
      emit({ kind: 'rows', created: row.id })
      return row
    },

    async deleteRows(ids) {
      const set = new Set(ids)
      const removed = s.rows.filter((r) => set.has(r.id))
      s.rows = s.rows.filter((r) => !set.has(r.id))
      for (const id of ids) s.rowById.delete(id)
      emit({ kind: 'rows', deleted: ids })
      try {
        await api.post(`${base}/rows/batch`, { delete: ids })
        for (const a of [...s.attachments.values()]) if (set.has(a.page_id)) s.attachments.delete(a.id)
        // the server removed links to these rows; mirror that for relations inside this database
        let changed = false
        for (const p of s.properties.filter((x) => isRelation(x) && x.config?.targetModuleId === moduleId)) {
          for (const r of s.rows) {
            const v = r.values[p.id]
            if (!v?.some((id) => set.has(id))) continue
            const next = v.filter((id) => !set.has(id))
            if (next.length) r.values[p.id] = next
            else delete r.values[p.id]
            touch(r)
            changed = true
          }
        }
        if (changed) emit({ kind: 'rows' })
        for (const p of s.properties.filter(isRelation)) if (p.config?.twoWay && p.config.targetModuleId !== moduleId) s.refreshRelated(p.config.targetModuleId)
      } catch (err) {
        for (const r of removed) (s.rows.push(r), s.rowById.set(r.id, r))
        sortRowsByOrder()
        emit({ kind: 'rows' })
        fail(err, 'Could not delete')
      }
    },

    /** Reassigns the sort_order slots of the given ids in the given order (same rule as the server). */
    async reorderRows(ids) {
      const rows = ids.map((id) => s.rowById.get(id)).filter(Boolean)
      const slots = rows.map((r) => r.sort_order).sort((a, b) => a - b)
      for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1e-6
      rows.forEach((r, i) => { r.sort_order = slots[i] })
      sortRowsByOrder()
      emit({ kind: 'rows', reordered: true })
      try {
        await api.post(`${base}/rows/reorder`, { ids: rows.map((r) => r.id) })
      } catch (err) {
        fail(err, 'Could not reorder')
      }
    },

    /* ---- properties */

    async createProperty(data) {
      try {
        const p = await api.post(`${base}/properties`, data)
        setProperties([...s.properties, p])
        if (isRelation(p) || locksRows(p)) await s.reload().catch(() => {})
        else if (typeOf(p).computed) {
          await s.ensureRelated().catch(() => {}) // a lookup may read a database that isn't loaded yet
          touchAll()
        }
        emit({ kind: 'schema' })
        return p
      } catch (err) {
        fail(err, 'Could not add the property')
        throw err
      }
    },

    async updateProperty(id, patch) {
      const prev = s.propById.get(id)
      if (!prev) return null
      const optimistic = !('type' in patch) || patch.type === prev.type
      if (optimistic) {
        setProperties(s.properties.map((p) => (p.id === id ? { ...p, ...patch } : p)))
        emit({ kind: 'schema' })
      }
      try {
        const { property, rows } = await api.patch(`${base}/properties/${enc(id)}`, patch)
        setProperties(s.properties.map((p) => (p.id === id ? property : p)))
        for (const r of rows) {
          const local = s.rowById.get(r.id)
          if (local) (local.values = r.values, touch(local))
        }
        if (isRelation(prev) || isRelation(property) || locksRows(prev) || locksRows(property)) await s.reload().catch(() => {})
        else if (typeOf(property).computed) {
          await s.ensureRelated().catch(() => {})
          touchAll()
        }
        emit({ kind: 'schema' })
        return property
      } catch (err) {
        setProperties(s.properties.map((p) => (p.id === id ? prev : p)))
        emit({ kind: 'schema' })
        fail(err, 'Could not update the property')
        throw err
      }
    },

    async deleteProperty(id) {
      const prev = s.properties
      setProperties(prev.filter((p) => p.id !== id))
      emit({ kind: 'schema' })
      try {
        const res = await api.del(`${base}/properties/${enc(id)}`)
        const gone = new Set(res?.deleted || [id])
        if (gone.size > 1) setProperties(s.properties.filter((p) => !gone.has(p.id)))
        for (const r of s.rows) for (const pid of gone) if (pid in r.values) (delete r.values[pid], touch(r))
        if (gone.size > 1) for (const rdb of s.related.values()) s.refreshRelated(rdb.moduleId)
        emit({ kind: 'schema' })
      } catch (err) {
        setProperties(prev)
        emit({ kind: 'schema' })
        fail(err, 'Could not delete the property')
      }
    },

    async reorderProperties(ids) {
      const prev = s.properties
      setProperties(ids.map((id, i) => ({ ...s.propById.get(id), sort_order: i + 1 })))
      emit({ kind: 'schema' })
      try {
        await api.post(`${base}/properties/reorder`, { ids })
      } catch (err) {
        setProperties(prev)
        emit({ kind: 'schema' })
        fail(err, 'Could not reorder properties')
      }
    },

    /* ---- views */

    async createView(data) {
      try {
        const v = await api.post(`${base}/views`, data)
        s.views.push(v)
        emit({ kind: 'views' })
        return v
      } catch (err) {
        fail(err, 'Could not create the view')
        throw err
      }
    },

    /** Local config change applied immediately; persisted after a short debounce. */
    setViewConfig(viewId, patch) {
      const v = s.views.find((x) => x.id === viewId)
      if (!v) return
      v.config = { ...v.config, ...patch }
      clearTimeout(pendingViewSaves.get(viewId))
      pendingViewSaves.set(viewId, setTimeout(() => saveView(viewId), 250))
      emit({ kind: 'config', viewId })
    },

    async renameView(viewId, name) {
      const v = s.views.find((x) => x.id === viewId)
      if (!v) return
      v.name = name
      emit({ kind: 'views' })
      try {
        Object.assign(v, await api.patch(`${base}/views/${enc(viewId)}`, { name }))
      } catch (err) {
        fail(err, 'Could not rename the view')
      }
      emit({ kind: 'views' })
    },

    async deleteView(viewId) {
      try {
        await api.del(`${base}/views/${enc(viewId)}`)
        s.views = s.views.filter((v) => v.id !== viewId)
        emit({ kind: 'views' })
      } catch (err) {
        fail(err, 'Could not delete the view')
      }
    },

    flush() {
      for (const [id, t] of pendingViewSaves) {
        clearTimeout(t)
        saveView(id)
      }
    },

    /* ---- attachments */

    async upload(rowId, file) {
      const a = await api.upload(`/api/attachments?moduleId=${enc(moduleId)}&pageId=${enc(rowId)}`, file, file.name)
      s.attachments.set(a.id, a)
      return a
    },
  }

  function setProperties(list) {
    s.properties = [...list].sort((a, b) => a.sort_order - b.sort_order)
    s.propById = new Map(s.properties.map((p) => [p.id, p]))
    s.schemaVersion++
  }

  async function fetchRelated(targetId, knownStamp) {
    try {
      // The stamp is read before the data: a change landing in between leaves an older stamp, so the next poll refetches.
      const st = knownStamp ? { stamp: knownStamp } : await api.get(`/api/databases/${enc(targetId)}/stamp`)
      const data = await api.get(`/api/databases/${enc(targetId)}`)
      if (destroyed) return null
      const properties = [...data.properties].sort((a, b) => a.sort_order - b.sort_order)
      const rdb = {
        moduleId: targetId, module: data.module, properties, propById: new Map(properties.map((p) => [p.id, p])),
        rows: data.rows, rowById: new Map(data.rows.map((r) => [r.id, r])), views: data.views, attachments: new Map(), stamp: st.stamp,
      }
      s.related.set(targetId, rdb)
      registerDb(rdb)
      return rdb
    } catch (err) {
      console.warn('[database] could not load related database', targetId, err?.message)
      return null
    }
  }

  async function pollRelated() {
    if (destroyed || document.hidden || !s.related.size) return
    for (const id of [...s.related.keys()]) await s.refreshRelated(id)
  }

  // After a two-way relation edit: rows in this database may have changed on the server; other databases refresh by stamp.
  async function syncLinked(values, before, saved) {
    for (const p of Object.keys(values).map((k) => s.propById.get(k)).filter((x) => x && isRelation(x) && x.config?.twoWay)) {
      const target = p.config.targetModuleId
      if (target !== moduleId) {
        // only matters when the other side computes values from its links; polling catches up otherwise
        if (hasComputed(s.related.get(target)?.properties || [])) await s.refreshRelated(target)
        continue
      }
      const a = before[p.id] || []
      const b = saved.values[p.id] || []
      const affected = [...new Set([...a.filter((x) => !b.includes(x)), ...b.filter((x) => !a.includes(x)), saved.id])]
      const fresh = await Promise.all(affected.map((rid) => api.get(`${base}/rows/${enc(rid)}`).catch(() => null)))
      for (const r of fresh.filter(Boolean)) {
        const local = s.rowById.get(r.id)
        if (local) (local.values = r.values, local.updated_at = r.updated_at, touch(local))
      }
      emit({ kind: 'rows' })
    }
  }

  // Computed values may depend on other rows or databases: recompute and re-render every row.
  function touchAll() {
    invalidate()
    for (const r of s.rows) r._v = (r._v || 0) + 1
  }

  function sortRowsByOrder() {
    s.rows.sort((a, b) => a.sort_order - b.sort_order)
  }

  function touch(row) {
    row._v = (row._v || 0) + 1
    row.updated_at = new Date().toISOString() > row.updated_at ? new Date().toISOString() : row.updated_at
  }

  async function saveView(viewId) {
    pendingViewSaves.delete(viewId)
    const v = s.views.find((x) => x.id === viewId)
    if (!v) return
    try {
      await api.patch(`${base}/views/${enc(viewId)}`, { config: v.config })
    } catch (err) {
      fail(err, 'Could not save the view')
    }
  }

  function emit(change) {
    invalidate()
    if ((change.kind === 'row' || change.kind === 'rows') && s.properties.some((p) => typeOf(p).computed || (isRelation(p) && p.config?.targetModuleId === moduleId))) {
      // rollups and same-database relations can show values from other rows
      for (const r of s.rows) if (r.id !== change.rowId) r._v = (r._v || 0) + 1
    }
    for (const fn of [...listeners]) {
      try {
        fn(change)
      } catch (err) {
        console.warn('[database] listener failed', err)
      }
    }
  }

  function fail(err, fallback) {
    console.warn('[database]', err)
    toast(err?.message || fallback, { type: 'error' })
  }

  return s
}
