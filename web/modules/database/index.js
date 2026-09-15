// Database content type: loads the database, renders view tabs, toolbar, the active view and row peek/page.

import { h, loadCss, menu, promptDialog, confirmDialog, hasOpenLayer, debounce, toast } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import { createStore } from './store.js'
import { createTableView } from './table.js'
import { createBoardView } from './board.js'
import { createCalendarView } from './calendar.js'
import { createListView, createGalleryView } from './cards.js'
import { createRowPanel } from './peek.js'
import { sortMenu, filterMenu, groupMenu, propertiesMenu, propertyPicker } from './menus.js'
import { todayIso, canCover, canCalendar } from './types.js'
import { exportCsv, exportJson, importIntoDatabase, importNewDatabase, pickFile, mountImportPage } from './io.js'

const VIEW_TYPES = {
  table: { label: 'Table', icon: 'table', create: createTableView },
  board: { label: 'Board', icon: 'board', create: createBoardView },
  list: { label: 'List', icon: 'list', create: createListView },
  gallery: { label: 'Gallery', icon: 'gallery', create: createGalleryView },
  calendar: { label: 'Calendar', icon: 'calendar', create: createCalendarView },
}
const CSS_URL = new URL('./database.css', import.meta.url).href
const viewKey = (moduleId) => `truss.db.view.${moduleId}`

function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch {
    return null
  }
}

function countRules(filter) {
  return (filter?.rules || []).reduce((n, r) => n + (r.rules ? countRules(r) : 1), 0)
}

function mount(el, mctx) {
  const { module, api, navigate } = mctx
  const cssReady = loadCss(CSS_URL)
  const root = h('div', { class: 'db-root', dataset: { moduleId: module.id } },
    h('div', { class: 'db-loading' }, h('div', { class: 'list-skeleton' }, [1, 2, 3, 4].map(() => h('span')))))
  el.append(root)

  const store = createStore(api, module.id)
  let destroyed = false
  let viewId = null
  let viewHandle = null
  let peek = null
  let page = null
  let route = mctx.route
  const els = {}

  const view = () => store.views.find((v) => v.id === viewId) || store.views[0]

  const ctx = {
    store,
    view,
    setConfig: (patch) => store.setViewConfig(view().id, patch),
    openRow: (rowId, opts) => openPeek(rowId, opts),
    rowMenu,
    addRow: (values) => {
      const source = store.rowSource()
      if (source) {
        toast(`Rows come from the "${source.name}" list. Add them to its database instead.`)
        return Promise.resolve(null)
      }
      return store.createRow({ values }).catch(() => null)
    },
    openFilter: (propId) => filterMenu(els.filterBtn, ctx, { addFor: propId }),
  }

  /* ---- toolbar */

  function buildChrome() {
    els.tabs = h('div', { class: 'db-tabs', role: 'tablist', 'aria-label': 'Views' })
    els.addView = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-add-view', title: 'Add a view', 'aria-label': 'Add a view' }, icon('plus', { size: 14 }))
    els.addView.addEventListener('click', () => menu(els.addView, [
      { header: 'Add a view' },
      ...Object.entries(VIEW_TYPES).map(([type, t]) => ({
        label: t.label, icon: t.icon,
        onClick: async () => {
          const v = await store.createView({ type, name: t.label }).catch(() => null)
          if (v) switchView(v.id)
        },
      })),
    ]))

    els.search = h('input', { class: 'db-search', type: 'search', placeholder: 'Search', 'aria-label': 'Search rows', spellcheck: 'false' })
    els.searchWrap = h('label', { class: 'db-search-wrap' }, icon('search', { size: 14 }), els.search)
    const saveSearch = debounce(() => ctx.setConfig({ search: els.search.value }), 150)
    els.search.addEventListener('input', saveSearch)
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.search.value) {
        e.preventDefault()
        e.stopPropagation()
        els.search.value = ''
        saveSearch.cancel()
        ctx.setConfig({ search: '' })
      }
    })

    const toolBtn = (label, iconName, onClick, cls) => {
      const b = h('button', { type: 'button', class: `btn btn-ghost btn-sm db-tool ${cls}` }, icon(iconName, { size: 14 }), h('span', { class: 'btn-label' }, label))
      b.addEventListener('click', () => onClick(b))
      return b
    }
    els.filterBtn = toolBtn('Filter', 'filter', (b) => filterMenu(b, ctx), 'db-filter-btn')
    els.sortBtn = toolBtn('Sort', 'sort', (b) => sortMenu(b, ctx), 'db-sort-btn')
    els.groupBtn = toolBtn('Group', 'board', (b) => groupMenu(b, ctx), 'db-group-btn')
    els.coverBtn = toolBtn('Cover', 'image', (b) => propertyPicker(b, {
      title: 'Card cover', props: store.properties.filter(canCover), current: view().config.cover_property === 'none' ? null : view().config.cover_property,
      allowNone: true, noneLabel: 'No cover', onPick: (id) => ctx.setConfig({ cover_property: id || 'none' }),
    }), 'db-cover-btn')
    els.propsBtn = toolBtn('Properties', 'eye', (b) => propertiesMenu(b, ctx), 'db-props-btn')
    els.moreBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon db-tool db-more-btn', title: 'Import and export', 'aria-label': 'Import and export' }, icon('more', { size: 16 }))
    els.moreBtn.addEventListener('click', () => menu(els.moreBtn, [
      { header: 'Export' },
      { label: 'Export this view as CSV', icon: 'download', onClick: () => exportCsv(ctx, 'view') },
      { label: 'Export all rows as CSV', icon: 'download', onClick: () => exportCsv(ctx, 'all') },
      { label: 'Export database as JSON', icon: 'download', onClick: () => exportJson(ctx) },
      'divider',
      { header: 'Import' },
      { label: 'Import CSV into this database', icon: 'upload', disabled: !!store.rowSource(), onClick: async () => { const f = await pickFile('.csv,text/csv'); if (f) importIntoDatabase(ctx, f) } },
      { label: 'Import as a new database', icon: 'upload', onClick: async () => { const f = await pickFile('.csv,.json,text/csv,application/json'); if (f) importNewDatabase(f, { navigate }) } },
    ], { align: 'end' }))
    els.newBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm db-new' }, icon('plus', { size: 14 }), h('span', { class: 'btn-label' }, 'New'))
    els.newBtn.addEventListener('click', async () => {
      const v = view()
      const values = {}
      if (v.type === 'calendar') {
        const dp = store.propById.get(v.config.date_property) || store.properties.find(canCalendar)
        if (dp) values[dp.id] = { start: todayIso() }
      }
      const row = await ctx.addRow(values)
      if (row) openPeek(row.id, { focusTitle: true })
    })

    els.toolbar = h('div', { class: 'db-toolbar' },
      h('div', { class: 'db-tabs-wrap' }, els.tabs, els.addView),
      h('div', { class: 'db-actions' }, els.searchWrap, els.filterBtn, els.sortBtn, els.groupBtn, els.coverBtn, els.propsBtn, els.moreBtn, els.newBtn))
    els.viewHost = h('div', { class: 'db-view-host' })
    els.pageHost = h('div', { class: 'db-page-host', hidden: true })
    root.replaceChildren(els.toolbar, els.viewHost, els.pageHost)
  }

  function renderTabs() {
    els.tabs.replaceChildren(...store.views.map((v) => {
      const t = VIEW_TYPES[v.type] || VIEW_TYPES.table
      const active = v.id === view().id
      const tab = h('button', {
        type: 'button', class: `db-tab${active ? ' is-active' : ''}`, role: 'tab', 'aria-selected': String(active), dataset: { viewId: v.id, type: v.type }, title: v.name,
      }, icon(t.icon, { size: 14 }), h('span', { class: 'db-tab-name' }, v.name), active ? icon('chevron-down', { size: 12, className: 'db-tab-caret' }) : null)
      tab.addEventListener('click', () => (active ? viewMenu(tab, v) : switchView(v.id)))
      tab.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        viewMenu(tab, v)
      })
      return tab
    }))
  }

  function viewMenu(anchor, v) {
    menu(anchor, [
      {
        label: 'Rename', icon: 'edit',
        onClick: async () => {
          const name = await promptDialog({ title: 'Rename view', label: 'View name', value: v.name, confirmLabel: 'Rename' })
          if (name?.trim()) store.renameView(v.id, name.trim())
        },
      },
      {
        label: 'Duplicate', icon: 'copy',
        onClick: async () => {
          store.flush()
          const copy = await store.createView({ type: v.type, name: `${v.name} copy`, config: JSON.parse(JSON.stringify(v.config)) }).catch(() => null)
          if (copy) switchView(copy.id)
        },
      },
      'divider',
      {
        label: 'Delete', icon: 'trash', danger: true, disabled: store.views.length <= 1,
        onClick: async () => {
          if (await confirmDialog({ title: `Delete the "${v.name}" view?`, message: 'Rows are not affected.', confirmLabel: 'Delete view', danger: true })) {
            await store.deleteView(v.id)
          }
        },
      },
    ])
  }

  function renderToolbarState() {
    const v = view()
    const c = v.config
    const filters = countRules(c.filter)
    const sorts = (c.sorts || []).filter((s) => store.propById.has(s.property)).length
    setCount(els.filterBtn, 'Filter', filters)
    setCount(els.sortBtn, 'Sort', sorts)
    const gp = store.propById.get(c.group_by)
    els.groupBtn.hidden = !(v.type === 'table' || v.type === 'board')
    els.groupBtn.classList.toggle('is-active', !!gp)
    els.groupBtn.querySelector('.btn-label').textContent = gp ? `Group: ${gp.name}` : 'Group'
    els.coverBtn.hidden = v.type !== 'gallery'
    if (document.activeElement !== els.search) els.search.value = c.search || ''
    els.searchWrap.classList.toggle('is-active', !!c.search)
    root.classList.toggle('is-rows-locked', !!store.rowSource())
    const hidden = (c.hidden || []).filter((id) => store.propById.has(id)).length
    els.propsBtn.classList.toggle('is-active', hidden > 0)
  }

  function setCount(btn, label, n) {
    btn.classList.toggle('is-active', n > 0)
    btn.querySelector('.btn-label').textContent = n ? `${label} (${n})` : label
  }

  /* ---- views */

  function switchView(id) {
    if (!store.views.some((v) => v.id === id)) id = store.views[0].id
    viewId = id
    remember(viewKey(module.id), id)
    viewHandle?.destroy()
    els.viewHost.replaceChildren()
    const v = view()
    els.viewHost.dataset.viewType = v.type
    viewHandle = (VIEW_TYPES[v.type] || VIEW_TYPES.table).create(els.viewHost, ctx)
    renderTabs()
    renderToolbarState()
  }

  /* ---- rows: peek, page, menu */

  function openPeek(rowId, opts = {}) {
    if (!store.rowById.has(rowId)) return
    if (page) return
    closePeek()
    peek = createRowPanel(ctx, rowId, {
      mode: 'peek', focusTitle: opts.focusTitle,
      onClose: closePeek,
      onOpenPage: () => navigate(`#/m/${encodeURIComponent(module.id)}/r/${encodeURIComponent(rowId)}`),
    })
    root.append(peek.el)
    root.classList.add('has-peek')
    for (const r of root.querySelectorAll('.is-peeked')) r.classList.remove('is-peeked')
  }

  function closePeek() {
    if (!peek) return
    peek.destroy()
    peek = null
    root.classList.remove('has-peek')
  }

  function rowMenu(anchor, rowId, { inPanel } = {}) {
    menu(anchor, [
      !inPanel ? { label: 'Open in side peek', icon: 'sidebar', onClick: () => openPeek(rowId) } : null,
      !page ? { label: 'Open as page', icon: 'external-link', onClick: () => navigate(`#/m/${encodeURIComponent(module.id)}/r/${encodeURIComponent(rowId)}`) } : null,
      'divider',
      {
        label: 'Delete row', icon: 'trash', danger: true,
        onClick: async () => {
          if (!(await confirmDialog({ title: 'Delete this row?', message: 'Its values, notes and files will be removed. This cannot be undone.', confirmLabel: 'Delete', danger: true }))) return
          if (peek?.rowId === rowId) closePeek()
          const wasPage = page?.rowId === rowId
          await store.deleteRows([rowId])
          toast('Row deleted', { type: 'success' })
          if (wasPage) navigate(`#/m/${encodeURIComponent(module.id)}`)
        },
      },
    ], { align: 'end' })
  }

  function applyRoute(r) {
    route = r
    const sub = r?.sub || []
    if (sub[0] === 'r' && sub[1]) {
      closePeek()
      page?.destroy()
      if (!store.rowById.has(sub[1])) {
        page = null
        els.pageHost.replaceChildren(h('div', { class: 'empty-state db-empty' },
          h('span', { class: 'empty-state-icon' }, icon('search', { size: 22 })),
          h('p', { class: 'empty-state-title' }, 'Row not found'),
          h('p', { class: 'empty-state-text' }, 'It may have been deleted.'),
          h('a', { class: 'btn btn-secondary btn-sm', href: `#/m/${encodeURIComponent(module.id)}` }, 'Back to the database')))
      } else {
        page = createRowPanel(ctx, sub[1], { mode: 'page', onBack: () => navigate(`#/m/${encodeURIComponent(module.id)}`), onClose: () => navigate(`#/m/${encodeURIComponent(module.id)}`) })
        els.pageHost.replaceChildren(page.el)
      }
      els.pageHost.hidden = false
      els.toolbar.hidden = true
      els.viewHost.hidden = true
      root.classList.add('is-row-page')
    } else if (page || !els.pageHost.hidden) {
      page?.destroy()
      page = null
      els.pageHost.hidden = true
      els.pageHost.replaceChildren()
      els.toolbar.hidden = false
      els.viewHost.hidden = false
      root.classList.remove('is-row-page')
      viewHandle?.refresh({ kind: 'rows' })
    }
  }

  /* ---- store events */

  const unsubscribe = store.on((change) => {
    if (destroyed || !viewHandle) return
    if (change.kind === 'views') {
      if (!store.views.some((v) => v.id === viewId)) return switchView(store.views[0].id)
      renderTabs()
      renderToolbarState()
      return
    }
    if (change.kind === 'config') {
      if (change.viewId !== view().id) return
      renderToolbarState()
    }
    if (change.kind === 'schema') renderToolbarState()
    viewHandle.refresh(change)
    peek?.refresh(change)
    page?.refresh(change)
  })

  /* ---- peek dismissal */

  const onKey = (e) => {
    if (e.key !== 'Escape' || !peek || e.defaultPrevented || hasOpenLayer()) return
    const t = e.target
    if (t.closest?.('.db-inline-input')) return
    closePeek()
  }
  const onPointer = (e) => {
    if (!peek || hasOpenLayer()) return
    const t = e.target
    if (peek.el.contains(t) || t.closest?.('.popover, .modal-backdrop, .toast-region, .db-card, .db-list-row, .db-gallery-card, .db-cal-item, .db-open-btn, .db-row-menu, .db-new')) return
    if (!root.contains(t)) return
    closePeek()
  }
  document.addEventListener('keydown', onKey)
  document.addEventListener('mousedown', onPointer, true)

  /* ---- boot */

  Promise.all([store.load(), cssReady]).then(() => {
    if (destroyed) return
    buildChrome()
    const saved = remember(viewKey(module.id))
    switchView(store.views.some((v) => v.id === saved) ? saved : store.views[0].id)
    applyRoute(route)
    root.dataset.ready = 'true'
    performance.mark('truss:database-ready')
  }).catch((err) => {
    if (destroyed) return
    console.warn('[database] load failed', err)
    root.replaceChildren(h('div', { class: 'empty-state db-empty' },
      h('span', { class: 'empty-state-icon' }, icon('alert', { size: 22 })),
      h('p', { class: 'empty-state-title' }, 'Could not open this database'),
      h('p', { class: 'empty-state-text' }, err?.message || 'An unexpected error occurred.')))
  })

  return {
    unmount() {
      destroyed = true
      store.flush()
      unsubscribe()
      store.destroy()
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer, true)
      closePeek()
      page?.destroy()
      viewHandle?.destroy()
      root.remove()
    },
    onRoute(r) {
      if (els.toolbar) applyRoute(r)
      else route = r
    },
  }
}

// No `label`: the shell already names this type "Database", and declaring one makes the shell
// re-render the whole sidebar once modules load (which drops keyboard focus mid-interaction).
export default {
  type: 'database',
  icon: 'database',
  mount,
  init({ registry }) {
    registry.registerRoute('/import', {
      title: 'Import',
      mount: (el, rctx) => {
        loadCss(CSS_URL)
        return mountImportPage(el, rctx)
      },
    })
    registry.registerSidebarItem({ id: 'database-import', label: 'Import', icon: 'upload', href: '#/import' })
  },
}
