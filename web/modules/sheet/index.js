// Workbook content type: virtualised spreadsheet grid on top of the formula engine.
import { WorkbookModel, key, keyRow, keyCol, shiftFormula, toTsv, parseTsv, fillLine, isFormula, numberFormatSpec } from './model.js'
import { listFunctions, colToLetters, fromA1, tokenize, refToString, isError, formatValue, MAX_ROW, MAX_COL } from '../../lib/formula/index.js'

const DEFAULT_W = 100
const DEFAULT_H = 26
const HEAD_H = 26
const MIN_ROWS = 1000
const MIN_COLS = 26
const ROW_BUFFER = 6
const COL_BUFFER = 2
const PALETTE = [
  ['gray', 'Grey'], ['brown', 'Brown'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'],
  ['blue', 'Blue'], ['purple', 'Purple'], ['pink', 'Pink'], ['red', 'Red'],
]
const NUMBER_FORMATS = [
  ['general', 'General', 'Automatic'],
  ['number', 'Number', '1,234.56'],
  ['currency', 'Currency (AUD)', '$1,234.56'],
  ['percent', 'Percent', '12.34%'],
  ['date', 'Date', 'DD/MM/YYYY'],
  ['text', 'Plain text', 'As typed'],
]
const ERROR_HELP = {
  '#DIV/0!': 'Division by zero. The formula divides by zero or by an empty cell.',
  '#REF!': 'Invalid reference. The formula points at a cell, sheet or workbook that does not exist (it may have been deleted or renamed).',
  '#NAME?': 'Unknown name. Check the spelling of the function, or put text in double quotes.',
  '#VALUE!': 'Wrong kind of value. An argument has the wrong type (for example text where a number is needed), or the formula cannot be read.',
  '#N/A': 'Value not available. A lookup found no match, or referenced data is still loading.',
  '#NUM!': 'Invalid number. The result is too large, too small or not a real number.',
  '#CYCLE!': 'Circular reference. The formula depends on its own result.',
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const GLYPHS = {
  undo: '<path d="M9 7 4.5 11.5 9 16"/><path d="M5 11.5h9.5a5 5 0 0 1 0 10H12"/>',
  redo: '<path d="m15 7 4.5 4.5L15 16"/><path d="M19 11.5H9.5a5 5 0 0 0 0 10H12"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" stroke-width="2.2"/>',
  italic: '<path d="M10 5h8M6 19h8M14.5 5l-5 14"/>',
  color: '<path d="m6.5 16 5.5-12 5.5 12M8.6 11.5h6.8"/>',
  fill: '<path d="m5 11 6.5-6.5 7 7L12 18a2 2 0 0 1-2.8 0L5 13.8A2 2 0 0 1 5 11z"/><path d="M19.5 15.5s1.5 1.8 1.5 2.8a1.5 1.5 0 0 1-3 0c0-1 1.5-2.8 1.5-2.8z"/>',
  'align-left': '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  'align-center': '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  'align-right': '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  freeze: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9h17M9 3.5v17" stroke-width="2.4"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  fx: '<path d="M10.5 5.5c-2 0-2.6 1.2-3 3.2L6 17c-.4 2-1 3-3 3M4.5 10h6"/><path d="m13 11 6 7M19 11l-6 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
}

function glyph(name, size = 16) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon')
  svg.innerHTML = GLYPHS[name] // static, trusted markup
  return svg
}

// No `label`: the shell already names this type "Workbook", and a label makes it re-render the sidebar after boot.
export default { type: 'sheet', icon: 'sheet', mount }

function mount(el, mctx) {
  const { api, ui } = mctx
  let view = null
  let disposed = false
  const root = ui.h('div', { class: 'sheet-app is-loading', 'aria-busy': 'true' }, ui.h('div', { class: 'sheet-loading' }, 'Loading workbook'))
  el.append(root)
  Promise.all([
    api.get(`/api/sheets/${encodeURIComponent(mctx.module.id)}`),
    ui.loadCss(new URL('./sheet.css', import.meta.url).href),
  ]).then(([data]) => {
    if (disposed) return
    root.classList.remove('is-loading')
    root.removeAttribute('aria-busy')
    view = createView(root, data, mctx)
  }).catch((err) => {
    if (disposed) return
    console.warn('[sheet] load failed', err)
    root.classList.remove('is-loading')
    root.replaceChildren(ui.h('div', { class: 'sheet-loading is-error' }, `Could not open this workbook: ${err?.message || 'unknown error'}`))
  })
  return {
    unmount() {
      disposed = true
      view?.destroy()
    },
    onModuleChange(m) {
      if (view) view.model.title = m.title
    },
  }
}

/* ================================================================== view */

function createView(root, data, mctx) {
  const { api, ui } = mctx
  const { h } = ui
  const cleanups = []
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts)
    cleanups.push(() => target.removeEventListener(type, fn, opts))
  }
  const ACTIVE_KEY = `truss.sheet.active.${data.module.id}`
  const FUNCTIONS = listFunctions()

  /* ---------------------------------------------------------------- model */

  const model = new WorkbookModel({
    data,
    api,
    loadExternal: async (title) => {
      const mods = await api.get('/api/modules')
      const wanted = String(title).trim().toLowerCase()
      const m = mods.find((x) => x.type === 'sheet' && x.id !== data.module.id && x.title.trim().toLowerCase() === wanted)
      return m ? api.get(`/api/sheets/${encodeURIComponent(m.id)}`) : null
    },
    onChange: (e) => onModelChange(e),
    onError: (err) => {
      console.warn('[sheet] save failed', err)
      setSaveState('error')
      ui.toast(`Could not save changes: ${err?.message || 'unknown error'}`, { type: 'error' })
    },
    onSaveState: (s) => setSaveState(s),
  })

  let sheet = model.sheets.find((s) => s.id === store(ACTIVE_KEY)) || model.sheets[0]
  const selections = new Map() // sheetId -> { sel, scrollX, scrollY }
  let sel = { ar: 0, ac: 0, er: 0, ec: 0 }
  let edit = null // { sheetId, r, c, mode: 'enter'|'edit', source: 'cell'|'bar', original, point }
  let clip = null
  let ac = null // autocomplete state
  let fillPreview = null
  let lastCommitMs = 0

  /* ---------------------------------------------------------------- DOM */

  const tbButton = (name, title, onClick, extra = {}) => {
    const b = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon sheet-tb', title, 'aria-label': title, ...extra }, glyph(name))
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => onClick(e, b))
    return b
  }
  const sep = () => h('span', { class: 'sheet-tb-sep', 'aria-hidden': 'true' })

  const undoBtn = tbButton('undo', 'Undo (Ctrl+Z)', () => undo())
  const redoBtn = tbButton('redo', 'Redo (Ctrl+Y)', () => redo())
  const nfLabel = h('span', { class: 'sheet-nf-label' }, 'General')
  const nfBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm sheet-tb sheet-nf', title: 'Number format', 'aria-haspopup': 'menu' }, nfLabel, glyph('chevron', 14))
  nfBtn.addEventListener('mousedown', (e) => e.preventDefault())
  nfBtn.addEventListener('click', () => openNumberFormatMenu())
  const boldBtn = tbButton('bold', 'Bold (Ctrl+B)', () => toggleFormat('bold'), { 'aria-pressed': 'false' })
  const italicBtn = tbButton('italic', 'Italic (Ctrl+I)', () => toggleFormat('italic'), { 'aria-pressed': 'false' })
  const colorBar = h('span', { class: 'sheet-swatch-bar' })
  const colorBtn = tbButton('color', 'Text colour', (e, b) => openPalette(b, 'color'), { 'aria-haspopup': 'dialog' })
  colorBtn.append(colorBar)
  const fillBar = h('span', { class: 'sheet-swatch-bar' })
  const fillBtn = tbButton('fill', 'Fill colour', (e, b) => openPalette(b, 'fill'), { 'aria-haspopup': 'dialog' })
  fillBtn.append(fillBar)
  const alignBtns = ['left', 'center', 'right'].map((a) => tbButton(`align-${a}`, `Align ${a === 'center' ? 'centre' : a}`, () => setAlign(a), { 'aria-pressed': 'false', 'data-align': a }))
  const freezeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm sheet-tb sheet-freeze', title: 'Freeze panes', 'aria-haspopup': 'menu' }, glyph('freeze'), h('span', { class: 'btn-label' }, 'Freeze'), glyph('chevron', 14))
  freezeBtn.addEventListener('mousedown', (e) => e.preventDefault())
  freezeBtn.addEventListener('click', () => openFreezeMenu())
  const saveEl = h('span', { class: 'sheet-save-state', role: 'status', 'aria-live': 'polite' })
  const toolbar = h('div', { class: 'sheet-toolbar', role: 'toolbar', 'aria-label': 'Workbook toolbar' },
    undoBtn, redoBtn, sep(), nfBtn, sep(), boldBtn, italicBtn, colorBtn, fillBtn, sep(), ...alignBtns, sep(), freezeBtn,
    h('span', { class: 'sheet-tb-spacer' }), saveEl)

  const nameBox = h('input', { class: 'sheet-namebox', type: 'text', 'aria-label': 'Name box', spellcheck: 'false', autocomplete: 'off' })
  const fxInput = h('input', { class: 'sheet-fx-input', type: 'text', 'aria-label': 'Formula bar', spellcheck: 'false', autocomplete: 'off' })
  const formulaBar = h('div', { class: 'sheet-formula-bar' }, nameBox, h('span', { class: 'sheet-fx', 'aria-hidden': 'true' }, glyph('fx', 15)), fxInput)

  const canvas = h('div', { class: 'sheet-canvas' })
  const spacer = h('div', { class: 'sheet-spacer', 'aria-hidden': 'true' })
  const scroller = h('div', { class: 'sheet-scroller' }, canvas, spacer)
  const editor = h('textarea', { class: 'sheet-editor is-idle', 'aria-label': 'Cell editor', spellcheck: 'false', autocomplete: 'off', wrap: 'off', rows: '1' })
  const acBox = h('div', { class: 'sheet-ac', role: 'listbox', hidden: true })
  const tooltip = h('div', { class: 'sheet-tooltip', role: 'tooltip', hidden: true })
  const gridEl = h('div', { class: 'sheet-grid' }, scroller, editor, acBox, tooltip)

  const addSheetBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon sheet-tab-add', title: 'Add sheet', 'aria-label': 'Add sheet' }, glyph('plus', 15))
  const tabsEl = h('div', { class: 'sheet-tabs', role: 'tablist', 'aria-label': 'Sheets' })
  const statusEl = h('div', { class: 'sheet-status', 'aria-live': 'polite' })
  const footer = h('div', { class: 'sheet-footer' }, addSheetBtn, tabsEl, statusEl)

  root.replaceChildren(toolbar, formulaBar, gridEl, footer)

  const pane = (cls, rk, ck) => {
    const el = h('div', { class: `sheet-pane ${cls}` })
    const layer = h('div', { class: 'sheet-layer' })
    const ov = h('div', { class: 'sheet-ov' })
    el.append(layer)
    layer.append(ov)
    return { el, layer, ov, rk, ck, cells: new Map(), range: null }
  }
  const panes = {
    main: pane('pane-main', 'main', 'main'),
    left: pane('pane-left', 'main', 'frozen'),
    top: pane('pane-top', 'frozen', 'main'),
    corner: pane('pane-corner', 'frozen', 'frozen'),
  }
  const cellPanes = [panes.main, panes.left, panes.top, panes.corner]
  const headPane = (cls, axis, kind) => {
    const el = h('div', { class: `sheet-head ${cls}` })
    const layer = h('div', { class: 'sheet-layer' })
    el.append(layer)
    return { el, layer, axis, kind, range: null }
  }
  const heads = {
    colMain: headPane('head-col', 'col', 'main'),
    colFrozen: headPane('head-col is-frozen', 'col', 'frozen'),
    rowMain: headPane('head-row', 'row', 'main'),
    rowFrozen: headPane('head-row is-frozen', 'row', 'frozen'),
  }
  const cornerHead = h('div', { class: 'sheet-head head-corner', title: 'Select all' })
  canvas.append(panes.main.el, panes.left.el, panes.top.el, panes.corner.el, heads.colMain.el, heads.colFrozen.el, heads.rowMain.el, heads.rowFrozen.el, cornerHead)

  /* ---------------------------------------------------------------- geometry */

  let rows = 0
  let cols = 0
  let colX = new Float64Array(1)
  let rowY = new Float64Array(1)
  let HW = 46
  let FW = 0
  let FH = 0
  let fr = 0
  let fc = 0
  let viewW = 0
  let viewH = 0
  let scrollX = 0
  let scrollY = 0

  const colW = (c) => sheet.colWidths[c] ?? DEFAULT_W
  const rowH = (r) => sheet.rowHeights[r] ?? DEFAULT_H

  function rebuildGeometry() {
    rows = Math.min(MAX_ROW, Math.max(rows, MIN_ROWS, sheet.maxRow + 200, sel.er + 50, sel.ar + 50))
    cols = Math.min(MAX_COL, Math.max(cols, MIN_COLS, sheet.maxCol + 10, sel.ec + 5, sel.ac + 5))
    colX = new Float64Array(cols + 1)
    for (let c = 0; c < cols; c++) colX[c + 1] = colX[c] + colW(c)
    rowY = new Float64Array(rows + 1)
    const custom = Object.keys(sheet.rowHeights).length > 0
    for (let r = 0; r < rows; r++) rowY[r + 1] = rowY[r] + (custom ? rowH(r) : DEFAULT_H)
    HW = Math.max(46, String(rows).length * 8 + 18)
    fr = Math.min(sheet.frozenRows, rows)
    fc = Math.min(sheet.frozenCols, cols)
    FW = colX[fc]
    FH = rowY[fr]
    spacer.style.width = `${HW + colX[cols]}px`
    spacer.style.height = `${HEAD_H + rowY[rows]}px`
    measureView()
  }

  function measureView() {
    viewW = scroller.clientWidth
    viewH = scroller.clientHeight
    canvas.style.width = `${viewW}px`
    canvas.style.height = `${viewH}px`
    const place = (el, l, t, w, hh) => { el.style.cssText = `left:${l}px;top:${t}px;width:${Math.max(0, w)}px;height:${Math.max(0, hh)}px` }
    place(panes.corner.el, HW, HEAD_H, FW, FH)
    place(panes.top.el, HW + FW, HEAD_H, viewW - HW - FW, FH)
    place(panes.left.el, HW, HEAD_H + FH, FW, viewH - HEAD_H - FH)
    place(panes.main.el, HW + FW, HEAD_H + FH, viewW - HW - FW, viewH - HEAD_H - FH)
    place(heads.colFrozen.el, HW, 0, FW, HEAD_H)
    place(heads.colMain.el, HW + FW, 0, viewW - HW - FW, HEAD_H)
    place(heads.rowFrozen.el, 0, HEAD_H, HW, FH)
    place(heads.rowMain.el, 0, HEAD_H + FH, HW, viewH - HEAD_H - FH)
    place(cornerHead, 0, 0, HW, HEAD_H)
    panes.top.el.classList.toggle('has-freeze', fr > 0)
    panes.corner.el.classList.toggle('has-freeze-row', fr > 0)
    panes.corner.el.classList.toggle('has-freeze-col', fc > 0)
    panes.left.el.classList.toggle('has-freeze', fc > 0)
    applyTransforms()
  }

  function applyTransforms() {
    const tx = `translateX(${-(FW + scrollX)}px)`
    const ty = `translateY(${-(FH + scrollY)}px)`
    panes.main.layer.style.transform = `${tx} ${ty}`
    panes.top.layer.style.transform = tx
    panes.left.layer.style.transform = ty
    heads.colMain.layer.style.transform = tx
    heads.rowMain.layer.style.transform = ty
  }

  // Largest i with arr[i] <= px.
  function indexAt(arr, px, count) {
    let lo = 0
    let hi = count - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (arr[mid] <= px) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  function visible(kind, axis) {
    const isRow = axis === 'row'
    const frozen = isRow ? fr : fc
    if (kind === 'frozen') return frozen ? [0, frozen - 1] : null
    const arr = isRow ? rowY : colX
    const count = isRow ? rows : cols
    const start = (isRow ? FH + scrollY : FW + scrollX)
    const span = isRow ? viewH - HEAD_H - FH : viewW - HW - FW
    if (span <= 0 || frozen >= count) return null
    return [Math.max(frozen, indexAt(arr, start, count)), Math.min(count - 1, indexAt(arr, start + span, count))]
  }

  /* ---------------------------------------------------------------- cell rendering */

  const measureCtx = document.createElement('canvas').getContext('2d')
  const fontFamily = getComputedStyle(root).fontFamily
  const textWidth = (text, bold, italic) => {
    measureCtx.font = `${italic ? 'italic ' : ''}${bold ? '600 ' : '400 '}13px ${fontFamily}`
    return measureCtx.measureText(text).width
  }

  function paintCell(el, r, c, p) {
    const d = model.display(sheet, r, c)
    const x = colX[c]
    let w = colX[c + 1] - x
    let cls = 'sheet-cell'
    let style = ''
    let text = ''
    if (d) {
      const { value, format } = d
      text = d.text
      if (isError(value)) cls += ' is-error'
      else if (typeof value === 'number' && format?.numberFormat !== 'text') cls += ' is-num'
      else if (typeof value === 'boolean') cls += ' is-bool'
      if (format) {
        if (format.bold) cls += ' is-bold'
        if (format.italic) cls += ' is-italic'
        if (format.align) cls += ` align-${format.align}`
        if (format.color) style += `color:var(--sheet-${format.color});`
        if (format.fill) style += `background:var(--sheet-fill-${format.fill});`
      }
      // Left-aligned text spills into empty neighbours, like Excel.
      if (typeof value === 'string' && text && (!format?.align || format.align === 'left') && textWidth(text, format?.bold, format?.italic) > w - 12) {
        const need = textWidth(text, format?.bold, format?.italic) + 14
        const limit = p ? p.range.cb : c
        let n = c + 1
        while (w < need && n <= limit && !model.display(sheet, r, n)) {
          w += colX[n + 1] - colX[n]
          n++
        }
        if (n > c + 1) cls += ' is-spill'
      }
    }
    el.className = cls
    el.style.cssText = `left:${x}px;top:${rowY[r]}px;width:${w}px;height:${rowY[r + 1] - rowY[r]}px;${style}`
    el.textContent = text
  }

  function renderPane(p, force) {
    const vr = visible(p.rk, 'row')
    const vc = visible(p.ck, 'col')
    if (!vr || !vc) {
      if (p.range) {
        p.layer.replaceChildren(p.ov)
        p.cells.clear()
        p.range = null
      }
      return
    }
    const cur = p.range
    if (!force && cur && vr[0] >= cur.ra && vr[1] <= cur.rb && vc[0] >= cur.ca && vc[1] <= cur.cb) return
    const range = p.rk === 'main'
      ? { ra: Math.max(fr, vr[0] - ROW_BUFFER), rb: Math.min(rows - 1, vr[1] + ROW_BUFFER) }
      : { ra: vr[0], rb: vr[1] }
    if (p.ck === 'main') Object.assign(range, { ca: Math.max(fc, vc[0] - COL_BUFFER), cb: Math.min(cols - 1, vc[1] + COL_BUFFER) })
    else Object.assign(range, { ca: vc[0], cb: vc[1] })
    p.range = range
    const frag = document.createDocumentFragment()
    p.cells = new Map()
    for (let r = range.ra; r <= range.rb; r++) {
      for (let c = range.ca; c <= range.cb; c++) {
        const el = document.createElement('div')
        paintCell(el, r, c, p)
        p.cells.set(key(r, c), el)
        frag.appendChild(el)
      }
    }
    // Spilled text must paint above the empty neighbours to its right.
    frag.append(p.ov)
    p.layer.replaceChildren(frag)
  }

  function repaintRow(p, r) {
    if (!p.range || r < p.range.ra || r > p.range.rb) return
    for (let c = p.range.ca; c <= p.range.cb; c++) {
      const el = p.cells.get(key(r, c))
      if (el) paintCell(el, r, c, p)
    }
  }

  function renderHead(hp, force) {
    const v = visible(hp.kind, hp.axis)
    if (!v) {
      hp.layer.replaceChildren()
      hp.range = null
      return
    }
    const isRow = hp.axis === 'row'
    const buffer = hp.kind === 'main' ? (isRow ? ROW_BUFFER : COL_BUFFER) : 0
    const lo = Math.max(isRow ? (hp.kind === 'main' ? fr : 0) : (hp.kind === 'main' ? fc : 0), v[0] - buffer)
    const hi = Math.min((isRow ? rows : cols) - 1, v[1] + buffer)
    if (!force && hp.range && v[0] >= hp.range[0] && v[1] <= hp.range[1]) return
    hp.range = [lo, hi]
    const rg = range()
    const frag = document.createDocumentFragment()
    for (let i = lo; i <= hi; i++) {
      const el = document.createElement('div')
      const inSel = isRow ? i >= rg.r1 && i <= rg.r2 : i >= rg.c1 && i <= rg.c2
      const full = isRow ? rg.c1 === 0 && rg.c2 >= cols - 1 : rg.r1 === 0 && rg.r2 >= rows - 1
      el.className = `sheet-hcell${inSel ? (full ? ' is-full' : ' is-sel') : ''}`
      if (isRow) {
        el.style.cssText = `top:${rowY[i]}px;height:${rowY[i + 1] - rowY[i]}px`
        el.textContent = String(i + 1)
      } else {
        el.style.cssText = `left:${colX[i]}px;width:${colX[i + 1] - colX[i]}px`
        el.textContent = colToLetters(i)
      }
      frag.appendChild(el)
    }
    hp.layer.replaceChildren(frag)
  }

  function renderAll(force = true) {
    for (const p of cellPanes) renderPane(p, force)
    for (const hp of Object.values(heads)) renderHead(hp, force)
    renderOverlay()
    positionEditor()
  }

  /* ---------------------------------------------------------------- selection + overlay */

  function range() {
    return {
      r1: Math.min(sel.ar, sel.er), r2: Math.max(sel.ar, sel.er),
      c1: Math.min(sel.ac, sel.ec), c2: Math.max(sel.ac, sel.ec),
    }
  }

  function rectEl(cls, r1, c1, r2, c2, extra = '') {
    const el = document.createElement('div')
    el.className = cls
    const rr2 = Math.min(r2, rows - 1)
    const cc2 = Math.min(c2, cols - 1)
    el.style.cssText = `left:${colX[c1]}px;top:${rowY[r1]}px;width:${colX[cc2 + 1] - colX[c1]}px;height:${rowY[rr2 + 1] - rowY[r1]}px;${extra}`
    return el
  }

  function overlayItems() {
    const items = []
    const rg = range()
    const onEditSheet = !edit || edit.sheetId === sheet.id
    if (rg.r1 !== rg.r2 || rg.c1 !== rg.c2) items.push(() => rectEl('ov-range', rg.r1, rg.c1, rg.r2, rg.c2))
    if (clip && clip.sheetId === sheet.id) items.push(() => rectEl('ov-clip', clip.r1, clip.c1, clip.r2, clip.c2))
    if (edit) {
      formulaRefs(activeInput().value).forEach((ref, i) => {
        const same = ref.sheet ? ref.sheet.toLowerCase() === sheet.name.toLowerCase() : edit.sheetId === sheet.id
        if (ref.wb || !same) return
        const r2 = Math.min(ref.r2, rows - 1)
        const c2 = Math.min(ref.c2, cols - 1)
        if (ref.r1 >= rows || ref.c1 >= cols) return
        items.push(() => rectEl(`ov-ref ref-${i % 6}`, ref.r1, ref.c1, r2, c2))
      })
    }
    if (onEditSheet) items.push(() => rectEl(`ov-active${edit ? ' is-editing' : ''}`, sel.ar, sel.ac, sel.ar, sel.ac))
    if (fillPreview) items.push(() => rectEl('ov-fill', fillPreview.r1, fillPreview.c1, fillPreview.r2, fillPreview.c2))
    if (!edit && !fillPreview) {
      const r2 = Math.min(rg.r2, rows - 1)
      const c2 = Math.min(rg.c2, cols - 1)
      items.push(() => {
        const el = document.createElement('div')
        el.className = 'ov-handle'
        el.style.cssText = `left:${colX[c2 + 1] - 4}px;top:${rowY[r2 + 1] - 4}px`
        return el
      })
    }
    return items
  }

  function renderOverlay() {
    const items = overlayItems()
    for (const p of cellPanes) p.ov.replaceChildren(...items.map((make) => make()))
  }

  function selectionChanged({ scroll = true } = {}) {
    if (scroll) ensureVisible(sel.er, sel.ec)
    renderOverlay()
    for (const hp of Object.values(heads)) renderHead(hp, true)
    updateFormulaBar()
    updateToolbarState()
    scheduleStatus()
    positionEditor()
  }

  function setActive(r, c, extend = false) {
    r = Math.max(0, Math.min(MAX_ROW - 1, r))
    c = Math.max(0, Math.min(MAX_COL - 1, c))
    if (extend) {
      sel.er = r
      sel.ec = c
    } else sel = { ar: r, ac: c, er: r, ec: c }
    if (r >= rows - 20 || c >= cols - 3) {
      rebuildGeometry()
      renderAll()
    }
  }

  function move(dr, dc, extend = false) {
    if (extend) setActive(sel.er + dr, sel.ec + dc, true)
    else setActive(sel.ar + dr, sel.ac + dc)
    selectionChanged()
  }

  function ensureVisible(r, c) {
    if (r >= fr) {
      const top = rowY[r] - FH
      const bottom = rowY[Math.min(r + 1, rows)] - FH
      const span = viewH - HEAD_H - FH
      if (top < scrollY) scroller.scrollTop = top
      else if (bottom > scrollY + span) scroller.scrollTop = bottom - span
    }
    if (c >= fc) {
      const left = colX[c] - FW
      const right = colX[Math.min(c + 1, cols)] - FW
      const span = viewW - HW - FW
      if (left < scrollX) scroller.scrollLeft = left
      else if (right > scrollX + span) scroller.scrollLeft = right - span
    }
  }

  /** Grid-relative rectangle of a cell as currently displayed. */
  function cellBox(r, c) {
    const x = HW + (c < fc ? colX[c] : colX[c] - scrollX)
    const y = HEAD_H + (r < fr ? rowY[r] : rowY[r] - scrollY)
    return { x, y, w: colX[c + 1] - colX[c], h: rowY[r + 1] - rowY[r] }
  }

  function hitTest(clientX, clientY, clamp = false) {
    const rect = canvas.getBoundingClientRect()
    let x = clientX - rect.left
    let y = clientY - rect.top
    if (clamp) {
      x = Math.max(HW, Math.min(viewW - 1, x))
      y = Math.max(HEAD_H, Math.min(viewH - 1, y))
    } else if (x < 0 || y < 0 || x >= viewW || y >= viewH) return null
    const gx = x - HW
    const gy = y - HEAD_H
    const lx = gx < FW ? gx : gx + scrollX
    const ly = gy < FH ? gy : gy + scrollY
    const c = indexAt(colX, Math.max(0, lx), cols)
    const r = indexAt(rowY, Math.max(0, ly), rows)
    const area = x < HW && y < HEAD_H ? 'corner' : y < HEAD_H ? 'col' : x < HW ? 'row' : 'cell'
    const hit = { area, r, c, x, y }
    if (area === 'col') {
      if (colX[c + 1] - lx <= 4) hit.resize = c
      else if (lx - colX[c] <= 3 && c > 0) hit.resize = c - 1
    } else if (area === 'row') {
      if (rowY[r + 1] - ly <= 3) hit.resize = r
      else if (ly - rowY[r] <= 2 && r > 0) hit.resize = r - 1
    }
    return hit
  }

  /* ---------------------------------------------------------------- formula bar, toolbar, status */

  function updateFormulaBar() {
    const rg = range()
    const a1 = `${colToLetters(sel.ac)}${sel.ar + 1}`
    if (document.activeElement !== nameBox) {
      nameBox.value = rg.r1 === rg.r2 && rg.c1 === rg.c2 ? a1 : `${colToLetters(rg.c1)}${rg.r1 + 1}:${colToLetters(rg.c2)}${rg.r2 + 1}`
    }
    if (!edit) fxInput.value = model.getRaw(sheet.id, sel.ar, sel.ac)
  }

  function updateToolbarState() {
    const f = model.getFormat(sheet.id, sel.ar, sel.ac) || {}
    boldBtn.setAttribute('aria-pressed', String(!!f.bold))
    italicBtn.setAttribute('aria-pressed', String(!!f.italic))
    for (const b of alignBtns) b.setAttribute('aria-pressed', String((f.align || '') === b.dataset.align))
    nfLabel.textContent = (NUMBER_FORMATS.find(([k]) => k === (f.numberFormat || 'general')) || NUMBER_FORMATS[0])[1]
    colorBar.style.background = f.color ? `var(--sheet-${f.color})` : ''
    fillBar.style.background = f.fill ? `var(--sheet-${f.fill})` : ''
    undoBtn.disabled = !model.undoStack.length
    redoBtn.disabled = !model.redoStack.length
    const frozen = sheet.frozenRows || sheet.frozenCols
    freezeBtn.classList.toggle('is-active', !!frozen)
  }

  let saveTimer
  function setSaveState(state) {
    clearTimeout(saveTimer)
    saveEl.dataset.state = state
    if (state === 'error') saveEl.textContent = 'Not saved'
    else if (state === 'saved') saveEl.textContent = 'All changes saved'
    else saveEl.textContent = 'Saving…'
  }

  let statusFrame = 0
  function scheduleStatus() {
    cancelAnimationFrame(statusFrame)
    statusFrame = requestAnimationFrame(updateStatus)
  }

  function eachCellIn(rg, fn) {
    const r2 = Math.min(rg.r2, sheet.maxRow)
    const c2 = Math.min(rg.c2, sheet.maxCol)
    if (r2 < rg.r1 || c2 < rg.c1) return
    const area = (r2 - rg.r1 + 1) * (c2 - rg.c1 + 1)
    if (area > sheet.cells.size * 2) {
      for (const k of [...sheet.cells.keys()]) {
        const r = keyRow(k)
        const c = keyCol(k)
        if (r >= rg.r1 && r <= r2 && c >= rg.c1 && c <= c2) fn(r, c)
      }
    } else {
      for (let r = rg.r1; r <= r2; r++) for (let c = rg.c1; c <= c2; c++) fn(r, c)
    }
  }

  function updateStatus() {
    const rg = range()
    let sum = 0
    let nums = 0
    let count = 0
    eachCellIn(rg, (r, c) => {
      const v = model.getValue(sheet.id, r, c)
      if (v === null || v === '') return
      count++
      if (typeof v === 'number') {
        sum += v
        nums++
      }
    })
    if (!nums || count < 1 || (rg.r1 === rg.r2 && rg.c1 === rg.c2)) {
      statusEl.replaceChildren()
      return
    }
    const spec = numberFormatSpec(model.getFormat(sheet.id, sel.ar, sel.ac))
    const fmt = (n) => (spec && typeof spec === 'object' ? formatValue(n, spec) : new Intl.NumberFormat('en-AU', { maximumFractionDigits: 10 }).format(n))
    const item = (label, value) => h('span', { class: 'sheet-status-item' }, h('span', { class: 'sheet-status-label' }, label), h('span', { class: 'sheet-status-value' }, value))
    statusEl.replaceChildren(item('Sum', fmt(sum)), item('Average', fmt(sum / nums)), item('Count', String(count)))
  }

  /* ---------------------------------------------------------------- tabs */

  function renderTabs() {
    tabsEl.replaceChildren(...model.sheets.map((s) => h('div', {
      class: `sheet-tab${s.id === sheet.id ? ' is-active' : ''}`, role: 'tab', tabindex: '-1', 'aria-selected': String(s.id === sheet.id), dataset: { id: s.id }, title: s.name,
    }, h('span', { class: 'sheet-tab-label' }, s.name))))
  }

  function switchSheet(id, { keepEdit = false } = {}) {
    const next = model.sheet(id)
    if (!next || next === sheet) return
    if (edit && !keepEdit) commitEdit(0, 0)
    selections.set(sheet.id, { sel, scrollX, scrollY })
    sheet = next
    store(ACTIVE_KEY, sheet.id)
    const saved = selections.get(sheet.id)
    sel = saved ? { ...saved.sel } : { ar: 0, ac: 0, er: 0, ec: 0 }
    rows = 0
    cols = 0
    rebuildGeometry()
    scroller.scrollTop = saved?.scrollY ?? 0
    scroller.scrollLeft = saved?.scrollX ?? 0
    scrollX = scroller.scrollLeft
    scrollY = scroller.scrollTop
    applyTransforms()
    renderAll()
    renderTabs()
    selectionChanged({ scroll: false })
    tabsEl.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function startRenameTab(id) {
    const s = model.sheet(id)
    const tab = tabsEl.querySelector(`[data-id="${CSS.escape(id)}"]`)
    if (!s || !tab) return
    const input = h('input', { class: 'sheet-tab-input', type: 'text', value: s.name, 'aria-label': 'Sheet name', spellcheck: 'false' })
    let done = false
    const finish = (save) => {
      if (done) return
      const value = input.value.trim()
      if (save && value !== s.name) {
        const problem = WorkbookModel.validateName(value, model, s.id)
        if (problem) {
          ui.toast(problem, { type: 'error' })
          input.focus()
          input.select()
          return
        }
        done = true
        model.renameSheet(s.id, value)
      }
      done = true
      renderTabs()
      focusGrid()
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => { if (!done) finish(true) })
    input.addEventListener('mousedown', (e) => e.stopPropagation())
    tab.classList.add('is-renaming')
    tab.replaceChildren(input)
    input.style.width = `${Math.max(60, textWidth(s.name) + 28)}px`
    input.addEventListener('input', () => { input.style.width = `${Math.max(60, textWidth(input.value) + 28)}px` })
    input.focus()
    input.select()
  }

  async function confirmDeleteSheet(id) {
    const s = model.sheet(id)
    if (!s) return
    if (model.sheets.length <= 1) {
      ui.toast('A workbook needs at least one sheet', { type: 'info' })
      return
    }
    const ok = await ui.confirmDialog({
      title: `Delete "${s.name}"?`,
      message: 'The sheet and all of its cells will be removed. Formulas in other sheets that refer to it will show #REF!. This cannot be undone.',
      confirmLabel: 'Delete sheet',
      danger: true,
    })
    if (!ok || !model.sheet(id)) return
    const idx = model.sheets.findIndex((x) => x.id === id)
    if (sheet.id === id) switchSheet(model.sheets[idx === 0 ? 1 : idx - 1].id)
    model.deleteSheet(id)
    focusGrid()
  }

  listen(addSheetBtn, 'mousedown', (e) => e.preventDefault())
  listen(addSheetBtn, 'click', () => {
    if (edit) commitEdit(0, 0)
    const s = model.addSheet()
    switchSheet(s.id)
    focusGrid()
  })

  listen(tabsEl, 'mousedown', (e) => {
    const tab = e.target.closest('.sheet-tab')
    if (!tab || tab.classList.contains('is-renaming') || e.button !== 0) return
    const pointing = edit && canPoint()
    e.preventDefault()
    const id = tab.dataset.id
    const startX = e.clientX
    let dragging = false
    let indicator = null
    let target = -1
    const onMove = (ev) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 5) return
      if (!dragging) {
        dragging = true
        tab.classList.add('is-dragging')
        indicator = h('div', { class: 'sheet-tab-drop' })
        tabsEl.append(indicator)
      }
      const tabs = [...tabsEl.querySelectorAll('.sheet-tab')]
      target = tabs.length
      for (let i = 0; i < tabs.length; i++) {
        const r = tabs[i].getBoundingClientRect()
        if (ev.clientX < r.left + r.width / 2) { target = i; break }
      }
      const ref = tabs[target] || tabs[tabs.length - 1]
      const rr = ref.getBoundingClientRect()
      const host = tabsEl.getBoundingClientRect()
      indicator.style.left = `${(tabs[target] ? rr.left : rr.right) - host.left + tabsEl.scrollLeft - 1}px`
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (!dragging) {
        if (pointing) switchSheet(id, { keepEdit: true })
        else switchSheet(id)
        if (!pointing) focusGrid()
        return
      }
      tab.classList.remove('is-dragging')
      indicator?.remove()
      const from = model.sheets.findIndex((s) => s.id === id)
      const to = target > from ? target - 1 : target
      model.moveSheet(id, to)
      renderTabs()
      focusGrid()
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
  listen(tabsEl, 'dblclick', (e) => {
    const tab = e.target.closest('.sheet-tab')
    if (tab && !tab.classList.contains('is-renaming')) startRenameTab(tab.dataset.id)
  })
  listen(tabsEl, 'contextmenu', (e) => {
    const tab = e.target.closest('.sheet-tab')
    if (!tab) return
    e.preventDefault()
    const id = tab.dataset.id
    switchSheet(id)
    ui.menu(pointAnchor(e), [
      { label: 'Rename', icon: 'edit', onClick: () => startRenameTab(id) },
      { label: 'Delete', icon: 'trash', danger: true, disabled: model.sheets.length <= 1, onClick: () => confirmDeleteSheet(id) },
    ])
  })

  /* ---------------------------------------------------------------- editing */

  const activeInput = () => (edit?.source === 'bar' ? fxInput : editor)
  const focusGrid = () => editor.focus({ preventScroll: true })

  function beginEdit({ mode = 'edit', initial, source = 'cell' } = {}) {
    if (edit) return
    const original = model.getRaw(sheet.id, sel.ar, sel.ac)
    edit = { sheetId: sheet.id, r: sel.ar, c: sel.ac, mode, source, original, point: null }
    const value = initial ?? original
    editor.value = value
    fxInput.value = value
    editor.classList.remove('is-idle')
    root.classList.add('is-editing')
    const f = model.getFormat(sheet.id, sel.ar, sel.ac) || {}
    editor.classList.toggle('is-bold', !!f.bold)
    editor.classList.toggle('is-italic', !!f.italic)
    positionEditor()
    if (source === 'cell') {
      focusGrid()
      editor.setSelectionRange(value.length, value.length)
    }
    afterEditInput()
  }

  function closeParens(v) {
    let depth = 0
    let inStr = false
    for (const ch of v) {
      if (ch === '"') inStr = !inStr
      else if (!inStr && ch === '(') depth++
      else if (!inStr && ch === ')') depth--
    }
    return depth > 0 && !inStr ? v + ')'.repeat(depth) : v
  }

  function endEditUi() {
    edit = null
    hideAc()
    editor.value = ''
    editor.classList.add('is-idle')
    root.classList.remove('is-editing')
  }

  function commitEdit(dr, dc) {
    if (!edit) return
    const e = edit
    let value = activeInput().value
    if (value.startsWith('=')) value = closeParens(value)
    endEditUi()
    if (sheet.id !== e.sheetId) switchSheet(e.sheetId)
    sel = { ar: e.r, ac: e.c, er: e.r, ec: e.c }
    if (value !== e.original) {
      const t0 = performance.now()
      model.setCells(e.sheetId, [{ row: e.r, col: e.c, raw: value }])
      lastCommitMs = performance.now() - t0
    }
    focusGrid()
    if (dr || dc) move(dr, dc)
    else selectionChanged()
  }

  function cancelEdit() {
    if (!edit) return
    const e = edit
    endEditUi()
    if (sheet.id !== e.sheetId) switchSheet(e.sheetId)
    focusGrid()
    selectionChanged()
  }

  function positionEditor() {
    if (!edit) {
      const b = cellBox(sel.ar, sel.ac)
      editor.style.left = `${Math.max(0, Math.min(b.x, viewW - 4))}px`
      editor.style.top = `${Math.max(0, Math.min(b.y, viewH - 4))}px`
      editor.style.width = ''
      editor.style.height = ''
      return
    }
    const hidden = edit.sheetId !== sheet.id
    editor.classList.toggle('is-away', hidden)
    if (hidden) return
    const b = cellBox(edit.r, edit.c)
    const lines = editor.value.split('\n')
    const longest = Math.max(...lines.map((l) => textWidth(l, editor.classList.contains('is-bold'), editor.classList.contains('is-italic'))))
    const width = Math.min(Math.max(b.w + 1, longest + 22), Math.max(b.w + 1, viewW - b.x - 8))
    editor.style.left = `${b.x - 1}px`
    editor.style.top = `${b.y - 1}px`
    editor.style.width = `${width + 1}px`
    editor.style.height = `${Math.max(b.h + 1, lines.length * 18 + 8) + 1}px`
  }

  function afterEditInput() {
    positionEditor()
    updateAc()
    renderOverlay()
  }

  /** True when the caret sits where a cell reference can be inserted by pointing. */
  function canPoint() {
    if (!edit) return false
    const inp = activeInput()
    const v = inp.value
    if (!v.startsWith('=')) return false
    const caret = inp.selectionStart ?? v.length
    if (edit.point && caret === edit.point.end && inp.selectionEnd === caret) return true
    if (inp.selectionEnd !== caret) return false
    const before = v.slice(0, caret).trimEnd()
    if ((before.split('"').length - 1) % 2) return false
    return /[=(,+\-*/^&<>:;]$/.test(before)
  }

  function refText(r1, c1, r2, c2) {
    const onOther = sheet.id !== edit.sheetId
    return refToString({
      wb: null, sheet: onOther ? sheet.name : null, kind: r1 === r2 && c1 === c2 ? 'cell' : 'range',
      r1: Math.min(r1, r2), r2: Math.max(r1, r2), c1: Math.min(c1, c2), c2: Math.max(c1, c2),
      ar1: false, ar2: false, ac1: false, ac2: false,
    })
  }

  function insertPointRef(anchorR, anchorC, r, c) {
    const inp = activeInput()
    const v = inp.value
    const text = refText(anchorR, anchorC, r, c)
    let start
    let end
    if (edit.point && inp.selectionStart === edit.point.end) {
      start = edit.point.start
      end = edit.point.end
    } else {
      start = inp.selectionStart ?? v.length
      end = inp.selectionEnd ?? start
    }
    const next = v.slice(0, start) + text + v.slice(end)
    inp.value = next
    const other = inp === editor ? fxInput : editor
    other.value = next
    const caret = start + text.length
    inp.setSelectionRange(caret, caret)
    edit.point = { start, end: caret, ar: anchorR, ac: anchorC, r, c }
    hideAc()
    positionEditor()
    renderOverlay()
  }

  function formulaRefs(text) {
    if (!text || !text.startsWith('=')) return []
    const src = text.slice(1)
    for (let end = src.length; end >= 0; end--) {
      try {
        return tokenize(src.slice(0, end)).filter((t) => t.t === 'ref').map((t) => t.v)
      } catch { /* incomplete formula: try a shorter prefix */ }
    }
    return []
  }

  /* ---- autocomplete */

  function updateAc() {
    if (!edit) return hideAc()
    const inp = activeInput()
    const v = inp.value
    const caret = inp.selectionStart ?? v.length
    if (!v.startsWith('=') || inp.selectionEnd !== caret) return hideAc()
    const before = v.slice(0, caret)
    if ((before.split('"').length - 1) % 2) return hideAc()
    const m = /(?:^=|[=(,+\-*/^&<>:;\s])([A-Za-z][A-Za-z0-9_.]*)$/.exec(before)
    if (!m) return hideAc()
    const prefix = m[1].toUpperCase()
    const items = FUNCTIONS.filter((f) => f.name.startsWith(prefix))
    if (!items.length || (items.length === 1 && items[0].name === prefix && v[caret] === '(')) return hideAc()
    const prevName = ac?.items[ac.index]?.name
    ac = { items, index: Math.max(0, items.findIndex((f) => f.name === prevName)), start: caret - m[1].length, end: caret }
    renderAc()
  }

  function renderAc() {
    const list = h('div', { class: 'sheet-ac-list' }, ac.items.map((f, i) => h('div', {
      class: `sheet-ac-item${i === ac.index ? ' is-selected' : ''}`, role: 'option', id: `sheet-ac-${i}`, 'aria-selected': String(i === ac.index), dataset: { index: String(i) },
    }, h('span', { class: 'sheet-ac-name' }, f.name), h('span', { class: 'sheet-ac-sig' }, f.signature))))
    const cur = ac.items[ac.index]
    const detail = h('div', { class: 'sheet-ac-detail' },
      h('div', { class: 'sheet-ac-detail-sig' }, cur.signature),
      cur.description ? h('div', { class: 'sheet-ac-detail-text' }, cur.description) : null)
    acBox.replaceChildren(list, detail)
    acBox.hidden = false
    const inp = activeInput()
    const gridRect = gridEl.getBoundingClientRect()
    let left
    let top
    if (inp === editor && !editor.classList.contains('is-away')) {
      left = parseFloat(editor.style.left)
      top = parseFloat(editor.style.top) + editor.offsetHeight + 2
    } else {
      const r = fxInput.getBoundingClientRect()
      left = r.left - gridRect.left + 4
      top = 4
    }
    acBox.style.left = `${Math.max(4, Math.min(left, gridRect.width - acBox.offsetWidth - 8))}px`
    acBox.style.top = `${top}px`
    list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
  }

  function hideAc() {
    ac = null
    acBox.hidden = true
  }

  function acceptAc(index = ac?.index) {
    if (!ac || !edit) return
    const f = ac.items[index]
    const inp = activeInput()
    const v = inp.value
    const hasParen = v[ac.end] === '('
    const insert = f.name + (hasParen ? '' : '(')
    const next = v.slice(0, ac.start) + insert + v.slice(ac.end)
    const caret = ac.start + insert.length + (hasParen ? 1 : 0)
    inp.value = next
    ;(inp === editor ? fxInput : editor).value = next
    inp.setSelectionRange(caret, caret)
    hideAc()
    edit.point = null
    afterEditInput()
  }

  listen(acBox, 'mousedown', (e) => {
    e.preventDefault()
    const item = e.target.closest('.sheet-ac-item')
    if (item) acceptAc(Number(item.dataset.index))
  })

  /* ---- keyboard while editing */

  function editKey(e) {
    const inp = activeInput()
    if (ac) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        ac.index = (ac.index + (e.key === 'ArrowDown' ? 1 : -1) + ac.items.length) % ac.items.length
        renderAc()
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.altKey)) {
        e.preventDefault()
        acceptAc()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        hideAc()
        return
      }
    }
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.altKey && inp === editor) {
        const s = editor.selectionStart
        editor.setRangeText('\n', s, editor.selectionEnd, 'end')
        fxInput.value = editor.value
        afterEditInput()
        return
      }
      commitEdit(e.shiftKey ? -1 : 1, 0)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      commitEdit(0, e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEdit()
    } else if (e.key === 'F2') {
      e.preventDefault()
      edit.mode = edit.mode === 'enter' ? 'edit' : 'enter'
    } else if (arrows[e.key] && edit.mode === 'enter' && edit.source === 'cell') {
      const [dr, dc] = arrows[e.key]
      e.preventDefault()
      if (canPoint() && edit.sheetId === sheet.id) {
        const p = edit.point
        if (e.shiftKey && p) insertPointRef(p.ar, p.ac, Math.max(0, p.r + dr), Math.max(0, p.c + dc))
        else {
          const base = p || { r: edit.r, c: edit.c }
          const r = Math.max(0, base.r + dr)
          const c = Math.max(0, base.c + dc)
          insertPointRef(r, c, r, c)
        }
        const pp = edit.point
        ensureVisible(pp.r, pp.c)
        return
      }
      commitEdit(dr, dc)
    }
  }

  /* ---------------------------------------------------------------- commands */

  function writeRange(entries, sheetId = sheet.id) {
    if (!entries.length) return
    model.setCells(sheetId, entries)
  }

  function undo() {
    if (edit) cancelEdit()
    const step = model.undo()
    if (step) revealStep(step, true)
    updateToolbarState()
  }

  function redo() {
    if (edit) cancelEdit()
    const step = model.redo()
    if (step) revealStep(step, false)
    updateToolbarState()
  }

  function revealStep(step, undone) {
    const cells = step.kind === 'cells' ? step : step.kind === 'group' ? step.steps.find((s) => s.kind === 'cells') : null
    if (!cells) return
    if (cells.sheetId !== sheet.id) switchSheet(cells.sheetId)
    const list = undone ? cells.before : cells.after
    let r1 = Infinity
    let c1 = Infinity
    let r2 = -1
    let c2 = -1
    for (const e of list) {
      r1 = Math.min(r1, e.row); c1 = Math.min(c1, e.col); r2 = Math.max(r2, e.row); c2 = Math.max(c2, e.col)
    }
    if (r2 < 0) return
    sel = { ar: r1, ac: c1, er: r2, ec: c2 }
    selectionChanged()
  }

  function clearContents() {
    const entries = []
    eachCellIn(range(), (r, c) => {
      if (model.getCell(sheet.id, r, c)?.raw != null) entries.push({ row: r, col: c, raw: null })
    })
    writeRange(entries)
    selectionChanged({ scroll: false })
  }

  /** Applies fn(format) to every cell of the selection (whole rows/columns: the used area). */
  function formatSelection(fn) {
    if (edit) commitEdit(0, 0)
    const rg = range()
    const r2 = rg.r2 >= rows - 1 ? Math.max(rg.r1, sheet.maxRow) : rg.r2
    const c2 = rg.c2 >= cols - 1 ? Math.max(rg.c1, sheet.maxCol) : rg.c2
    const entries = []
    for (let r = rg.r1; r <= r2; r++) for (let c = rg.c1; c <= c2; c++) entries.push({ row: r, col: c, format: fn({ ...(model.getFormat(sheet.id, r, c) || {}) }) })
    writeRange(entries)
    updateToolbarState()
    scheduleStatus()
    focusGrid()
  }

  function toggleFormat(prop) {
    const on = !model.getFormat(sheet.id, sel.ar, sel.ac)?.[prop]
    formatSelection((f) => ({ ...f, [prop]: on }))
  }

  function setAlign(a) {
    const cur = model.getFormat(sheet.id, sel.ar, sel.ac)?.align
    formatSelection((f) => ({ ...f, align: cur === a ? null : a }))
  }

  function openNumberFormatMenu() {
    const cur = model.getFormat(sheet.id, sel.ar, sel.ac)?.numberFormat || 'general'
    ui.menu(nfBtn, NUMBER_FORMATS.map(([k, label, sample]) => ({
      label, shortcut: sample, icon: k === cur ? 'check' : null,
      onClick: () => formatSelection((f) => ({ ...f, numberFormat: k === 'general' ? null : k })),
    })))
  }

  function openPalette(anchor, prop) {
    const cur = model.getFormat(sheet.id, sel.ar, sel.ac)?.[prop]
    let pop
    const pick = (name) => {
      pop.close()
      formatSelection((f) => ({ ...f, [prop]: name }))
    }
    const swatch = (name, label) => {
      const b = h('button', {
        type: 'button', class: `sheet-swatch${(cur || null) === name ? ' is-current' : ''}`, title: label, 'aria-label': label, dataset: { colour: name || 'default' },
      }, h('span', { class: 'sheet-swatch-chip', style: { [prop === 'fill' ? 'background' : 'color']: name ? `var(--sheet-${prop === 'fill' ? 'fill-' : ''}${name})` : '' } }, 'A'))
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => pick(name))
      return b
    }
    const content = h('div', { class: `sheet-palette is-${prop}` },
      h('div', { class: 'sheet-palette-title' }, prop === 'fill' ? 'Fill colour' : 'Text colour'),
      h('div', { class: 'sheet-palette-grid' }, swatch(null, 'Default'), PALETTE.map(([n, l]) => swatch(n, l))))
    pop = ui.popover(anchor, content, { className: 'sheet-palette-pop', role: 'dialog', onClose: () => focusGrid() })
    pop.el.querySelector('.is-current, .sheet-swatch')?.focus({ preventScroll: true })
  }

  function openFreezeMenu() {
    const cur = `${sheet.frozenRows},${sheet.frozenCols}`
    const opt = (label, r, c) => ({ label, icon: cur === `${r},${c}` ? 'check' : null, onClick: () => freeze(r, c) })
    ui.menu(freezeBtn, [
      opt('No frozen panes', 0, 0),
      opt('Freeze first row', 1, 0),
      opt('Freeze first column', 0, 1),
      opt('Freeze first row and column', 1, 1),
      'divider',
      { label: `Freeze up to ${colToLetters(sel.ac)}${sel.ar + 1}`, onClick: () => freeze(sel.ar, sel.ac), disabled: !sel.ar && !sel.ac },
    ])
  }

  function freeze(r, c) {
    model.setFrozen(sheet.id, Math.min(r, 1000), Math.min(c, 100))
    scroller.scrollTop = 0
    scroller.scrollLeft = 0
    focusGrid()
  }

  function structure(axis, where) {
    if (edit) commitEdit(0, 0)
    const rg = range()
    const isRow = axis === 'row'
    const a = isRow ? rg.r1 : rg.c1
    const count = (isRow ? rg.r2 : rg.c2) - a + 1
    const n = Math.min(count, isRow ? 10000 : 500)
    if (where === 'delete') {
      if (isRow) model.deleteRows(sheet.id, a, n)
      else model.deleteCols(sheet.id, a, n)
    } else {
      const index = where === 'before' ? a : a + n
      if (isRow) model.insertRows(sheet.id, index, n)
      else model.insertCols(sheet.id, index, n)
    }
    updateToolbarState()
    focusGrid()
  }

  /* ---- clipboard */

  function copySelection(cut) {
    const rg = range()
    const r2 = rg.r2 >= rows - 1 ? Math.max(rg.r1, Math.min(rg.r2, sheet.maxRow)) : rg.r2
    const c2 = rg.c2 >= cols - 1 ? Math.max(rg.c1, Math.min(rg.c2, sheet.maxCol)) : rg.c2
    const texts = []
    const cells = []
    for (let r = rg.r1; r <= r2; r++) {
      const tr = []
      const cr = []
      for (let c = rg.c1; c <= c2; c++) {
        const d = model.display(sheet, r, c)
        tr.push(d ? d.text : '')
        const cell = model.getCell(sheet.id, r, c)
        cr.push({ raw: cell?.raw ?? null, format: cell?.format ?? null })
      }
      texts.push(tr)
      cells.push(cr)
    }
    const text = toTsv(texts)
    clip = { text, sheetId: sheet.id, r1: rg.r1, c1: rg.c1, r2, c2, cells, cut }
    renderOverlay()
    return text
  }

  function paste(text) {
    const norm = (s) => String(s).replace(/\r\n?/g, '\n').replace(/\n$/, '')
    const internal = clip && model.sheet(clip.sheetId) && norm(clip.text) === norm(text)
    const src = internal ? clip.cells : parseTsv(text).map((row) => row.map((v) => ({ raw: v })))
    const srcH = src.length
    const srcW = Math.max(...src.map((r) => r.length))
    const rg = range()
    const selH = rg.r2 - rg.r1 + 1
    const selW = rg.c2 - rg.c1 + 1
    const repR = selH > srcH && selH % srcH === 0 ? selH / srcH : 1
    const repC = selW > srcW && selW % srcW === 0 ? selW / srcW : 1
    const target = new Map()
    for (let i = 0; i < srcH * repR; i++) {
      for (let j = 0; j < srcW * repC; j++) {
        const s = src[i % srcH][j % srcW]
        if (!s) continue
        const row = rg.r1 + i
        const col = rg.c1 + j
        if (row >= MAX_ROW || col >= MAX_COL) continue
        let raw = s.raw
        if (internal && !clip.cut) raw = shiftFormula(raw, row - (clip.r1 + (i % srcH)), col - (clip.c1 + (j % srcW)))
        target.set(key(row, col), { row, col, raw, format: internal ? s.format : undefined })
      }
    }
    model.group(() => {
      if (internal && clip.cut) {
        const sourceEntries = []
        for (let r = clip.r1; r <= clip.r2; r++) {
          for (let c = clip.c1; c <= clip.c2; c++) {
            if (clip.sheetId === sheet.id && target.has(key(r, c))) continue
            sourceEntries.push({ row: r, col: c, raw: null, format: null })
          }
        }
        writeRange(sourceEntries, clip.sheetId)
      }
      writeRange([...target.values()])
    })
    if (internal && clip.cut) clip = null
    sel = { ar: rg.r1, ac: rg.c1, er: rg.r1 + srcH * repR - 1, ec: rg.c1 + srcW * repC - 1 }
    rebuildGeometry()
    renderAll(false)
    selectionChanged()
  }

  listen(editor, 'copy', (e) => {
    if (edit) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', copySelection(false))
  })
  listen(editor, 'cut', (e) => {
    if (edit) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', copySelection(true))
  })
  listen(editor, 'paste', (e) => {
    if (edit) return
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (text) paste(text)
  })

  async function pasteFromMenu() {
    let text = null
    try {
      text = await navigator.clipboard.readText()
    } catch { /* permission denied: fall back to the last copy made here */ }
    if (text == null && clip) text = clip.text
    if (text) paste(text)
    else ui.toast('Use Ctrl+V to paste from the clipboard', { type: 'info' })
    focusGrid()
  }

  function copyFromMenu(cut) {
    focusGrid()
    const ok = document.execCommand(cut ? 'cut' : 'copy')
    if (!ok) {
      const text = copySelection(cut)
      navigator.clipboard?.writeText(text).catch(() => {})
    }
  }

  /* ---- fill */

  function doFill(pre) {
    const rg = range()
    const entries = []
    if (pre.axis === 'row') {
      const down = pre.r2 > rg.r2
      const count = down ? pre.r2 - rg.r2 : rg.r1 - pre.r1
      for (let c = rg.c1; c <= rg.c2; c++) {
        const raws = []
        const formats = []
        for (let r = rg.r1; r <= rg.r2; r++) {
          raws.push(model.getRaw(sheet.id, r, c))
          formats.push(model.getFormat(sheet.id, r, c))
        }
        const out = fillLine(raws, count, 'row', !down)
        out.forEach((raw, i) => {
          const row = down ? rg.r2 + 1 + i : rg.r1 - 1 - i
          const fi = down ? i % formats.length : formats.length - 1 - (i % formats.length)
          entries.push({ row, col: c, raw, format: formats[fi] })
        })
      }
    } else {
      const right = pre.c2 > rg.c2
      const count = right ? pre.c2 - rg.c2 : rg.c1 - pre.c1
      for (let r = rg.r1; r <= rg.r2; r++) {
        const raws = []
        const formats = []
        for (let c = rg.c1; c <= rg.c2; c++) {
          raws.push(model.getRaw(sheet.id, r, c))
          formats.push(model.getFormat(sheet.id, r, c))
        }
        const out = fillLine(raws, count, 'col', !right)
        out.forEach((raw, i) => {
          const col = right ? rg.c2 + 1 + i : rg.c1 - 1 - i
          const fi = right ? i % formats.length : formats.length - 1 - (i % formats.length)
          entries.push({ row: r, col, raw, format: formats[fi] })
        })
      }
    }
    writeRange(entries)
    sel = { ar: pre.r1, ac: pre.c1, er: pre.r2, ec: pre.c2 }
    selectionChanged({ scroll: false })
  }

  /* ---------------------------------------------------------------- mouse */

  let autoScroll = null
  function dragLoop(onPoint) {
    let last = null
    const tick = () => {
      if (!last) return
      const rect = canvas.getBoundingClientRect()
      const dx = last.clientX < rect.left + HW ? -1 : last.clientX > rect.right - 4 ? 1 : 0
      const dy = last.clientY < rect.top + HEAD_H ? -1 : last.clientY > rect.bottom - 4 ? 1 : 0
      if (dx || dy) {
        scroller.scrollLeft += dx * 24
        scroller.scrollTop += dy * 20
        onPoint(hitTest(last.clientX, last.clientY, true))
      }
      autoScroll = requestAnimationFrame(tick)
    }
    const onMove = (ev) => {
      last = ev
      onPoint(hitTest(ev.clientX, ev.clientY, true))
    }
    const stop = () => {
      cancelAnimationFrame(autoScroll)
      last = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    let onUpCb = () => {}
    const onUp = (ev) => {
      stop()
      onUpCb(ev)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    autoScroll = requestAnimationFrame(tick)
    return { onUp: (fn) => { onUpCb = fn } }
  }

  listen(canvas, 'mousedown', (e) => {
    if (e.button !== 0 && e.button !== 2) return
    const hit = hitTest(e.clientX, e.clientY)
    if (!hit) return
    e.preventDefault()
    hideTooltip()

    if (hit.resize !== undefined && e.button === 0) return startResize(hit, e)

    if (e.target.classList.contains('ov-handle') && e.button === 0 && !edit) return startFill(e)

    if (edit && hit.area === 'cell' && e.button === 0 && canPoint()) {
      if (edit.source === 'bar') fxInput.focus({ preventScroll: true })
      insertPointRef(hit.r, hit.c, hit.r, hit.c)
      const ar = hit.r
      const acol = hit.c
      dragLoop((p) => {
        if (p && edit) insertPointRef(ar, acol, p.r, p.c)
      })
      return
    }
    if (edit) commitEdit(0, 0)
    focusGrid()

    const rg = range()
    if (e.button === 2) {
      const inside = hit.area === 'cell' ? hit.r >= rg.r1 && hit.r <= rg.r2 && hit.c >= rg.c1 && hit.c <= rg.c2
        : hit.area === 'row' ? hit.r >= rg.r1 && hit.r <= rg.r2 && rg.c2 >= cols - 1
          : hit.area === 'col' ? hit.c >= rg.c1 && hit.c <= rg.c2 && rg.r2 >= rows - 1 : true
      if (!inside) selectHit(hit, false)
      return
    }
    selectHit(hit, e.shiftKey)
    const area = hit.area
    if (area === 'corner') return
    dragLoop((p) => {
      if (!p) return
      if (area === 'cell') setActive(p.r, p.c, true)
      else if (area === 'row') { sel.er = p.r; sel.ec = cols - 1 }
      else if (area === 'col') { sel.ec = p.c; sel.er = rows - 1 }
      selectionChanged({ scroll: false })
    })
  })

  function selectHit(hit, extend) {
    if (hit.area === 'cell') setActive(hit.r, hit.c, extend)
    else if (hit.area === 'row') {
      if (extend) { sel.er = hit.r; sel.ec = cols - 1; sel.ac = 0 }
      else sel = { ar: hit.r, ac: 0, er: hit.r, ec: cols - 1 }
    } else if (hit.area === 'col') {
      if (extend) { sel.ec = hit.c; sel.er = rows - 1; sel.ar = 0 }
      else sel = { ar: 0, ac: hit.c, er: rows - 1, ec: hit.c }
    } else sel = { ar: 0, ac: 0, er: rows - 1, ec: cols - 1 }
    selectionChanged({ scroll: false })
  }

  listen(canvas, 'dblclick', (e) => {
    const hit = hitTest(e.clientX, e.clientY)
    if (!hit || hit.area !== 'cell' || edit) return
    setActive(hit.r, hit.c)
    selectionChanged({ scroll: false })
    beginEdit({ mode: 'edit' })
  })

  listen(canvas, 'contextmenu', (e) => {
    e.preventDefault()
    const hit = hitTest(e.clientX, e.clientY)
    if (!hit) return
    const rg = range()
    const nr = rg.r2 - rg.r1 + 1
    const nc = rg.c2 - rg.c1 + 1
    const rowsLabel = (n) => (n > 1 && n < rows ? `${n} rows` : 'row')
    const colsLabel = (n) => (n > 1 && n < cols ? `${n} columns` : 'column')
    const rowItems = [
      { label: `Insert ${rowsLabel(nr)} above`, icon: 'plus', onClick: () => structure('row', 'before') },
      { label: `Insert ${rowsLabel(nr)} below`, icon: 'plus', onClick: () => structure('row', 'after') },
      { label: `Delete ${rowsLabel(nr)}`, icon: 'trash', danger: true, onClick: () => structure('row', 'delete') },
    ]
    const colItems = [
      { label: `Insert ${colsLabel(nc)} left`, icon: 'plus', onClick: () => structure('col', 'before') },
      { label: `Insert ${colsLabel(nc)} right`, icon: 'plus', onClick: () => structure('col', 'after') },
      { label: `Delete ${colsLabel(nc)}`, icon: 'trash', danger: true, onClick: () => structure('col', 'delete') },
    ]
    const clipItems = [
      { label: 'Cut', shortcut: 'Ctrl+X', onClick: () => copyFromMenu(true) },
      { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => copyFromMenu(false) },
      { label: 'Paste', shortcut: 'Ctrl+V', onClick: () => pasteFromMenu() },
    ]
    let items
    if (hit.area === 'row') items = [...clipItems, 'divider', ...rowItems]
    else if (hit.area === 'col') items = [...clipItems, 'divider', ...colItems]
    else items = [...clipItems, 'divider', ...rowItems, 'divider', ...colItems, 'divider', { label: 'Clear contents', shortcut: 'Del', onClick: () => { clearContents(); focusGrid() } }]
    ui.menu(pointAnchor(e), items)
  })

  function startResize(hit, e) {
    const isCol = hit.area === 'col'
    const index = hit.resize
    const start = isCol ? e.clientX : e.clientY
    const orig = isCol ? colW(index) : rowH(index)
    const guide = h('div', { class: `sheet-resize-guide ${isCol ? 'is-col' : 'is-row'}` })
    gridEl.append(guide)
    let size = orig
    const place = () => {
      const b = cellBox(isCol ? 0 : index, isCol ? index : 0)
      if (isCol) guide.style.left = `${b.x + size - 1}px`
      else guide.style.top = `${b.y + size - 1}px`
    }
    place()
    root.classList.add(isCol ? 'is-resizing-col' : 'is-resizing-row')
    const onMove = (ev) => {
      size = Math.max(isCol ? 24 : 16, Math.min(2000, orig + (isCol ? ev.clientX : ev.clientY) - start))
      const map = isCol ? sheet.colWidths : sheet.rowHeights
      map[index] = size
      rebuildGeometry()
      renderAll()
      place()
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      guide.remove()
      root.classList.remove('is-resizing-col', 'is-resizing-row')
      if (size !== orig) model.setSize(sheet.id, isCol ? 'col' : 'row', index, size)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  function startFill() {
    const rg = range()
    const d = dragLoop((p) => {
      if (!p) return
      const below = p.r - rg.r2
      const above = rg.r1 - p.r
      const right = p.c - rg.c2
      const left = rg.c1 - p.c
      const vert = Math.max(below, above)
      const horiz = Math.max(right, left)
      if (vert <= 0 && horiz <= 0) fillPreview = null
      else if (vert >= horiz) fillPreview = below > 0 ? { ...rg, r2: p.r, axis: 'row' } : { ...rg, r1: p.r, axis: 'row' }
      else fillPreview = right > 0 ? { ...rg, c2: p.c, axis: 'col' } : { ...rg, c1: p.c, axis: 'col' }
      root.classList.add('is-filling')
      renderOverlay()
    })
    d.onUp(() => {
      root.classList.remove('is-filling')
      const pre = fillPreview
      fillPreview = null
      if (pre) doFill(pre)
      else renderOverlay()
    })
  }

  /* ---- hover: resize cursors and error tooltips */

  let tipTimer = 0
  function hideTooltip() {
    clearTimeout(tipTimer)
    tooltip.hidden = true
  }
  listen(canvas, 'mousemove', (e) => {
    if (e.buttons) return
    const hit = hitTest(e.clientX, e.clientY)
    canvas.classList.toggle('cursor-col-resize', hit?.resize !== undefined && hit.area === 'col')
    canvas.classList.toggle('cursor-row-resize', hit?.resize !== undefined && hit.area === 'row')
    const v = hit && hit.area === 'cell' ? model.getValue(sheet.id, hit.r, hit.c) : null
    if (!isError(v)) return hideTooltip()
    const k = `${hit.r},${hit.c}`
    if (tooltip.dataset.cell === k && (!tooltip.hidden || tipTimer)) return
    hideTooltip()
    tooltip.dataset.cell = k
    tipTimer = setTimeout(() => {
      tipTimer = 0
      tooltip.replaceChildren(h('strong', { class: 'sheet-tooltip-code' }, v.error), h('span', {}, ERROR_HELP[v.error] || 'The formula could not be calculated.'))
      tooltip.hidden = false
      const b = cellBox(hit.r, hit.c)
      const w = tooltip.offsetWidth
      tooltip.style.left = `${Math.max(4, Math.min(b.x, viewW - w - 8))}px`
      tooltip.style.top = `${b.y + b.h + 4 + tooltip.offsetHeight > viewH ? b.y - tooltip.offsetHeight - 4 : b.y + b.h + 4}px`
    }, 250)
  })
  listen(canvas, 'mouseleave', hideTooltip)

  /* ---------------------------------------------------------------- keyboard */

  listen(editor, 'keydown', (e) => {
    if (e.isComposing) return
    if (edit) return editKey(e)
    const mod = e.ctrlKey || e.metaKey
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (mod && !e.altKey) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
      else if (k === 'y') { e.preventDefault(); redo() }
      else if (k === 'b') { e.preventDefault(); toggleFormat('bold') }
      else if (k === 'i') { e.preventDefault(); toggleFormat('italic') }
      else if (k === 'a') { e.preventDefault(); sel = { ar: 0, ac: 0, er: rows - 1, ec: cols - 1 }; selectionChanged({ scroll: false }) }
      else if (k === 'Home') { e.preventDefault(); setActive(0, 0); selectionChanged() }
      else if (k.startsWith('Arrow')) {
        e.preventDefault()
        const r = e.shiftKey ? sel.er : sel.ar
        const c = e.shiftKey ? sel.ec : sel.ac
        const target = { ArrowUp: [0, c], ArrowDown: [Math.max(r, sheet.maxRow), c], ArrowLeft: [r, 0], ArrowRight: [r, Math.max(c, sheet.maxCol)] }[k]
        setActive(target[0], target[1], e.shiftKey)
        selectionChanged()
      }
      return
    }
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (arrows[k]) {
      e.preventDefault()
      move(arrows[k][0], arrows[k][1], e.shiftKey)
    } else if (k === 'Enter') {
      e.preventDefault()
      move(e.shiftKey ? -1 : 1, 0)
    } else if (k === 'Tab') {
      e.preventDefault()
      move(0, e.shiftKey ? -1 : 1)
    } else if (k === 'F2') {
      e.preventDefault()
      beginEdit({ mode: 'edit' })
    } else if (k === 'Delete') {
      e.preventDefault()
      clearContents()
    } else if (k === 'Backspace') {
      e.preventDefault()
      beginEdit({ mode: 'enter', initial: '' })
    } else if (k === 'Escape') {
      if (clip) {
        clip = null
        renderOverlay()
      }
    } else if (k === 'PageDown' || k === 'PageUp') {
      e.preventDefault()
      const n = Math.max(1, Math.floor((viewH - HEAD_H - FH) / DEFAULT_H) - 1)
      move(k === 'PageDown' ? n : -n, 0, e.shiftKey)
    } else if (k === 'Home') {
      e.preventDefault()
      setActive(sel.ar, 0)
      selectionChanged()
    }
  })

  // Typing into the idle editor starts an edit that replaces the cell.
  listen(editor, 'input', () => {
    if (!edit) {
      const typed = editor.value
      editor.value = ''
      beginEdit({ mode: 'enter', initial: typed })
      return
    }
    fxInput.value = editor.value
    edit.point = null
    afterEditInput()
  })
  listen(editor, 'click', () => { if (edit) { edit.point = null; updateAc() } })
  listen(editor, 'keyup', (e) => { if (edit && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) updateAc() })

  listen(fxInput, 'focus', () => {
    if (!edit) beginEdit({ mode: 'edit', source: 'bar' })
    else if (edit.source !== 'bar') edit.source = 'bar'
    root.classList.add('is-bar-editing')
  })
  listen(fxInput, 'blur', () => root.classList.remove('is-bar-editing'))
  listen(fxInput, 'input', () => {
    if (!edit) beginEdit({ mode: 'edit', source: 'bar' })
    editor.value = fxInput.value
    edit.point = null
    afterEditInput()
  })
  listen(fxInput, 'keydown', (e) => {
    if (!edit) return
    editKey(e)
  })
  listen(fxInput, 'click', () => { if (edit) { edit.point = null; updateAc() } })

  // Leaving the workbook entirely (for example the page title) commits the edit.
  const commitOnFocusLoss = (e) => {
    if (!edit || !e.relatedTarget || root.contains(e.relatedTarget)) return
    if (e.relatedTarget.closest?.('.popover, .modal-backdrop')) return
    commitEdit(0, 0)
  }
  listen(editor, 'blur', commitOnFocusLoss)
  listen(fxInput, 'blur', commitOnFocusLoss)

  listen(nameBox, 'focus', () => nameBox.select())
  listen(nameBox, 'keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      updateFormulaBar()
      focusGrid()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const [a, b] = nameBox.value.trim().split(':')
      const p1 = fromA1(a || '')
      const p2 = b ? fromA1(b) : p1
      if (!p1 || !p2 || p1.row >= MAX_ROW || p2.row >= MAX_ROW || p1.col >= MAX_COL || p2.col >= MAX_COL) {
        ui.toast('Enter a cell like B4 or a range like A1:C10', { type: 'error' })
        return
      }
      if (edit) commitEdit(0, 0)
      sel = { ar: p1.row, ac: p1.col, er: p2.row, ec: p2.col }
      rebuildGeometry()
      renderAll()
      focusGrid()
      selectionChanged()
    }
  })

  /* ---------------------------------------------------------------- model events + scrolling */

  function onModelChange(e) {
    if (e.type === 'cells') {
      const byRow = new Set()
      let active = false
      for (const c of e.cells) {
        if (c.sheetId !== sheet.id) continue
        byRow.add(c.row)
        if (c.row === sel.ar && c.col === sel.ac) active = true
      }
      if (!byRow.size) return
      if (byRow.size > 300) renderAll()
      else for (const r of byRow) for (const p of cellPanes) repaintRow(p, r)
      if (active && !edit) updateFormulaBar()
      scheduleStatus()
      updateToolbarState()
    } else if (e.type === 'layout') {
      if (e.sheetId && e.sheetId !== sheet.id) return
      rebuildGeometry()
      renderAll()
      updateFormulaBar()
      updateToolbarState()
      scheduleStatus()
    } else if (e.type === 'sheets') {
      if (!model.sheet(sheet.id)) switchSheet(model.sheets[0].id)
      renderTabs()
    }
  }

  // The caret of the focused editor can scroll the clipped grid container itself; keep it pinned.
  listen(gridEl, 'scroll', () => {
    gridEl.scrollTop = 0
    gridEl.scrollLeft = 0
  })

  let scrollFrame = 0
  listen(scroller, 'scroll', () => {
    scrollX = scroller.scrollLeft
    scrollY = scroller.scrollTop
    applyTransforms()
    hideTooltip()
    for (const p of cellPanes) renderPane(p, false)
    for (const hp of Object.values(heads)) renderHead(hp, false)
    positionEditor()
    if (ac) renderAc()
    cancelAnimationFrame(scrollFrame)
    scrollFrame = requestAnimationFrame(() => {
      // Grow the sheet as the user scrolls towards its edges.
      const growRows = scrollY + viewH * 2 > rowY[rows] && rows < MAX_ROW
      const growCols = scrollX + viewW * 1.5 > colX[cols] && cols < MAX_COL
      if (growRows || growCols) {
        if (growRows) rows = Math.min(MAX_ROW, rows + 1000)
        if (growCols) cols = Math.min(MAX_COL, cols + 10)
        rebuildGeometry()
        renderAll(false)
      }
    })
  })

  const ro = new ResizeObserver(() => {
    const w = scroller.clientWidth
    const hh = scroller.clientHeight
    if (w === viewW && hh === viewH) return
    measureView()
    renderAll(false)
  })
  ro.observe(scroller)
  cleanups.push(() => ro.disconnect())

  const onPageHide = () => model.flushOnUnload()
  listen(window, 'pagehide', onPageHide)

  /* ---------------------------------------------------------------- start */

  rebuildGeometry()
  renderAll()
  renderTabs()
  selectionChanged({ scroll: false })
  setSaveState('saved')
  focusGrid()

  const handle = {
    model,
    get sheet() { return sheet },
    get selection() { return range() },
    get lastCommitMs() { return lastCommitMs },
    destroy() {
      if (edit) commitEdit(0, 0)
      model.flush()
      for (const fn of cleanups) fn()
      if (window.__trussSheet === handle) window.__trussSheet = null
    },
  }
  window.__trussSheet = handle
  return handle
}

function pointAnchor(e) {
  return { getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) }
}

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k)
    localStorage.setItem(k, v)
  } catch {
    return null
  }
  return null
}
