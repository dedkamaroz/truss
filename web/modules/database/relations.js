// Relations, rollups and formulas: loaded databases by id, computed values (cached per data generation)
// and their editors (relation picker, setup dialogs, formula editor). Type entries live in types.js.

import { h, popover, modal, toast, formatDate } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import api from '../../lib/api.js'
import { evaluateExpression, parse, err, isError, dateToSerial } from '../../lib/formula/index.js'
import { keepInView } from './fit.js'

let T = null // { typeOf, getValue, valueText, isEmptyValue, glyph } bound by types.js (avoids an import cycle)
export const bindTypes = (t) => { T = t }

const lower = (s) => String(s ?? '').toLocaleLowerCase('en-AU')
const collator = new Intl.Collator('en-AU', { sensitivity: 'base', numeric: true })

/* ------------------------------------------------------------------ loaded databases */

const DBS = new Map() // moduleId -> { moduleId, module, properties, propById, rows, rowById }
let GEN = 1

export function registerDb(db) {
  DBS.set(db.moduleId, db)
  GEN++
}
export function unregisterDb(db) {
  if (DBS.get(db.moduleId) === db) DBS.delete(db.moduleId)
  GEN++
}
/** Call after any data change: computed values are recomputed lazily on next read. */
export const invalidate = () => { GEN++ }
export const dbFor = (moduleId) => (moduleId ? DBS.get(moduleId) || null : null)
export const titlePropOf = (db) => db?.properties.find((p) => p.type === 'title') || null
export const rowTitle = (db, row) => (row && titlePropOf(db) ? row.values[titlePropOf(db).id] || '' : '')

/** Related rows of a relation value, in link order, skipping ids that are not loaded. */
export function relatedRows(prop, ids) {
  const tdb = dbFor(prop.config?.targetModuleId)
  if (!tdb || !Array.isArray(ids)) return []
  return ids.map((id) => tdb.rowById.get(id)).filter(Boolean)
}
export const relatedTitles = (prop, ids) => {
  const tdb = dbFor(prop.config?.targetModuleId)
  return relatedRows(prop, ids).map((r) => rowTitle(tdb, r) || 'Untitled')
}

/* ------------------------------------------------------------------ computed value cache */

const inProgress = new Set()

export function cached(row, prop, compute) {
  if (row._cg !== GEN) {
    row._cg = GEN
    row._cv = new Map()
  }
  if (row._cv.has(prop.id)) return row._cv.get(prop.id)
  const key = `${row.id}|${prop.id}`
  if (inProgress.has(key)) return err('#CYCLE!')
  inProgress.add(key)
  let v
  try {
    v = compute()
  } catch (e) {
    console.warn('[database] computed value failed', e)
    v = err('#VALUE!')
  } finally {
    inProgress.delete(key)
  }
  row._cv.set(prop.id, v)
  return v
}

/* ------------------------------------------------------------------ rollups */

export const ROLLUP_FNS = [
  { key: 'show_original', label: 'Show original', kind: 'text' },
  { key: 'count', label: 'Count all', kind: 'count' },
  { key: 'count_values', label: 'Count values', kind: 'count' },
  { key: 'count_unique', label: 'Count unique values', kind: 'count' },
  { key: 'percent_empty', label: 'Percent empty', kind: 'percent' },
  { key: 'percent_checked', label: 'Percent checked', kind: 'percent' },
  { key: 'sum', label: 'Sum', kind: 'number' },
  { key: 'average', label: 'Average', kind: 'number' },
  { key: 'median', label: 'Median', kind: 'number' },
  { key: 'min', label: 'Min', kind: 'number' },
  { key: 'max', label: 'Max', kind: 'number' },
  { key: 'range', label: 'Range', kind: 'number' },
  { key: 'earliest_date', label: 'Earliest date', kind: 'date' },
  { key: 'latest_date', label: 'Latest date', kind: 'date' },
]
const FN_BY_KEY = new Map(ROLLUP_FNS.map((f) => [f.key, f]))
export const rollupFn = (prop) => FN_BY_KEY.get(prop.config?.fn) || FN_BY_KEY.get('count')

/** { relation, targetDb, target } for a rollup property (any may be null). */
export function rollupParts(prop) {
  const db = dbFor(prop.module_id)
  const relation = db?.propById.get(prop.config?.relationPropertyId) || null
  const targetDb = relation ? dbFor(relation.config?.targetModuleId) : null
  const target = targetDb?.propById.get(prop.config?.targetPropertyId) || null
  return { db, relation, targetDb, target }
}

const sumOf = (xs) => xs.reduce((a, b) => a + b, 0)
const flatValues = (vals) => vals.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => !T.isEmptyValue(v))
const ROLLUP_CALC = {
  count: (rows) => rows.length,
  count_values: (rows, vals) => flatValues(vals).length,
  count_unique: (rows, vals) => new Set(flatValues(vals).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))).size,
  percent_empty: (rows, vals) => (rows.length ? (vals.filter((v) => T.isEmptyValue(v)).length / rows.length) * 100 : 0),
  percent_checked: (rows, vals) => (rows.length ? (vals.filter((v) => v === true).length / rows.length) * 100 : 0),
  sum: (rows, vals, nums) => sumOf(nums),
  average: (rows, vals, nums) => (nums.length ? sumOf(nums) / nums.length : null),
  median: (rows, vals, nums) => {
    if (!nums.length) return null
    const s = [...nums].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  },
  min: (rows, vals, nums) => (nums.length ? nums.reduce((a, b) => (b < a ? b : a)) : null),
  max: (rows, vals, nums) => (nums.length ? nums.reduce((a, b) => (b > a ? b : a)) : null),
  range: (rows, vals, nums) => (nums.length ? ROLLUP_CALC.max(rows, vals, nums) - ROLLUP_CALC.min(rows, vals, nums) : null),
  earliest_date: (rows, vals, nums, days) => (days.length ? days.reduce((a, b) => (b < a ? b : a)) : null),
  latest_date: (rows, vals, nums, days) => (days.length ? days.reduce((a, b) => (b > a ? b : a)) : null),
}

export function rollupValue(row, prop) {
  return cached(row, prop, () => {
    const { relation, targetDb, target } = rollupParts(prop)
    if (!relation || !targetDb) return null
    const rows = (row.values[relation.id] || []).map((id) => targetDb.rowById.get(id)).filter(Boolean)
    const fn = rollupFn(prop).key
    if (fn === 'count') return rows.length
    if (!target) return null
    if (fn === 'show_original') return rows.map((r) => T.valueText(r, target, targetDb)).filter(Boolean).join(', ')
    const vals = rows.map((r) => T.getValue(r, target))
    const nums = vals.filter((v) => typeof v === 'number' && Number.isFinite(v))
    const day = T.typeOf(target).day
    const days = vals.map((v) => (day ? day(v, target) : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)).filter(Boolean)
    return ROLLUP_CALC[fn](rows, vals, nums, days)
  })
}

const pct = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 })
const plain = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 2 })

export function rollupText(v, prop) {
  if (v == null || v === '') return ''
  const { kind } = rollupFn(prop)
  if (kind === 'percent') return `${pct.format(v)}%`
  if (kind === 'date') return formatDate(v)
  if (kind === 'count') return String(v)
  if (kind === 'number') {
    const { target } = rollupParts(prop)
    const rounded = Math.round(v * 100) / 100
    const t = target && T.typeOf(target)
    return t?.formats ? t.text(rounded, target) : plain.format(rounded)
  }
  return String(v)
}

/** 'number' | 'date' | 'text': how a rollup's values sort and filter. */
export const rollupKind = (prop) => ({ percent: 'number', count: 'number', number: 'number', date: 'date' }[rollupFn(prop).kind] || 'text')

/* ------------------------------------------------------------------ lookups */

/** { db, source, targetDb, match, ret } for a lookup property (any may be null). */
export function lookupParts(prop) {
  const db = dbFor(prop.module_id)
  const c = prop.config || {}
  const targetDb = dbFor(c.targetModuleId)
  return {
    db, targetDb,
    source: db?.propById.get(c.sourcePropertyId) || null,
    match: targetDb?.propById.get(c.matchPropertyId) || null,
    ret: targetDb?.propById.get(c.returnPropertyId) || null,
  }
}

/** Match key: the unformatted text of a value (raw numbers, DD/MM/YYYY dates, option names), trimmed and lowercased. */
function lookupKey(row, prop, db) {
  const t = T.typeOf(prop)
  const v = T.getValue(row, prop)
  if (isError(v)) return ''
  return lower(String((t.serialise || t.text)(v, prop, row, db) ?? '').trim())
}

const indexes = new WeakMap() // target db -> { gen, byProp: Map(propId -> Map(key -> first row)) }
const building = new Set() // `${moduleId}|${propId}` while an index is being built

/** First row of db per match key, rebuilt once per data generation. Null while that index is being built (a cycle). */
function lookupIndex(db, match) {
  let entry = indexes.get(db)
  if (entry?.gen !== GEN) indexes.set(db, (entry = { gen: GEN, byProp: new Map() }))
  let index = entry.byProp.get(match.id)
  if (index) return index
  const key = `${db.moduleId}|${match.id}`
  if (building.has(key)) return null
  building.add(key)
  try {
    index = new Map()
    for (const r of db.rows) {
      const k = lookupKey(r, match, db)
      if (k && !index.has(k)) index.set(k, r)
    }
  } finally {
    building.delete(key)
  }
  entry.byProp.set(match.id, index)
  return index
}

/** 'number' | 'date' | 'boolean' | 'text': how a lookup's values display, sort and filter. */
const lookupKinds = new WeakMap() // prop -> { gen, kind }
export function lookupKind(prop) {
  const hit = lookupKinds.get(prop)
  if (hit?.gen === GEN) return hit.kind
  const kind = detectLookupKind(prop)
  lookupKinds.set(prop, { gen: GEN, kind })
  return kind
}

function detectLookupKind(prop) {
  const { ret, targetDb } = lookupParts(prop)
  if (!ret || !targetDb) return 'text'
  const t = T.typeOf(ret)
  if (t.day && !t.computed) return 'date'
  if (t.formats) return 'number'
  for (const r of targetDb.rows.slice(0, 50)) {
    const v = T.getValue(r, ret)
    if (typeof v === 'boolean' && !t.isEmpty?.(v)) return 'boolean'
    if (typeof v === 'number') return 'number'
    if (v != null && v !== '') return 'text'
  }
  return 'text'
}

/** The matched target row with its return column and database: { hit, ret, targetDb }, null when unset or blank, or an error value. */
export function lookupHit(row, prop) {
  const { db, source, targetDb, match, ret } = lookupParts(prop)
  if (!db || !source || !targetDb || !match || !ret) return null
  const key = lookupKey(row, source, db)
  if (!key) return null
  const index = lookupIndex(targetDb, match)
  if (!index) return err('#CYCLE!')
  const hit = index.get(key)
  return hit ? { hit, ret, targetDb } : err('#N/A')
}

/**
 * VLOOKUP: the return column of the first target row whose match column equals this row's source column
 * (case-insensitive). Blank when the search value is empty, #N/A when nothing matches.
 * Values are plain: number, boolean, ISO day (date kind) or display text.
 */
export function lookupValue(row, prop) {
  return cached(row, prop, () => {
    const found = lookupHit(row, prop)
    if (!found || isError(found)) return found
    const { hit, ret, targetDb } = found
    const v = T.getValue(hit, ret)
    if (isError(v)) return v
    const kind = lookupKind(prop)
    if (kind === 'date') return T.typeOf(ret).day(v, ret) || null
    if (kind === 'number') return typeof v === 'number' ? v : null
    if (kind === 'boolean') return v === true
    return T.valueText(hit, ret, targetDb) || null
  })
}

export function lookupText(v, prop) {
  if (v == null || v === '') return ''
  if (isError(v)) return v.error
  const kind = lookupKind(prop)
  if (kind === 'date') return formatDate(v)
  if (kind === 'boolean') return v ? 'Checked' : 'Unchecked'
  if (kind === 'number') {
    const { ret } = lookupParts(prop)
    const t = ret && T.typeOf(ret)
    return t?.formats ? t.text(v, ret) : plain.format(v)
  }
  return String(v)
}

/** Pick the search column, database, match column and return column. Resolves the lookup config or null. */
export async function lookupSetup({ store, current }) {
  let modules
  try {
    modules = (await api.get('/api/modules')).filter((m) => m.type === 'database')
  } catch (e) {
    toast(e?.message || 'Could not load databases', { type: 'error' })
    return null
  }
  const searchable = store.properties
  const state = {
    sourcePropertyId: current?.sourcePropertyId || titlePropOf(store)?.id || searchable[0]?.id || null,
    targetModuleId: current?.targetModuleId || modules.find((m) => m.id !== store.moduleId)?.id || modules[0]?.id || null,
    matchPropertyId: current?.matchPropertyId || null,
    returnPropertyId: current?.returnPropertyId || null,
  }
  let targetProps = []
  const field = (label, control, help) => h('label', { class: 'db-dialog-field' }, h('span', { class: 'field-label' }, label), control, help ? h('span', { class: 'db-dialog-help' }, help) : null)
  const sourceSel = h('select', { class: 'db-select db-lookup-source', 'aria-label': 'Search with' }, searchable.map((p) => h('option', { value: p.id }, p.name)))
  const dbSel = h('select', { class: 'db-select db-lookup-target', 'aria-label': 'In database' },
    modules.map((m) => h('option', { value: m.id }, m.id === store.moduleId ? `${m.title} (this database)` : m.title)))
  const matchSel = h('select', { class: 'db-select db-lookup-match', 'aria-label': 'Match on' })
  const returnSel = h('select', { class: 'db-select db-lookup-return', 'aria-label': 'Return' })
  let footer
  const options = (sel, value) => {
    sel.replaceChildren(...targetProps.map((p) => h('option', { value: p.id }, p.name)))
    sel.value = value || ''
  }
  async function loadTarget() {
    const id = state.targetModuleId
    let props = dbFor(id)?.properties
    if (!props && id) {
      for (const sel of [matchSel, returnSel]) (sel.disabled = true, sel.replaceChildren(h('option', {}, 'Loading...')))
      if (footer) footer.confirm.disabled = true
      props = await api.get(`/api/databases/${encodeURIComponent(id)}`).then((d) => d.properties, (e) => {
        toast(e?.message || 'Could not load that database', { type: 'error' })
        return []
      })
      for (const sel of [matchSel, returnSel]) sel.disabled = false
    }
    if (id !== state.targetModuleId) return // changed while loading
    targetProps = [...(props || [])].sort((a, b) => a.sort_order - b.sort_order)
    const has = (pid) => targetProps.some((p) => p.id === pid)
    if (!has(state.matchPropertyId)) state.matchPropertyId = targetProps.find((p) => p.type === 'title')?.id || targetProps[0]?.id || null
    if (!has(state.returnPropertyId)) state.returnPropertyId = targetProps.find((p) => p.id !== state.matchPropertyId)?.id || state.matchPropertyId
    options(matchSel, state.matchPropertyId)
    options(returnSel, state.returnPropertyId)
    if (footer) footer.confirm.disabled = !ready()
  }
  const ready = () => !!(state.sourcePropertyId && state.targetModuleId && state.matchPropertyId && state.returnPropertyId)
  sourceSel.value = state.sourcePropertyId || ''
  dbSel.value = state.targetModuleId || ''
  sourceSel.addEventListener('change', () => { state.sourcePropertyId = sourceSel.value })
  dbSel.addEventListener('change', () => { state.targetModuleId = dbSel.value; loadTarget() })
  matchSel.addEventListener('change', () => { state.matchPropertyId = matchSel.value })
  returnSel.addEventListener('change', () => { state.returnPropertyId = returnSel.value })
  await loadTarget()
  const body = h('div', { class: 'db-dialog db-lookup-setup' },
    field('Search with', sourceSel, 'The value in this row to look for.'),
    field('In database', dbSel),
    field('Match on', matchSel, 'The first row whose value here matches (ignoring upper and lower case) is used.'),
    field('Return', returnSel, 'Shown in this column. #N/A means no row matched.'))
  return modal({
    title: current ? 'Lookup settings' : 'New lookup', description: 'Show a value from another database, like VLOOKUP in Excel.',
    size: 'sm', className: 'db-modal db-lookup-modal', actions: [], body,
    onOpen: ({ close, dialog }) => {
      footer = dialogFooter(close, current ? 'Save' : 'Create lookup', () => ready() && close({ ...state }))
      footer.confirm.disabled = !ready()
      dialog.append(footer.el)
      sourceSel.focus()
    },
  })
}

/* ------------------------------------------------------------------ formulas */

const syntaxCache = new Map()
export function formulaSyntaxError(expression) {
  const src = String(expression ?? '')
  if (!syntaxCache.has(src)) {
    let message = null
    try {
      parse(src.replace(/^\s*=/, ''))
    } catch (e) {
      message = e?.message || 'Syntax error'
    }
    if (syntaxCache.size > 500) syntaxCache.clear()
    syntaxCache.set(src, message)
  }
  return syntaxCache.get(src)
}

function propArg(row, db, name) {
  if (typeof name !== 'string') return err('#VALUE!')
  const p = db.properties.find((x) => x.name === name) || db.properties.find((x) => lower(x.name) === lower(name))
  if (!p) return err('#REF!')
  const v = T.getValue(row, p)
  const hook = T.typeOf(p).formula
  if (hook) return hook(v, p, row, db)
  if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || isError(v)) return v ?? null
  return T.valueText(row, p, db)
}

export function formulaValue(row, prop) {
  return cached(row, prop, () => evaluateFormula(prop.config?.expression, row, dbFor(prop.module_id)))
}

export function evaluateFormula(expression, row, db) {
  const src = String(expression ?? '')
  if (!src.trim() || !db || !row) return null
  if (formulaSyntaxError(src)) return { error: '#SYNTAX!' }
  const v = evaluateExpression(src, { functions: { prop: (name) => propArg(row, db, name) } })
  return v === undefined ? null : v
}

/** Most common result type over the first rows: 'number' | 'boolean' | 'text'. */
const kindCache = new WeakMap()
export function formulaKind(prop) {
  const hit = kindCache.get(prop)
  if (hit?.gen === GEN) return hit.kind
  const db = dbFor(prop.module_id)
  const counts = { number: 0, boolean: 0, text: 0 }
  for (const row of db?.rows.slice(0, 100) || []) {
    const v = formulaValue(row, prop)
    if (typeof v === 'number') counts.number++
    else if (typeof v === 'boolean') counts.boolean++
    else if (typeof v === 'string' && v) counts.text++
  }
  const kind = counts.number >= counts.text && counts.number >= counts.boolean && counts.number ? 'number' : counts.boolean > counts.text ? 'boolean' : 'text'
  kindCache.set(prop, { gen: GEN, kind })
  return kind
}

export const formulaDateSerial = (iso) => (iso ? dateToSerial(+iso.slice(0, 4), +iso.slice(5, 7), +iso.slice(8, 10)) : null)

export const ERROR_HINTS = {
  '#SYNTAX!': 'The formula has a syntax error',
  '#REF!': 'A prop("...") name does not match any property',
  '#NAME?': 'Unknown function name',
  '#VALUE!': 'A value has the wrong type',
  '#DIV/0!': 'Division by zero',
  '#CYCLE!': 'The formula refers to itself',
  '#NUM!': 'Invalid number',
  '#N/A': 'Value not available',
}

/* ------------------------------------------------------------------ relation picker */

const MAX_RESULTS = 50

export function relationEditor({ anchor, prop: initialProp, row, store, onDone }) {
  const prop = () => store.propById.get(initialProp.id) || initialProp
  const target = () => dbFor(prop().config?.targetModuleId)
  const linked = () => store.rowById.get(row.id)?.values[initialProp.id] || []
  let active = 0
  let items = []
  const input = h('input', { class: 'db-opt-input db-rel-search', type: 'text', spellcheck: 'false', 'aria-label': 'Search rows to link' })
  const list = h('div', { class: 'db-opt-list db-rel-list', role: 'listbox', 'aria-label': 'Rows' })
  const content = h('div', { class: 'db-opt-editor db-rel-editor' },
    h('div', { class: 'db-opt-head' }, icon('search', { size: 14, className: 'db-rel-search-icon' }), input), list)

  const setIds = (ids) => store.updateValues(row.id, { [initialProp.id]: ids }).catch(() => {}).then(render)
  const toggle = (id) => {
    const cur = linked()
    setIds(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
  }
  async function createAndLink(title) {
    const tdb = target()
    const tp = titlePropOf(tdb)
    if (!tdb || !tp) return
    try {
      const created = tdb === store ? await store.createRow({ values: { [tp.id]: title } }) : await store.createRelatedRow(tdb.moduleId, { [tp.id]: title })
      input.value = ''
      await setIds([...linked(), created.id])
    } catch {
      /* the store already reported the error */
    }
  }

  function render() {
    const tdb = target()
    const q = lower(input.value.trim())
    const rows = []
    items = []
    if (!tdb) {
      list.replaceChildren(h('div', { class: 'db-opt-empty' }, 'The related database is not available.'))
      return
    }
    input.placeholder = `Search ${tdb.module?.title || 'rows'}`
    const cur = linked()
    const curSet = new Set(cur)
    const linkedRows = cur.map((id) => tdb.rowById.get(id)).filter(Boolean)
    const title = (r) => rowTitle(tdb, r)
    const option = (r, isLinked) => {
      const i = items.length
      items.push({ kind: 'row', id: r.id })
      return h('div', {
        class: `db-opt-row db-rel-row${isLinked ? ' is-selected' : ''}${i === active ? ' is-active' : ''}`, role: 'option', 'aria-selected': String(isLinked),
        dataset: { rowId: r.id }, onClick: () => toggle(r.id), onMousemove: () => { if (active !== i) (active = i, paint()) },
      }, h('span', { class: 'db-rel-icon' }, icon('page', { size: 14 })), h('span', { class: `db-rel-title${title(r) ? '' : ' is-empty'}` }, title(r) || 'Untitled'),
      h('span', { class: 'db-opt-spacer' }),
      isLinked ? h('span', { class: 'db-rel-action', title: 'Remove link', 'aria-hidden': 'true' }, icon('close', { size: 12 })) : h('span', { class: 'db-rel-action is-add', 'aria-hidden': 'true' }, icon('plus', { size: 12 })))
    }
    const shownLinked = linkedRows.filter((r) => !q || lower(title(r)).includes(q))
    if (shownLinked.length) {
      rows.push(h('div', { class: 'db-opt-hint' }, `Linked (${linkedRows.length})`))
      for (const r of shownLinked) rows.push(option(r, true))
    }
    let total = 0
    const results = []
    for (const r of tdb.rows) {
      if (curSet.has(r.id) || (q && !lower(title(r)).includes(q))) continue
      total++
      if (results.length < MAX_RESULTS) results.push(r)
    }
    rows.push(h('div', { class: 'db-opt-hint' }, q ? `Results in ${tdb.module?.title || 'database'}` : `Link a row from ${tdb.module?.title || 'the database'}`))
    for (const r of results) rows.push(option(r, false))
    const exact = q && tdb.rows.some((r) => lower(title(r)) === q)
    if (q && !exact) {
      const i = items.length
      items.push({ kind: 'create', title: input.value.trim() })
      rows.push(h('div', { class: `db-opt-row db-opt-create${i === active ? ' is-active' : ''}`, role: 'option', onClick: () => createAndLink(input.value.trim()), onMousemove: () => { if (active !== i) (active = i, paint()) } },
        h('span', { class: 'db-rel-icon' }, icon('plus', { size: 14 })), h('span', { class: 'db-opt-create-label' }, 'New row'), h('span', { class: 'db-rel-title' }, input.value.trim())))
    }
    if (!total && !(q && !exact)) rows.push(h('div', { class: 'db-opt-empty' }, q ? 'No matching rows' : tdb.rows.length ? 'Every row is already linked' : 'No rows yet. Type a name to create one.'))
    if (total > results.length) rows.push(h('div', { class: 'db-rel-more' }, `Showing ${results.length} of ${total.toLocaleString('en-AU')}. Keep typing to narrow the list.`))
    active = Math.min(active, Math.max(0, items.length - 1))
    list.replaceChildren(...rows)
    paint()
  }
  const paint = () => [...list.querySelectorAll('.db-opt-row')].forEach((el, i) => el.classList.toggle('is-active', i === active))

  input.addEventListener('input', () => { active = 0; render() })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      paint()
      list.querySelectorAll('.db-opt-row')[active]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[active]
      if (it?.kind === 'row') toggle(it.id)
      else if (it?.kind === 'create') createAndLink(it.title)
    }
  })
  render()
  const unsubscribe = store.on((change) => { if (change.kind === 'related' || change.kind === 'rows') render() })
  const pop = popover(anchor, content, { className: 'db-popover db-popover-options db-popover-relation', onClose: () => { unsubscribe(); onDone?.({}) } })
  keepInView(pop.el)
  input.focus()
  return { close: () => pop.close() }
}

/* ------------------------------------------------------------------ dialogs */

function dialogFooter(close, confirmLabel, onConfirm) {
  const confirm = h('button', { type: 'button', class: 'btn btn-primary db-dialog-confirm' }, h('span', { class: 'btn-label' }, confirmLabel))
  confirm.addEventListener('click', onConfirm)
  return { el: h('div', { class: 'modal-footer' }, h('button', { type: 'button', class: 'btn btn-secondary', onClick: () => close(null) }, h('span', { class: 'btn-label' }, 'Cancel')), confirm), confirm }
}

/**
 * Choose the related database and two-way sync. Resolves { targetModuleId, twoWay } or null.
 * With list: choose the database a list column comes from (not this one, no two-way). Resolves { sourceModuleId } or null.
 */
export async function relationSetup({ store, current, list = false }) {
  let modules
  try {
    modules = (await api.get('/api/modules')).filter((m) => m.type === 'database' && !(list && m.id === store.moduleId))
  } catch (e) {
    toast(e?.message || 'Could not load databases', { type: 'error' })
    return null
  }
  let picked = (list ? current?.sourceModuleId : current?.targetModuleId) || null
  const twoWay = h('input', { type: 'checkbox', class: 'db-switch db-rel-twoway', checked: current ? !!current.twoWay : true, 'aria-label': 'Two-way relation' })
  const search = h('input', { class: 'input input-sm db-rel-db-search', type: 'search', placeholder: 'Search databases', 'aria-label': 'Search databases', spellcheck: 'false' })
  const listEl = h('div', { class: 'db-rel-dbs', role: 'listbox', 'aria-label': 'Databases' })
  const twoWayText = h('span', { class: 'db-rel-twoway-text' })
  let footer
  const nameOf = (m) => (m.id === store.moduleId ? `${m.title} (this database)` : m.title)
  function render() {
    const q = lower(search.value.trim())
    const shown = modules.filter((m) => !q || lower(m.title).includes(q))
    listEl.replaceChildren(...shown.map((m) => h('button', {
      type: 'button', class: `db-rel-db${m.id === picked ? ' is-selected' : ''}`, role: 'option', 'aria-selected': String(m.id === picked), dataset: { moduleId: m.id },
      onClick: () => { picked = m.id; render() },
    }, h('span', { class: 'db-rel-db-icon' }, m.icon ? h('span', { class: 'db-rel-emoji' }, m.icon) : icon('database', { size: 16 })),
    h('span', { class: 'db-rel-db-name' }, nameOf(m)), m.id === picked ? icon('check', { size: 14, className: 'db-rel-db-check' }) : null)),
    ...(shown.length ? [] : [h('div', { class: 'db-opt-empty' }, 'No databases match')]))
    const target = modules.find((m) => m.id === picked)
    twoWayText.replaceChildren(h('span', { class: 'db-rel-twoway-title' }, target ? `Show on ${target.id === store.moduleId ? 'this database too' : target.title}` : 'Two-way relation'),
      h('span', { class: 'db-rel-twoway-help' }, 'Adds a matching property on the other side that stays in sync.'))
    if (footer) footer.confirm.disabled = !picked
  }
  search.addEventListener('input', render)
  const body = h('div', { class: 'db-dialog db-rel-setup' },
    search, listEl,
    list ? h('p', { class: 'db-dialog-help' }, 'This database gets one row per row there, kept in step as rows are added or renamed. Other columns stay editable.')
      : h('label', { class: 'db-rel-twoway' }, twoWayText, twoWay))
  render()
  const result = () => (list ? { sourceModuleId: picked } : { targetModuleId: picked, twoWay: twoWay.checked })
  return modal({
    title: list ? (current ? 'List settings' : 'New list column') : current ? 'Relation settings' : 'New relation',
    description: list ? 'Fill this database with the rows of another database.' : 'Link rows to rows in another database, or in this one.',
    size: 'md', className: 'db-modal db-relation-modal', actions: [], body,
    onOpen: ({ close, dialog }) => {
      footer = dialogFooter(close, list ? (current ? 'Save' : 'Create list') : current ? 'Save' : 'Create relation', () => picked && close(result()))
      footer.confirm.disabled = !picked
      dialog.append(footer.el)
      search.focus()
    },
  })
}

/** Pick relation, property and calculation. Resolves { relationPropertyId, targetPropertyId, fn } or null. */
export async function rollupSetup({ store, current }) {
  await store.ensureRelated?.()
  const relations = store.properties.filter((p) => T.typeOf(p).relation)
  if (!relations.length) {
    toast('Add a relation property first, then roll up values through it.', { type: 'error' })
    return null
  }
  const state = { relationPropertyId: current?.relationPropertyId || relations[0].id, targetPropertyId: current?.targetPropertyId || null, fn: current?.fn || 'count' }
  const field = (label, control) => h('label', { class: 'db-dialog-field' }, h('span', { class: 'field-label' }, label), control)
  const relSel = h('select', { class: 'db-select db-rollup-relation', 'aria-label': 'Relation' })
  const propSel = h('select', { class: 'db-select db-rollup-property', 'aria-label': 'Property' })
  const fnSel = h('select', { class: 'db-select db-rollup-fn', 'aria-label': 'Calculate' }, ROLLUP_FNS.map((f) => h('option', { value: f.key }, f.label)))
  const render = () => {
    relSel.replaceChildren(...relations.map((p) => h('option', { value: p.id }, p.name)))
    relSel.value = state.relationPropertyId
    const tdb = dbFor(store.propById.get(state.relationPropertyId)?.config?.targetModuleId)
    const props = tdb?.properties || []
    if (!props.some((p) => p.id === state.targetPropertyId)) state.targetPropertyId = titlePropOf(tdb)?.id || props[0]?.id || null
    propSel.replaceChildren(...props.map((p) => h('option', { value: p.id }, p.name)))
    propSel.value = state.targetPropertyId || ''
    fnSel.value = state.fn
  }
  relSel.addEventListener('change', () => { state.relationPropertyId = relSel.value; render() })
  propSel.addEventListener('change', () => { state.targetPropertyId = propSel.value })
  fnSel.addEventListener('change', () => { state.fn = fnSel.value })
  render()
  const body = h('div', { class: 'db-dialog db-rollup-setup' }, field('Relation', relSel), field('Property', propSel), field('Calculate', fnSel))
  return modal({
    title: current ? 'Rollup settings' : 'New rollup', description: 'Summarise a property of related rows.',
    size: 'sm', className: 'db-modal', actions: [], body,
    onOpen: ({ close, dialog }) => {
      dialog.append(dialogFooter(close, current ? 'Save' : 'Create rollup', () => close({ ...state })).el)
      relSel.focus()
    },
  })
}

/** Formula editor with live preview on the first row. Resolves { expression } or null. */
export function formulaSetup({ store, current, name }) {
  const textarea = h('textarea', { class: 'db-formula-input', rows: 3, spellcheck: 'false', 'aria-label': 'Formula', placeholder: 'prop("Price") * prop("Qty")' })
  textarea.value = current?.expression || ''
  const preview = h('div', { class: 'db-formula-preview', role: 'status' })
  const sample = store.rows[0]
  const renderPreview = () => {
    const src = textarea.value
    const syntax = src.trim() && formulaSyntaxError(src)
    preview.classList.toggle('is-error', !!syntax)
    if (!src.trim()) return preview.replaceChildren(h('span', { class: 'db-muted' }, 'Type a formula. Use prop("Name") to read a property of the same row.'))
    if (syntax) return preview.replaceChildren(icon('alert', { size: 14 }), h('span', {}, `Syntax error: ${syntax}`))
    if (!sample) return preview.replaceChildren(h('span', { class: 'db-muted' }, 'Looks good. Add a row to see a result.'))
    const v = evaluateFormula(src, sample, dbFor(store.moduleId) || store)
    preview.classList.toggle('is-error', isError(v))
    preview.replaceChildren(h('span', { class: 'db-formula-preview-label' }, `First row${rowTitle(store, sample) ? ` (${rowTitle(store, sample)})` : ''}:`),
      h('span', { class: 'db-formula-preview-value' }, isError(v) ? `${v.error} ${ERROR_HINTS[v.error] || ''}`.trim() : v == null ? 'Empty' : String(v)))
  }
  textarea.addEventListener('input', renderPreview)
  const insert = (text) => {
    const { selectionStart: a, selectionEnd: b, value } = textarea
    textarea.value = value.slice(0, a) + text + value.slice(b)
    textarea.focus()
    textarea.setSelectionRange(a + text.length, a + text.length)
    renderPreview()
  }
  const chips = h('div', { class: 'db-formula-props' }, store.properties.filter((p) => p.name !== name).map((p) =>
    h('button', { type: 'button', class: 'db-formula-chip', title: `Insert prop("${p.name}")`, onClick: () => insert(`prop("${p.name.replace(/"/g, '""')}")`) }, T.glyph(T.typeOf(p).icon, 13), h('span', {}, p.name))))
  renderPreview()
  const body = h('div', { class: 'db-dialog db-formula-setup' }, textarea, preview,
    h('div', { class: 'field-label' }, 'Properties'), chips,
    h('p', { class: 'db-dialog-help' }, 'Excel-style operators and functions work, for example IF, ROUND, CONCAT and DATEDIF.'))
  return modal({
    title: name ? `Formula: ${name}` : 'New formula', size: 'md', className: 'db-modal db-formula-modal', actions: [], body,
    onOpen: ({ close, dialog }) => {
      dialog.append(dialogFooter(close, current ? 'Save' : 'Create formula', () => close({ expression: textarea.value.trim() })).el)
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), close({ expression: textarea.value.trim() }))
      })
      textarea.focus()
    },
  })
}

export const compareMixed = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  if (isError(a) || isError(b)) return isError(a) === isError(b) ? 0 : isError(a) ? 1 : -1
  return collator.compare(String(a), String(b))
}
export { isError }
