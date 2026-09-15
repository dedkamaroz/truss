// Table view: virtualised rows, sticky header, column drag/resize, inline editing and keyboard navigation.

import { h } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import { typeOf, propIcon, renderValue, startEdit, groupLabel, alignOf, EMPTY_GROUP } from './types.js'
import { viewRows, groupRows, isGroupable, groupValue } from './query.js'
import { createVirtual } from './virtual.js'
import { dragGesture } from './drag.js'
import { propertyMenu, typePicker } from './menus.js'

const ROW_H = 34
const GROUP_H = 44
const HEAD_H = 34
const MIN_W = 80

export function createTableView(host, ctx) {
  const { store } = ctx
  const cfg = () => ctx.view().config
  const head = h('div', { class: 'db-thead', role: 'row' })
  const body = h('div', { class: 'db-tbody', role: 'rowgroup' })
  const inner = h('div', { class: 'db-table-inner' }, head, body)
  const scroller = h('div', { class: 'db-table', tabindex: '0', role: 'grid', 'aria-label': 'Table', dataset: { view: 'table' } }, inner)
  host.append(scroller)

  let cols = [] // visible properties
  let colsSig = ''
  let sel = null // { rowId, propId }
  let editing = null // { rowId, propId }
  let raf = 0

  const virtual = createVirtual({
    scroller, body, overscan: ROW_H * 6,
    create: (it) => (it.kind === 'row' ? createRow(it) : it.kind === 'group' ? h('div', { class: 'db-group-head' }) : h('div', { class: 'db-add-row', role: 'button', tabindex: '-1' })),
    update: (el, it) => (it.kind === 'row' ? updateRow(el, it) : it.kind === 'group' ? updateGroup(el, it) : updateAdd(el, it)),
  })

  /* ---- columns */

  const widthOf = (p) => Math.max(MIN_W, cfg().widths?.[p.id] ?? p.width ?? typeOf(p).defaultWidth ?? 200)
  const cssVar = (p) => `--w-${p.id}`

  function applyWidths() {
    let total = 0
    for (const p of cols) {
      const w = widthOf(p)
      inner.style.setProperty(cssVar(p), `${w}px`)
      total += w
    }
    inner.style.setProperty('--db-cols-width', `${total}px`)
  }

  function buildHeader() {
    const hidden = new Set(cfg().hidden || [])
    cols = store.properties.filter((p) => p.type === 'title' || !hidden.has(p.id))
    const sig = `${store.schemaVersion}|${cols.map((p) => p.id).join(',')}`
    applyWidths()
    if (sig === colsSig) return false
    colsSig = sig
    const add = h('button', { type: 'button', class: 'db-th-add', title: 'Add a property', 'aria-label': 'Add a property' }, icon('plus', { size: 16 }))
    add.addEventListener('click', () => typePicker(add, {
      title: 'New property', store,
      onPick: async (type, config) => {
        const p = await store.createProperty(config ? { type, config } : { type }).catch(() => null)
        if (!p) return
        requestAnimationFrame(() => {
          const th = head.querySelector(`.db-th[data-prop="${p.id}"]`)
          th?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
          if (th) propertyMenu(th, p, ctx, { focusName: true })
        })
      },
    }))
    head.replaceChildren(h('div', { class: 'db-gutter-head' }), ...cols.map(headerCell), add, h('div', { class: 'db-th-fill' }))
    virtual.clear()
    return true
  }

  function headerCell(p) {
    const resize = h('div', { class: 'db-resize', title: 'Drag to resize', 'aria-hidden': 'true' })
    const th = h('div', { class: 'db-th', role: 'columnheader', tabindex: '-1', dataset: { prop: p.id, type: p.type }, style: { width: `var(${cssVar(p)})` } },
      h('span', { class: 'db-th-icon' }, propIcon(p, 14)), h('span', { class: 'db-th-name' }, p.name), resize)
    th.addEventListener('pointerdown', (e) => {
      if (e.target === resize) return
      let indicator
      let dropIndex = -1
      dragGesture(e, {
        source: th, axis: 'x',
        onStart: () => {
          indicator = h('div', { class: 'db-col-indicator' })
          inner.append(indicator)
        },
        onMove: ({ x }) => {
          const ths = [...head.querySelectorAll('.db-th')]
          dropIndex = ths.findIndex((c) => { const r = c.getBoundingClientRect(); return x < r.left + r.width / 2 })
          if (dropIndex < 0) dropIndex = ths.length
          const ref = ths[dropIndex] || ths[ths.length - 1]
          const r = ref.getBoundingClientRect()
          const ir = inner.getBoundingClientRect()
          indicator.style.left = `${(dropIndex < ths.length ? r.left : r.right) - ir.left - 1}px`
        },
        onDrop: ({ x }) => {
          const ths = [...head.querySelectorAll('.db-th')]
          let idx = ths.findIndex((c) => { const r = c.getBoundingClientRect(); return x < r.left + r.width / 2 })
          if (idx < 0) idx = ths.length
          moveColumn(p.id, idx)
        },
        onEnd: () => indicator?.remove(),
      })
    })
    th.addEventListener('click', () => propertyMenu(th, store.propById.get(p.id) || p, ctx))
    resize.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const startX = e.clientX
      const startW = widthOf(p)
      let w = startW
      th.classList.add('is-resizing')
      const move = (ev) => {
        w = Math.max(MIN_W, Math.round(startW + ev.clientX - startX))
        inner.style.setProperty(cssVar(p), `${w}px`)
      }
      const up = () => {
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', up, true)
        th.classList.remove('is-resizing')
        window.addEventListener('click', swallow, true)
        setTimeout(() => window.removeEventListener('click', swallow, true), 0)
        if (w !== startW) ctx.setConfig({ widths: { ...cfg().widths, [p.id]: w } })
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', up, true)
    })
    return th
  }
  const swallow = (e) => (e.stopPropagation(), e.preventDefault())

  function moveColumn(propId, visibleIndex) {
    const visibleIds = cols.map((c) => c.id)
    const from = visibleIds.indexOf(propId)
    if (visibleIndex === from || visibleIndex === from + 1) return
    const before = visibleIds[visibleIndex] // insert before this visible column (undefined = at the end)
    const all = store.properties.map((x) => x.id).filter((id) => id !== propId)
    const at = before ? all.indexOf(before) : all.indexOf(visibleIds[visibleIds.length - 1]) + 1
    all.splice(at, 0, propId)
    store.reorderProperties(all)
  }

  /* ---- items */

  function layout() {
    const c = cfg()
    const rows = viewRows(store, c)
    const items = []
    const gp = c.group_by && store.propById.get(c.group_by)
    if (gp && isGroupable(gp)) {
      const collapsed = new Set(c.collapsed || [])
      for (const g of groupRows(rows, gp)) {
        if (g.key === EMPTY_GROUP && !g.rows.length) continue
        const isCollapsed = collapsed.has(g.key)
        items.push({ kind: 'group', key: `g:${g.key}`, group: g, prop: gp, collapsed: isCollapsed })
        if (isCollapsed) continue
        for (const row of g.rows) items.push({ kind: 'row', key: row.id, row, group: g })
        items.push({ kind: 'add', key: `a:${g.key}`, group: g, prop: gp })
      }
    } else {
      for (const row of rows) items.push({ kind: 'row', key: row.id, row })
      items.push({ kind: 'add', key: 'a:', group: null })
    }
    virtual.setItems(items, (it) => (it.kind === 'group' ? GROUP_H : ROW_H))
    scroller.classList.toggle('is-grouped', !!gp)
  }

  function createRow(it) {
    const el = h('div', { class: 'db-tr', role: 'row', dataset: { rowId: it.row.id } })
    el._v = -1
    return el
  }

  function updateRow(el, it) {
    const row = it.row
    if (el._v === row._v && el._row === row && el._sig === colsSig) return
    const first = el._sig !== colsSig
    el._v = row._v
    el._row = row
    el._sig = colsSig
    if (first) {
      el.replaceChildren(
        h('div', { class: 'db-gutter' }, h('button', { type: 'button', class: 'db-row-menu', title: 'Row actions', 'aria-label': 'Row actions', tabindex: '-1' }, icon('drag', { size: 14 }))),
        ...cols.map((p) => h('div', { class: 'db-td', role: 'gridcell', dataset: { prop: p.id, type: p.type }, style: { width: `var(${cssVar(p)})` } })),
        h('div', { class: 'db-td-fill' }))
    }
    const tds = el.children
    cols.forEach((p, i) => {
      const td = tds[i + 1]
      if (td.classList.contains('is-editing')) return // inline input lives in this cell
      fillCell(td, row, p)
    })
    if (sel?.rowId === row.id) paintSelection()
  }

  function fillCell(td, row, p) {
    const content = renderValue(row, p, store)
    const kids = [content]
    if (p.type === 'title') kids.push(h('button', { type: 'button', class: 'db-open-btn', tabindex: '-1', title: 'Open in side peek' }, icon('sidebar', { size: 12 }), h('span', {}, 'Open')))
    td.replaceChildren(...kids.filter(Boolean))
    td.classList.toggle('is-readonly', !!typeOf(p).readOnly)
    const align = alignOf(p)
    if (align) td.dataset.align = align
    else delete td.dataset.align
  }

  function updateGroup(el, it) {
    const sig = `${it.group.key}|${it.group.rows.length}|${it.collapsed}|${it.group.label}|${it.group.option?.color}`
    if (el._sig === sig) return
    el._sig = sig
    const g = it.group
    el.dataset.group = g.key
    el.classList.toggle('is-collapsed', it.collapsed)
    const label = groupLabel(g, it.prop)
    el.replaceChildren(
      h('button', { type: 'button', class: 'db-group-toggle', 'aria-expanded': String(!it.collapsed), 'aria-label': `${it.collapsed ? 'Expand' : 'Collapse'} ${g.label}` }, icon('chevron-down', { size: 14, strokeWidth: 2 })),
      label, h('span', { class: 'db-group-count' }, String(g.rows.length)))
  }

  function updateAdd(el, it) {
    if (el._done) return
    el._done = true
    el.replaceChildren(icon('plus', { size: 14 }), h('span', {}, 'New'))
    el._group = it
  }

  /* ---- render loop */

  function render() {
    raf = 0
    virtual.render()
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(render) }
  scroller.addEventListener('scroll', schedule, { passive: true })
  const ro = new ResizeObserver(schedule)
  ro.observe(scroller)

  /* ---- selection and keyboard */

  const navRows = () => virtual.items.filter((it) => it.kind === 'row')

  function paintSelection() {
    for (const td of body.querySelectorAll('.db-td.is-selected')) td.classList.remove('is-selected')
    if (!sel) return
    body.querySelector(`.db-tr[data-row-id="${sel.rowId}"] .db-td[data-prop="${sel.propId}"]`)?.classList.add('is-selected')
  }

  function select(rowId, propId, reveal = true) {
    sel = rowId && propId ? { rowId, propId } : null
    if (sel && reveal) {
      virtual.reveal(virtual.indexOf(rowId), HEAD_H)
      virtual.render()
      const td = cellEl(rowId, propId)
      if (td) {
        const left = td.offsetLeft
        if (left < scroller.scrollLeft) scroller.scrollLeft = left - 40
        else if (left + td.offsetWidth > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = left + td.offsetWidth - scroller.clientWidth + 16
      }
    }
    paintSelection()
  }

  const cellEl = (rowId, propId) => body.querySelector(`.db-tr[data-row-id="${rowId}"] .db-td[data-prop="${propId}"]`)

  function edit(rowId, propId, initialText) {
    const row = store.rowById.get(rowId)
    const prop = store.propById.get(propId)
    if (!row || !prop || typeOf(prop).readOnly) return
    select(rowId, propId)
    const td = cellEl(rowId, propId)
    if (!td) return
    if (initialText != null && typeOf(prop).edit !== 'text') initialText = undefined
    editing = { rowId, propId }
    const handle = startEdit({
      cell: td, prop, row, store, initialText,
      onDone: ({ move } = {}) => {
        editing = null
        const r = store.rowById.get(rowId)
        const c = cellEl(rowId, propId)
        if (r && c && !c.classList.contains('is-editing')) fillCell(c, r, store.propById.get(propId) || prop)
        if (move === 'right' || move === 'left') moveSel(move === 'right' ? 1 : -1, 0, true)
        if (move !== undefined && move !== null) scroller.focus({ preventScroll: true })
        else setTimeout(() => {
          const active = document.activeElement
          if (scroller.isConnected && (!active || active === document.body)) scroller.focus({ preventScroll: true })
        }, 0)
      },
    })
    if (!handle && typeOf(prop).edit === 'toggle') editing = null
  }

  function moveSel(dx, dy, wrap = false) {
    const rows = navRows()
    if (!rows.length || !cols.length) return
    let ri = sel ? rows.findIndex((it) => it.row.id === sel.rowId) : 0
    let ci = sel ? cols.findIndex((p) => p.id === sel.propId) : 0
    if (ri < 0) ri = 0
    if (ci < 0) ci = 0
    ci += dx
    if (wrap && ci >= cols.length) (ci = 0, ri++)
    if (wrap && ci < 0) (ci = cols.length - 1, ri--)
    ri += dy
    if (wrap && (ri < 0 || ri >= rows.length)) return
    ri = Math.max(0, Math.min(rows.length - 1, ri))
    ci = Math.max(0, Math.min(cols.length - 1, ci))
    select(rows[ri].row.id, cols[ci].id)
  }

  scroller.addEventListener('keydown', (e) => {
    if (e.target !== scroller || editing) return
    const k = e.key
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault()
      moveSel(k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : 0, k === 'ArrowDown' ? 1 : k === 'ArrowUp' ? -1 : 0)
    } else if (k === 'Tab' && sel) {
      e.preventDefault()
      moveSel(e.shiftKey ? -1 : 1, 0, true)
    } else if (k === 'Enter' && sel) {
      e.preventDefault()
      if (e.shiftKey || (e.ctrlKey && store.propById.get(sel.propId)?.type === 'title')) ctx.openRow(sel.rowId)
      else edit(sel.rowId, sel.propId)
    } else if (k === ' ' && sel && typeOf(store.propById.get(sel.propId)).edit === 'toggle') {
      e.preventDefault()
      edit(sel.rowId, sel.propId)
    } else if (k === 'Escape' && sel) {
      e.preventDefault()
      select(null)
    } else if ((k === 'Delete' || k === 'Backspace') && sel) {
      const p = store.propById.get(sel.propId)
      if (p && !typeOf(p).readOnly) {
        e.preventDefault()
        store.updateValues(sel.rowId, { [p.id]: null }).catch(() => {})
      }
    } else if (sel && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && typeOf(store.propById.get(sel.propId)).edit === 'text') {
      e.preventDefault()
      edit(sel.rowId, sel.propId, k)
    }
  })

  /* ---- pointer interactions */

  body.addEventListener('click', async (e) => {
    const t = e.target
    if (t.closest('a') || t.closest('.db-inline-input')) return
    const add = t.closest('.db-add-row')
    if (add) {
      const it = add._group
      const values = it?.group && it.prop ? { [it.prop.id]: groupValue(it.prop, it.group.key) } : {}
      const row = await ctx.addRow(values)
      if (row) {
        const title = cols.find((p) => p.type === 'title')
        requestAnimationFrame(() => title && edit(row.id, title.id))
      }
      return
    }
    const groupHead = t.closest('.db-group-head')
    if (groupHead) {
      const key = groupHead.dataset.group
      const collapsed = new Set(cfg().collapsed || [])
      if (collapsed.has(key)) collapsed.delete(key)
      else collapsed.add(key)
      ctx.setConfig({ collapsed: [...collapsed] })
      return
    }
    const tr = t.closest('.db-tr')
    if (!tr) return
    const rowId = tr.dataset.rowId
    if (t.closest('.db-open-btn')) return ctx.openRow(rowId)
    if (t.closest('.db-row-menu')) return ctx.rowMenu(t.closest('.db-row-menu'), rowId)
    const td = t.closest('.db-td')
    if (!td) return
    scroller.focus({ preventScroll: true })
    const prop = store.propById.get(td.dataset.prop)
    if (!prop) return
    if (typeOf(prop).readOnly) return select(rowId, prop.id, false)
    edit(rowId, prop.id)
  })

  body.addEventListener('contextmenu', (e) => {
    const tr = e.target.closest('.db-tr')
    if (!tr) return
    e.preventDefault()
    ctx.rowMenu({ getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) }, tr.dataset.rowId)
  })

  scroller.addEventListener('focusout', () => {
    // keep the selection visible but dimmed when focus moves elsewhere
    requestAnimationFrame(() => scroller.classList.toggle('is-blurred', !scroller.contains(document.activeElement)))
  })
  scroller.addEventListener('focusin', () => scroller.classList.remove('is-blurred'))

  /* ---- lifecycle */

  function refresh(change = {}) {
    if (change.notesOnly) return
    buildHeader()
    layout()
    if (sel && virtual.indexOf(sel.rowId) < 0) sel = null
    virtual.render()
    paintSelection()
  }

  refresh()

  return {
    el: scroller,
    refresh,
    focusRow(rowId) {
      const title = cols.find((p) => p.type === 'title')
      if (title) select(rowId, title.id)
    },
    destroy() {
      cancelAnimationFrame(raf)
      ro.disconnect()
      scroller.remove()
    },
    // for tests and diagnostics
    get rowElementCount() { return body.querySelectorAll('.db-tr').length },
  }
}
