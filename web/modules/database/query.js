// Filtering, search, sorting and grouping for a view. Type behaviour comes from types.js.

import { typeOf, getValue, isEmptyFor, valueText, EMPTY_GROUP } from './types.js'

/** A rule is { property, operator, value }; a group is { op: 'and'|'or', rules: [rule|group] }. */
export function matchesFilter(row, filter, store) {
  if (!filter?.rules?.length) return true
  const results = filter.rules.map((r) => (r.rules ? (r.rules.length ? matchesFilter(row, r, store) : null) : matchesRule(row, r, store)))
  const active = results.filter((x) => x !== null)
  if (!active.length) return true
  return filter.op === 'or' ? active.some(Boolean) : active.every(Boolean)
}

/** Returns true/false, or null when the rule is incomplete (ignored). */
export function matchesRule(row, rule, store) {
  const prop = store.propById.get(rule.property)
  if (!prop) return null
  const op = typeOf(prop).filters?.[rule.operator]
  if (!op) return null
  if (op.input !== 'none' && (rule.value == null || rule.value === '')) return null
  return !!op.test(getValue(row, prop), rule.value, prop)
}

export function matchesSearch(row, query, props, store) {
  const q = query.trim().toLocaleLowerCase('en-AU')
  if (!q) return true
  return props.some((p) => valueText(row, p, store).toLocaleLowerCase('en-AU').includes(q))
}

/** Stable multi-level sort; empty values always last. Without sorts, manual order (sort_order) is kept. */
export function sortRows(rows, sorts, store) {
  const levels = (sorts || []).map((s) => ({ prop: store.propById.get(s.property), dir: s.direction === 'desc' ? -1 : 1 })).filter((l) => l.prop)
  if (!levels.length) return rows
  const keyed = rows.map((row, i) => ({ row, i, vals: levels.map((l) => getValue(row, l.prop)) }))
  keyed.sort((a, b) => {
    for (let k = 0; k < levels.length; k++) {
      const { prop, dir } = levels[k]
      const x = a.vals[k]
      const y = b.vals[k]
      const ex = isEmptyFor(prop, x)
      const ey = isEmptyFor(prop, y)
      if (ex || ey) {
        if (ex && ey) continue
        return ex ? 1 : -1
      }
      const c = typeOf(prop).compare(x, y, prop)
      if (c) return c * dir
    }
    return a.i - b.i
  })
  return keyed.map((k) => k.row)
}

/** Rows visible in a view (filter, search, sort). */
export function viewRows(store, config = {}) {
  const props = store.properties
  const hasFilter = config.filter?.rules?.length
  const q = config.search?.trim()
  let rows = store.rows
  if (hasFilter || q) rows = rows.filter((r) => (!hasFilter || matchesFilter(r, config.filter, store)) && (!q || matchesSearch(r, q, props, store)))
  return sortRows(rows, config.sorts, store)
}

export const isGroupable = (prop) => !!typeOf(prop).group

/** Splits rows into groups of a groupable property: [{ key, label, option?, rows }]. */
export function groupRows(rows, prop) {
  const spec = typeOf(prop).group
  const groups = spec.groups(prop).map((g) => ({ ...g, rows: [] }))
  const byKey = new Map(groups.map((g) => [g.key, g]))
  for (const row of rows) (byKey.get(spec.key(getValue(row, prop))) || byKey.get(EMPTY_GROUP))?.rows.push(row)
  return groups
}

export const groupValue = (prop, key) => typeOf(prop).group.value(key)
