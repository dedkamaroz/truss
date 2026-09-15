// Client-side database state with optimistic mutations. Views subscribe to change events.

import { toast } from '../../lib/ui.js'

const enc = encodeURIComponent

export function createStore(api, moduleId) {
  const base = `/api/databases/${enc(moduleId)}`
  const listeners = new Set()
  const pendingViewSaves = new Map() // viewId -> timer

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
        await api.del(`${base}/properties/${enc(id)}`)
        for (const r of s.rows) if (id in r.values) (delete r.values[id], touch(r))
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
