// CSV import helpers without DOM dependencies: column type inference, cell conversion and the Truss document builder.

import { parse as parseCsv, CsvError } from '../../lib/csv.js'

export const IMPORT_TYPES = [
  { key: 'title', label: 'Title' },
  { key: 'text', label: 'Text' },
  { key: 'number', label: 'Number' },
  { key: 'checkbox', label: 'Checkbox' },
  { key: 'date', label: 'Date' },
  { key: 'select', label: 'Select' },
  { key: 'multi_select', label: 'Multi-select' },
  { key: 'url', label: 'URL' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'skip', label: 'Do not import' },
]
const OPTION_COLOURS = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray']
const BOOL_ANY = /^(true|false|yes|no|checked|unchecked)$/i
const BOOL_TRUE = /^(true|yes|y|1|x|checked)$/i
const NUMBER = /^[-+]?\$?\s?[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?%?$/
const URL_RE = /^(https?:\/\/|www\.)\S+$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[+\d\s().-]{3,40}$/

export function parseNumber(text) {
  const t = String(text).trim()
  if (!/\d/.test(t) || !NUMBER.test(t)) return null
  if (/^[-+]?0\d/.test(t.replace(/[$\s]/g, ''))) return null // leading zeros (phone numbers, codes) are text
  const n = Number(t.replace(/[$,\s%]/g, ''))
  return Number.isFinite(n) ? n : null
}

const pad = (n) => String(n).padStart(2, '0')
/** "14/05/2026", "14/5/2026", "2026-05-14" or "2026-05-14T09:30:00Z" -> "2026-05-14"; null otherwise. */
export function parseDate(text) {
  const s = String(text).trim()
  let y, m, d
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s)
  if (match) [, y, m, d] = match
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [, d, m, y] = match
  else return null
  const dt = new Date(Date.UTC(+y, +m - 1, +d))
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

const validUrl = (s) => !/\s/.test(s) && !(/^([a-z][a-z0-9+.-]*):/i.exec(s) && !/^(https?|mailto):/i.test(s) && !/^[a-z0-9.-]+:\d+/i.test(s))

/** Inferred { type, format? } for a column from its non-empty, trimmed values. */
export function inferType(values) {
  if (!values.length) return { type: 'text' }
  if (values.every((v) => BOOL_ANY.test(v))) return { type: 'checkbox' }
  if (values.every((v) => parseNumber(v) != null)) {
    const format = values.some((v) => v.includes('$')) ? 'aud' : values.some((v) => v.endsWith('%')) ? 'percent' : values.some((v) => /\d,\d{3}/.test(v)) ? 'number_with_commas' : 'number'
    return { type: 'number', format }
  }
  if (values.every((v) => parseDate(v))) return { type: 'date' }
  if (values.every((v) => URL_RE.test(v))) return { type: 'url' }
  if (values.every((v) => EMAIL_RE.test(v))) return { type: 'email' }
  const distinct = new Set(values)
  if (values.length >= 2 && distinct.size <= 20 && distinct.size < values.length && values.every((v) => v.length <= 60 && !/[\r\n]/.test(v))) return { type: 'select' }
  return { type: 'text' }
}

/** Converters from cell text to a stored value (undefined when the text does not fit the type). */
export const CONVERT = {
  title: (s) => s || undefined,
  text: (s) => s || undefined,
  number: (s) => parseNumber(s) ?? undefined,
  checkbox: (s) => BOOL_TRUE.test(s.trim()) || undefined,
  date: (s) => {
    const iso = parseDate(s)
    return iso ? { start: iso } : undefined
  },
  url: (s) => (s.trim() && validUrl(s.trim()) ? s.trim() : undefined),
  email: (s) => (EMAIL_RE.test(s.trim()) ? s.trim() : undefined),
  phone: (s) => (PHONE_RE.test(s.trim()) && (s.match(/\d/g) || []).length >= 3 ? s.trim() : undefined),
}
/** Option-based types: how a cell splits into option names. */
export const OPTION_SPLIT = {
  select: (s) => (s.trim() ? [s.trim()] : []),
  status: (s) => (s.trim() ? [s.trim()] : []),
  multi_select: (s) => s.split(',').map((x) => x.trim()).filter(Boolean),
}

const FORMATTED = { number: true }
const MULTI = { multi_select: true }

/** Reads CSV text into { headers, rows } or throws CsvError with a friendly message. */
export function readCsv(text) {
  if (typeof text !== 'string' || /\u0000/.test(text)) throw new CsvError('This file is not CSV text.')
  const body = text.replace(/^\uFEFF/, '')
  const firstLine = body.slice(0, body.search(/\r|\n|$/))
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length])
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0][1] > 1 ? counts[0][0] : ','
  const table = parseCsv(body, { delimiter })
  const nonEmpty = table.filter((r) => r.some((c) => c.trim() !== ''))
  if (!nonEmpty.length) throw new CsvError('The file is empty.')
  const [head, ...rest] = nonEmpty
  if (!rest.length) throw new CsvError('The file has a header row but no rows to import.')
  if (head.length > 500) throw new CsvError('The file has more than 500 columns.')
  const seen = new Map()
  const headers = head.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    return n > 1 ? `${base} ${n}` : base
  })
  const width = headers.length
  const rows = rest.map((r) => (r.length === width ? r : r.length > width ? r.slice(0, width) : [...r, ...Array(width - r.length).fill('')]))
  return { headers, rows, delimiter }
}

/** Column plans with inferred types; the first column becomes the title. */
export function planColumns({ headers, rows }) {
  return headers.map((name, index) => {
    const values = []
    for (const r of rows) {
      const v = r[index].trim()
      if (v) values.push(v)
    }
    const inferred = index === 0 ? { type: 'title' } : inferType(values)
    return { index, name, ...inferred, inferred: inferred.type, samples: values.slice(0, 3), filled: values.length }
  })
}

/** Builds a Truss import document from parsed CSV and column plans. */
export function buildDocument({ title, rows, columns }) {
  const cols = columns.filter((c) => c.type !== 'skip')
  const properties = cols.map((c) => {
    const p = { id: `col${c.index}`, name: c.name, type: c.type, config: {} }
    if (FORMATTED[c.type]) p.config = { format: c.format || 'number' }
    if (OPTION_SPLIT[c.type]) {
      const names = new Map()
      for (const r of rows) for (const n of OPTION_SPLIT[c.type](r[c.index])) if (!names.has(n.toLowerCase())) names.set(n.toLowerCase(), n)
      p.config = { options: [...names.values()].slice(0, 1000).map((name, i) => ({ id: `o${i}`, name: name.slice(0, 200), color: OPTION_COLOURS[i % OPTION_COLOURS.length] })) }
      p._ids = new Map(p.config.options.map((o) => [o.name.toLowerCase(), o.id]))
    }
    return p
  })
  const docRows = rows.map((r) => {
    const values = {}
    properties.forEach((p, i) => {
      const text = r[cols[i].index]
      let v
      if (p._ids) {
        const ids = [...new Set(OPTION_SPLIT[p.type](text).map((n) => p._ids.get(n.toLowerCase())).filter(Boolean))]
        v = MULTI[p.type] ? (ids.length ? ids : undefined) : ids[0]
      } else v = CONVERT[p.type](text)
      if (v !== undefined) values[p.id] = v
    })
    return { values }
  })
  for (const p of properties) delete p._ids
  return { truss: 1, database: { title, properties, views: [{ name: 'Table', type: 'table', config: {} }], rows: docRows } }
}
