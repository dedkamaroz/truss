// Workbook (sheet module) endpoints and templates. The client owns all computation; the server stores
// raw inputs, formats and sheet layout, and applies structural shifts atomically.
import crypto from 'node:crypto'
import { httpError } from '../http.js'
import { transaction } from '../db.js'

const MAX_ROW = 1048576
const MAX_COL = 16384
const MAX_STRUCT = 100000
const BAD_NAME = /[:\\/?*[\]]/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const now = () => new Date().toISOString()
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text)
    return v ?? fallback
  } catch {
    return fallback
  }
}

function toSheet(row) {
  return {
    id: row.id,
    name: row.name,
    sort_order: row.sort_order,
    col_widths: parseJson(row.col_widths, {}),
    row_heights: parseJson(row.row_heights, {}),
    frozen_rows: row.frozen_rows,
    frozen_cols: row.frozen_cols,
  }
}

export function validateSheetName(name) {
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'invalid_name', 'Sheet name is required')
  const v = name.trim()
  if (v.length > 100) throw httpError(400, 'invalid_name', 'Sheet names can be at most 100 characters')
  if (BAD_NAME.test(v)) throw httpError(400, 'invalid_name', 'Sheet names cannot contain : \\ / ? * [ or ]')
  if (v.startsWith("'") || v.endsWith("'")) throw httpError(400, 'invalid_name', 'Sheet names cannot start or end with an apostrophe')
  return v
}

// Index -> size maps ({ "3": 140 }) sanitised to positive whole pixels.
function sizeMap(v, field) {
  if (!isObj(v)) throw httpError(400, 'invalid_' + field, `${field} must be an object`)
  const out = {}
  for (const [k, px] of Object.entries(v)) {
    if (!/^\d+$/.test(k) || typeof px !== 'number' || !(px >= 4 && px <= 2000)) throw httpError(400, 'invalid_' + field, `${field} entries must map an index to 4-2000 px`)
    out[k] = Math.round(px)
  }
  return JSON.stringify(out)
}

function frozen(v, field, max) {
  if (!Number.isInteger(v) || v < 0 || v > max) throw httpError(400, 'invalid_' + field, `${field} must be a whole number from 0 to ${max}`)
  return v
}

export default function register(router, ctx) {
  const { db } = ctx
  const q = {
    module: db.prepare('SELECT id, type, title FROM modules WHERE id = ?'),
    sheets: db.prepare('SELECT * FROM worksheets WHERE module_id = ? ORDER BY sort_order, created_at'),
    sheet: db.prepare('SELECT * FROM worksheets WHERE id = ? AND module_id = ?'),
    maxOrder: db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM worksheets WHERE module_id = ?'),
    insertSheet: db.prepare(`INSERT INTO worksheets (id, module_id, name, sort_order, col_widths, frozen_rows, frozen_cols, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    delSheet: db.prepare('DELETE FROM worksheets WHERE id = ?'),
    order: db.prepare('UPDATE worksheets SET sort_order = ?, updated_at = ? WHERE id = ? AND module_id = ?'),
    cells: db.prepare('SELECT row, col, raw, format FROM cells WHERE sheet_id = ?'),
    upsert: db.prepare(`INSERT INTO cells (sheet_id, row, col, raw, format) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (sheet_id, row, col) DO UPDATE SET raw = excluded.raw, format = excluded.format`),
    delCell: db.prepare('DELETE FROM cells WHERE sheet_id = ? AND row = ? AND col = ?'),
    touch: db.prepare('UPDATE modules SET updated_at = ? WHERE id = ?'),
  }

  const loadModule = (id) => {
    const m = q.module.get(id)
    if (!m) throw httpError(404, 'module_not_found', 'Module not found')
    if (m.type !== 'sheet') throw httpError(400, 'not_a_workbook', 'Module is not a workbook')
    return m
  }
  const loadSheet = (moduleId, sheetId) => {
    const s = q.sheet.get(sheetId, moduleId)
    if (!s) throw httpError(404, 'sheet_not_found', 'Worksheet not found')
    return s
  }
  const assertUniqueName = (moduleId, name, exceptId) => {
    const clash = q.sheets.all(moduleId).find((s) => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase())
    if (clash) throw httpError(409, 'duplicate_name', `A sheet named "${name}" already exists`)
  }

  function createSheet(moduleId, name, { id = crypto.randomUUID(), colWidths = {}, frozenRows = 0, frozenCols = 0 } = {}) {
    const t = now()
    q.insertSheet.run(id, moduleId, name, q.maxOrder.get(moduleId).m + 1, JSON.stringify(colWidths), frozenRows, frozenCols, t, t)
    return id
  }

  // cells: [{ sheet, row, col, raw, format }]; empty raw with no format deletes the cell.
  function applyCells(moduleId, cells) {
    if (cells === undefined) return 0
    if (!Array.isArray(cells)) throw httpError(400, 'invalid_cells', 'cells must be an array')
    const owned = new Set(q.sheets.all(moduleId).map((s) => s.id))
    const rows = cells.map((c, i) => {
      if (!isObj(c)) throw httpError(400, 'invalid_cells', `cells[${i}] must be an object`)
      if (!owned.has(c.sheet)) throw httpError(400, 'invalid_cells', `cells[${i}].sheet is not a worksheet of this workbook`)
      if (!Number.isInteger(c.row) || c.row < 0 || c.row >= MAX_ROW || !Number.isInteger(c.col) || c.col < 0 || c.col >= MAX_COL) {
        throw httpError(400, 'invalid_cells', `cells[${i}] has an out-of-range row or col`)
      }
      let raw = c.raw
      if (typeof raw === 'number' || typeof raw === 'boolean') raw = String(raw)
      if (raw !== undefined && raw !== null && typeof raw !== 'string') throw httpError(400, 'invalid_cells', `cells[${i}].raw must be a string or null`)
      if (raw === '' || raw === undefined) raw = null
      if (raw !== null && raw.length > 50000) throw httpError(400, 'invalid_cells', `cells[${i}].raw is too long`)
      const f = c.format
      if (f !== undefined && f !== null && !isObj(f)) throw httpError(400, 'invalid_cells', `cells[${i}].format must be an object or null`)
      const format = f && Object.keys(f).length ? JSON.stringify(f) : null
      return [c.sheet, c.row, c.col, raw, format]
    })
    for (const [sheet, row, col, raw, format] of rows) {
      if (raw === null && format === null) q.delCell.run(sheet, row, col)
      else q.upsert.run(sheet, row, col, raw, format)
    }
    return rows.length
  }

  // Shift cell coordinates for inserted/deleted rows or columns. Two passes through negative
  // indices avoid transient primary-key collisions.
  function shift(sheetId, axis, index, count, insert) {
    const c = axis === 'row' ? 'row' : 'col'
    if (!insert) db.prepare(`DELETE FROM cells WHERE sheet_id = ? AND ${c} >= ? AND ${c} < ?`).run(sheetId, index, index + count)
    const from = insert ? index : index + count
    const delta = insert ? count : -count
    db.prepare(`UPDATE cells SET ${c} = -(${c} + ?) - 1 WHERE sheet_id = ? AND ${c} >= ?`).run(delta, sheetId, from)
    db.prepare(`UPDATE cells SET ${c} = -${c} - 1 WHERE sheet_id = ? AND ${c} < 0`).run(sheetId)
    db.prepare(`DELETE FROM cells WHERE sheet_id = ? AND ${c} >= ?`).run(sheetId, axis === 'row' ? MAX_ROW : MAX_COL)
  }

  function fullLoad(moduleId) {
    const m = loadModule(moduleId)
    let rows = q.sheets.all(moduleId)
    if (!rows.length) {
      transaction(db, () => createSheet(moduleId, 'Sheet1'))
      rows = q.sheets.all(moduleId)
    }
    return {
      module: { id: m.id, title: m.title },
      sheets: rows.map((r) => ({
        ...toSheet(r),
        cells: q.cells.all(r.id).map((c) => [c.row, c.col, c.raw, c.format ? parseJson(c.format, null) : null]),
      })),
    }
  }

  const touch = (moduleId) => q.touch.run(now(), moduleId)

  router.get('/api/sheets/:moduleId', ({ params }) => fullLoad(params.moduleId))

  router.post('/api/sheets/:moduleId/sheets', ({ params, body, res }) => {
    loadModule(params.moduleId)
    const b = isObj(body) ? body : {}
    const existing = q.sheets.all(params.moduleId)
    let name
    if (b.name !== undefined) name = validateSheetName(b.name)
    else {
      const taken = new Set(existing.map((s) => s.name.toLowerCase()))
      let n = existing.length + 1
      while (taken.has(`sheet${n}`)) n++
      name = `Sheet${n}`
    }
    if (b.id !== undefined && (typeof b.id !== 'string' || !UUID.test(b.id))) throw httpError(400, 'invalid_id', 'id must be a UUID')
    if (b.id && db.prepare('SELECT 1 FROM worksheets WHERE id = ?').get(b.id)) throw httpError(409, 'duplicate_id', 'A worksheet with this id already exists')
    const id = transaction(db, () => {
      assertUniqueName(params.moduleId, name)
      const sid = createSheet(params.moduleId, name, { id: b.id })
      applyCells(params.moduleId, b.cells)
      touch(params.moduleId)
      return sid
    })
    res.statusCode = 201
    return toSheet(q.sheet.get(id, params.moduleId))
  })

  router.patch('/api/sheets/:moduleId/sheets/:sheetId', ({ params, body }) => {
    loadModule(params.moduleId)
    const sheet = loadSheet(params.moduleId, params.sheetId)
    if (!isObj(body)) throw httpError(400, 'invalid_body', 'JSON object body required')
    const sets = []
    const args = []
    if ('name' in body) {
      const name = validateSheetName(body.name)
      assertUniqueName(params.moduleId, name, sheet.id)
      sets.push('name = ?'), args.push(name)
    }
    if ('col_widths' in body) sets.push('col_widths = ?'), args.push(sizeMap(body.col_widths, 'col_widths'))
    if ('row_heights' in body) sets.push('row_heights = ?'), args.push(sizeMap(body.row_heights, 'row_heights'))
    if ('frozen_rows' in body) sets.push('frozen_rows = ?'), args.push(frozen(body.frozen_rows, 'frozen_rows', 1000))
    if ('frozen_cols' in body) sets.push('frozen_cols = ?'), args.push(frozen(body.frozen_cols, 'frozen_cols', 100))
    if ('sort_order' in body) {
      if (typeof body.sort_order !== 'number' || !Number.isFinite(body.sort_order)) throw httpError(400, 'invalid_sort_order', 'sort_order must be a number')
      sets.push('sort_order = ?'), args.push(body.sort_order)
    }
    transaction(db, () => {
      if (sets.length) {
        sets.push('updated_at = ?'), args.push(now())
        db.prepare(`UPDATE worksheets SET ${sets.join(', ')} WHERE id = ?`).run(...args, sheet.id)
      }
      applyCells(params.moduleId, body.cells)
      touch(params.moduleId)
    })
    return toSheet(q.sheet.get(sheet.id, params.moduleId))
  })

  router.delete('/api/sheets/:moduleId/sheets/:sheetId', ({ params, body }) => {
    loadModule(params.moduleId)
    const sheet = loadSheet(params.moduleId, params.sheetId)
    if (q.sheets.all(params.moduleId).length <= 1) throw httpError(409, 'last_sheet', 'A workbook needs at least one sheet')
    transaction(db, () => {
      q.delSheet.run(sheet.id)
      applyCells(params.moduleId, isObj(body) ? body.cells : undefined)
      touch(params.moduleId)
    })
    return { ok: true }
  })

  router.put('/api/sheets/:moduleId/order', ({ params, body }) => {
    loadModule(params.moduleId)
    const ids = body?.ids
    const existing = q.sheets.all(params.moduleId).map((s) => s.id)
    if (!Array.isArray(ids) || ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((id) => existing.includes(id))) {
      throw httpError(400, 'invalid_order', 'ids must list every worksheet of this workbook exactly once')
    }
    const t = now()
    transaction(db, () => ids.forEach((id, i) => q.order.run(i + 1, t, id, params.moduleId)))
    return q.sheets.all(params.moduleId).map(toSheet)
  })

  router.post('/api/sheets/:moduleId/cells', ({ params, body }) => {
    loadModule(params.moduleId)
    if (!isObj(body) || !Array.isArray(body.cells)) throw httpError(400, 'invalid_body', 'Body must be { cells: [...] }')
    const n = transaction(db, () => {
      const count = applyCells(params.moduleId, body.cells)
      touch(params.moduleId)
      return count
    })
    return { ok: true, count: n }
  })

  // { axis: 'row'|'col', op: 'insert'|'delete', index, count, col_widths?, row_heights?, cells? }
  router.post('/api/sheets/:moduleId/sheets/:sheetId/structure', ({ params, body }) => {
    loadModule(params.moduleId)
    const sheet = loadSheet(params.moduleId, params.sheetId)
    if (!isObj(body)) throw httpError(400, 'invalid_body', 'JSON object body required')
    const { axis, op, index, count = 1 } = body
    if (axis !== 'row' && axis !== 'col') throw httpError(400, 'invalid_axis', 'axis must be row or col')
    if (op !== 'insert' && op !== 'delete') throw httpError(400, 'invalid_op', 'op must be insert or delete')
    const max = axis === 'row' ? MAX_ROW : MAX_COL
    if (!Number.isInteger(index) || index < 0 || index >= max) throw httpError(400, 'invalid_index', 'index out of range')
    if (!Number.isInteger(count) || count < 1 || count > MAX_STRUCT) throw httpError(400, 'invalid_count', 'count out of range')
    transaction(db, () => {
      shift(sheet.id, axis, index, count, op === 'insert')
      const sets = []
      const args = []
      if ('col_widths' in body) sets.push('col_widths = ?'), args.push(sizeMap(body.col_widths, 'col_widths'))
      if ('row_heights' in body) sets.push('row_heights = ?'), args.push(sizeMap(body.row_heights, 'row_heights'))
      sets.push('updated_at = ?'), args.push(now())
      db.prepare(`UPDATE worksheets SET ${sets.join(', ')} WHERE id = ?`).run(...args, sheet.id)
      applyCells(params.moduleId, body.cells)
      touch(params.moduleId)
    })
    return toSheet(q.sheet.get(sheet.id, params.moduleId))
  })

  /* ---------------------------------------------------------------- templates */

  const put = (sheetId, cells) => {
    for (const [a1, raw, format] of cells) {
      const m = /^([A-Z]+)(\d+)$/.exec(a1)
      const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
      q.upsert.run(sheetId, Number(m[2]) - 1, col, raw, format ? JSON.stringify(format) : null)
    }
  }
  const HEAD = { bold: true, fill: 'gray' }
  const AUD = { numberFormat: 'currency' }

  ctx.registerTemplate('sheet', 'blank', {
    name: 'Blank',
    description: 'An empty workbook with one sheet',
    apply(tdb, moduleId) {
      createSheet(moduleId, 'Sheet1')
    },
  })

  ctx.registerTemplate('sheet', 'monthly-budget', {
    name: 'Monthly budget',
    description: 'Income, expenses and a summary that totals them in AUD',
    apply(tdb, moduleId) {
      const income = createSheet(moduleId, 'Income', { colWidths: { 0: 200, 1: 130, 2: 240 }, frozenRows: 1 })
      put(income, [
        ['A1', 'Source', HEAD], ['B1', 'Amount', { ...HEAD, align: 'right' }], ['C1', 'Notes', HEAD],
        ['A2', 'Salary (after tax)'], ['B2', '6200', AUD], ['C2', 'Paid fortnightly'],
        ['A3', 'Freelance work'], ['B3', '850', AUD],
        ['A4', 'Interest'], ['B4', '35', AUD], ['C4', 'High-interest savings account'],
        ['A5', 'Other'], ['B5', '0', AUD],
      ])
      const expenses = createSheet(moduleId, 'Expenses', { colWidths: { 0: 200, 1: 130, 2: 240 }, frozenRows: 1 })
      put(expenses, [
        ['A1', 'Category', HEAD], ['B1', 'Amount', { ...HEAD, align: 'right' }], ['C1', 'Notes', HEAD],
        ['A2', 'Rent'], ['B2', '2400', AUD],
        ['A3', 'Groceries'], ['B3', '720', AUD],
        ['A4', 'Utilities'], ['B4', '260', AUD], ['C4', 'Electricity, gas and water'],
        ['A5', 'Transport'], ['B5', '210', AUD], ['C5', 'Fuel and public transport'],
        ['A6', 'Insurance'], ['B6', '180', AUD],
        ['A7', 'Phone and internet'], ['B7', '110', AUD],
        ['A8', 'Health'], ['B8', '90', AUD],
        ['A9', 'Entertainment'], ['B9', '240', AUD],
        ['A10', 'Savings transfer'], ['B10', '1000', AUD],
      ])
      const summary = createSheet(moduleId, 'Summary', { colWidths: { 0: 200, 1: 140 } })
      put(summary, [
        ['A1', 'Monthly summary', { bold: true }],
        ['A3', 'Total income'], ['B3', '=SUM(Income!B2:B100)', AUD],
        ['A4', 'Total expenses'], ['B4', '=SUM(Expenses!B2:B100)', AUD],
        ['A5', 'Net position', { bold: true }], ['B5', '=B3-B4', { ...AUD, bold: true }],
        ['A6', 'Savings rate'], ['B6', '=IF(B3=0,0,B5/B3)', { numberFormat: 'percent' }],
        ['A8', 'Largest expense'], ['B8', '=MAX(Expenses!B2:B100)', AUD],
      ])
    },
  })
}
