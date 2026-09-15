// Schema and view configuration menus: type picker, property menu, sort, filter, group and properties.

import { h, popover, menu, confirmDialog, formatDate } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import { TYPES, typeOf, glyph, propIcon, parseDateInput, filtersOf } from './types.js'
import { isGroupable } from './query.js'
import { dragGesture } from './drag.js'
import { keepInView } from './fit.js'

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))

function item(label, iconEl, onClick, { danger, trailing, cls = '' } = {}) {
  return h('button', { type: 'button', class: `menu-item${danger ? ' is-danger' : ''} ${cls}`.trim(), onClick },
    h('span', { class: 'menu-item-icon' }, iconEl), h('span', { class: 'menu-item-label' }, label), trailing || null)
}

function nativeSelect(options, value, onChange, attrs = {}) {
  const sel = h('select', { class: 'db-select', ...attrs, onChange: () => onChange(sel.value) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)))
  sel.value = value ?? ''
  return sel
}

/* ------------------------------------------------------------------ type picker */

export function typePicker(anchor, { title = 'Property type', current, store, onPick } = {}) {
  let pop
  const list = h('div', { class: 'menu db-type-list', role: 'menu' },
    h('div', { class: 'menu-header' }, title),
    Object.entries(TYPES).filter(([k]) => k !== 'title').map(([key, t]) => {
      const b = item(t.label, glyph(t.icon, 16), async () => {
        pop.close()
        if (!t.setup || key === current || !store) return onPick(key)
        const config = await t.setup({ store })
        if (config) onPick(key, config)
      }, { trailing: key === current ? icon('check', { size: 14 }) : null, cls: 'db-type-item' })
      b.dataset.type = key
      return b
    }))
  pop = popover(anchor, list, { className: 'popover-menu db-popover' })
  list.querySelector('.menu-item')?.focus({ preventScroll: true })
  return pop
}

/* ------------------------------------------------------------------ property header menu */

export function propertyMenu(anchor, prop, ctx, { focusName = false } = {}) {
  const { store } = ctx
  const t = typeOf(prop)
  const name = h('input', { class: 'input input-sm db-prop-name', type: 'text', value: prop.name, 'aria-label': 'Property name', spellcheck: 'false' })
  let pop
  const rename = () => {
    const v = name.value.trim()
    const cur = store.propById.get(prop.id)
    if (cur && v && v !== cur.name) store.updateProperty(prop.id, { name: v }).catch(() => {})
  }
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.preventDefault(), pop.close())
  })
  const view = ctx.view()
  const hidden = new Set(view.config.hidden || [])
  const rows = [h('div', { class: 'db-prop-menu-name' }, name)]
  if (prop.type !== 'title') {
    const typeBtn = item('Type', glyph(t.icon, 16), () => typePicker(typeBtn, {
      title: 'Change type', current: prop.type, store,
      onPick: (type, config) => {
        pop.close()
        if (type !== prop.type) store.updateProperty(prop.id, config ? { type, config } : { type }).catch(() => {})
      },
    }), { trailing: h('span', { class: 'db-menu-value' }, t.label, icon('chevron-right', { size: 12 })), cls: 'db-prop-type' })
    rows.push(typeBtn)
  }
  if (t.formats) {
    const fmt = t.formats.find((f) => f.key === prop.config.format) || t.formats[0]
    const fmtBtn = item('Format', glyph(t.icon, 16), () => menu(fmtBtn, t.formats.map((f) => ({
      label: f.label, icon: f.key === fmt.key ? 'check' : undefined,
      onClick: () => store.updateProperty(prop.id, { config: { ...prop.config, format: f.key } }).catch(() => {}),
    }))), { trailing: h('span', { class: 'db-menu-value' }, fmt.label, icon('chevron-right', { size: 12 })), cls: 'db-number-format' })
    rows.push(fmtBtn)
  }
  for (const mi of t.menuItems?.(prop, ctx) || []) {
    rows.push(item(mi.label, glyph(t.icon, 16), () => {
      pop.close()
      mi.onClick()
    }, { trailing: h('span', { class: 'db-menu-value' }, mi.value || '', icon('chevron-right', { size: 12 })), cls: mi.cls }))
  }
  rows.push(h('div', { class: 'menu-divider' }))
  const sortBy = (direction) => () => {
    pop.close()
    ctx.setConfig({ sorts: [{ property: prop.id, direction }] })
  }
  rows.push(item('Sort ascending', icon('sort', { size: 16 }), sortBy('asc')))
  rows.push(item('Sort descending', icon('sort', { size: 16 }), sortBy('desc')))
  rows.push(item('Filter', icon('filter', { size: 16 }), () => {
    pop.close()
    ctx.openFilter(prop.id)
  }))
  if (isGroupable(prop) && view.type === 'table') {
    rows.push(item(view.config.group_by === prop.id ? 'Remove grouping' : 'Group by this property', icon('board', { size: 16 }), () => {
      pop.close()
      ctx.setConfig({ group_by: view.config.group_by === prop.id ? null : prop.id, collapsed: [] })
    }))
  }
  if (prop.type !== 'title') {
    rows.push(item('Hide in view', icon('eye-off', { size: 16 }), () => {
      pop.close()
      ctx.setConfig({ hidden: [...hidden, prop.id] })
    }))
    rows.push(h('div', { class: 'menu-divider' }))
    rows.push(item('Delete property', icon('trash', { size: 16 }), async () => {
      pop.close()
      const ok = await confirmDialog({ title: `Delete "${prop.name}"?`, message: t.deleteMessage?.(prop, store) || 'Its values will be removed from every row. This cannot be undone.', confirmLabel: 'Delete', danger: true })
      if (ok) store.deleteProperty(prop.id)
    }, { danger: true }))
  }
  pop = popover(anchor, h('div', { class: 'menu db-prop-menu', role: 'menu' }, rows), { className: 'popover-menu db-popover', onClose: rename })
  if (focusName) {
    name.focus()
    name.select()
  } else name.focus({ preventScroll: true })
  return pop
}

/* ------------------------------------------------------------------ sort */

export function sortMenu(anchor, ctx) {
  const { store } = ctx
  let sorts = clone(ctx.view().config.sorts) || []
  const root = h('div', { class: 'db-config-menu db-sort-menu' })
  const save = () => ctx.setConfig({ sorts: clone(sorts) })
  const propOptions = () => store.properties.map((p) => ({ value: p.id, label: p.name }))
  function render() {
    const rows = sorts.map((s, i) => h('div', { class: 'db-config-row db-sort-row' },
      h('span', { class: 'db-config-handle' }, icon('sort', { size: 14 })),
      nativeSelect(propOptions(), s.property, (v) => { s.property = v; save() }, { 'aria-label': `Sort ${i + 1} property` }),
      nativeSelect([{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], s.direction, (v) => { s.direction = v; save() }, { 'aria-label': `Sort ${i + 1} direction` }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon', title: 'Remove sort', 'aria-label': 'Remove sort', onClick: () => { sorts.splice(i, 1); save(); render() } }, icon('close', { size: 14 }))))
    const used = new Set(sorts.map((s) => s.property))
    const next = store.properties.find((p) => !used.has(p.id))
    root.replaceChildren(
      rows.length ? h('div', { class: 'db-config-rows' }, rows) : h('div', { class: 'db-config-empty' }, 'No sorts applied. Rows keep their manual order.'),
      h('div', { class: 'db-config-foot' },
        next ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm db-add-sort', onClick: () => { sorts.push({ property: next.id, direction: 'asc' }); save(); render() } }, icon('plus', { size: 14 }), h('span', { class: 'btn-label' }, 'Add sort')) : null,
        sorts.length ? h('button', { type: 'button', class: 'btn btn-danger-ghost btn-sm', onClick: () => { sorts = []; save(); render() } }, icon('trash', { size: 14 }), h('span', { class: 'btn-label' }, 'Delete sorts')) : null))
  }
  if (!sorts.length && store.properties[0]) {
    sorts.push({ property: store.properties[0].id, direction: 'asc' })
    save()
  }
  render()
  const pop = popover(anchor, root, { className: 'db-popover' })
  keepInView(pop.el)
  return pop
}

/* ------------------------------------------------------------------ filter */

function defaultRule(prop) {
  const ops = Object.keys(filtersOf(prop))
  return { property: prop.id, operator: ops[0], value: '' }
}

export function filterMenu(anchor, ctx, { addFor } = {}) {
  const { store } = ctx
  const filter = clone(ctx.view().config.filter) || { op: 'and', rules: [] }
  filter.op ||= 'and'
  filter.rules ||= []
  const root = h('div', { class: 'db-config-menu db-filter-menu' })
  const save = () => ctx.setConfig({ filter: clone(filter) })
  const first = store.propById.get(addFor) || store.properties[0]
  if ((addFor || !filter.rules.length) && first) {
    filter.rules.push(defaultRule(first))
    save()
  }

  function valueInput(rule, prop, op) {
    const set = (v) => { rule.value = v; save() }
    if (!op || op.input === 'none') return h('span', { class: 'db-filter-novalue' })
    if (op.input === 'option') {
      return nativeSelect([{ value: '', label: 'Select an option' }, ...(prop.config.options || []).map((o) => ({ value: o.id, label: o.name }))], rule.value, set, { 'aria-label': 'Filter value' })
    }
    if (op.input === 'date') {
      const input = h('input', { class: 'input input-sm db-filter-value', type: 'text', placeholder: 'DD/MM/YYYY', value: rule.value ? formatDate(rule.value) : '', 'aria-label': 'Filter value' })
      const commit = () => {
        const iso = parseDateInput(input.value)
        input.classList.toggle('is-invalid', !!input.value.trim() && !iso)
        if (iso || !input.value.trim()) set(iso || '')
      }
      input.addEventListener('input', commit)
      return input
    }
    const input = h('input', { class: 'input input-sm db-filter-value', type: op.input === 'number' ? 'number' : 'text', placeholder: 'Value', value: rule.value ?? '', 'aria-label': 'Filter value' })
    input.addEventListener('input', () => set(op.input === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value))
    return input
  }

  function conj(group, i) {
    if (i === 0) return h('span', { class: 'db-filter-conj' }, 'Where')
    if (i === 1) return nativeSelect([{ value: 'and', label: 'And' }, { value: 'or', label: 'Or' }], group.op, (v) => { group.op = v; save(); render() }, { class: 'db-select db-filter-op-select', 'aria-label': 'Combine filters with' })
    return h('span', { class: 'db-filter-conj' }, group.op === 'or' ? 'Or' : 'And')
  }

  function renderGroup(group, depth) {
    const rows = group.rules.map((rule, i) => {
      const remove = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon', title: 'Remove', 'aria-label': 'Remove filter', onClick: () => { group.rules.splice(i, 1); save(); render() } }, icon('close', { size: 14 }))
      if (rule.rules) {
        return h('div', { class: 'db-config-row db-filter-row' }, conj(group, i), h('div', { class: 'db-filter-group' }, renderGroup(rule, depth + 1)), remove)
      }
      const prop = store.propById.get(rule.property) || store.properties[0]
      const ops = filtersOf(prop)
      const op = ops[rule.operator]
      return h('div', { class: 'db-config-row db-filter-row', dataset: { type: prop.type } },
        conj(group, i),
        nativeSelect(store.properties.map((p) => ({ value: p.id, label: p.name })), prop.id, (v) => {
          Object.assign(rule, defaultRule(store.propById.get(v)))
          save()
          render()
        }, { 'aria-label': 'Filter property' }),
        nativeSelect(Object.entries(ops).map(([k, o]) => ({ value: k, label: o.label })), rule.operator, (v) => {
          const before = ops[rule.operator]?.input
          rule.operator = v
          if (ops[v].input !== before) rule.value = ''
          save()
          render()
        }, { 'aria-label': 'Filter operator' }),
        valueInput(rule, prop, op),
        remove)
    })
    const addRule = () => {
      if (!store.properties[0]) return
      group.rules.push(defaultRule(store.properties[0]))
      save()
      render()
    }
    return h('div', { class: 'db-filter-rules', dataset: { depth } },
      rows.length ? rows : h('div', { class: 'db-config-empty' }, depth ? 'Empty group' : 'No filters applied'),
      h('div', { class: 'db-config-foot' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm db-add-filter', onClick: addRule }, icon('plus', { size: 14 }), h('span', { class: 'btn-label' }, 'Add filter')),
        depth === 0 ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm db-add-filter-group', onClick: () => {
          group.rules.push({ op: group.op === 'or' ? 'and' : 'or', rules: store.properties[0] ? [defaultRule(store.properties[0])] : [] })
          save()
          render()
        } }, icon('plus', { size: 14 }), h('span', { class: 'btn-label' }, 'Add filter group')) : null))
  }

  function render() {
    const focused = document.activeElement
    const path = focused && root.contains(focused) ? [...root.querySelectorAll('input, select')].indexOf(focused) : -1
    root.replaceChildren(renderGroup(filter, 0))
    if (path >= 0) root.querySelectorAll('input, select')[path]?.focus({ preventScroll: true })
  }
  render()
  const pop = popover(anchor, root, { className: 'db-popover' })
  keepInView(pop.el)
  root.querySelector('.db-filter-value, select')?.focus({ preventScroll: true })
  return pop
}

/* ------------------------------------------------------------------ group, layout pickers */

export function propertyPicker(anchor, { title, props, current, allowNone, noneLabel = 'None', onPick }) {
  return menu(anchor, [
    { header: title },
    ...(allowNone ? [{ label: noneLabel, icon: current ? undefined : 'check', onClick: () => onPick(null) }] : []),
    ...props.map((p) => ({ label: p.name, icon: p.id === current ? 'check' : undefined, onClick: () => onPick(p.id) })),
  ])
}

export function groupMenu(anchor, ctx) {
  const view = ctx.view()
  const props = ctx.store.properties.filter(isGroupable)
  return propertyPicker(anchor, {
    title: 'Group by', props, current: view.config.group_by, allowNone: view.type !== 'board',
    onPick: (id) => ctx.setConfig({ group_by: id, collapsed: [] }),
  })
}

/* ------------------------------------------------------------------ properties (visibility and order) */

export function propertiesMenu(anchor, ctx) {
  const { store } = ctx
  const root = h('div', { class: 'db-config-menu db-props-menu' })
  function render() {
    const hidden = new Set(ctx.view().config.hidden || [])
    const list = h('div', { class: 'db-props-list' })
    for (const p of store.properties) {
      const isHidden = hidden.has(p.id) && p.type !== 'title'
      const toggle = h('button', {
        type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-prop-toggle', disabled: p.type === 'title',
        title: p.type === 'title' ? 'The title is always shown' : isHidden ? 'Show' : 'Hide', 'aria-label': `${isHidden ? 'Show' : 'Hide'} ${p.name}`, 'aria-pressed': String(!isHidden),
        onClick: () => {
          const next = new Set(ctx.view().config.hidden || [])
          if (next.has(p.id)) next.delete(p.id)
          else next.add(p.id)
          ctx.setConfig({ hidden: [...next] })
          render()
        },
      }, icon(isHidden ? 'eye-off' : 'eye', { size: 14 }))
      const handle = h('span', { class: 'db-config-handle db-drag-handle', title: 'Drag to reorder' }, icon('drag', { size: 14 }))
      const row = h('div', { class: `db-props-row${isHidden ? ' is-hidden' : ''}`, dataset: { prop: p.id } }, handle, h('span', { class: 'db-props-icon' }, propIcon(p, 14)), h('span', { class: 'db-props-name' }, p.name), toggle)
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        dragGesture(e, {
          source: row, axis: 'y',
          onMove: ({ y }) => {
            for (const r of list.children) r.classList.remove('drop-before', 'drop-after')
            const target = [...list.children].find((r) => { const b = r.getBoundingClientRect(); return y < b.bottom })
            if (target && target !== row) target.classList.add(y < target.getBoundingClientRect().top + target.offsetHeight / 2 ? 'drop-before' : 'drop-after')
          },
          onDrop: ({ y }) => {
            const ids = store.properties.map((x) => x.id).filter((id) => id !== p.id)
            const rows = [...list.children].filter((r) => r !== row)
            let idx = rows.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2 })
            if (idx < 0) idx = rows.length
            ids.splice(idx, 0, p.id)
            store.reorderProperties(ids).then(render)
            render()
          },
          onEnd: () => { for (const r of list.children) r.classList.remove('drop-before', 'drop-after') },
        })
      })
      list.append(row)
    }
    const anyHidden = store.properties.some((p) => hidden.has(p.id) && p.type !== 'title')
    root.replaceChildren(
      h('div', { class: 'db-props-head' }, h('span', { class: 'menu-header' }, 'Properties'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => {
          ctx.setConfig({ hidden: anyHidden ? [] : store.properties.filter((p) => p.type !== 'title').map((p) => p.id) })
          render()
        } }, anyHidden ? 'Show all' : 'Hide all')),
      list)
  }
  render()
  const pop = popover(anchor, root, { className: 'db-popover' })
  keepInView(pop.el)
  return pop
}
