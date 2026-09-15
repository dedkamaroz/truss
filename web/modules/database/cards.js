// List view (virtualised rows) and gallery view (cards with a cover from a files property).

import { h } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import api from '../../lib/api.js'
import { renderValue, hasDisplayValue, getValue, canCover } from './types.js'
import { viewRows } from './query.js'
import { createVirtual } from './virtual.js'

const LIST_H = 40
const GALLERY_PAGE = 60

function shownProps(store, config) {
  const hidden = new Set(config.hidden || [])
  return store.properties.filter((p) => p.type !== 'title' && !hidden.has(p.id))
}

function fields(row, props, store, cls) {
  return props.filter((p) => hasDisplayValue(row, p))
    .map((p) => h('span', { class: cls, dataset: { prop: p.id }, title: p.name }, renderValue(row, p, store)))
}

function wireOpen(el, rowId, ctx) {
  el.addEventListener('click', (e) => {
    if (!e.target.closest('a')) ctx.openRow(rowId)
  })
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.preventDefault(), ctx.openRow(rowId))
  })
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    ctx.rowMenu({ getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) }, rowId)
  })
}

export function createListView(host, ctx) {
  const { store } = ctx
  const body = h('div', { class: 'db-list-body' })
  const add = h('button', { type: 'button', class: 'db-add-row db-list-add' }, icon('plus', { size: 14 }), h('span', {}, 'New'))
  const scroller = h('div', { class: 'db-list', dataset: { view: 'list' } }, h('div', { class: 'db-list-inner' }, body, add))
  host.append(scroller)
  let sig = ''
  add.addEventListener('click', async () => {
    const row = await ctx.addRow({})
    if (row) ctx.openRow(row.id, { focusTitle: true })
  })

  const virtual = createVirtual({
    scroller, body, overscan: LIST_H * 8,
    create: (it) => {
      const el = h('div', { class: 'db-list-row', role: 'button', tabindex: '0', dataset: { rowId: it.row.id } })
      wireOpen(el, it.row.id, ctx)
      return el
    },
    update: (el, it) => {
      if (el._v === it.row._v && el._sig === sig) return
      el._v = it.row._v
      el._sig = sig
      const title = store.properties.find((p) => p.type === 'title')
      el.replaceChildren(
        h('span', { class: 'db-list-icon' }, icon('page', { size: 16 })),
        h('span', { class: 'db-list-title' }, title ? renderValue(it.row, title, store) : 'Untitled'),
        h('span', { class: 'db-list-fields' }, fields(it.row, shownProps(store, ctx.view().config), store, 'db-list-field')))
    },
  })
  let raf = 0
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; virtual.render() }) }
  scroller.addEventListener('scroll', schedule, { passive: true })
  const ro = new ResizeObserver(schedule)
  ro.observe(scroller)

  function refresh(change = {}) {
    if (change.notesOnly) return
    sig = `${store.schemaVersion}|${(ctx.view().config.hidden || []).join(',')}`
    const rows = viewRows(store, ctx.view().config)
    virtual.setItems(rows.map((row) => ({ key: row.id, row })), () => LIST_H)
    virtual.render()
    body.classList.toggle('is-empty', !rows.length)
  }
  refresh()
  return { el: scroller, refresh, destroy: () => { cancelAnimationFrame(raf); ro.disconnect(); scroller.remove() } }
}

export function createGalleryView(host, ctx) {
  const { store } = ctx
  const root = h('div', { class: 'db-gallery', dataset: { view: 'gallery' } })
  host.append(root)
  let limit = GALLERY_PAGE

  const coverProp = () => {
    const c = ctx.view().config.cover_property
    if (c === 'none') return null
    const p = store.propById.get(c)
    return p && canCover(p) ? p : store.properties.find(canCover) || null
  }

  function cover(row, cp) {
    const img = cp && (getValue(row, cp) || []).map((id) => store.attachments.get(id)).find((a) => a && /^image\//.test(a.mime))
    if (img) return h('div', { class: 'db-gallery-cover' }, h('img', { src: api.url(`/api/attachments/${encodeURIComponent(img.id)}/content`), alt: '', loading: 'lazy', draggable: 'false' }))
    return h('div', { class: 'db-gallery-cover is-empty' }, icon('page', { size: 28, strokeWidth: 1.4 }))
  }

  function refresh(change = {}) {
    if (change.notesOnly) return
    const rows = viewRows(store, ctx.view().config)
    const cp = coverProp()
    const title = store.properties.find((p) => p.type === 'title')
    const props = shownProps(store, ctx.view().config).filter((p) => p.id !== cp?.id)
    const cards = rows.slice(0, limit).map((row) => {
      const el = h('div', { class: 'db-gallery-card', role: 'button', tabindex: '0', dataset: { rowId: row.id } },
        cover(row, cp),
        h('div', { class: 'db-gallery-body' },
          h('div', { class: 'db-gallery-title' }, title ? renderValue(row, title, store) : 'Untitled'),
          h('div', { class: 'db-gallery-fields' }, fields(row, props, store, 'db-gallery-field'))))
      wireOpen(el, row.id, ctx)
      return el
    })
    const addCard = h('button', { type: 'button', class: 'db-gallery-card db-gallery-new' }, icon('plus', { size: 16 }), h('span', {}, 'New'))
    addCard.addEventListener('click', async () => {
      const row = await ctx.addRow({})
      if (row) ctx.openRow(row.id, { focusTitle: true })
    })
    const more = rows.length > limit
      ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm db-gallery-more', onClick: () => { limit += GALLERY_PAGE; refresh() } }, `Show ${Math.min(GALLERY_PAGE, rows.length - limit)} more`)
      : null
    const scroll = root.scrollTop
    root.replaceChildren(h('div', { class: 'db-gallery-grid' }, cards, addCard), more)
    root.scrollTop = scroll
  }
  refresh()
  return { el: root, refresh, destroy: () => root.remove() }
}
