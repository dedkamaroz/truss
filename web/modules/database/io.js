// Export (CSV of a view or the whole database, Truss JSON) and import (CSV preview with type overrides,
// CSV into an existing database with a column mapping, Truss JSON round trip).

import { h, modal, toast } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import api from '../../lib/api.js'
import { emit } from '../../lib/registry.js'
import { stringify, neutraliseFormula } from '../../lib/csv.js'
import { viewRows } from './query.js'
import { typeOf, exportText, glyph } from './types.js'
import { IMPORT_TYPES, readCsv, planColumns, buildDocument, CONVERT, OPTION_SPLIT } from './infer.js'

const NEW_DB_BATCH = 5000
const COLOURS = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray']
const count = (n, word) => `${n.toLocaleString('en-AU')} ${word}${n === 1 ? '' : 's'}`
const safeName = (s) => (String(s || 'database').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim() || 'database').slice(0, 120)

/* ------------------------------------------------------------------ export */

export function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = h('a', { href: url, download: filename, hidden: true })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Rows and columns of a CSV export: the current view (filters, search, sorts, hidden properties) or everything. */
export function csvTable(store, view, scope = 'view') {
  const hidden = new Set(view?.config?.hidden || [])
  const props = scope === 'view' ? store.properties.filter((p) => p.type === 'title' || !hidden.has(p.id)) : store.properties
  const rows = scope === 'view' ? viewRows(store, view.config) : store.rows
  return [props.map((p) => neutraliseFormula(p.name)), ...rows.map((r) => props.map((p) => neutraliseFormula(exportText(r, p, store))))]
}

export function exportCsv(ctx, scope) {
  const { store } = ctx
  const view = ctx.view()
  const table = csvTable(store, view, scope)
  const name = scope === 'view' ? `${safeName(store.module?.title)} - ${safeName(view.name)}.csv` : `${safeName(store.module?.title)}.csv`
  download(name, stringify(table, { bom: true }), 'text/csv;charset=utf-8')
  toast(`Exported ${count(table.length - 1, 'row')} to CSV`, { type: 'success' })
}

export function jsonDocument(store) {
  return {
    truss: 1,
    database: {
      id: store.moduleId,
      title: store.module?.title || 'Untitled',
      icon: store.module?.icon || null,
      exported_at: new Date().toISOString(),
      properties: store.properties.map(({ id, name, type, config, width, sort_order }) => ({ id, name, type, config, width, sort_order })),
      views: store.views.map(({ id, name, type, config, sort_order }) => ({ id, name, type, config, sort_order })),
      rows: store.rows.map((r) => ({ id: r.id, values: r.values, notes: r.notes || '', created_at: r.created_at, updated_at: r.updated_at })),
    },
  }
}

export function exportJson(ctx) {
  const { store } = ctx
  store.flush()
  download(`${safeName(store.module?.title)}.json`, JSON.stringify(jsonDocument(store), null, 2), 'application/json')
  toast(`Exported ${count(store.rows.length, 'row')} to JSON`, { type: 'success' })
}

/* ------------------------------------------------------------------ file helpers */

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, hidden: true, class: 'db-import-file' })
    input.addEventListener('change', () => {
      resolve(input.files[0] || null)
      input.remove()
    })
    input.addEventListener('cancel', () => {
      resolve(null)
      input.remove()
    })
    document.body.append(input)
    input.click()
  })
}

const isJsonFile = (file, text) => /\.json$/i.test(file.name) || /^\s*[{[]/.test(text.replace(/^\uFEFF/, '').slice(0, 20))
const failToast = (err, fallback) => toast(err?.message ? `${fallback}: ${err.message}` : fallback, { type: 'error' })

function dialogFooter(close, label, onConfirm) {
  const confirm = h('button', { type: 'button', class: 'btn btn-primary db-import-confirm' }, h('span', { class: 'btn-label' }, label))
  const cancel = h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => close(null) }, h('span', { class: 'btn-label' }, 'Cancel'))
  confirm.addEventListener('click', onConfirm)
  const status = h('span', { class: 'db-import-status', role: 'status' })
  return { el: h('div', { class: 'modal-footer db-import-footer' }, status, cancel, confirm), confirm, cancel, status }
}

/* ------------------------------------------------------------------ import as a new database */

/** Imports a CSV or Truss JSON file as a new database. Resolves the new module or null. */
export async function importNewDatabase(file, { navigate } = {}) {
  let text
  try {
    text = await file.text()
  } catch (err) {
    failToast(err, 'Could not read the file')
    return null
  }
  if (isJsonFile(file, text)) return importJson(file, text, { navigate })
  let parsed
  try {
    parsed = readCsv(text)
  } catch (err) {
    failToast(err, `Could not import "${file.name}"`)
    return null
  }
  return csvPreview(file, parsed, { navigate })
}

async function importJson(file, text, { navigate }) {
  let doc
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    toast(`Could not import "${file.name}": the file is not valid JSON.`, { type: 'error' })
    return null
  }
  if (!doc || doc.truss !== 1 || typeof doc.database !== 'object' || !doc.database) {
    toast(`Could not import "${file.name}": it is not a Truss database export.`, { type: 'error' })
    return null
  }
  try {
    const res = await api.post('/api/databases/import', doc)
    return finishImport(res.module, `Imported ${count(res.rowCount, 'row')} into "${res.module.title}"`, navigate)
  } catch (err) {
    failToast(err, `Could not import "${file.name}"`)
    return null
  }
}

function finishImport(module, message, navigate) {
  emit('modules:changed', { source: 'database', action: 'create', module, moduleId: module.id })
  toast(message, { type: 'success' })
  navigate?.(`#/m/${encodeURIComponent(module.id)}`)
  return module
}

function typeSelect(value, onChange) {
  const iconBox = h('span', { class: 'db-import-type-icon' })
  const sel = h('select', { class: 'db-select db-import-type', 'aria-label': 'Column type' }, IMPORT_TYPES.map((t) => h('option', { value: t.key }, t.label)))
  const paint = () => iconBox.replaceChildren(sel.value === 'skip' ? icon('eye-off', { size: 14 }) : glyph(typeOf({ type: sel.value }).icon, 14))
  sel.value = value
  paint()
  sel.addEventListener('change', () => {
    paint()
    onChange(sel.value)
  })
  return { el: h('span', { class: 'db-import-type-wrap' }, iconBox, sel), sel }
}

function samplesCell(samples) {
  return h('span', { class: 'db-import-samples' }, samples.length
    ? samples.map((s) => h('span', { class: 'db-import-sample', title: s }, s))
    : h('span', { class: 'db-import-empty' }, 'Empty column'))
}

function csvPreview(file, { headers, rows }, { navigate }) {
  const columns = planColumns({ headers, rows })
  const name = h('input', { class: 'input db-import-name', type: 'text', value: file.name.replace(/\.[^.]+$/, ''), 'aria-label': 'Database name', spellcheck: 'false' })
  const selects = []
  const setType = (col, type) => {
    if (type === 'title') {
      for (const c of columns) {
        if (c !== col && c.type === 'title') {
          c.type = c.inferred === 'title' ? 'text' : c.inferred
          selects[c.index].sel.value = c.type
          selects[c.index].sel.dispatchEvent(new Event('change'))
        }
      }
    }
    col.type = type
  }
  const list = h('div', { class: 'db-import-cols', role: 'table', 'aria-label': 'Columns' },
    h('div', { class: 'db-import-head', role: 'row' }, h('span', { role: 'columnheader' }, 'Column'), h('span', { role: 'columnheader' }, 'Type'), h('span', { role: 'columnheader' }, 'Sample values')),
    columns.map((c) => {
      const input = h('input', { class: 'input input-sm db-import-col-name', type: 'text', value: c.name, 'aria-label': `Name for column ${c.index + 1}`, spellcheck: 'false' })
      input.addEventListener('input', () => { c.name = input.value.trim() || headers[c.index] })
      const sel = typeSelect(c.type, (type) => setType(c, type))
      selects[c.index] = sel
      return h('div', { class: 'db-import-col', role: 'row', dataset: { column: c.name, inferred: c.inferred } }, input, sel.el, samplesCell(c.samples))
    }))
  const body = h('div', { class: 'db-dialog db-import' },
    h('label', { class: 'db-dialog-field' }, h('span', { class: 'field-label' }, 'Database name'), name),
    h('div', { class: 'db-import-summary' }, icon('file', { size: 14 }), h('span', {}, `${file.name}`), h('span', { class: 'db-import-dot', 'aria-hidden': 'true' }), h('span', {}, count(rows.length, 'row')), h('span', { class: 'db-import-dot', 'aria-hidden': 'true' }), h('span', {}, count(headers.length, 'column'))),
    h('p', { class: 'db-dialog-help' }, 'Types were detected from the values. Change any column before importing.'),
    list)
  let busy = false
  return modal({
    title: 'Import CSV', description: 'Create a new database from a spreadsheet export.', size: 'lg', className: 'db-modal db-import-modal', actions: [], body,
    onOpen: ({ close, dialog }) => {
      const footer = dialogFooter((v) => !busy && close(v), `Import ${count(rows.length, 'row')}`, async () => {
        if (busy) return
        busy = true
        footer.confirm.disabled = footer.cancel.disabled = true
        footer.status.textContent = 'Importing...'
        try {
          const module = await createFromCsv({ title: name.value.trim() || 'Imported database', rows, columns }, (done) => {
            footer.status.textContent = `Importing ${done.toLocaleString('en-AU')} of ${rows.length.toLocaleString('en-AU')}...`
          })
          busy = false
          close(module)
          finishImport(module, `Imported ${count(rows.length, 'row')} into "${module.title}"`, navigate)
        } catch (err) {
          busy = false
          footer.confirm.disabled = footer.cancel.disabled = false
          footer.status.textContent = ''
          failToast(err, 'Import failed')
        }
      })
      dialog.append(footer.el)
      name.select()
    },
  })
}

async function createFromCsv({ title, rows, columns }, onProgress) {
  const doc = buildDocument({ title, rows, columns })
  const all = doc.database.rows
  doc.database.rows = all.slice(0, NEW_DB_BATCH)
  const res = await api.post('/api/databases/import', doc)
  onProgress?.(doc.database.rows.length)
  try {
    for (let i = NEW_DB_BATCH; i < all.length; i += NEW_DB_BATCH) {
      const create = all.slice(i, i + NEW_DB_BATCH).map((r) => ({ values: Object.fromEntries(Object.entries(r.values).map(([k, v]) => [res.propertyIds[k], v])) }))
      await api.post(`/api/databases/${encodeURIComponent(res.module.id)}/rows/batch`, { create })
      onProgress?.(Math.min(all.length, i + NEW_DB_BATCH))
    }
  } catch (err) {
    await api.del(`/api/modules/${encodeURIComponent(res.module.id)}`).catch(() => {}) // all or nothing
    throw err
  }
  return res.module
}

/* ------------------------------------------------------------------ import into this database */

export async function importIntoDatabase(ctx, file) {
  const { store } = ctx
  let parsed
  try {
    const text = await file.text()
    if (isJsonFile(file, text)) throw new Error('choose a CSV file to add rows to this database')
    parsed = readCsv(text)
  } catch (err) {
    failToast(err, `Could not import "${file.name}"`)
    return null
  }
  const { headers, rows } = parsed
  const columns = planColumns(parsed)
  const writable = store.properties.filter((p) => !typeOf(p).readOnly && typeOf(p).parse && (CONVERT[p.type] || OPTION_SPLIT[p.type] || typeOf(p).relation))
  const byName = new Map(writable.map((p) => [p.name.toLocaleLowerCase('en-AU'), p]))
  const mapping = columns.map((c) => byName.get(c.name.toLocaleLowerCase('en-AU'))?.id || '')
  const list = h('div', { class: 'db-import-cols is-mapping', role: 'table', 'aria-label': 'Column mapping' },
    h('div', { class: 'db-import-head', role: 'row' }, h('span', { role: 'columnheader' }, 'CSV column'), h('span', { role: 'columnheader' }, 'Property'), h('span', { role: 'columnheader' }, 'Sample values')),
    columns.map((c, i) => {
      const iconBox = h('span', { class: 'db-import-type-icon' })
      const sel = h('select', { class: 'db-select db-import-map', 'aria-label': `Property for ${c.name}` },
        h('option', { value: '' }, 'Do not import'), writable.map((p) => h('option', { value: p.id }, p.name)))
      const paint = () => iconBox.replaceChildren(sel.value ? glyph(typeOf(store.propById.get(sel.value)).icon, 14) : icon('eye-off', { size: 14 }))
      sel.value = mapping[i]
      paint()
      sel.addEventListener('change', () => { mapping[i] = sel.value; paint() })
      return h('div', { class: 'db-import-col', role: 'row', dataset: { column: c.name } }, h('span', { class: 'db-import-col-label', title: c.name }, c.name), h('span', { class: 'db-import-type-wrap' }, iconBox, sel), samplesCell(c.samples))
    }))
  const body = h('div', { class: 'db-dialog db-import' },
    h('div', { class: 'db-import-summary' }, icon('file', { size: 14 }), h('span', {}, file.name), h('span', { class: 'db-import-dot', 'aria-hidden': 'true' }), h('span', {}, count(rows.length, 'row'))),
    h('p', { class: 'db-dialog-help' }, 'Choose the property each column fills. New rows are added after the existing ones.'),
    list)
  let busy = false
  return modal({
    title: `Import into ${store.module?.title || 'this database'}`, size: 'lg', className: 'db-modal db-import-modal', actions: [], body,
    onOpen: ({ close, dialog }) => {
      const footer = dialogFooter((v) => !busy && close(v), `Add ${count(rows.length, 'row')}`, async () => {
        if (busy) return
        if (!mapping.some(Boolean)) return toast('Map at least one column to a property.', { type: 'error' })
        busy = true
        footer.confirm.disabled = footer.cancel.disabled = true
        footer.status.textContent = 'Importing...'
        try {
          const created = await appendRows(store, headers, rows, mapping, (done, total) => {
            footer.status.textContent = `Importing ${done.toLocaleString('en-AU')} of ${total.toLocaleString('en-AU')}...`
          })
          busy = false
          close(created)
          toast(`Added ${count(created.length, 'row')}`, { type: 'success' })
        } catch (err) {
          busy = false
          footer.confirm.disabled = footer.cancel.disabled = false
          footer.status.textContent = ''
          failToast(err, 'Import failed')
        }
      })
      dialog.append(footer.el)
      footer.confirm.focus()
    },
  })
}

async function appendRows(store, headers, rows, mapping, onProgress) {
  const used = mapping.map((id, i) => [i, id && store.propById.get(id)]).filter(([, p]) => p)
  // option types: add options that the file uses but the property does not have yet
  for (const [i, p] of used) {
    if (!OPTION_SPLIT[p.type]) continue
    const known = new Set((p.config.options || []).map((o) => o.name.toLocaleLowerCase('en-AU')))
    const extra = []
    for (const r of rows) {
      for (const n of OPTION_SPLIT[p.type](r[i])) {
        const key = n.toLocaleLowerCase('en-AU')
        if (known.has(key)) continue
        known.add(key)
        extra.push({ id: crypto.randomUUID(), name: n.slice(0, 200), color: COLOURS[(p.config.options.length + extra.length) % COLOURS.length], ...(p.config.options[0]?.group ? { group: 'todo' } : {}) })
      }
    }
    if (extra.length) await store.updateProperty(p.id, { config: { ...p.config, options: [...p.config.options, ...extra] } })
  }
  const props = used.map(([i, p]) => [i, store.propById.get(p.id)])
  const valuesList = rows.map((r) => {
    const values = {}
    for (const [i, p] of props) {
      const text = r[i]
      let v
      if (CONVERT[p.type]) v = CONVERT[p.type](text)
      else {
        try {
          v = typeOf(p).parse(text, p)
        } catch {
          v = undefined
        }
      }
      if (v != null && !(Array.isArray(v) && !v.length) && v !== '') values[p.id] = v
    }
    return values
  })
  return store.importRows(valuesList, onProgress)
}

/* ------------------------------------------------------------------ import page (sidebar) */

export function mountImportPage(el, { navigate }) {
  const drop = h('div', { class: 'db-import-drop', tabindex: '0', role: 'button', 'aria-label': 'Choose a CSV or JSON file to import' },
    h('span', { class: 'db-import-drop-icon' }, icon('upload', { size: 22 })),
    h('p', { class: 'db-import-drop-title' }, 'Drop a CSV or Truss JSON file here'),
    h('p', { class: 'db-import-drop-text' }, 'CSV files open a preview where you can check each column type. JSON exports from Truss are restored with their properties, views and relations.'),
    h('span', { class: 'btn btn-primary btn-sm db-import-choose' }, icon('file', { size: 14 }), h('span', { class: 'btn-label' }, 'Choose file')))
  const run = async (file) => {
    if (!file) return
    drop.classList.add('is-busy')
    try {
      await importNewDatabase(file, { navigate })
    } finally {
      drop.classList.remove('is-busy')
    }
  }
  drop.addEventListener('click', async () => run(await pickFile('.csv,.json,text/csv,application/json')))
  drop.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), run(await pickFile('.csv,.json,text/csv,application/json')))
  })
  drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('is-over')))
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'))
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('is-over')
    run(e.dataTransfer.files[0])
  })
  const page = h('div', { class: 'page db-import-page' },
    h('h1', { class: 'db-import-page-title' }, 'Import a database'),
    h('p', { class: 'db-import-page-text' }, 'Bring in a spreadsheet or restore a database exported from Truss.'),
    drop)
  el.append(page)
  return { unmount: () => page.remove() }
}
