// Workbook model: wraps the formula engine, owns raw inputs + formats, batches saves and keeps undo history.
// No DOM access, so it runs under node --test as well as in the browser.
import { createWorkbookEngine, rewriteRefs, parseLiteral, isError, MAX_ROW, MAX_COL } from '../../lib/formula/index.js'

export const key = (row, col) => row * MAX_COL + col
export const keyRow = (k) => Math.floor(k / MAX_COL)
export const keyCol = (k) => k % MAX_COL
const lower = (s) => String(s).toLowerCase()
const isFormula = (raw) => typeof raw === 'string' && raw.length > 1 && raw[0] === '='
const SAVE_DELAY = 400
const UNDO_LIMIT = 200

const NUMBER_FORMATS = {
  number: { type: 'number', decimals: 2 },
  currency: { type: 'currency', decimals: 2 },
  percent: { type: 'percent', decimals: 2 },
  date: 'date',
  text: 'text',
}
const FORMAT_KEYS = ['bold', 'italic', 'color', 'fill', 'align', 'numberFormat']

/** Drops empty keys; returns null for an empty format. */
export function normaliseFormat(f) {
  if (!f) return null
  const out = {}
  for (const k of FORMAT_KEYS) if (f[k] && f[k] !== 'general') out[k] = f[k]
  return Object.keys(out).length ? out : null
}

const sameFormat = (a, b) => JSON.stringify(normaliseFormat(a)) === JSON.stringify(normaliseFormat(b))

/* ---------------------------------------------------------------- pure helpers */

/** Shifts relative references in a formula by (dr, dc), like Excel copy/paste and fill. */
export function shiftFormula(raw, dr, dc) {
  if (!isFormula(raw) || (!dr && !dc)) return raw
  try {
    return '=' + rewriteRefs(raw.slice(1), (ref) => {
      const n = { ...ref }
      if (ref.kind !== 'cols') {
        if (!ref.ar1) n.r1 += dr
        if (!ref.ar2) n.r2 += dr
      }
      if (ref.kind !== 'rows') {
        if (!ref.ac1) n.c1 += dc
        if (!ref.ac2) n.c2 += dc
      }
      if (n.r1 < 0 || n.c1 < 0 || n.r2 < 0 || n.c2 < 0 || n.r1 >= MAX_ROW || n.r2 >= MAX_ROW || n.c1 >= MAX_COL || n.c2 >= MAX_COL) return null
      if (n.r1 === ref.r1 && n.r2 === ref.r2 && n.c1 === ref.c1 && n.c2 === ref.c2) return undefined
      if (n.r1 > n.r2) [n.r1, n.r2, n.ar1, n.ar2] = [n.r2, n.r1, n.ar2, n.ar1]
      if (n.c1 > n.c2) [n.c1, n.c2, n.ac1, n.ac2] = [n.c2, n.c1, n.ac2, n.ac1]
      return n
    })
  } catch {
    return raw
  }
}

/** Excel-compatible TSV: tab separated, newline rows, fields with tabs/newlines/quotes are quoted. */
export function toTsv(rows) {
  const q = (s) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return rows.map((r) => r.map((v) => q(String(v ?? ''))).join('\t')).join('\n')
}

export function parseTsv(text) {
  const rows = []
  let row = []
  let field = ''
  let i = 0
  const s = String(text).replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (!s) return [['']]
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"' && field === '') {
      const end = findClosingQuote(s, i + 1)
      if (end > 0) {
        field = s.slice(i + 1, end).replace(/""/g, '"')
        i = end + 1
        continue
      }
    }
    if (ch === '\t') { row.push(field); field = ''; i++; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += ch
    i++
  }
  row.push(field)
  rows.push(row)
  return rows
}

// A quoted field only counts when the closing quote is followed by a delimiter or the end.
function findClosingQuote(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] !== '"') continue
    if (s[j + 1] === '"') { j++; continue }
    return j + 1 >= s.length || s[j + 1] === '\t' || s[j + 1] === '\n' ? j : -1
  }
  return -1
}

const plainNumber = (raw) => {
  if (typeof raw !== 'string' || raw === '' || isFormula(raw)) return null
  const lit = parseLiteral(raw)
  return typeof lit.value === 'number' && !lit.format ? lit.value : null
}
const numText = (n) => String(Number(n.toPrecision(15)))

/**
 * Continues a line of source raws for `count` cells, nearest first. Two or more plain numbers form a
 * linear series; anything else repeats, with formulas shifted by their distance along `axis`.
 */
export function fillLine(raws, count, axis, backwards = false) {
  const n = raws.length
  const out = []
  const nums = raws.map(plainNumber)
  if (n >= 2 && nums.every((v) => v !== null)) {
    const step = (nums[n - 1] - nums[0]) / (n - 1)
    for (let i = 1; i <= count; i++) out.push(numText(backwards ? nums[0] - step * i : nums[n - 1] + step * i))
    return out
  }
  for (let i = 0; i < count; i++) {
    const j = backwards ? n - 1 - (i % n) : i % n
    const target = backwards ? -1 - i : n + i
    const d = target - j
    out.push(shiftFormula(raws[j], axis === 'row' ? d : 0, axis === 'col' ? d : 0))
  }
  return out
}

/** Shifts an index -> size map for inserted/deleted rows or columns. */
export function shiftSizeMap(map, index, count, insert) {
  const out = {}
  for (const [k, v] of Object.entries(map || {})) {
    const i = Number(k)
    if (i < index) out[i] = v
    else if (insert) out[i + count] = v
    else if (i >= index + count) out[i - count] = v
  }
  return out
}

export function numberFormatSpec(format) {
  return format?.numberFormat ? NUMBER_FORMATS[format.numberFormat] : undefined
}

/* ---------------------------------------------------------------- model */

export class WorkbookModel {
  /**
   * data: GET /api/sheets/:id payload. api: { post, patch, put, del, token }.
   * loadExternal(title) -> Promise<payload|null> for [Workbook]Sheet!A1 references.
   * onChange({ type: 'cells', cells: [{ sheetId, row, col }] } | { type: 'layout', sheetId } | { type: 'sheets' })
   */
  constructor({ data, api, loadExternal, onChange = () => {}, onError = () => {}, onSaveState = () => {}, saveDelay = SAVE_DELAY }) {
    this.moduleId = data.module.id
    this.title = data.module.title
    this.api = api
    this.loadExternal = loadExternal
    this.onChange = onChange
    this.onError = onError
    this.onSaveState = onSaveState
    this.saveDelay = saveDelay
    this.externals = new Map()
    this.pending = new Map()
    this.chain = Promise.resolve()
    this.inflight = 0
    this.undoStack = []
    this.redoStack = []
    this.engine = createWorkbookEngine({ resolveExternal: (wb, sheet, row, col) => this.resolveExternal(wb, sheet, row, col) })
    this.sheets = []
    const entries = []
    for (const s of data.sheets) {
      const sheet = this.makeSheet(s)
      this.engine.addSheet(sheet.name)
      for (const [row, col, raw, format] of s.cells) {
        sheet.cells.set(key(row, col), { raw: raw ?? null, format: normaliseFormat(format) })
        if (raw !== null && raw !== '') entries.push({ sheet: sheet.name, row, col, raw })
        this.grow(sheet, row, col)
      }
    }
    if (entries.length) this.engine.setCells(entries)
  }

  makeSheet(s) {
    const sheet = {
      id: s.id, name: s.name, colWidths: { ...(s.col_widths || {}) }, rowHeights: { ...(s.row_heights || {}) },
      frozenRows: s.frozen_rows || 0, frozenCols: s.frozen_cols || 0, cells: new Map(), maxRow: -1, maxCol: -1,
    }
    this.sheets.push(sheet)
    return sheet
  }

  grow(sheet, row, col) {
    if (row > sheet.maxRow) sheet.maxRow = row
    if (col > sheet.maxCol) sheet.maxCol = col
  }

  recomputeBounds(sheet) {
    sheet.maxRow = -1
    sheet.maxCol = -1
    for (const k of sheet.cells.keys()) this.grow(sheet, keyRow(k), keyCol(k))
  }

  sheet(id) {
    return this.sheets.find((s) => s.id === id)
  }

  sheetByName(name) {
    const n = lower(name)
    return this.sheets.find((s) => lower(s.name) === n)
  }

  /* ---- reads */

  getCell(sheetId, row, col) {
    return this.sheet(sheetId)?.cells.get(key(row, col))
  }

  getRaw(sheetId, row, col) {
    return this.getCell(sheetId, row, col)?.raw ?? ''
  }

  getFormat(sheetId, row, col) {
    return this.getCell(sheetId, row, col)?.format ?? null
  }

  getValue(sheetId, row, col) {
    const s = this.sheet(sheetId)
    return s ? this.engine.getValue(s.name, row, col) : null
  }

  /** { text, value, format } for rendering. */
  display(sheet, row, col) {
    const cell = sheet.cells.get(key(row, col))
    const value = this.engine.getValue(sheet.name, row, col)
    if (!cell && value === null) return null
    return { text: this.engine.getDisplay(sheet.name, row, col, numberFormatSpec(cell?.format)), value, format: cell?.format ?? null }
  }

  /* ---- external workbooks */

  resolveExternal(wb, sheetName, row, col) {
    if (lower(wb) === lower(this.title)) {
      return this.engine.hasSheet(sheetName) ? this.engine.getValue(sheetName, row, col) : { error: '#REF!' }
    }
    const k = lower(wb)
    let ext = this.externals.get(k)
    if (!ext) {
      ext = { status: 'loading', name: wb }
      this.externals.set(k, ext)
      Promise.resolve(this.loadExternal ? this.loadExternal(wb) : null).then((data) => {
        if (data) {
          const engine = createWorkbookEngine({ resolveExternal: () => ({ error: '#REF!' }) }) // ponytail: no nested external chains
          const entries = []
          for (const s of data.sheets) {
            engine.addSheet(s.name)
            for (const [row, col, raw] of s.cells) if (raw !== null && raw !== '') entries.push({ sheet: s.name, row, col, raw })
          }
          if (entries.length) engine.setCells(entries)
          Object.assign(ext, { status: 'ready', engine })
        } else ext.status = 'missing'
      }, () => { ext.status = 'missing' }).then(() => {
        this.emitCells(this.engine.invalidateExternal(wb))
      })
    }
    if (ext.status === 'loading') return { error: '#N/A' }
    if (ext.status === 'missing' || !ext.engine.hasSheet(sheetName)) return { error: '#REF!' }
    return ext.engine.getValue(sheetName, row, col)
  }

  /** 'loading' | 'missing' | 'ready' | undefined for a referenced workbook title. */
  externalStatus(title) {
    return this.externals.get(lower(title))?.status
  }

  emitCells(changes) {
    if (!changes.length) return
    const cells = []
    for (const c of changes) {
      const s = this.sheetByName(c.sheet)
      if (s) cells.push({ sheetId: s.id, row: c.row, col: c.col })
    }
    this.onChange({ type: 'cells', cells })
  }

  /* ---- persistence */

  queue(sheetId, row, col) {
    this.pending.set(`${sheetId}|${row}|${col}`, { sheetId, row, col })
  }

  scheduleSave() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.saveDelay)
    this.onSaveState('pending')
  }

  takeBatch() {
    clearTimeout(this.timer)
    const batch = []
    for (const { sheetId, row, col } of this.pending.values()) {
      const s = this.sheet(sheetId)
      if (!s) continue
      const c = s.cells.get(key(row, col))
      batch.push({ sheet: sheetId, row, col, raw: c?.raw ?? null, format: c?.format ?? null })
    }
    this.pending.clear()
    return batch
  }

  send(fn) {
    this.inflight++
    this.onSaveState('saving')
    this.chain = this.chain.then(fn).catch((err) => this.onError(err)).finally(() => {
      if (--this.inflight === 0 && !this.pending.size) this.onSaveState('saved')
    })
    return this.chain
  }

  /** Sends pending cell edits now (in order with any structural requests). */
  flush() {
    const batch = this.takeBatch()
    if (!batch.length) return this.chain
    return this.send(() => this.api.post(`/api/sheets/${this.moduleId}/cells`, { cells: batch }))
  }

  /** Best-effort save while the page unloads. ponytail: keepalive bodies cap at 64 KB, so a huge unsaved batch can be lost. */
  flushOnUnload() {
    const batch = this.takeBatch()
    if (!batch.length) return
    try {
      fetch(`/api/sheets/${this.moduleId}/cells`, {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Truss-Token': this.api.token }, body: JSON.stringify({ cells: batch }),
      })
    } catch { /* page is going away */ }
  }

  /* ---- cell edits */

  /**
   * entries: [{ row, col, raw?, format? }] (undefined keeps the current value). Records one undo step.
   * Returns the changed cell positions.
   */
  setCells(sheetId, entries, { record = true } = {}) {
    const sheet = this.sheet(sheetId)
    if (!sheet) return []
    const before = []
    const after = []
    for (const e of entries) {
      const cur = sheet.cells.get(key(e.row, e.col))
      const raw = e.raw === undefined ? cur?.raw ?? null : e.raw === '' || e.raw === null ? null : String(e.raw)
      const format = e.format === undefined ? cur?.format ?? null : normaliseFormat(e.format)
      if ((cur?.raw ?? null) === raw && sameFormat(cur?.format, format)) continue
      before.push({ row: e.row, col: e.col, raw: cur?.raw ?? null, format: cur?.format ?? null })
      after.push({ row: e.row, col: e.col, raw, format })
    }
    if (!after.length) return []
    if (record) this.record({ kind: 'cells', sheetId, before, after })
    return this.applyCells(sheet, after)
  }

  applyCells(sheet, list) {
    const engineEntries = []
    const touched = []
    for (const e of list) {
      const k = key(e.row, e.col)
      const cur = sheet.cells.get(k)
      if ((cur?.raw ?? null) !== e.raw) engineEntries.push({ sheet: sheet.name, row: e.row, col: e.col, raw: e.raw })
      if (e.raw === null && !e.format) sheet.cells.delete(k)
      else {
        sheet.cells.set(k, { raw: e.raw, format: e.format })
        this.grow(sheet, e.row, e.col)
      }
      this.queue(sheet.id, e.row, e.col)
      touched.push({ sheetId: sheet.id, row: e.row, col: e.col })
    }
    this.scheduleSave()
    const changes = engineEntries.length ? this.engine.setCells(engineEntries) : []
    const seen = new Set(touched.map((t) => `${t.sheetId}|${t.row}|${t.col}`))
    for (const c of changes) {
      const s = this.sheetByName(c.sheet)
      if (s && !seen.has(`${s.id}|${c.row}|${c.col}`)) touched.push({ sheetId: s.id, row: c.row, col: c.col })
    }
    this.onChange({ type: 'cells', cells: touched })
    return touched
  }

  /* ---- undo / redo */

  record(step) {
    if (this.groupSteps) return void this.groupSteps.push(step)
    this.undoStack.push(step)
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()
    this.redoStack = []
  }

  /** Runs fn; every change it records becomes a single undo step. */
  group(fn) {
    if (this.groupSteps) return fn()
    this.groupSteps = []
    try {
      return fn()
    } finally {
      const steps = this.groupSteps
      this.groupSteps = null
      if (steps.length === 1) this.record(steps[0])
      else if (steps.length) this.record({ kind: 'group', steps, sheetIds: steps.map((s) => s.sheetId) })
    }
  }

  undo() {
    const step = this.undoStack.pop()
    if (!step) return null
    this.replay(step, true)
    this.redoStack.push(step)
    return step
  }

  redo() {
    const step = this.redoStack.pop()
    if (!step) return null
    this.replay(step, false)
    this.undoStack.push(step)
    return step
  }

  replay(step, reverse) {
    if (step.kind === 'group') {
      for (const s of reverse ? [...step.steps].reverse() : step.steps) this.replay(s, reverse)
      return
    }
    const sheet = this.sheet(step.sheetId)
    if (!sheet) return
    if (step.kind === 'cells') this.applyCells(sheet, reverse ? step.before : step.after)
    else if (step.kind === 'struct') {
      const { axis, index, count, insert, snapshot } = step
      if (!reverse) return this.structural(sheet, axis, index, count, insert)
      // Invert, then put back every formula text and any deleted cells exactly as they were.
      const restore = [...snapshot.formulas]
      if (!insert) for (const c of snapshot.band) restore.push({ sheetId: sheet.id, ...c })
      this.structural(sheet, axis, index, count, !insert, { restore, sizes: snapshot.sizes })
    }
  }

  /* ---- rows and columns */

  insertRows(sheetId, index, count = 1) { return this.structure(sheetId, 'row', index, count, true) }
  deleteRows(sheetId, index, count = 1) { return this.structure(sheetId, 'row', index, count, false) }
  insertCols(sheetId, index, count = 1) { return this.structure(sheetId, 'col', index, count, true) }
  deleteCols(sheetId, index, count = 1) { return this.structure(sheetId, 'col', index, count, false) }

  structure(sheetId, axis, index, count, insert) {
    const sheet = this.sheet(sheetId)
    if (!sheet) return
    const formulas = []
    for (const s of this.sheets) for (const [k, c] of s.cells) if (isFormula(c.raw)) formulas.push({ sheetId: s.id, row: keyRow(k), col: keyCol(k), raw: c.raw, format: c.format })
    const band = []
    if (!insert) {
      for (const [k, c] of sheet.cells) {
        const p = axis === 'row' ? keyRow(k) : keyCol(k)
        if (p >= index && p < index + count) band.push({ row: keyRow(k), col: keyCol(k), raw: c.raw, format: c.format })
      }
    }
    const sizes = { colWidths: { ...sheet.colWidths }, rowHeights: { ...sheet.rowHeights } }
    this.record({ kind: 'struct', sheetId, axis, index, count, insert, snapshot: { formulas, band, sizes } })
    this.structural(sheet, axis, index, count, insert)
  }

  structural(sheet, axis, index, count, insert, { restore = [], sizes } = {}) {
    this.flush()
    const isRow = axis === 'row'
    const name = sheet.name
    if (isRow) (insert ? this.engine.insertRows : this.engine.deleteRows)(name, index, count)
    else (insert ? this.engine.insertCols : this.engine.deleteCols)(name, index, count)

    const moved = new Map()
    for (const [k, c] of sheet.cells) {
      let r = keyRow(k)
      let col = keyCol(k)
      let p = isRow ? r : col
      if (insert) { if (p >= index) p += count }
      else if (p >= index && p < index + count) continue
      else if (p >= index + count) p -= count
      if (p >= (isRow ? MAX_ROW : MAX_COL)) continue
      if (isRow) r = p
      else col = p
      moved.set(key(r, col), c)
    }
    sheet.cells = moved
    this.recomputeBounds(sheet)
    if (sizes) {
      sheet.colWidths = { ...sizes.colWidths }
      sheet.rowHeights = { ...sizes.rowHeights }
    } else if (isRow) sheet.rowHeights = shiftSizeMap(sheet.rowHeights, index, count, insert)
    else sheet.colWidths = shiftSizeMap(sheet.colWidths, index, count, insert)

    const payload = new Map()
    const put = (s, row, col) => {
      const c = s.cells.get(key(row, col))
      payload.set(`${s.id}|${row}|${col}`, { sheet: s.id, row, col, raw: c?.raw ?? null, format: c?.format ?? null })
    }
    // Formula text rewritten by the engine (references into the shifted sheet, from any sheet).
    for (const s of this.sheets) {
      for (const [k, c] of s.cells) {
        if (!isFormula(c.raw)) continue
        const next = this.engine.getRaw(s.name, keyRow(k), keyCol(k))
        if (next && next !== c.raw) {
          c.raw = next
          put(s, keyRow(k), keyCol(k))
        }
      }
    }
    if (restore.length) {
      const bySheet = new Map()
      for (const c of restore) {
        const s = this.sheet(c.sheetId)
        if (!s) continue
        const cur = s.cells.get(key(c.row, c.col))
        if (cur?.raw === c.raw && sameFormat(cur?.format, c.format)) continue
        s.cells.set(key(c.row, c.col), { raw: c.raw, format: c.format ?? cur?.format ?? null })
        this.grow(s, c.row, c.col)
        if (!bySheet.has(s)) bySheet.set(s, [])
        bySheet.get(s).push({ sheet: s.name, row: c.row, col: c.col, raw: c.raw })
        put(s, c.row, c.col)
      }
      for (const list of bySheet.values()) this.engine.setCells(list)
    }
    this.send(() => this.api.post(`/api/sheets/${this.moduleId}/sheets/${sheet.id}/structure`, {
      axis, op: insert ? 'insert' : 'delete', index, count,
      col_widths: sheet.colWidths, row_heights: sheet.rowHeights, cells: [...payload.values()],
    }))
    this.onChange({ type: 'layout', sheetId: sheet.id })
  }

  /* ---- layout */

  setSize(sheetId, axis, index, px) {
    const sheet = this.sheet(sheetId)
    if (!sheet) return
    const map = axis === 'col' ? sheet.colWidths : sheet.rowHeights
    map[index] = Math.round(px)
    this.patchSheet(sheet, axis === 'col' ? { col_widths: sheet.colWidths } : { row_heights: sheet.rowHeights })
  }

  setFrozen(sheetId, rows, cols) {
    const sheet = this.sheet(sheetId)
    if (!sheet) return
    sheet.frozenRows = rows
    sheet.frozenCols = cols
    this.patchSheet(sheet, { frozen_rows: rows, frozen_cols: cols })
    this.onChange({ type: 'layout', sheetId })
  }

  patchSheet(sheet, body) {
    this.flush()
    return this.send(() => this.api.patch(`/api/sheets/${this.moduleId}/sheets/${sheet.id}`, body))
  }

  /* ---- sheets */

  nextSheetName() {
    let n = this.sheets.length + 1
    while (this.sheetByName(`Sheet${n}`)) n++
    return `Sheet${n}`
  }

  static validateName(name, model, exceptId) {
    const v = String(name ?? '').trim()
    if (!v) return 'Sheet name is required'
    if (v.length > 100) return 'Sheet names can be at most 100 characters'
    if (/[:\\/?*[\]]/.test(v)) return 'Sheet names cannot contain : \\ / ? * [ or ]'
    if (v.startsWith("'") || v.endsWith("'")) return 'Sheet names cannot start or end with an apostrophe'
    const clash = model.sheetByName(v)
    if (clash && clash.id !== exceptId) return `A sheet named "${v}" already exists`
    return null
  }

  addSheet(name = this.nextSheetName()) {
    const id = globalThis.crypto.randomUUID()
    this.flush()
    const sheet = this.makeSheet({ id, name })
    this.engine.addSheet(name)
    this.send(() => this.api.post(`/api/sheets/${this.moduleId}/sheets`, { id, name }))
    // Formulas that referenced a not-yet-existing sheet now resolve.
    this.emitAll()
    this.onChange({ type: 'sheets' })
    return sheet
  }

  renameSheet(sheetId, name) {
    const sheet = this.sheet(sheetId)
    const v = String(name).trim()
    if (!sheet || v === sheet.name) return
    this.flush()
    this.engine.renameSheet(sheet.name, v)
    sheet.name = v
    const cells = this.syncFormulaRaws()
    this.send(() => this.api.patch(`/api/sheets/${this.moduleId}/sheets/${sheet.id}`, { name: v, cells }))
    this.onChange({ type: 'sheets' })
  }

  deleteSheet(sheetId) {
    const sheet = this.sheet(sheetId)
    if (!sheet || this.sheets.length <= 1) return
    this.flush()
    this.engine.removeSheet(sheet.name)
    this.sheets = this.sheets.filter((s) => s !== sheet)
    const cells = this.syncFormulaRaws()
    // Steps that touch the deleted sheet can no longer be replayed.
    const keep = (s) => s.sheetId !== sheetId && !s.sheetIds?.includes(sheetId)
    this.undoStack = this.undoStack.filter(keep)
    this.redoStack = this.redoStack.filter(keep)
    this.send(() => this.api.del(`/api/sheets/${this.moduleId}/sheets/${sheet.id}`, { cells }))
    this.onChange({ type: 'sheets' })
  }

  moveSheet(sheetId, toIndex) {
    const from = this.sheets.findIndex((s) => s.id === sheetId)
    if (from < 0) return
    const [s] = this.sheets.splice(from, 1)
    this.sheets.splice(Math.max(0, Math.min(toIndex, this.sheets.length)), 0, s)
    if (from === this.sheets.indexOf(s)) return
    const ids = this.sheets.map((x) => x.id)
    this.flush()
    this.send(() => this.api.put(`/api/sheets/${this.moduleId}/order`, { ids }))
    this.onChange({ type: 'sheets' })
  }

  /** Copies engine-rewritten formula text into the model; returns the save payload. */
  syncFormulaRaws() {
    const out = []
    for (const s of this.sheets) {
      for (const [k, c] of s.cells) {
        if (!isFormula(c.raw)) continue
        const next = this.engine.getRaw(s.name, keyRow(k), keyCol(k))
        if (next && next !== c.raw) {
          c.raw = next
          out.push({ sheet: s.id, row: keyRow(k), col: keyCol(k), raw: next, format: c.format })
        }
      }
    }
    this.emitAll()
    return out
  }

  emitAll() {
    this.onChange({ type: 'layout', sheetId: null })
  }
}

export { isError, isFormula }
