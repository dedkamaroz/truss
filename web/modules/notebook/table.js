// Table editor used for table-style pages and for table blocks inside text pages.
// Data shape: { columns: [{ id, name, width }], rows: [{ id, cells: { [columnId]: string } }] }, edited in place.

import { h, menu } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import { bid, caretOffset, selectionEndOffset, setCaret } from './util.js'

const MIN_WIDTH = 64
const HANDLE_WIDTH = 28
const ADD_WIDTH = 36

export function normaliseTable(d) {
  const t = d && typeof d === 'object' ? d : {}
  if (!Array.isArray(t.columns) || !t.columns.length) t.columns = [{ name: 'Name' }, { name: 'Notes' }]
  t.columns = t.columns.map((c) => ({ id: c?.id || bid(), name: String(c?.name ?? ''), width: Math.max(MIN_WIDTH, Number(c?.width) || 180) }))
  if (!Array.isArray(t.rows)) t.rows = [{}, {}]
  t.rows = t.rows.map((r) => ({ id: r?.id || bid(), cells: r?.cells && typeof r.cells === 'object' ? r.cells : {} }))
  return t
}

export function newTable(cols = 3, rows = 3) {
  return normaliseTable({ columns: Array.from({ length: cols }, () => ({ name: '', width: 160 })), rows: Array.from({ length: rows }, () => ({})) })
}

const readCell = (el) => el.innerText.replace(/\n$/, '')

/**
 * createTableEditor({ data, record(key), onChange(kind), full }) -> { el, data, setData, focusCell }
 * record(key) is called before each change (undo history); onChange(kind) after it ('type' for cell typing).
 */
export function createTableEditor({ data, record = () => {}, onChange = () => {}, full = false }) {
  let t = normaliseTable(data)
  let dragging = null
  const root = h('div', { class: `nb-table-wrap${full ? ' is-full' : ''}` })
  const scroller = h('div', { class: 'nb-table-scroll' })
  const addRowBtn = h('button', { type: 'button', class: 'nb-table-add-row', onClick: () => addRow(t.rows.length, true) }, icon('plus', { size: 14 }), h('span', {}, 'New row'))
  root.append(scroller, addRowBtn)
  let tableEl
  let colEls = []

  const totalWidth = () => HANDLE_WIDTH + t.columns.reduce((s, c) => s + c.width, 0) + ADD_WIDTH

  function cellEl(r, c) {
    return tableEl.querySelector(`.nb-cell[data-r="${r}"][data-c="${c}"]`)
  }

  function focusCell(r, c, where = 'end') {
    const el = cellEl(r, c)
    if (!el) return
    setCaret(el, where === 'start' ? 0 : Infinity)
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function render() {
    colEls = [h('col', { style: { width: `${HANDLE_WIDTH}px` } }), ...t.columns.map((c) => h('col', { style: { width: `${c.width}px` } })), h('col', { style: { width: `${ADD_WIDTH}px` } })]
    const head = h('tr', { class: 'nb-tr-head' }, h('th', { class: 'nb-th-corner' }),
      t.columns.map((col, c) => h('th', { class: 'nb-th', dataset: { c } },
        h('div', { class: 'nb-th-inner' },
          h('div', { class: 'nb-cell nb-head', contenteditable: 'plaintext-only', spellcheck: 'false', dataset: { r: -1, c }, 'aria-label': `Column ${c + 1} name` }, col.name),
          h('button', { type: 'button', class: 'nb-col-btn', draggable: 'true', title: 'Column options (drag to reorder)', 'aria-label': `Column options for ${col.name || 'column ' + (c + 1)}`, dataset: { c } }, icon('more', { size: 14 }))),
        h('span', { class: 'nb-col-resize', dataset: { c }, title: 'Drag to resize' }))),
      h('th', { class: 'nb-th-add' }, h('button', { type: 'button', class: 'nb-table-add-col', title: 'Add column', 'aria-label': 'Add column', onClick: () => addColumn(t.columns.length, true) }, icon('plus', { size: 14 }))))
    const body = t.rows.map((row, r) => h('tr', { class: 'nb-tr', dataset: { r } },
      h('td', { class: 'nb-td-handle' }, h('button', { type: 'button', class: 'nb-row-btn', draggable: 'true', title: 'Row options (drag to reorder)', 'aria-label': `Row ${r + 1} options`, dataset: { r } }, icon('drag', { size: 14 }))),
      t.columns.map((col, c) => h('td', { class: 'nb-td' },
        h('div', { class: 'nb-cell', contenteditable: 'plaintext-only', spellcheck: 'false', dataset: { r, c } }, row.cells[col.id] ?? ''))),
      h('td', { class: 'nb-td-pad' })))
    tableEl = h('table', { class: 'nb-table', style: { width: `${totalWidth()}px` } },
      h('colgroup', {}, colEls), h('thead', {}, head), h('tbody', {}, body))
    scroller.replaceChildren(tableEl)
  }

  const structural = (fn, focus) => {
    record(null)
    fn()
    render()
    onChange('structure')
    if (focus) focus()
  }

  function addRow(at, focusIt) {
    structural(() => t.rows.splice(at, 0, { id: bid(), cells: {} }), focusIt ? () => focusCell(at, 0) : null)
  }
  function addColumn(at, focusIt) {
    structural(() => t.columns.splice(at, 0, { id: bid(), name: '', width: 160 }), focusIt ? () => focusCell(-1, at) : null)
  }
  const moveItem = (list, from, to) => {
    if (to < 0 || to >= list.length || from === to) return false
    list.splice(to, 0, list.splice(from, 1)[0])
    return true
  }

  function columnMenu(anchor, c) {
    menu(anchor, [
      { label: 'Insert column left', icon: 'plus', onClick: () => addColumn(c, true) },
      { label: 'Insert column right', icon: 'plus', onClick: () => addColumn(c + 1, true) },
      'divider',
      { label: 'Move left', icon: 'chevron-left', disabled: c === 0, onClick: () => structural(() => moveItem(t.columns, c, c - 1)) },
      { label: 'Move right', icon: 'chevron-right', disabled: c === t.columns.length - 1, onClick: () => structural(() => moveItem(t.columns, c, c + 1)) },
      'divider',
      { label: 'Delete column', icon: 'trash', danger: true, disabled: t.columns.length <= 1, onClick: () => structural(() => {
        const [gone] = t.columns.splice(c, 1)
        for (const row of t.rows) delete row.cells[gone.id]
      }) },
    ], { align: 'start' })
  }

  function rowMenu(anchor, r) {
    menu(anchor, [
      { label: 'Insert row above', icon: 'plus', onClick: () => addRow(r, true) },
      { label: 'Insert row below', icon: 'plus', onClick: () => addRow(r + 1, true) },
      'divider',
      { label: 'Move up', icon: 'sort', disabled: r === 0, onClick: () => structural(() => moveItem(t.rows, r, r - 1)) },
      { label: 'Move down', icon: 'sort', disabled: r === t.rows.length - 1, onClick: () => structural(() => moveItem(t.rows, r, r + 1)) },
      'divider',
      { label: 'Delete row', icon: 'trash', danger: true, onClick: () => structural(() => t.rows.splice(r, 1)) },
    ])
  }

  root.addEventListener('click', (e) => {
    const colBtn = e.target.closest('.nb-col-btn')
    if (colBtn) return columnMenu(colBtn, Number(colBtn.dataset.c))
    const rowBtn = e.target.closest('.nb-row-btn')
    if (rowBtn) return rowMenu(rowBtn, Number(rowBtn.dataset.r))
  })

  root.addEventListener('beforeinput', (e) => {
    const cell = e.target.closest?.('.nb-cell')
    if (cell) record(`cell:${cell.dataset.r}:${cell.dataset.c}`)
  })

  root.addEventListener('input', (e) => {
    const cell = e.target.closest?.('.nb-cell')
    if (!cell) return
    const r = Number(cell.dataset.r)
    const col = t.columns[Number(cell.dataset.c)]
    if (!col) return
    const value = readCell(cell)
    if (r === -1) {
      col.name = value
      const btn = cell.parentElement.querySelector('.nb-col-btn')
      btn?.setAttribute('aria-label', `Column options for ${value || 'column'}`)
    } else if (t.rows[r]) t.rows[r].cells[col.id] = value
    onChange('type')
  })

  root.addEventListener('keydown', (e) => {
    const cell = e.target.closest?.('.nb-cell')
    if (!cell || e.isComposing) return
    const r = Number(cell.dataset.r)
    const c = Number(cell.dataset.c)
    const nc = t.columns.length
    const nr = t.rows.length
    const collapsed = getSelection().isCollapsed
    const stop = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === 'Tab') {
      stop()
      if (e.shiftKey) {
        if (c > 0) focusCell(r, c - 1)
        else if (r > -1) focusCell(r - 1, nc - 1)
      } else if (c + 1 < nc) focusCell(r, c + 1)
      else if (r + 1 < nr) focusCell(r + 1, 0)
      else addRow(nr, true)
    } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      stop()
      if (r + 1 < nr) focusCell(r + 1, c)
      else structural(() => t.rows.push({ id: bid(), cells: {} }), () => focusCell(r + 1, c))
    } else if (e.key === 'ArrowUp' && !e.shiftKey && r > -1) {
      stop()
      focusCell(r - 1, c)
    } else if (e.key === 'ArrowDown' && !e.shiftKey && r + 1 < nr) {
      stop()
      focusCell(r + 1, c)
    } else if (e.key === 'ArrowLeft' && !e.shiftKey && collapsed && c > 0 && caretOffset(cell) === 0) {
      stop()
      focusCell(r, c - 1, 'end')
    } else if (e.key === 'ArrowRight' && !e.shiftKey && collapsed && c + 1 < nc && selectionEndOffset(cell) >= cell.textContent.length) {
      stop()
      focusCell(r, c + 1, 'start')
    } else if (e.key === 'Escape') {
      cell.blur()
    }
  })

  // Multi-cell TSV paste (from Excel or another table) fills cells from the focused one, growing the table as needed.
  root.addEventListener('paste', (e) => {
    const cell = e.target.closest?.('.nb-cell')
    if (!cell) return
    const text = (e.clipboardData?.getData('text/plain') || '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
    if (!/[\t\n]/.test(text)) return
    e.preventDefault()
    const r0 = Number(cell.dataset.r)
    const c0 = Number(cell.dataset.c)
    const grid = text.split('\n').map((line) => line.split('\t'))
    let maxC = 0
    structural(() => {
      grid.forEach((line, i) => {
        const r = r0 + i
        line.forEach((val, j) => {
          const c = c0 + j
          maxC = Math.max(maxC, c)
          while (c >= t.columns.length) t.columns.push({ id: bid(), name: '', width: 160 })
          if (r === -1) t.columns[c].name = val
          else {
            while (r >= t.rows.length) t.rows.push({ id: bid(), cells: {} })
            t.rows[r].cells[t.columns[c].id] = val
          }
        })
      })
    }, () => focusCell(r0 + grid.length - 1, maxC))
  })

  // Column resize
  root.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.nb-col-resize')
    if (!handle || e.button !== 0) return
    e.preventDefault()
    const c = Number(handle.dataset.c)
    const col = t.columns[c]
    const startX = e.clientX
    const startW = col.width
    record(null)
    handle.setPointerCapture(e.pointerId)
    handle.classList.add('is-active')
    const move = (ev) => {
      col.width = Math.max(MIN_WIDTH, Math.round(startW + ev.clientX - startX))
      colEls[c + 1].style.width = `${col.width}px`
      tableEl.style.width = `${totalWidth()}px`
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('lostpointercapture', up)
      handle.classList.remove('is-active')
      if (col.width !== startW) onChange('resize')
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('lostpointercapture', up)
  })

  // Drag to reorder rows (row handle) and columns (column button)
  const clearDrop = () => tableEl?.querySelectorAll('.is-drop-before, .is-drop-after').forEach((x) => x.classList.remove('is-drop-before', 'is-drop-after'))
  root.addEventListener('dragstart', (e) => {
    const rowBtn = e.target.closest?.('.nb-row-btn')
    const colBtn = e.target.closest?.('.nb-col-btn')
    if (!rowBtn && !colBtn) return
    e.stopPropagation()
    dragging = rowBtn ? { kind: 'row', index: Number(rowBtn.dataset.r) } : { kind: 'col', index: Number(colBtn.dataset.c) }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-truss-table', dragging.kind)
    if (rowBtn) e.dataTransfer.setDragImage(rowBtn.closest('tr'), 12, 12)
  })
  const dropTarget = (e) => {
    if (!dragging) return null
    if (dragging.kind === 'row') {
      const tr = e.target.closest?.('tr.nb-tr')
      if (!tr) return null
      const rect = tr.getBoundingClientRect()
      return { el: tr, index: Number(tr.dataset.r), after: e.clientY > rect.top + rect.height / 2 }
    }
    const th = e.target.closest?.('th.nb-th')
    if (!th) return null
    const rect = th.getBoundingClientRect()
    return { el: th, index: Number(th.dataset.c), after: e.clientX > rect.left + rect.width / 2 }
  }
  root.addEventListener('dragover', (e) => {
    const target = dropTarget(e)
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    clearDrop()
    target.el.classList.add(target.after ? 'is-drop-after' : 'is-drop-before')
  })
  root.addEventListener('drop', (e) => {
    const target = dropTarget(e)
    clearDrop()
    if (!target) return
    e.preventDefault()
    e.stopPropagation()
    const { kind, index: from } = dragging
    let to = target.index + (target.after ? 1 : 0)
    if (to > from) to--
    dragging = null
    if (to === from) return
    structural(() => moveItem(kind === 'row' ? t.rows : t.columns, from, to))
  })
  root.addEventListener('dragend', () => {
    dragging = null
    clearDrop()
  })

  render()
  return {
    el: root,
    get data() {
      return t
    },
    setData(d) {
      t = normaliseTable(d)
      render()
    },
    focusCell,
  }
}
