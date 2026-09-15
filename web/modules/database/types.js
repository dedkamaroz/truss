// Property type registry. This file is the single place property types are defined:
// render, text, compare, filters, grouping, editing, parse and serialise.
// Views, peek, sort and filter code only look types up through typeOf(prop).
// To add a type: add one entry to TYPES (and its server rule in server/routes/database.js).

import { h, popover, toast, confirmDialog, formatDate, formatDateTime } from '../../lib/ui.js'
import { icon, hasIcon } from '../../lib/icons.js'
import api from '../../lib/api.js'
import { keepInView } from './fit.js'
import {
  bindTypes, relationEditor, relationSetup, rollupSetup, formulaSetup, relatedTitles, rollupValue, rollupText, rollupKind, rollupParts, rollupFn,
  lookupSetup, lookupValue, lookupText, lookupKind, lookupParts,
  formulaValue, formulaKind, formulaDateSerial, formulaSyntaxError, compareMixed, isError, dbFor, ERROR_HINTS,
} from './relations.js'

export const COLORS = ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']
const COLOR_LABELS = { default: 'Default', gray: 'Grey', brown: 'Brown', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink', red: 'Red' }
export const NUMBER_FORMATS = [
  { key: 'number', label: 'Number' },
  { key: 'number_with_commas', label: 'Number with commas' },
  { key: 'percent', label: 'Percent' },
  { key: 'aud', label: 'Australian dollar' },
]
export const EMPTY_GROUP = '__empty__'

/* ------------------------------------------------------------------ small helpers */

const collator = new Intl.Collator('en-AU', { sensitivity: 'base', numeric: true })
const lower = (s) => String(s ?? '').toLocaleLowerCase('en-AU')
const pad = (n) => String(n).padStart(2, '0')
export const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const todayIso = () => isoOf(new Date())
const dayOfDateTime = (iso) => (iso ? isoOf(new Date(iso)) : '')

/** "14/05/2026", "14/5/2026" or "2026-05-14" -> "2026-05-14"; null when not a real date. */
export function parseDateInput(text) {
  const s = String(text ?? '').trim()
  let y, m, d
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (match) [, y, m, d] = match
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [, d, m, y] = match
  else return null
  const dt = new Date(+y, +m - 1, +d)
  if (dt.getFullYear() !== +y || dt.getMonth() !== +m - 1 || dt.getDate() !== +d) return null
  return isoOf(dt)
}

const GLYPHS = {
  title: '<path d="M5.5 7V5h13v2M12 5v14M9.5 19h5"/>',
  text: '<path d="M4.5 7h15M4.5 12h15M4.5 17h9"/>',
  number: '<path d="M10 4 8 20M16 4l-2 16M5 9h15M4 15h15"/>',
  select: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 10.5 3.5 3.5 3.5-3.5"/>',
  status: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3.2 2.4"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
  checkbox: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="m8.2 12.4 2.7 2.7 5-5.6"/>',
  email: '<circle cx="12" cy="12" r="3.4"/><path d="M15.4 8.6v4.6a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7"/>',
  phone: '<path d="M6 4h3l1.6 4.2-2 1.4a10.5 10.5 0 0 0 5.8 5.8l1.4-2L20 15v3a2 2 0 0 1-2.1 2A16 16 0 0 1 4 6.1 2 2 0 0 1 6 4z"/>',
  relation: '<path d="M7 17 17 7M9.5 7H17v7.5"/><path d="M4.5 12.5v6a1 1 0 0 0 1 1h6"/>',
  rollup: '<path d="M5 19h14M7 15l3.5-4 3 2.5L18 7"/><circle cx="18" cy="7" r="1.2" fill="currentColor" stroke="none"/>',
  formula: '<path d="M15.5 4.5h-2.2a2.3 2.3 0 0 0-2.3 2.1L9.8 17.4a2.3 2.3 0 0 1-2.3 2.1H6M8 10.5h7"/><path d="m14.5 14 4.5 5M19 14l-4.5 5"/>',
}

/** Icon for a type: shared icons.js icon when one exists, else a local glyph in the same style. */
export function glyph(name, size = 16) {
  if (hasIcon(name)) return icon(name, { size })
  const el = icon('file', { size })
  el.innerHTML = GLYPHS[name] || ''
  el.dataset.icon = name
  return el
}

export function propIcon(prop, size = 14) {
  return glyph(typeOf(prop).icon, size)
}

export function tag(option, { removable, onRemove } = {}) {
  if (!option) return null
  return h('span', { class: 'db-tag', dataset: { color: option.color || 'default' }, title: option.name },
    h('span', { class: 'db-tag-label' }, option.name),
    removable ? h('button', { type: 'button', class: 'db-tag-remove', 'aria-label': `Remove ${option.name}`, onClick: (e) => { e.stopPropagation(); onRemove?.() } }, icon('close', { size: 10, strokeWidth: 2.4 })) : null)
}

function statusTag(option) {
  if (!option) return null
  return h('span', { class: 'db-tag db-status', dataset: { color: option.color || 'default' }, title: option.name },
    h('span', { class: 'db-status-dot' }), h('span', { class: 'db-tag-label' }, option.name))
}

const optionOf = (prop, id) => prop.config?.options?.find((o) => o.id === id)

function formatNumber(v, cfg = {}) {
  const d = cfg.decimals
  const frac = (def) => ({ minimumFractionDigits: d ?? def, maximumFractionDigits: d ?? Math.max(def, 6) })
  switch (cfg.format) {
    case 'aud': return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', ...frac(2) }).format(v)
    case 'percent': return new Intl.NumberFormat('en-AU', { style: 'percent', ...frac(0) }).format(v / 100)
    case 'number_with_commas': return new Intl.NumberFormat('en-AU', frac(0)).format(v)
    default: return new Intl.NumberFormat('en-AU', { useGrouping: false, ...frac(0) }).format(v)
  }
}

export function hrefFor(type, v) {
  if (type === 'email') return `mailto:${v}`
  if (type === 'phone') return `tel:${String(v).replace(/[^\d+]/g, '')}`
  return /^(https?|mailto):/i.test(v) ? v : `https://${v}`
}

/* ------------------------------------------------------------------ filter operator builders */

const needsText = (label, test) => ({ label, input: 'text', test })
const emptyOps = {
  is_empty: { label: 'is empty', input: 'none', test: (v) => isEmptyValue(v) },
  is_not_empty: { label: 'is not empty', input: 'none', test: (v) => !isEmptyValue(v) },
}
const textOps = {
  contains: needsText('contains', (v, a) => lower(v).includes(lower(a))),
  does_not_contain: needsText('does not contain', (v, a) => !lower(v).includes(lower(a))),
  is: needsText('is', (v, a) => lower(v) === lower(a)),
  is_not: needsText('is not', (v, a) => lower(v) !== lower(a)),
  starts_with: needsText('starts with', (v, a) => lower(v).startsWith(lower(a))),
  ...emptyOps,
}
const num = (label, test) => ({ label, input: 'number', test: (v, a) => v != null && test(v, Number(a)) })
const numberOps = {
  eq: num('=', (v, a) => v === a),
  neq: { label: '≠', input: 'number', test: (v, a) => v !== Number(a) },
  gt: num('>', (v, a) => v > a),
  lt: num('<', (v, a) => v < a),
  gte: num('≥', (v, a) => v >= a),
  lte: num('≤', (v, a) => v <= a),
  ...emptyOps,
}
const optionOps = {
  is: { label: 'is', input: 'option', test: (v, a) => v === a },
  is_not: { label: 'is not', input: 'option', test: (v, a) => v !== a },
  ...emptyOps,
}
const multiOps = {
  contains: { label: 'contains', input: 'option', test: (v, a) => Array.isArray(v) && v.includes(a) },
  does_not_contain: { label: 'does not contain', input: 'option', test: (v, a) => !Array.isArray(v) || !v.includes(a) },
  ...emptyOps,
}
const dateOps = (day) => ({
  is: { label: 'is', input: 'date', test: (v, a) => !!v && day(v) === a },
  before: { label: 'is before', input: 'date', test: (v, a) => !!v && day(v) < a },
  after: { label: 'is after', input: 'date', test: (v, a) => !!v && day(v) > a },
  on_or_before: { label: 'is on or before', input: 'date', test: (v, a) => !!v && day(v) <= a },
  on_or_after: { label: 'is on or after', input: 'date', test: (v, a) => !!v && day(v) >= a },
  ...emptyOps,
})

export function isEmptyValue(v) {
  return v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0)
}

/* ------------------------------------------------------------------ option grouping */

const optionGroups = {
  groups: (prop) => [...(prop.config?.options || []).map((o) => ({ key: o.id, label: o.name, option: o })), { key: EMPTY_GROUP, label: `No ${prop.name}` }],
  key: (v) => v ?? EMPTY_GROUP,
  value: (key) => (key === EMPTY_GROUP ? null : key),
}

/* ------------------------------------------------------------------ the registry */

const textual = (extra) => ({
  edit: 'text',
  get: (row, prop) => row.values[prop.id],
  text: (v) => v ?? '',
  compare: (a, b) => collator.compare(a, b),
  filters: textOps,
  parse: (s) => s.trim(),
  serialise: (v) => v ?? '',
  render: (v) => (v ? h('span', { class: 'db-text' }, v) : null),
  ...extra,
})

const linkType = (type, label, iconName, placeholder) => textual({
  label,
  icon: iconName,
  placeholder,
  render: (v) => (v ? h('a', { class: 'db-link', href: hrefFor(type, v), target: type === 'url' ? '_blank' : null, rel: 'noopener noreferrer', title: v, onClick: (e) => e.stopPropagation() },
    type === 'url' ? v.replace(/^https?:\/\//i, '').replace(/\/$/, '') : v) : null),
})

const options = (prop) => prop.config?.options || []
const serialOfDay = (iso) => formulaDateSerial(iso)
const formulaNumber = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 4 })

/* ---- relation, rollup and formula helpers */

const relationText = (v, prop) => relatedTitles(prop, v).join(', ')
const relationOps = {
  contains: needsText('contains', (v, a, prop) => relatedTitles(prop, v).some((t) => lower(t).includes(lower(a)))),
  does_not_contain: needsText('does not contain', (v, a, prop) => !relatedTitles(prop, v).some((t) => lower(t).includes(lower(a)))),
  ...emptyOps,
}
const dayOps = dateOps((v) => v)
const checkboxOps = {
  checked: { label: 'is checked', input: 'none', test: (v) => v === true },
  unchecked: { label: 'is not checked', input: 'none', test: (v) => v !== true },
}

function renderRelation(v, prop) {
  const tdb = dbFor(prop.config?.targetModuleId)
  if (!v?.length || !tdb) return null
  const title = tdb.properties.find((p) => p.type === 'title')
  const chips = v.map((id) => tdb.rowById.get(id)).filter(Boolean).map((r) => {
    const t = (title && r.values[title.id]) || ''
    return h('span', { class: 'db-rel-chip', title: t || 'Untitled', dataset: { rowId: r.id } }, icon('page', { size: 12 }), h('span', { class: `db-rel-chip-label${t ? '' : ' is-empty'}` }, t || 'Untitled'))
  })
  return chips.length ? h('span', { class: 'db-rel-chips' }, chips) : null
}

function renderFormulaValue(v) {
  if (v == null || v === '') return null
  if (isError(v)) {
    return h('span', { class: 'db-formula-error', title: ERROR_HINTS[v.error] || 'Formula error', dataset: { error: v.error } }, icon('alert', { size: 12 }), h('span', {}, v.error === '#SYNTAX!' ? 'Syntax error' : v.error))
  }
  if (typeof v === 'boolean') return h('span', { class: `db-checkbox is-readonly${v ? ' is-checked' : ''}`, role: 'img', 'aria-label': v ? 'True' : 'False' }, v ? icon('check', { size: 12, strokeWidth: 3 }) : null)
  if (typeof v === 'number') return h('span', { class: 'db-number' }, formulaNumber.format(v))
  return h('span', { class: 'db-text' }, String(v))
}

const formulaText = (v) => (v == null ? '' : isError(v) ? v.error : typeof v === 'number' ? formulaNumber.format(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v))

async function openSetupMenu(anchor, prop, ctx) {
  const t = typeOf(prop)
  const config = await t.setup({ store: ctx.store, current: prop.config, name: prop.name, anchor })
  if (config) ctx.store.updateProperty(prop.id, { config }).catch(() => {})
}

export const TYPES = {
  title: textual({
    label: 'Title', icon: 'title', defaultWidth: 280,
    render: (v) => h('span', { class: `db-title-text${v ? '' : ' is-empty'}` }, v || 'Untitled'),
    text: (v) => v ?? '',
  }),
  text: textual({ label: 'Text', icon: 'text' }),
  number: {
    label: 'Number', icon: 'number', edit: 'text', align: 'end', defaultWidth: 140, formats: NUMBER_FORMATS,
    get: (row, prop) => row.values[prop.id],
    text: (v, prop) => (v == null ? '' : formatNumber(v, prop.config)),
    compare: (a, b) => a - b,
    filters: numberOps,
    parse(s) {
      const t = s.trim().replace(/[$,\s]/g, '').replace(/%$/, '')
      if (!t) return null
      if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) throw new Error('Enter a number')
      return Number(t)
    },
    serialise: (v) => (v == null ? '' : String(v)),
    render: (v, prop) => (v == null ? null : h('span', { class: 'db-number' }, formatNumber(v, prop.config))),
  },
  select: {
    label: 'Select', icon: 'select',
    get: (row, prop) => row.values[prop.id],
    text: (v, prop) => optionOf(prop, v)?.name ?? '',
    compare: (a, b, prop) => options(prop).findIndex((o) => o.id === a) - options(prop).findIndex((o) => o.id === b),
    filters: optionOps,
    group: optionGroups,
    edit: (o) => optionEditor(o),
    parse: (s, prop) => options(prop).find((o) => lower(o.name) === lower(s.trim()))?.id ?? null,
    serialise: (v, prop) => optionOf(prop, v)?.name ?? '',
    formula: (v, prop) => optionOf(prop, v)?.name ?? null,
    render: (v, prop) => tag(optionOf(prop, v)),
  },
  multi_select: {
    label: 'Multi-select', icon: 'list', defaultWidth: 220,
    get: (row, prop) => row.values[prop.id],
    text: (v, prop) => (v || []).map((id) => optionOf(prop, id)?.name).filter(Boolean).join(', '),
    compare: (a, b, prop) => options(prop).findIndex((o) => o.id === a[0]) - options(prop).findIndex((o) => o.id === b[0]) || a.length - b.length,
    filters: multiOps,
    edit: (o) => optionEditor(o),
    parse: (s, prop) => s.split(',').map((p) => options(prop).find((o) => lower(o.name) === lower(p.trim()))?.id).filter(Boolean),
    serialise: (v, prop) => (v || []).map((id) => optionOf(prop, id)?.name).filter(Boolean).join(', '),
    formula: (v, prop) => (v || []).map((id) => optionOf(prop, id)?.name).filter(Boolean).join(', '),
    render: (v, prop) => (v?.length ? h('span', { class: 'db-tags' }, v.map((id) => tag(optionOf(prop, id)))) : null),
  },
  status: {
    label: 'Status', icon: 'status', defaultWidth: 160,
    get: (row, prop) => row.values[prop.id],
    text: (v, prop) => optionOf(prop, v)?.name ?? '',
    compare: (a, b, prop) => options(prop).findIndex((o) => o.id === a) - options(prop).findIndex((o) => o.id === b),
    filters: optionOps,
    group: optionGroups,
    edit: (o) => optionEditor(o),
    parse: (s, prop) => options(prop).find((o) => lower(o.name) === lower(s.trim()))?.id ?? null,
    serialise: (v, prop) => optionOf(prop, v)?.name ?? '',
    formula: (v, prop) => optionOf(prop, v)?.name ?? null,
    render: (v, prop) => statusTag(optionOf(prop, v)),
  },
  date: {
    label: 'Date', icon: 'calendar', defaultWidth: 180, calendar: true,
    get: (row, prop) => row.values[prop.id],
    text: (v) => (v ? (v.end ? `${formatDate(v.start)} → ${formatDate(v.end)}` : formatDate(v.start)) : ''),
    compare: (a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0),
    filters: dateOps((v) => v.start),
    edit: (o) => dateEditor(o),
    parse: (s) => {
      if (!s.trim()) return null
      const [a, b] = s.trim().split(/\s*(?:→|\s-\s|\sto\s)\s*/)
      const start = parseDateInput(a)
      if (!start) throw new Error('Enter a date as DD/MM/YYYY')
      const end = b ? parseDateInput(b) : null
      return end && end >= start ? { start, end } : { start }
    },
    serialise: (v) => (v ? (v.end ? `${formatDate(v.start)} - ${formatDate(v.end)}` : formatDate(v.start)) : ''),
    render: (v) => (v ? h('span', { class: 'db-date' }, v.end ? `${formatDate(v.start)} → ${formatDate(v.end)}` : formatDate(v.start)) : null),
    day: (v) => v?.start || null,
    formula: (v) => (v ? serialOfDay(v.start) : null),
  },
  checkbox: {
    label: 'Checkbox', icon: 'checkbox', edit: 'toggle', align: 'center', defaultWidth: 110,
    get: (row, prop) => !!row.values[prop.id],
    isEmpty: () => false,
    text: (v) => (v ? 'Checked' : 'Unchecked'),
    compare: (a, b) => (a ? 1 : 0) - (b ? 1 : 0),
    filters: {
      checked: { label: 'is checked', input: 'none', test: (v) => !!v },
      unchecked: { label: 'is not checked', input: 'none', test: (v) => !v },
    },
    group: {
      groups: () => [{ key: 'true', label: 'Checked' }, { key: 'false', label: 'Unchecked' }],
      key: (v) => (v ? 'true' : 'false'),
      value: (key) => key === 'true',
    },
    parse: (s) => /^(true|yes|y|1|x|checked)$/i.test(s.trim()),
    serialise: (v) => (v ? 'true' : 'false'),
    render: (v) => h('span', { class: `db-checkbox${v ? ' is-checked' : ''}`, role: 'checkbox', 'aria-checked': String(!!v) }, v ? icon('check', { size: 12, strokeWidth: 3 }) : null),
  },
  url: linkType('url', 'URL', 'link', 'https://'),
  email: linkType('email', 'Email', 'email', 'name@example.com'),
  phone: linkType('phone', 'Phone', 'phone', '+61 4XX XXX XXX'),
  files: {
    label: 'Files & media', icon: 'paperclip', defaultWidth: 200, cover: true,
    get: (row, prop) => row.values[prop.id],
    text: (v, prop, row, store) => (v || []).map((id) => store?.attachments.get(id)?.filename).filter(Boolean).join(', '),
    compare: (a, b) => a.length - b.length,
    filters: emptyOps,
    edit: (o) => filesEditor(o),
    parse: () => { throw new Error('Upload files from the file picker') },
    serialise: () => '',
    render: (v, prop, row, store) => (v?.length ? h('span', { class: 'db-files' }, v.map((id) => {
      const a = store?.attachments.get(id)
      return a ? h('span', { class: 'db-file-chip', title: a.filename }, icon(/^image\//.test(a.mime) ? 'image' : 'file', { size: 12 }), h('span', { class: 'db-file-name' }, a.filename)) : null
    })) : null),
    formula: (v, prop, row, store) => (v || []).map((id) => store?.attachments?.get(id)?.filename).filter(Boolean).join(', '),
    csv: (v, prop, row, store) => (v || []).map((id) => store?.attachments?.get(id)?.filename).filter(Boolean).join(', '),
  },
  relation: {
    label: 'Relation', icon: 'relation', defaultWidth: 220, relation: true,
    target: (prop) => prop.config?.targetModuleId,
    get: (row, prop) => row.values[prop.id],
    text: relationText,
    compare: (a, b, prop) => a.length - b.length || collator.compare(relationText(a, prop), relationText(b, prop)),
    filters: relationOps,
    edit: (o) => relationEditor(o),
    parse: (s, prop) => {
      const tdb = dbFor(prop.config?.targetModuleId)
      const title = tdb?.properties.find((p) => p.type === 'title')
      if (!title) return []
      const byTitle = new Map(tdb.rows.map((r) => [lower(r.values[title.id]), r.id]))
      return [...new Set(s.split(',').map((p) => byTitle.get(lower(p.trim()))).filter(Boolean))]
    },
    serialise: relationText,
    render: renderRelation,
    formula: (v, prop) => relationText(v, prop),
    setup: (o) => relationSetup(o),
    menuItems: (prop, ctx) => {
      const target = dbFor(prop.config?.targetModuleId)
      return [{
        label: 'Related to', value: prop.config?.targetModuleId === ctx.store.moduleId ? 'This database' : target?.module?.title || 'Not set', cls: 'db-relation-target',
        onClick: async () => {
          const config = await relationSetup({ store: ctx.store, current: prop.config })
          if (!config) return
          if (config.targetModuleId !== prop.config?.targetModuleId && ctx.store.rows.some((r) => r.values[prop.id]?.length)) {
            if (!(await confirmDialog({ title: 'Change the related database?', message: 'Existing links in this property will be removed.', confirmLabel: 'Change', danger: true }))) return
          }
          ctx.store.updateProperty(prop.id, { config }).catch(() => {})
        },
      }]
    },
    deleteMessage: (prop, store) => {
      const reverseId = prop.config?.twoWay && prop.config.reversePropertyId
      const tdb = dbFor(prop.config?.targetModuleId)
      const reverse = reverseId && tdb?.propById.get(reverseId)
      if (!reverse) return null
      const where = tdb === store || prop.config.targetModuleId === store.moduleId ? 'this database' : `"${tdb.module?.title || 'the related database'}"`
      return `Its links will be removed from every row. The matching "${reverse.name}" property in ${where} will also be deleted. This cannot be undone.`
    },
  },
  rollup: {
    label: 'Rollup', icon: 'rollup', readOnly: true, computed: true, defaultWidth: 160,
    get: (row, prop) => rollupValue(row, prop),
    text: (v, prop) => rollupText(v, prop),
    alignFor: (prop) => (rollupKind(prop) === 'number' ? 'end' : null),
    compare: compareMixed,
    filters: numberOps,
    filtersFor: (prop) => ({ number: numberOps, date: dayOps, text: textOps }[rollupKind(prop)]),
    day: (v, prop) => (rollupKind(prop) === 'date' ? v : null),
    serialise: (v, prop) => rollupText(v, prop),
    render: (v, prop) => {
      if (v == null || v === '') return null
      const kind = rollupKind(prop)
      return h('span', { class: kind === 'number' ? 'db-number db-rollup' : 'db-text db-rollup' }, rollupText(v, prop))
    },
    formula: (v, prop) => (rollupKind(prop) === 'date' ? serialOfDay(v) : v),
    setup: (o) => rollupSetup(o),
    menuItems: (prop, ctx) => {
      const { relation, target } = rollupParts(prop)
      return [
        { label: 'Relation', value: relation?.name || 'Not set', cls: 'db-rollup-relation-item', onClick: () => openSetupMenu(null, prop, ctx) },
        { label: 'Property', value: target?.name || 'Not set', cls: 'db-rollup-property-item', onClick: () => openSetupMenu(null, prop, ctx) },
        { label: 'Calculate', value: rollupFn(prop).label, cls: 'db-rollup-fn-item', onClick: () => openSetupMenu(null, prop, ctx) },
      ]
    },
  },
  lookup: {
    label: 'Lookup', icon: 'search', readOnly: true, computed: true, defaultWidth: 180,
    target: (prop) => prop.config?.targetModuleId,
    get: (row, prop) => lookupValue(row, prop),
    isEmpty: (v) => v == null || v === '',
    text: (v, prop) => lookupText(v, prop),
    alignFor: (prop) => (lookupKind(prop) === 'number' ? 'end' : null),
    compare: compareMixed,
    filters: textOps,
    filtersFor: (prop) => ({ number: numberOps, date: dayOps, boolean: checkboxOps, text: textOps }[lookupKind(prop)]),
    day: (v, prop) => (lookupKind(prop) === 'date' && !isError(v) ? v : null),
    serialise: (v, prop) => lookupText(v, prop),
    render: (v, prop) => {
      if (v == null || v === '') return null
      if (isError(v)) return renderFormulaValue(v)
      const kind = lookupKind(prop)
      if (kind === 'boolean') return renderFormulaValue(v)
      return h('span', { class: kind === 'number' ? 'db-number db-lookup' : 'db-text db-lookup' }, lookupText(v, prop))
    },
    formula: (v, prop) => (lookupKind(prop) === 'date' && !isError(v) ? serialOfDay(v) : v),
    setup: (o) => lookupSetup(o),
    menuItems: (prop, ctx) => {
      const { source, targetDb, match, ret } = lookupParts(prop)
      const open = () => openSetupMenu(null, prop, ctx)
      return [
        { label: 'Search with', value: source?.name || 'Not set', cls: 'db-lookup-source-item', onClick: open },
        { label: 'In database', value: targetDb?.module?.title || (prop.config?.targetModuleId ? 'Loading' : 'Not set'), cls: 'db-lookup-target-item', onClick: open },
        { label: 'Match on', value: match?.name || 'Not set', cls: 'db-lookup-match-item', onClick: open },
        { label: 'Return', value: ret?.name || 'Not set', cls: 'db-lookup-return-item', onClick: open },
      ]
    },
  },
  formula: {
    label: 'Formula', icon: 'formula', readOnly: true, computed: true, defaultWidth: 160,
    get: (row, prop) => formulaValue(row, prop),
    isEmpty: (v) => v == null || v === '',
    text: formulaText,
    alignFor: (prop) => (formulaKind(prop) === 'number' ? 'end' : null),
    compare: compareMixed,
    filters: textOps,
    filtersFor: (prop) => ({ number: numberOps, boolean: checkboxOps, text: textOps }[formulaKind(prop)]),
    serialise: (v) => (v == null ? '' : isError(v) ? v.error : String(v)),
    render: renderFormulaValue,
    setup: (o) => formulaSetup(o),
    menuItems: (prop, ctx) => [{
      label: 'Edit formula', value: formulaSyntaxError(prop.config?.expression || '') ? 'Syntax error' : '', cls: 'db-formula-edit',
      onClick: () => openSetupMenu(null, prop, ctx),
    }],
  },
  created_time: {
    label: 'Created time', icon: 'clock', readOnly: true, defaultWidth: 210,
    get: (row) => row.created_at,
    isEmpty: () => false,
    text: (v) => formatDateTime(v),
    compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    filters: dateOps(dayOfDateTime),
    day: dayOfDateTime,
    formula: (v) => serialOfDay(dayOfDateTime(v)),
    render: (v) => h('span', { class: 'db-muted' }, formatDateTime(v)),
  },
  last_edited_time: {
    label: 'Last edited time', icon: 'clock', readOnly: true, defaultWidth: 210,
    get: (row) => row.updated_at,
    isEmpty: () => false,
    text: (v) => formatDateTime(v),
    compare: (a, b) => (a < b ? -1 : a > b ? 1 : 0),
    filters: dateOps(dayOfDateTime),
    day: dayOfDateTime,
    formula: (v) => serialOfDay(dayOfDateTime(v)),
    render: (v) => h('span', { class: 'db-muted' }, formatDateTime(v)),
  },
}

export const typeOf = (prop) => TYPES[prop?.type] || TYPES.text
export const getValue = (row, prop) => typeOf(prop).get(row, prop)
export const isEmptyFor = (prop, v) => (typeOf(prop).isEmpty ? typeOf(prop).isEmpty(v) : isEmptyValue(v))
export const valueText = (row, prop, store) => typeOf(prop).text(getValue(row, prop), prop, row, store)
export const renderValue = (row, prop, store) => typeOf(prop).render(getValue(row, prop), prop, row, store)
/** True when a card or peek should show the value (unchecked boxes and blanks are hidden). */
export const hasDisplayValue = (row, prop) => !isEmptyValue(getValue(row, prop))
/** Label for a group of rows: the option rendered by its type, or plain text. */
export const groupLabel = (group, prop) => (group.option ? typeOf(prop).render(group.option.id, prop) : h('span', { class: 'db-group-label' }, group.label))
export const canCalendar = (prop) => !!typeOf(prop).calendar
export const canCover = (prop) => !!typeOf(prop).cover
/** Filter operators for a property (computed types depend on their result kind). */
export const filtersOf = (prop) => typeOf(prop).filtersFor?.(prop) || typeOf(prop).filters || {}
export const alignOf = (prop) => (typeOf(prop).alignFor ? typeOf(prop).alignFor(prop) : typeOf(prop).align)
/** Text for CSV export: serialised form where a type has one (raw numbers, DD/MM/YYYY dates), else display text. */
export const exportText = (row, prop, store) => {
  const t = typeOf(prop)
  const v = getValue(row, prop)
  return (t.csv || t.serialise || t.text)(v, prop, row, store)
}

bindTypes({ typeOf, getValue, valueText, isEmptyValue, glyph })

/* ------------------------------------------------------------------ editing */

/**
 * Starts editing a value in place. cell is the element showing the value (table cell or peek field).
 * onDone({ move?: 'left'|'right'|'down', cancelled? }) fires when editing ends.
 */
export function startEdit({ cell, prop, row, store, initialText, onDone }) {
  const t = typeOf(prop)
  if (t.readOnly) return null
  if (t.edit === 'toggle') {
    store.updateValues(row.id, { [prop.id]: !getValue(row, prop) }).catch(() => {})
    onDone?.({})
    return null
  }
  if (t.edit === 'text') return inlineEditor({ cell, prop, row, store, initialText, onDone })
  return t.edit({ anchor: cell, prop, row, store, onDone })
}

function inlineEditor({ cell, prop, row, store, initialText, onDone }) {
  const t = typeOf(prop)
  const original = t.serialise(getValue(row, prop), prop)
  const input = h('input', {
    class: 'db-inline-input', type: 'text', value: initialText ?? original, spellcheck: 'false',
    placeholder: t.placeholder || '', 'aria-label': prop.name,
  })
  let done = false
  const finish = (result) => {
    if (done) return
    done = true
    input.remove()
    cell.classList.remove('is-editing')
    onDone?.(result)
  }
  const commit = (move) => {
    if (done) return
    let value
    try {
      value = t.parse(input.value, prop)
    } catch (err) {
      toast(err.message, { type: 'error' })
      input.focus()
      input.select()
      return false
    }
    const changed = input.value !== original
    finish({ move })
    if (changed) store.updateValues(row.id, { [prop.id]: value }).catch(() => {})
    return true
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(e.shiftKey ? null : 'stay')
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commit(e.shiftKey ? 'left' : 'right')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish({ cancelled: true })
    }
  })
  input.addEventListener('blur', () => commit(null))
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('mousedown', (e) => e.stopPropagation())
  cell.classList.add('is-editing')
  cell.append(input)
  input.focus()
  if (initialText == null) input.select()
  else input.setSelectionRange(input.value.length, input.value.length)
  return { commit, cancel: () => finish({ cancelled: true }), el: input }
}

/* ---- select, multi-select and status */

function optionEditor({ anchor, prop: initialProp, row, store, onDone }) {
  const multi = initialProp.type === 'multi_select'
  const prop = () => store.propById.get(initialProp.id) || initialProp
  const selected = () => {
    const v = getValue(store.rowById.get(row.id) || row, prop())
    return multi ? v || [] : v ? [v] : []
  }
  let active = 0
  let newColor = null
  const input = h('input', { class: 'db-opt-input', type: 'text', placeholder: multi ? 'Search or create options' : 'Search or create an option', 'aria-label': 'Search options', spellcheck: 'false' })
  const chips = h('div', { class: 'db-opt-chips' })
  const list = h('div', { class: 'db-opt-list', role: 'listbox' })
  const content = h('div', { class: 'db-opt-editor' }, h('div', { class: 'db-opt-head' }, chips, input), list)

  const setValue = async (ids) => {
    await store.updateValues(row.id, { [initialProp.id]: multi ? ids : ids[0] ?? null }).catch(() => {})
    render()
  }
  const choose = (id) => {
    if (multi) {
      const cur = selected()
      setValue(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])
      input.value = ''
      render()
    } else {
      setValue(selected()[0] === id ? [] : [id])
      pop.close()
    }
  }
  const create = async (name) => {
    const p = prop()
    const used = new Set(options(p).map((o) => o.color))
    const color = newColor || COLORS.slice(1).find((c) => !used.has(c)) || COLORS[1 + (options(p).length % (COLORS.length - 1))]
    const opt = { id: crypto.randomUUID(), name, color }
    if (p.type === 'status') opt.group = 'todo'
    try {
      await store.updateProperty(p.id, { config: { ...p.config, options: [...options(p), opt] } })
    } catch {
      return
    }
    newColor = null
    input.value = ''
    choose(opt.id)
  }

  function render() {
    const p = prop()
    const sel = selected()
    chips.replaceChildren(...(multi ? sel.map((id) => tag(optionOf(p, id), { removable: true, onRemove: () => setValue(sel.filter((x) => x !== id)) })) : []))
    const q = input.value.trim()
    const matches = options(p).filter((o) => !q || lower(o.name).includes(lower(q)))
    const exact = options(p).some((o) => lower(o.name) === lower(q))
    const rows = []
    rows.push(h('div', { class: 'db-opt-hint' }, q && !exact ? 'Select an option or create one' : 'Select an option'))
    const items = matches.map((o) => ({ kind: 'option', o }))
    if (q && !exact) items.push({ kind: 'create', name: q })
    active = Math.min(active, Math.max(0, items.length - 1))
    let lastGroup
    items.forEach((it, i) => {
      if (it.kind === 'option') {
        if (p.type === 'status' && it.o.group !== lastGroup) {
          lastGroup = it.o.group
          rows.push(h('div', { class: 'db-opt-group' }, { todo: 'To-do', in_progress: 'In progress', complete: 'Complete' }[it.o.group] || 'Other'))
        }
        const more = h('button', { type: 'button', class: 'db-opt-more', title: 'Edit option', 'aria-label': `Edit ${it.o.name}`, onClick: (e) => { e.stopPropagation(); editOption(more, it.o) } }, icon('more', { size: 14 }))
        rows.push(h('div', {
          class: `db-opt-row${i === active ? ' is-active' : ''}${sel.includes(it.o.id) ? ' is-selected' : ''}`, role: 'option', 'aria-selected': String(sel.includes(it.o.id)), dataset: { id: it.o.id, name: it.o.name },
          onClick: () => choose(it.o.id), onMousemove: () => { if (active !== i) (active = i, paintActive()) },
        }, p.type === 'status' ? statusTag(it.o) : tag(it.o), h('span', { class: 'db-opt-spacer' }), sel.includes(it.o.id) ? icon('check', { size: 14, className: 'db-opt-check' }) : null, more))
      } else {
        const preview = { name: it.name, color: newColor || 'default' }
        rows.push(h('div', { class: `db-opt-row db-opt-create${i === active ? ' is-active' : ''}`, role: 'option', onClick: () => create(it.name), onMousemove: () => { if (active !== i) (active = i, paintActive()) } },
          h('span', { class: 'db-opt-create-label' }, 'Create'), tag(preview)))
        rows.push(h('div', { class: 'db-swatches', role: 'radiogroup', 'aria-label': 'Colour for the new option' }, COLORS.map((c) => h('button', {
          type: 'button', class: `db-swatch${(newColor || 'default') === c ? ' is-selected' : ''}`, role: 'radio', 'aria-checked': String((newColor || 'default') === c),
          dataset: { color: c }, title: COLOR_LABELS[c], 'aria-label': COLOR_LABELS[c], onClick: (e) => { e.stopPropagation(); newColor = c; render(); input.focus() },
        }))))
      }
    })
    if (!items.length) rows.push(h('div', { class: 'db-opt-empty' }, 'No options yet. Type to create one.'))
    list.replaceChildren(...rows)
    list._items = items
  }
  const paintActive = () => [...list.querySelectorAll('.db-opt-row')].forEach((el, i) => el.classList.toggle('is-active', i === active))

  function editOption(anchorEl, o) {
    const name = h('input', { class: 'input input-sm', type: 'text', value: o.name, 'aria-label': 'Option name' })
    const save = (patch) => {
      const p = prop()
      store.updateProperty(p.id, { config: { ...p.config, options: options(p).map((x) => (x.id === o.id ? { ...x, ...patch } : x)) } }).then(render, () => {})
    }
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.preventDefault(), inner.close())
    })
    const body = h('div', { class: 'db-opt-edit' }, name,
      h('button', { type: 'button', class: 'menu-item is-danger', onClick: () => {
        const p = prop()
        inner.close()
        store.updateProperty(p.id, { config: { ...p.config, options: options(p).filter((x) => x.id !== o.id) } }).then(render, () => {})
      } }, h('span', { class: 'menu-item-icon' }, icon('trash', { size: 16 })), h('span', { class: 'menu-item-label' }, 'Delete')),
      h('div', { class: 'menu-divider' }),
      h('div', { class: 'menu-header' }, 'Colours'),
      COLORS.map((c) => h('button', { type: 'button', class: 'menu-item db-colour-item', dataset: { color: c }, onClick: () => { save({ color: c }); inner.close() } },
        h('span', { class: 'db-swatch', dataset: { color: c } }), h('span', { class: 'menu-item-label' }, COLOR_LABELS[c]), o.color === c ? icon('check', { size: 14 }) : null)))
    const inner = popover(anchorEl, body, { className: 'db-popover', onClose: () => {
      const v = name.value.trim()
      if (v && v !== o.name) save({ name: v })
    } })
    name.focus()
    name.select()
  }

  input.addEventListener('input', () => { active = 0; render() })
  input.addEventListener('keydown', (e) => {
    const items = list._items || []
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      paintActive()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = items[active]
      if (it?.kind === 'option') choose(it.o.id)
      else if (it?.kind === 'create') create(it.name)
    } else if (e.key === 'Backspace' && !input.value && multi && selected().length) {
      setValue(selected().slice(0, -1))
    }
  })
  render()
  const pop = popover(anchor, content, { className: 'db-popover db-popover-options', onClose: () => onDone?.({}) })
  keepInView(pop.el)
  input.focus()
  return { close: () => pop.close() }
}

/* ---- date */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
export const monthTitle = (y, m) => `${MONTHS[m]} ${y}`
/** 42 ISO dates for a month grid starting on Monday. */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, i) => isoOf(new Date(year, month, 1 - offset + i)))
}

function dateEditor({ anchor, prop, row, store, onDone }) {
  const current = () => getValue(store.rowById.get(row.id) || row, prop) || null
  let value = current()
  let target = 'start'
  const base = parseDateInput(value?.start || '') || todayIso()
  let year = +base.slice(0, 4)
  let month = +base.slice(5, 7) - 1
  const startInput = h('input', { class: 'input input-sm db-date-input', type: 'text', placeholder: 'DD/MM/YYYY', 'aria-label': 'Start date' })
  const endInput = h('input', { class: 'input input-sm db-date-input', type: 'text', placeholder: 'DD/MM/YYYY', 'aria-label': 'End date' })
  const endToggle = h('input', { type: 'checkbox', class: 'db-switch', 'aria-label': 'End date' })
  const title = h('span', { class: 'db-cal-title' })
  const grid = h('div', { class: 'db-cal-mini', role: 'grid' })
  const save = (v) => {
    value = v
    store.updateValues(row.id, { [prop.id]: v }).catch(() => {})
    paint()
  }
  const commitInput = (which) => {
    const el = which === 'start' ? startInput : endInput
    if (!el.value.trim()) {
      if (which === 'start') save(null)
      else if (value) save({ start: value.start })
      return
    }
    const iso = parseDateInput(el.value)
    if (!iso) {
      toast('Enter a date as DD/MM/YYYY', { type: 'error' })
      return paint()
    }
    if (which === 'start') save(value?.end && value.end >= iso ? { start: iso, end: value.end } : { start: iso })
    else if (value?.start) save(iso >= value.start ? { start: value.start, end: iso } : { start: iso, end: value.start })
    year = +iso.slice(0, 4)
    month = +iso.slice(5, 7) - 1
    paint()
  }
  for (const [el, which] of [[startInput, 'start'], [endInput, 'end']]) {
    el.addEventListener('focus', () => { target = which; paint(false) })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.preventDefault(), commitInput(which))
    })
    el.addEventListener('change', () => commitInput(which))
  }
  endToggle.addEventListener('change', () => {
    if (!endToggle.checked) save(value ? { start: value.start } : null)
    else {
      target = 'end'
      if (value) save({ start: value.start, end: value.end || value.start })
      else paint()
      endInput.focus()
    }
  })
  const pick = (iso) => {
    if (target === 'end' && value?.start) {
      save(iso >= value.start ? { start: value.start, end: iso } : { start: iso, end: value.start })
    } else {
      save(endToggle.checked && value?.end && value.end >= iso ? { start: iso, end: value.end } : endToggle.checked ? { start: iso, end: iso } : { start: iso })
      if (endToggle.checked) target = 'end'
    }
  }
  function paint(inputs = true) {
    if (inputs) {
      startInput.value = value?.start ? formatDate(value.start) : ''
      endInput.value = value?.end ? formatDate(value.end) : ''
      endToggle.checked = !!value?.end || endToggle.checked
    }
    endInput.hidden = !endToggle.checked
    startInput.classList.toggle('is-target', target === 'start' && endToggle.checked)
    endInput.classList.toggle('is-target', target === 'end')
    title.textContent = monthTitle(year, month)
    const today = todayIso()
    const inMonth = `${year}-${pad(month + 1)}`
    grid.replaceChildren(...WEEKDAYS.map((d) => h('span', { class: 'db-cal-mini-dow' }, d.slice(0, 2))),
      ...monthGrid(year, month).map((iso) => {
        const inRange = value?.end && iso >= value.start && iso <= value.end
        const sel = iso === value?.start || iso === value?.end
        return h('button', {
          type: 'button', class: `db-cal-mini-day${iso.startsWith(inMonth) ? '' : ' is-outside'}${iso === today ? ' is-today' : ''}${sel ? ' is-selected' : ''}${inRange ? ' is-range' : ''}`,
          dataset: { date: iso }, 'aria-label': formatDate(iso), onMousedown: (e) => e.preventDefault(), onClick: () => pick(iso),
        }, String(+iso.slice(8)))
      }))
  }
  const nav = (delta) => {
    month += delta
    if (month < 0) (month = 11, year--)
    if (month > 11) (month = 0, year++)
    paint(false)
  }
  const content = h('div', { class: 'db-date-editor' },
    h('div', { class: 'db-date-inputs' }, startInput, endInput),
    h('div', { class: 'db-cal-mini-head' }, title, h('span', { class: 'db-opt-spacer' }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': 'Previous month', onClick: () => nav(-1) }, icon('chevron-left', { size: 14 })),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': 'Next month', onClick: () => nav(1) }, icon('chevron-right', { size: 14 }))),
    grid,
    h('div', { class: 'db-date-foot' },
      h('label', { class: 'db-switch-label' }, h('span', {}, 'End date'), endToggle),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { endToggle.checked = false; save(null) } }, 'Clear')))
  paint()
  const pop = popover(anchor, content, { className: 'db-popover', onClose: () => onDone?.({}) })
  startInput.focus({ preventScroll: true })
  return { close: () => pop.close() }
}

/* ---- files */

function filesEditor({ anchor, prop, row, store, onDone }) {
  const ids = () => getValue(store.rowById.get(row.id) || row, prop) || []
  const fileInput = h('input', { type: 'file', multiple: true, class: 'visually-hidden db-files-input', 'aria-label': 'Upload files' })
  const list = h('div', { class: 'db-files-list' })
  const status = h('div', { class: 'db-files-status', role: 'status' })
  const render = () => {
    const items = ids().map((id) => store.attachments.get(id)).filter(Boolean)
    list.replaceChildren(...items.map((a) => h('div', { class: 'db-files-row', dataset: { id: a.id } },
      /^image\//.test(a.mime) ? h('img', { class: 'db-files-thumb', src: api.url(`/api/attachments/${encodeURIComponent(a.id)}/content`), alt: '' }) : h('span', { class: 'db-files-icon' }, icon('file', { size: 16 })),
      h('a', { class: 'db-files-name', href: api.url(`/api/attachments/${encodeURIComponent(a.id)}/content`), target: '_blank', rel: 'noopener', title: a.filename }, a.filename),
      h('span', { class: 'db-files-size' }, formatSize(a.size)),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon', title: 'Remove', 'aria-label': `Remove ${a.filename}`, onClick: async () => {
        await store.updateValues(row.id, { [prop.id]: ids().filter((x) => x !== a.id) }).catch(() => {})
        api.del(`/api/attachments/${encodeURIComponent(a.id)}`).then(() => store.attachments.delete(a.id), () => {})
        render()
      } }, icon('trash', { size: 14 })))))
    if (!items.length) list.append(h('div', { class: 'db-opt-empty' }, 'No files yet'))
  }
  fileInput.addEventListener('change', async () => {
    const files = [...fileInput.files]
    fileInput.value = ''
    if (!files.length) return
    status.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}`
    try {
      const added = []
      for (const f of files) added.push((await store.upload(row.id, f)).id)
      await store.updateValues(row.id, { [prop.id]: [...ids(), ...added] })
      status.textContent = ''
    } catch (err) {
      status.textContent = ''
      toast(err?.message || 'Upload failed', { type: 'error' })
    }
    render()
  })
  const content = h('div', { class: 'db-files-editor' }, list, status,
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm db-files-upload', onClick: () => fileInput.click() }, icon('upload', { size: 14 }), h('span', { class: 'btn-label' }, 'Upload file')),
    fileInput)
  render()
  const pop = popover(anchor, content, { className: 'db-popover', onClose: () => onDone?.({}) })
  keepInView(pop.el)
  content.querySelector('.db-files-upload').focus({ preventScroll: true })
  return { close: () => pop.close() }
}

function formatSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
