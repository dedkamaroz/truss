// Board view: columns per group of a select/status/checkbox property, draggable cards.

import { h } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import { typeOf, renderValue, hasDisplayValue, getValue, groupLabel } from './types.js'
import { viewRows, groupRows, isGroupable, groupValue } from './query.js'
import { dragGesture } from './drag.js'
import { groupMenu } from './menus.js'

const PAGE = 50

export function createBoardView(host, ctx) {
  const { store } = ctx
  const cfg = () => ctx.view().config
  const root = h('div', { class: 'db-board', dataset: { view: 'board' } })
  host.append(root)
  const limits = new Map() // group key -> number of cards shown
  let groups = []

  function cardProps(gp) {
    const hidden = new Set(cfg().hidden || [])
    return store.properties.filter((p) => p.type !== 'title' && p.id !== gp.id && !hidden.has(p.id))
  }

  function card(row, gp, props) {
    const title = store.properties.find((p) => p.type === 'title')
    const fields = props.filter((p) => hasDisplayValue(row, p))
      .map((p) => h('div', { class: 'db-card-field', dataset: { prop: p.id }, title: p.name }, renderValue(row, p, store)))
    const el = h('div', { class: 'db-card', role: 'button', tabindex: '0', dataset: { rowId: row.id } },
      h('div', { class: 'db-card-title' }, title ? renderValue(row, title, store) : 'Untitled'),
      fields.length ? h('div', { class: 'db-card-fields' }, fields) : null)
    el.addEventListener('click', (e) => {
      if (!e.target.closest('a')) ctx.openRow(row.id)
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.preventDefault(), ctx.openRow(row.id))
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      ctx.rowMenu({ getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) }, row.id)
    })
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('a')) return
      let marker = null
      const clear = () => {
        marker?.remove()
        for (const c of root.querySelectorAll('.db-board-col.is-drop')) c.classList.remove('is-drop')
      }
      dragGesture(e, {
        source: el,
        onMove: ({ x, y }) => {
          const col = columnAt(x, y)
          clear()
          if (!col) return
          col.classList.add('is-drop')
          const { before } = dropPoint(col, y, el)
          marker = h('div', { class: 'db-card-marker' })
          const list = col.querySelector('.db-board-cards')
          list.insertBefore(marker, before || list.querySelector('.db-board-more'))
        },
        onDrop: ({ x, y }) => {
          const col = columnAt(x, y)
          clear()
          if (col) drop(row, col, y, el, gp)
        },
        onEnd: clear,
      })
    })
    return el
  }

  function columnAt(x, y) {
    const hit = document.elementFromPoint(x, y)?.closest('.db-board-col')
    if (hit && root.contains(hit)) return hit
    // Between columns or below cards: nearest column horizontally.
    return [...root.querySelectorAll('.db-board-col')].find((c) => { const r = c.getBoundingClientRect(); return x >= r.left - 8 && x <= r.right + 8 }) || null
  }

  function dropPoint(col, y, dragged) {
    const cards = [...col.querySelectorAll('.db-card')].filter((c) => c !== dragged)
    const idx = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2 })
    return { index: idx < 0 ? cards.length : idx, before: idx < 0 ? null : cards[idx] }
  }

  async function drop(row, col, y, el, gp) {
    const key = col.dataset.group
    const group = groups.find((g) => g.key === key)
    if (!group) return
    const { index } = dropPoint(col, y, el)
    const visibleIds = [...col.querySelectorAll('.db-card')].map((c) => c.dataset.rowId).filter((id) => id !== row.id)
    const ids = group.rows.map((r) => r.id).filter((id) => id !== row.id)
    // index is among rendered cards; they are the first cards of the column in order
    const at = index < visibleIds.length ? ids.indexOf(visibleIds[index]) : Math.min(ids.length, visibleIds.length ? ids.indexOf(visibleIds[visibleIds.length - 1]) + 1 : 0)
    ids.splice(at < 0 ? ids.length : at, 0, row.id)
    const moves = []
    const current = typeOf(gp).group.key(getValue(row, gp))
    if (current !== key) moves.push(store.updateValues(row.id, { [gp.id]: groupValue(gp, key) }).catch(() => {}))
    if (!cfg().sorts?.length) moves.push(store.reorderRows(ids))
    await Promise.all(moves)
  }

  async function addCard(gp, key) {
    const row = await ctx.addRow({ [gp.id]: groupValue(gp, key) })
    if (row) ctx.openRow(row.id, { focusTitle: true })
  }

  function refresh() {
    const gp = store.propById.get(cfg().group_by)
    if (!gp || !isGroupable(gp)) {
      const pick = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('board', { size: 14 }), h('span', { class: 'btn-label' }, 'Choose a property'))
      pick.addEventListener('click', () => groupMenu(pick, ctx))
      root.replaceChildren(h('div', { class: 'empty-state db-empty' },
        h('span', { class: 'empty-state-icon' }, icon('board', { size: 22 })),
        h('p', { class: 'empty-state-title' }, 'Group this board'),
        h('p', { class: 'empty-state-text' }, 'Boards group cards by a status, select or checkbox property.'), pick))
      return
    }
    const scrollLeft = root.scrollLeft
    const colScroll = new Map([...root.querySelectorAll('.db-board-col')].map((c) => [c.dataset.group, c.querySelector('.db-board-cards').scrollTop]))
    groups = groupRows(viewRows(store, cfg()), gp)
    const props = cardProps(gp)
    root.replaceChildren(...groups.map((g) => {
      const limit = limits.get(g.key) || PAGE
      const header = h('div', { class: 'db-board-col-head' },
        groupLabel(g, gp),
        h('span', { class: 'db-group-count' }, String(g.rows.length)),
        h('span', { class: 'db-opt-spacer' }),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-board-add-top', title: 'Add a card', 'aria-label': `Add a card to ${g.label}`, onClick: () => addCard(gp, g.key) }, icon('plus', { size: 14 })))
      const cards = h('div', { class: 'db-board-cards' }, g.rows.slice(0, limit).map((r) => card(r, gp, props)),
        g.rows.length > limit ? h('button', { type: 'button', class: 'db-board-more', onClick: () => { limits.set(g.key, limit + PAGE); refresh() } }, `Show ${Math.min(PAGE, g.rows.length - limit)} more`) : null,
        h('button', { type: 'button', class: 'db-board-new', onClick: () => addCard(gp, g.key) }, icon('plus', { size: 14 }), h('span', {}, 'New')))
      const col = h('section', { class: 'db-board-col', dataset: { group: g.key }, 'aria-label': g.label }, header, cards)
      return col
    }))
    root.scrollLeft = scrollLeft
    for (const c of root.querySelectorAll('.db-board-col')) c.querySelector('.db-board-cards').scrollTop = colScroll.get(c.dataset.group) || 0
  }

  refresh()
  return {
    el: root,
    refresh: (change = {}) => { if (!change.notesOnly) refresh() },
    destroy: () => root.remove(),
  }
}
