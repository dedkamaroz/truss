// Calendar view: month grid (weeks start Monday) by a date property; drag items between days.

import { h, popover, formatDate } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import { renderValue, todayIso, monthGrid, monthTitle, WEEKDAYS, isoOf, canCalendar } from './types.js'
import { viewRows } from './query.js'
import { dragGesture } from './drag.js'
import { propertyPicker } from './menus.js'

const MAX_ITEMS = 3
const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000
const addDays = (iso, n) => isoOf(new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n))

export function createCalendarView(host, ctx) {
  const { store } = ctx
  const cfg = () => ctx.view().config
  const root = h('div', { class: 'db-calendar', dataset: { view: 'calendar' } })
  host.append(root)
  const today = todayIso()
  let year = +today.slice(0, 4)
  let month = +today.slice(5, 7) - 1

  const dateProp = () => {
    const p = store.propById.get(cfg().date_property)
    return p && canCalendar(p) ? p : store.properties.find(canCalendar) || null
  }

  function nav(delta) {
    if (delta === 0) {
      year = +today.slice(0, 4)
      month = +today.slice(5, 7) - 1
    } else {
      month += delta
      if (month < 0) (month = 11, year--)
      if (month > 11) (month = 0, year++)
    }
    refresh()
  }

  function item(row, dp, title) {
    const el = h('div', { class: 'db-cal-item', role: 'button', tabindex: '0', dataset: { rowId: row.id } }, title ? renderValue(row, title, store) : 'Untitled')
    el.addEventListener('click', () => ctx.openRow(row.id))
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') (e.preventDefault(), ctx.openRow(row.id))
    })
    el.addEventListener('pointerdown', (e) => {
      const clear = () => { for (const d of root.querySelectorAll('.db-cal-day.is-drop')) d.classList.remove('is-drop') }
      dragGesture(e, {
        source: el,
        onMove: ({ target }) => {
          clear()
          target?.closest('.db-cal-day')?.classList.add('is-drop')
        },
        onDrop: ({ target }) => {
          clear()
          const day = target?.closest('.db-cal-day')?.dataset.date
          const v = store.rowById.get(row.id)?.values[dp.id]
          if (!day || !v || day === v.start) return
          const shift = dayNum(day) - dayNum(v.start)
          store.updateValues(row.id, { [dp.id]: v.end ? { start: day, end: addDays(v.end, shift) } : { start: day } }).catch(() => {})
        },
        onEnd: clear,
      })
    })
    return el
  }

  function refresh() {
    const dp = dateProp()
    if (!dp) {
      const add = h('button', { type: 'button', class: 'btn btn-secondary btn-sm' }, icon('plus', { size: 14 }), h('span', { class: 'btn-label' }, 'Add a date property'))
      add.addEventListener('click', async () => {
        const p = await store.createProperty({ type: 'date', name: 'Date' }).catch(() => null)
        if (p) ctx.setConfig({ date_property: p.id })
      })
      root.replaceChildren(h('div', { class: 'empty-state db-empty' },
        h('span', { class: 'empty-state-icon' }, icon('calendar', { size: 22 })),
        h('p', { class: 'empty-state-title' }, 'No date property'),
        h('p', { class: 'empty-state-text' }, 'Calendars place rows on the days of a date property.'), add))
      return
    }
    const days = monthGrid(year, month)
    const first = days[0]
    const last = days[days.length - 1]
    const byDay = new Map(days.map((d) => [d, []]))
    const title = store.properties.find((p) => p.type === 'title')
    for (const row of viewRows(store, cfg())) {
      const v = row.values[dp.id]
      if (!v?.start || v.start > last || (v.end || v.start) < first) continue
      let d = v.start < first ? first : v.start
      const end = !v.end ? v.start : v.end > last ? last : v.end
      for (let n = 0; d <= end && n < 62; n++, d = addDays(d, 1)) byDay.get(d)?.push(row)
    }
    const inMonth = `${year}-${String(month + 1).padStart(2, '0')}`
    const dateBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm db-cal-prop' }, icon('calendar', { size: 14 }), h('span', { class: 'btn-label' }, dp.name))
    dateBtn.addEventListener('click', () => propertyPicker(dateBtn, {
      title: 'Show calendar by', props: store.properties.filter(canCalendar), current: dp.id,
      onPick: (id) => ctx.setConfig({ date_property: id }),
    }))
    root.replaceChildren(
      h('div', { class: 'db-cal-head' },
        h('h3', { class: 'db-cal-month' }, monthTitle(year, month)),
        h('span', { class: 'db-opt-spacer' }),
        dateBtn,
        h('div', { class: 'db-cal-nav' },
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-cal-prev', title: 'Previous month', 'aria-label': 'Previous month', onClick: () => nav(-1) }, icon('chevron-left', { size: 16 })),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm db-cal-today', onClick: () => nav(0) }, 'Today'),
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-cal-next', title: 'Next month', 'aria-label': 'Next month', onClick: () => nav(1) }, icon('chevron-right', { size: 16 })))),
      h('div', { class: 'db-cal-grid', role: 'grid' },
        WEEKDAYS.map((d) => h('div', { class: 'db-cal-dow', role: 'columnheader' }, d)),
        days.map((iso) => {
          const rows = byDay.get(iso)
          const more = rows.length - MAX_ITEMS
          const cell = h('div', {
            class: `db-cal-day${iso.startsWith(inMonth) ? '' : ' is-outside'}${iso === today ? ' is-today' : ''}`, role: 'gridcell', dataset: { date: iso },
          },
          h('div', { class: 'db-cal-day-head' },
            h('button', { type: 'button', class: 'db-cal-add', title: 'Add to this day', 'aria-label': `Add on ${formatDate(iso)}`, onClick: async () => {
              const row = await ctx.addRow({ [dp.id]: { start: iso } })
              if (row) ctx.openRow(row.id, { focusTitle: true })
            } }, icon('plus', { size: 12 })),
            h('span', { class: 'db-cal-num' }, +iso.slice(8) === 1 ? `${+iso.slice(8)} ${monthTitle(+iso.slice(0, 4), +iso.slice(5, 7) - 1).slice(0, 3)}` : String(+iso.slice(8)))),
          rows.slice(0, more > 0 ? MAX_ITEMS - 1 : MAX_ITEMS).map((r) => item(r, dp, title)),
          more > 0 ? h('button', { type: 'button', class: 'db-cal-more', onClick: (e) => {
            const list = h('div', { class: 'db-cal-more-list' }, rows.map((r) => item(r, dp, title)))
            popover(e.currentTarget, list, { className: 'db-popover' })
          } }, `${more + 1} more`) : null)
          return cell
        })))
  }

  refresh()
  return {
    el: root,
    refresh: (change = {}) => { if (!change.notesOnly) refresh() },
    destroy: () => root.remove(),
  }
}
