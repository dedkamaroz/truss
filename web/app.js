// Truss shell: layout, hash router, sidebar, module loading and mounting.

import api, { probeUrls } from './lib/api.js'
import ui, { h, button, toast, menu, modal, confirmDialog, emojiPicker, formatDate, formatDateTime, formatRelative } from './lib/ui.js'
import { icon, hasIcon } from './lib/icons.js'
import registry from './lib/registry.js'

const MODULE_FILES = ['database', 'sheet', 'notebook', 'scripts'].map((n) => new URL(`./modules/${n}/index.js`, import.meta.url).href)
const TYPE_ORDER = ['database', 'sheet', 'notebook']
const TYPE_INFO = {
  database: { label: 'Database', plural: 'Databases', icon: 'database', blurb: 'Track structured data with tables, boards and calendars.' },
  sheet: { label: 'Workbook', plural: 'Workbooks', icon: 'sheet', blurb: 'Crunch numbers in a spreadsheet with formulas.' },
  notebook: { label: 'Notebook', plural: 'Notebooks', icon: 'notebook', blurb: 'Write nested pages of notes and documents.' },
}
const THEME_KEY = 'truss.theme'
const SIDEBAR_KEY = 'truss.sidebarCollapsed'

const state = {
  modules: [], // active modules, server order
  byId: new Map(),
  templates: null,
  types: new Map(), // type -> content type export
  typesLoaded: false,
  typesReady: null,
  current: null, // { key, kind, el, handle, moduleId, route }
  collapsedGroups: new Set(),
  loadError: null,
}
const els = {}
let routeSeq = 0

/* ------------------------------------------------------------------ storage + theme */

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch {
    return null
  }
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  if (els.themeToggle) {
    const dark = theme === 'dark'
    els.themeToggle.replaceChildren(icon(dark ? 'sun' : 'moon', { size: 16 }), h('span', { class: 'sidebar-link-label' }, dark ? 'Light mode' : 'Dark mode'))
    els.themeToggle.setAttribute('aria-pressed', String(dark))
    els.themeToggle.title = dark ? 'Switch to light theme' : 'Switch to dark theme'
  }
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark'
  store(THEME_KEY, next)
  applyTheme(next)
}

applyTheme(store(THEME_KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))

/* ------------------------------------------------------------------ helpers */

const typeInfo = (type) => {
  const base = TYPE_INFO[type] || { label: type, plural: type, icon: 'file', blurb: '' }
  const loaded = state.types.get(type)
  return loaded?.label ? { ...base, label: loaded.label } : base
}

function moduleIcon(module, size = 16) {
  if (module?.icon) return h('span', { class: 'emoji', style: { fontSize: `${Math.round(size * 0.95)}px` } }, module.icon)
  const t = typeInfo(module?.type)
  return icon(hasIcon(t.icon) ? t.icon : 'file', { size })
}

const moduleHref = (id) => `#/m/${encodeURIComponent(id)}`
const safeCall = (fn, ...args) => {
  try {
    return fn?.(...args)
  } catch (err) {
    console.warn('[truss] module callback failed:', err)
  }
}

function navigate(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash.startsWith('/') ? '' : '/'}${hash}`
  if (location.hash === target) route()
  else location.hash = target
}

function reportError(err, fallback = 'Something went wrong') {
  console.warn('[truss]', err)
  toast(err?.message || fallback, { type: 'error' })
}

/* ------------------------------------------------------------------ module state */

function setModules(list) {
  state.modules = list
  state.byId = new Map(list.map((m) => [m.id, m]))
}

function upsertModule(m) {
  const i = state.modules.findIndex((x) => x.id === m.id)
  if (m.archived_at) {
    if (i >= 0) state.modules.splice(i, 1)
    state.byId.delete(m.id)
  } else {
    if (i >= 0) state.modules[i] = m
    else state.modules.push(m)
    state.byId.set(m.id, m)
  }
}

function removeModule(id) {
  const i = state.modules.findIndex((x) => x.id === id)
  if (i >= 0) state.modules.splice(i, 1)
  state.byId.delete(id)
}

function changed(action, module) {
  registry.emit('modules:changed', { source: 'shell', action, module, moduleId: module?.id })
}

async function refreshModules() {
  try {
    setModules(await api.get('/api/modules'))
    renderSidebarModules()
    if (state.current?.kind === 'home') route(true)
  } catch (err) {
    console.warn('[truss] could not refresh modules', err)
  }
}

/** Applies a local change immediately, persists it, then reconciles with the server copy. */
async function saveModule(id, patch) {
  const before = state.byId.get(id) || (state.current?.module?.id === id ? state.current.module : null)
  if (before) applyModuleUpdate({ ...before, ...patch })
  try {
    const saved = await api.patch(`/api/modules/${encodeURIComponent(id)}`, patch)
    applyModuleUpdate(saved)
    changed('update', saved)
    return saved
  } catch (err) {
    if (before) applyModuleUpdate(before)
    reportError(err, 'Could not save changes')
    return null
  }
}

function applyModuleUpdate(m) {
  if (state.byId.has(m.id)) upsertModule(m)
  updateSidebarItem(m)
  const cur = state.current
  if (cur?.kind === 'module' && cur.moduleId === m.id) {
    cur.module = m
    updatePageHeader(m)
    renderBreadcrumb()
    safeCall(cur.handle?.onModuleChange, m)
  }
}

async function createModule(type, template = 'blank') {
  const tpl = state.templates?.find((t) => t.type === type && t.key === template)
  // The server makes the title unique ("Monthly budget 2").
  const m = await api.post('/api/modules', { type, template, title: template === 'blank' || !tpl ? undefined : tpl.name })
  upsertModule(m)
  renderSidebarModules()
  changed('create', m)
  navigate(moduleHref(m.id))
  return m
}

async function archiveModule(m) {
  try {
    const saved = await api.post(`/api/modules/${encodeURIComponent(m.id)}/archive`)
    removeModule(m.id)
    renderSidebarModules()
    changed('archive', saved)
    toast(`Moved "${m.title}" to the archive`, { type: 'success' })
    if (state.current?.moduleId === m.id) navigate('#/')
    else if (state.current?.kind === 'home' || state.current?.kind === 'archive') route(true)
  } catch (err) {
    reportError(err, 'Could not archive')
  }
}

async function restoreModule(m) {
  try {
    const saved = await api.post(`/api/modules/${encodeURIComponent(m.id)}/restore`)
    upsertModule(saved)
    state.modules.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    renderSidebarModules()
    changed('restore', saved)
    toast(`Restored "${saved.title}"`, { type: 'success' })
    return saved
  } catch (err) {
    reportError(err, 'Could not restore')
    return null
  }
}

async function deleteModule(m) {
  const ok = await confirmDialog({
    title: `Delete "${m.title}" permanently?`,
    message: `This ${typeInfo(m.type).label.toLowerCase()} and all of its attachments will be removed from disk. This cannot be undone.`,
    confirmLabel: 'Delete permanently',
    danger: true,
  })
  if (!ok) return false
  try {
    await api.del(`/api/modules/${encodeURIComponent(m.id)}`)
    removeModule(m.id)
    renderSidebarModules()
    changed('delete', m)
    toast(`Deleted "${m.title}"`, { type: 'success' })
    if (state.current?.moduleId === m.id) navigate('#/')
    return true
  } catch (err) {
    reportError(err, 'Could not delete')
    return false
  }
}

async function changeIcon(m, anchor) {
  const value = await emojiPicker(anchor, { allowRemove: !!m.icon })
  if (value === null) return
  await saveModule(m.id, { icon: value || null })
}

function moduleMenu(m, anchor, { align } = {}) {
  return menu(anchor, [
    { label: 'Rename', icon: 'edit', onClick: () => startRename(m.id) },
    { label: 'Change icon', icon: 'smile', onClick: () => changeIcon(state.byId.get(m.id) || m, itemEls.get(m.id) || anchor) },
    'divider',
    { label: 'Archive', icon: 'archive', onClick: () => archiveModule(m) },
    { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteModule(m) },
  ], { align })
}

/* ------------------------------------------------------------------ layout */

function buildLayout() {
  els.newButton = button('New', { variant: 'primary', iconName: 'plus', class: 'btn btn-primary sidebar-new', onClick: () => openTemplatePicker(), title: 'Create a database, workbook or notebook' })
  els.themeToggle = h('button', { type: 'button', class: 'sidebar-link theme-toggle', onClick: toggleTheme })
  applyTheme(currentTheme())
  els.searchButton = h('button', { type: 'button', class: 'sidebar-link', onClick: openQuickSwitcher },
    icon('search'), h('span', { class: 'sidebar-link-label' }, 'Search'), h('kbd', { class: 'kbd' }, 'Ctrl K'))
  els.homeLink = h('a', { class: 'sidebar-link', href: '#/', dataset: { nav: 'home' } }, icon('home'), h('span', { class: 'sidebar-link-label' }, 'Home'))
  els.archiveLink = h('a', { class: 'sidebar-link', href: '#/archive', dataset: { nav: 'archive' } }, icon('archive'), h('span', { class: 'sidebar-link-label' }, 'Archive'))
  els.extraLinks = h('div', { class: 'sidebar-extra' })
  els.groups = h('div', { class: 'sidebar-groups' }, h('div', { class: 'sidebar-skeleton' }, [1, 2, 3, 4, 5].map(() => h('span'))))

  els.sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Sidebar' },
    h('div', { class: 'sidebar-header' },
      h('a', { class: 'brand', href: '#/', 'aria-label': 'Truss home' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, 'T'), h('span', { class: 'brand-name' }, 'Truss')),
      button('', { variant: 'ghost', size: 'sm', iconName: 'chevrons-left', title: 'Collapse sidebar (Ctrl+\\)', class: 'btn btn-ghost btn-sm btn-icon sidebar-collapse', onClick: () => setSidebarCollapsed(true) })),
    h('div', { class: 'sidebar-actions' }, els.newButton),
    h('nav', { class: 'sidebar-nav', 'aria-label': 'Workspace' }, els.searchButton, els.homeLink, els.archiveLink, els.extraLinks),
    h('div', { class: 'sidebar-scroll' }, els.groups),
    h('div', { class: 'sidebar-footer' }, els.themeToggle))

  els.expandButton = button('', { variant: 'ghost', size: 'sm', iconName: 'sidebar', title: 'Show sidebar (Ctrl+\\)', class: 'btn btn-ghost btn-sm btn-icon topbar-expand', onClick: () => setSidebarCollapsed(false) })
  els.breadcrumb = h('nav', { class: 'breadcrumb', 'aria-label': 'Breadcrumb' })
  els.topbarMeta = h('div', { class: 'topbar-meta' })
  els.topbarActions = h('div', { class: 'topbar-actions' })
  els.view = h('div', { class: 'view-host', id: 'view' })
  els.main = h('main', { class: 'main' },
    h('header', { class: 'topbar' }, els.expandButton, els.breadcrumb, h('div', { class: 'topbar-spacer' }), els.topbarMeta, els.topbarActions),
    els.view)

  els.app = document.getElementById('app')
  els.app.className = 'app'
  els.app.removeAttribute('aria-busy')
  els.app.replaceChildren(els.sidebar, els.main)
  setSidebarCollapsed(store(SIDEBAR_KEY) === '1', false)
}

function setSidebarCollapsed(collapsed, persist = true) {
  els.app.classList.toggle('is-sidebar-collapsed', collapsed)
  els.sidebar.inert = collapsed
  if (persist) store(SIDEBAR_KEY, collapsed ? '1' : '0')
  if (persist) (collapsed ? els.expandButton : els.newButton).focus({ preventScroll: true })
}

/* ------------------------------------------------------------------ sidebar */

const itemEls = new Map() // module id -> row element

function renderExtraLinks() {
  els.extraLinks.replaceChildren(...registry.getSidebarItems().map((it) =>
    h('a', { class: 'sidebar-link', href: it.href, dataset: { nav: it.id, href: it.href } },
      it.icon && hasIcon(it.icon) ? icon(it.icon) : h('span', { class: 'sidebar-link-emoji' }, it.icon || ''),
      h('span', { class: 'sidebar-link-label' }, it.label))))
  updateActiveNav()
}

function sidebarItem(m) {
  const title = h('span', { class: 'sidebar-item-title' }, m.title)
  const iconBox = h('span', { class: 'sidebar-item-icon' }, moduleIcon(m, 16))
  const more = h('button', {
    type: 'button', class: 'sidebar-item-more', title: 'More actions', 'aria-label': `Actions for ${m.title}`, 'aria-haspopup': 'menu',
    onClick: (e) => {
      e.preventDefault()
      e.stopPropagation()
      moduleMenu(state.byId.get(m.id) || m, more, { align: 'start' })
    },
  }, icon('more', { size: 16 }))
  const link = h('a', { class: 'sidebar-item-link', href: moduleHref(m.id), draggable: 'false' }, iconBox, title)
  const row = h('div', { class: 'sidebar-item', dataset: { id: m.id, type: m.type }, title: m.title }, link, more)
  link.addEventListener('dblclick', (e) => {
    e.preventDefault()
    startRename(m.id)
  })
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    moduleMenu(state.byId.get(m.id) || m, { getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) })
  })
  link.addEventListener('keydown', (e) => {
    if (e.key === 'F2') {
      e.preventDefault()
      startRename(m.id)
    }
  })
  return row
}

function renderSidebarModules() {
  itemEls.clear()
  const byType = new Map(TYPE_ORDER.map((t) => [t, []]))
  for (const m of state.modules) {
    if (!byType.has(m.type)) byType.set(m.type, [])
    byType.get(m.type).push(m)
  }
  const frag = document.createDocumentFragment()
  for (const [type, list] of byType) {
    const info = typeInfo(type)
    const collapsed = state.collapsedGroups.has(type)
    const listEl = h('div', { class: 'sidebar-list', role: 'list' })
    for (const m of list) {
      const row = sidebarItem(m)
      row.setAttribute('role', 'listitem')
      itemEls.set(m.id, row)
      listEl.appendChild(row)
    }
    if (!list.length) listEl.appendChild(h('div', { class: 'sidebar-empty' }, `No ${info.plural.toLowerCase()} yet`))
    listEl.hidden = collapsed
    frag.appendChild(h('section', { class: `sidebar-group${collapsed ? ' is-collapsed' : ''}`, dataset: { type } },
      h('div', { class: 'sidebar-group-header' },
        h('button', {
          type: 'button', class: 'sidebar-group-toggle', 'aria-expanded': String(!collapsed),
          onClick: () => {
            if (state.collapsedGroups.has(type)) state.collapsedGroups.delete(type)
            else state.collapsedGroups.add(type)
            renderSidebarModules()
          },
        }, icon('chevron-down', { size: 12, strokeWidth: 2.25, className: 'sidebar-group-chevron' }), h('span', { class: 'sidebar-group-label' }, info.plural),
        list.length ? h('span', { class: 'sidebar-group-count' }, String(list.length)) : null),
        h('button', { type: 'button', class: 'sidebar-group-add', title: `New ${info.label.toLowerCase()}`, 'aria-label': `New ${info.label.toLowerCase()}`, onClick: () => openTemplatePicker(type) }, icon('plus', { size: 14, strokeWidth: 2 }))),
      listEl))
  }
  els.groups.replaceChildren(frag)
  updateActiveNav()
}

function updateSidebarItem(m) {
  const row = itemEls.get(m.id)
  if (!row) return
  row.title = m.title
  row.querySelector('.sidebar-item-title').textContent = m.title
  row.querySelector('.sidebar-item-icon').replaceChildren(moduleIcon(m, 16))
  row.querySelector('.sidebar-item-more').setAttribute('aria-label', `Actions for ${m.title}`)
}

function updateActiveNav() {
  const cur = state.current
  for (const row of els.groups.querySelectorAll('.sidebar-item.is-active')) row.classList.remove('is-active')
  const active = cur?.kind === 'module' ? itemEls.get(cur.moduleId) : null
  if (active) {
    active.classList.add('is-active')
    active.querySelector('.sidebar-item-link').setAttribute('aria-current', 'page')
  }
  for (const a of els.sidebar.querySelectorAll('.sidebar-link[data-nav]')) {
    const on = (cur?.kind === 'home' && a.dataset.nav === 'home') || (cur?.kind === 'archive' && a.dataset.nav === 'archive') ||
      (cur?.kind === 'registry' && a.dataset.href && registry.matchRoute(a.dataset.href.replace(/^#/, ''))?.prefix === cur.prefix)
    a.classList.toggle('is-active', !!on)
    if (on) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
}

function startRename(id) {
  const m = state.byId.get(id)
  const row = itemEls.get(id)
  if (!m || !row) return
  if (state.collapsedGroups.has(m.type)) {
    state.collapsedGroups.delete(m.type)
    renderSidebarModules()
    return startRename(id)
  }
  const titleEl = row.querySelector('.sidebar-item-title')
  const input = h('input', { class: 'sidebar-rename', type: 'text', value: m.title, 'aria-label': 'Rename' })
  let done = false
  const finish = async (commit) => {
    if (done) return
    done = true
    const value = input.value.trim()
    row.classList.remove('is-renaming')
    input.replaceWith(titleEl)
    if (commit && value && value !== m.title) await saveModule(id, { title: value })
    else titleEl.textContent = (state.byId.get(id) || m).title
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
      row.querySelector('.sidebar-item-link')?.focus({ preventScroll: true })
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
      row.querySelector('.sidebar-item-link')?.focus({ preventScroll: true })
    }
  })
  input.addEventListener('blur', () => finish(true))
  input.addEventListener('click', (e) => e.preventDefault())
  row.classList.add('is-renaming')
  titleEl.replaceWith(input)
  row.scrollIntoView({ block: 'nearest' })
  input.focus()
  input.select()
}

/* ------------------------------------------------------------------ template picker */

let pickerOpen = false
async function openTemplatePicker(onlyType) {
  if (pickerOpen) return
  pickerOpen = true
  try {
    if (!state.templates) state.templates = await api.get('/api/templates')
  } catch (err) {
    pickerOpen = false
    return reportError(err, 'Could not load templates')
  }
  const types = [...new Set([...TYPE_ORDER, ...state.templates.map((t) => t.type)])].filter((t) => !onlyType || t === onlyType)
  let busy = false
  await modal({
    title: onlyType ? `New ${typeInfo(onlyType).label.toLowerCase()}` : 'Create something new',
    description: 'Start from a blank canvas or pick a template.',
    size: 'lg',
    className: 'template-picker',
    actions: [],
    body: (close) => h('div', { class: 'template-sections' }, types.map((type) => {
      const info = typeInfo(type)
      const list = state.templates.filter((t) => t.type === type).sort((a, b) => (a.key === 'blank' ? -1 : b.key === 'blank' ? 1 : 0))
      if (!list.length) return null
      return h('section', { class: 'template-section', dataset: { type } },
        onlyType ? null : h('h3', { class: `section-title type-${type}` }, icon(hasIcon(info.icon) ? info.icon : 'file', { size: 14 }), info.plural),
        h('div', { class: 'template-grid' }, list.map((t) => h('button', {
          type: 'button',
          class: 'template-card',
          dataset: { type: t.type, key: t.key },
          onClick: async (e) => {
            if (busy) return
            busy = true
            e.currentTarget.classList.add('is-busy')
            try {
              await createModule(t.type, t.key)
              close(true)
            } catch (err) {
              busy = false
              e.target.closest('.template-card')?.classList.remove('is-busy')
              reportError(err, 'Could not create')
            }
          },
        },
        h('span', { class: `type-tile type-${t.type}` }, icon(hasIcon(info.icon) ? info.icon : 'file', { size: 18 })),
        h('span', { class: 'template-card-text' },
          h('span', { class: 'template-card-name' }, t.key === 'blank' ? `Blank ${info.label.toLowerCase()}` : t.name),
          h('span', { class: 'template-card-desc' }, t.description || info.blurb))))))
    })),
  })
  pickerOpen = false
}

/* ------------------------------------------------------------------ quick switcher */

let switcher = null
function openQuickSwitcher() {
  if (switcher) return switcher.close()
  const input = h('input', { class: 'switcher-input', type: 'text', placeholder: 'Search modules by title', 'aria-label': 'Search modules', autocomplete: 'off', spellcheck: 'false', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'switcher-results', autofocus: true })
  const results = h('div', { class: 'switcher-results', id: 'switcher-results', role: 'listbox' })
  const hint = h('div', { class: 'switcher-footer' },
    h('span', {}, h('kbd', { class: 'kbd' }, '↑'), h('kbd', { class: 'kbd' }, '↓'), ' to select'),
    h('span', {}, h('kbd', { class: 'kbd' }, 'Enter'), ' to open'),
    h('span', {}, h('kbd', { class: 'kbd' }, 'Esc'), ' to close'))
  let items = []
  let sel = 0
  let closeFn
  const go = (m) => {
    closeFn?.(null)
    navigate(moduleHref(m.id))
  }
  const paint = () => {
    ;[...results.children].forEach((el, i) => {
      const on = i === sel
      el.classList.toggle('is-selected', on)
      el.setAttribute('aria-selected', String(on))
      if (on) {
        input.setAttribute('aria-activedescendant', el.id)
        el.scrollIntoView({ block: 'nearest' })
      }
    })
  }
  const render = () => {
    const q = input.value.trim().toLowerCase()
    if (q) {
      items = state.modules.filter((m) => m.title.toLowerCase().includes(q))
        .sort((a, b) => (b.title.toLowerCase().startsWith(q) - a.title.toLowerCase().startsWith(q)) || a.title.localeCompare(b.title))
    } else {
      items = [...state.modules].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    }
    const total = items.length
    items = items.slice(0, 50)
    sel = 0
    results.replaceChildren(...items.map((m, i) => h('div', {
      class: 'switcher-item', role: 'option', id: `switcher-opt-${i}`, dataset: { id: m.id },
      onMousedown: (e) => e.preventDefault(),
      onClick: () => go(m),
      onMousemove: () => {
        if (sel !== i) {
          sel = i
          paint()
        }
      },
    }, h('span', { class: 'switcher-item-icon' }, moduleIcon(m, 16)), h('span', { class: 'switcher-item-title' }, m.title),
    h('span', { class: 'switcher-item-type' }, typeInfo(m.type).label))))
    if (!items.length) results.appendChild(h('div', { class: 'switcher-empty' }, q ? `No modules match "${input.value.trim()}"` : 'No modules yet'))
    results.dataset.label = q ? `${total} result${total === 1 ? '' : 's'}` : 'Recent'
    paint()
  }
  input.addEventListener('input', render)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      paint()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (items[sel]) go(items[sel])
    }
  })
  render()
  switcher = { close: (v) => closeFn?.(v) }
  modal({
    size: 'switcher',
    className: 'switcher',
    actions: [],
    body: (close) => {
      closeFn = close
      return h('div', { class: 'switcher-panel' },
        h('div', { class: 'switcher-search' }, icon('search', { size: 18 }), input),
        results, hint)
    },
  }).then(() => {
    switcher = null
  })
}

/* ------------------------------------------------------------------ router */

function parseHash() {
  let raw = location.hash.replace(/^#/, '')
  if (!raw.startsWith('/')) raw = '/' + raw
  const parts = raw.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  })
  if (!parts.length) return { kind: 'home', key: 'home' }
  if (parts[0] === 'm' && parts[1]) return { kind: 'module', key: `m:${parts[1]}`, moduleId: parts[1], sub: parts.slice(2) }
  if (parts[0] === 'archive' && parts.length === 1) return { kind: 'archive', key: 'archive' }
  const r = registry.matchRoute(raw.replace(/\/+$/, ''))
  if (r) return { kind: 'registry', key: `r:${r.prefix}`, prefix: r.prefix, def: r, path: raw, sub: raw.slice(r.prefix.length).split('/').filter(Boolean) }
  return { kind: 'notfound', key: `404:${raw}`, path: raw }
}

function unmountCurrent() {
  const cur = state.current
  if (cur?.handle) safeCall(cur.handle.unmount?.bind(cur.handle))
  state.current = null
}

async function route(force = false) {
  if (!state.typesLoaded) {
    const peek = parseHash()
    if (peek.kind !== 'home' && peek.kind !== 'archive') await state.typesReady
  }
  const r = parseHash()
  const cur = state.current
  if (!force && cur && cur.key === r.key && (r.kind === 'module' || r.kind === 'registry')) {
    const next = r.kind === 'module' ? { moduleId: r.moduleId, sub: r.sub } : { path: r.path, sub: r.sub }
    cur.route = next
    if (cur.handle) safeCall(cur.handle.onRoute?.bind(cur.handle), next)
    renderBreadcrumb()
    return
  }
  const seq = ++routeSeq
  unmountCurrent()
  const el = h('div', { class: `view view-${r.kind}` })
  els.view.replaceChildren(el)
  els.view.scrollTop = 0
  state.current = { key: r.key, kind: r.kind, el, handle: null, moduleId: r.moduleId, prefix: r.prefix, route: r.kind === 'module' ? { moduleId: r.moduleId, sub: r.sub } : { path: r.path, sub: r.sub } }
  els.topbarActions.replaceChildren()
  els.topbarMeta.replaceChildren()
  updateActiveNav()
  renderBreadcrumb()
  if (r.kind === 'home') renderHome(el)
  else if (r.kind === 'archive') await renderArchive(el, seq)
  else if (r.kind === 'module') await renderModule(el, r, seq)
  else if (r.kind === 'registry') renderRegistryRoute(el, r)
  else renderNotFound(el)
}

/* ------------------------------------------------------------------ breadcrumb */

function crumb(content, href) {
  return href ? h('a', { class: 'crumb', href }, content) : h('span', { class: 'crumb crumb-current', 'aria-current': 'page' }, content)
}
const crumbSep = () => h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, icon('chevron-right', { size: 12, strokeWidth: 2 }))

function renderBreadcrumb() {
  const cur = state.current
  const parts = []
  let title = 'Truss'
  if (!cur || cur.kind === 'home') {
    parts.push(crumb([icon('home', { size: 14 }), h('span', {}, 'Home')]))
  } else if (cur.kind === 'archive') {
    parts.push(crumb([icon('home', { size: 14 }), h('span', {}, 'Home')], '#/'), crumbSep(), crumb([icon('archive', { size: 14 }), h('span', {}, 'Archive')]))
    title = 'Archive - Truss'
  } else if (cur.kind === 'module') {
    const m = cur.module
    if (m) {
      const info = typeInfo(m.type)
      parts.push(h('span', { class: 'crumb crumb-muted' }, icon(hasIcon(info.icon) ? info.icon : 'file', { size: 14 }), h('span', {}, info.plural)), crumbSep())
      if (m.archived_at) parts.push(crumb([icon('archive', { size: 14 }), h('span', {}, 'Archive')], '#/archive'), crumbSep())
      parts.push(crumb([h('span', { class: 'crumb-icon' }, moduleIcon(m, 14)), h('span', { class: 'crumb-title' }, m.title)], cur.route?.sub?.length ? moduleHref(m.id) : null))
      title = `${m.title} - Truss`
    } else {
      parts.push(crumb(h('span', {}, 'Loading')))
    }
  } else if (cur.kind === 'registry') {
    parts.push(crumb(h('span', {}, cur.title || cur.prefix?.slice(1) || '')))
    title = `${cur.title || 'Truss'} - Truss`
  } else {
    parts.push(crumb(h('span', {}, 'Not found')))
  }
  els.breadcrumb.replaceChildren(...parts)
  document.title = title
}

/* ------------------------------------------------------------------ views */

function greeting() {
  const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hourCycle: 'h23' }).format(new Date()))
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

function renderHome(el) {
  const today = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())
  const recent = [...state.modules].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 9)
  el.append(h('div', { class: 'page home' },
    h('header', { class: 'home-hero' },
      h('p', { class: 'eyebrow' }, today),
      h('h1', { class: 'home-title' }, greeting()),
      h('p', { class: 'home-subtitle' }, 'Pick up where you left off, or start something new.')),
    h('section', { class: 'home-section' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Create'),
        button('Browse templates', { variant: 'ghost', size: 'sm', onClick: () => openTemplatePicker() })),
      h('div', { class: 'create-grid' }, TYPE_ORDER.map((type) => {
        const info = typeInfo(type)
        return h('button', { type: 'button', class: 'create-card', dataset: { type }, onClick: () => openTemplatePicker(type) },
          h('span', { class: `type-tile type-${type}` }, icon(info.icon, { size: 18 })),
          h('span', { class: 'create-card-text' },
            h('span', { class: 'create-card-title' }, `New ${info.label.toLowerCase()}`),
            h('span', { class: 'create-card-desc' }, info.blurb)),
          h('span', { class: 'create-card-plus', 'aria-hidden': 'true' }, icon('plus', { size: 14, strokeWidth: 2 })))
      }))),
    h('section', { class: 'home-section' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Recently edited'),
        state.modules.length ? h('span', { class: 'section-count' }, `${state.modules.length} module${state.modules.length === 1 ? '' : 's'}`) : null),
      recent.length
        ? h('div', { class: 'recent-grid' }, recent.map((m) => h('a', { class: 'recent-card', href: moduleHref(m.id), dataset: { id: m.id } },
          h('span', { class: `recent-card-icon type-${m.type}` }, moduleIcon(m, 20)),
          h('span', { class: 'recent-card-title' }, m.title),
          h('span', { class: 'recent-card-meta' }, h('span', {}, typeInfo(m.type).label), h('span', { class: 'dot', 'aria-hidden': 'true' }),
            h('time', { datetime: m.updated_at, title: formatDateTime(m.updated_at) }, `Edited ${formatRelative(m.updated_at)}`)))))
        : emptyState('page', 'Nothing here yet', 'Create your first database, workbook or notebook to get started.',
          button('New', { variant: 'primary', iconName: 'plus', onClick: () => openTemplatePicker() })))))
}

function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty-state' },
    h('span', { class: 'empty-state-icon' }, icon(iconName, { size: 22 })),
    h('p', { class: 'empty-state-title' }, title),
    text ? h('p', { class: 'empty-state-text' }, text) : null,
    action || null)
}

async function renderArchive(el, seq) {
  const page = h('div', { class: 'page archive' },
    h('header', { class: 'page-intro' },
      h('h1', { class: 'page-intro-title' }, 'Archive'),
      h('p', { class: 'page-intro-text' }, 'Archived modules are hidden from the sidebar. Restore them at any time, or delete them for good.')))
  const listHost = h('div', { class: 'archive-list', 'aria-busy': 'true' }, h('div', { class: 'list-skeleton' }, [1, 2, 3].map(() => h('span'))))
  page.append(listHost)
  el.append(page)
  let list
  try {
    list = await api.get('/api/modules?archived=1')
  } catch (err) {
    if (seq !== routeSeq) return
    listHost.replaceChildren(emptyState('alert', 'Could not load the archive', err.message))
    return
  }
  if (seq !== routeSeq) return
  listHost.removeAttribute('aria-busy')
  const paint = () => {
    if (!list.length) {
      listHost.replaceChildren(emptyState('archive', 'The archive is empty', 'Modules you archive will appear here.'))
      return
    }
    listHost.replaceChildren(...list.map((m) => {
      const restore = button('Restore', {
        variant: 'secondary', size: 'sm', iconName: 'restore',
        onClick: async () => {
          restore.disabled = true
          if (await restoreModule(m)) {
            list = list.filter((x) => x.id !== m.id)
            paint()
          } else restore.disabled = false
        },
      })
      const del = button('Delete permanently', {
        variant: 'danger-ghost', size: 'sm', iconName: 'trash',
        onClick: async () => {
          if (await deleteModule(m)) {
            list = list.filter((x) => x.id !== m.id)
            paint()
          }
        },
      })
      return h('div', { class: 'archive-row', dataset: { id: m.id } },
        h('span', { class: `archive-row-icon type-${m.type}` }, moduleIcon(m, 18)),
        h('div', { class: 'archive-row-text' },
          h('a', { class: 'archive-row-title', href: moduleHref(m.id) }, m.title),
          h('span', { class: 'archive-row-meta' }, typeInfo(m.type).label, h('span', { class: 'dot', 'aria-hidden': 'true' }),
            h('time', { datetime: m.archived_at, title: formatDateTime(m.archived_at) }, `Archived ${formatDate(m.archived_at)}`))),
        h('div', { class: 'archive-row-actions' }, restore, del))
    }))
  }
  paint()
}

function renderNotFound(el) {
  el.append(h('div', { class: 'page' }, emptyState('search', 'Page not found', 'This link does not match anything in Truss.',
    button('Go home', { variant: 'secondary', onClick: () => navigate('#/') }))))
}

function renderRegistryRoute(el, r) {
  state.current.title = r.def.title
  renderBreadcrumb()
  const host = h('div', { class: 'route-body' })
  el.append(host)
  try {
    const handle = r.def.mount(host, { route: { path: r.path, sub: r.sub }, api, ui, registry, navigate })
    state.current.handle = handle && typeof handle === 'object' ? handle : null
  } catch (err) {
    console.warn(`[truss] route ${r.prefix} failed to mount`, err)
    host.replaceChildren(emptyState('alert', 'This view failed to load', err?.message || ''))
  }
}

/* ---- module view */

function buildPageHeader(m) {
  const iconBtn = h('button', { type: 'button', class: `page-icon type-${m.type}${m.icon ? ' has-emoji' : ''}`, title: 'Change icon', 'aria-label': 'Change icon' }, moduleIcon(m, m.icon ? 30 : 22))
  const title = h('input', { class: 'page-title', type: 'text', value: m.title, placeholder: 'Untitled', 'aria-label': 'Module title', spellcheck: 'false' })
  const meta = h('div', { class: 'page-meta' })
  let lastSaved = m.title
  const commit = async () => {
    const value = title.value.trim()
    if (!value) {
      title.value = lastSaved
      return
    }
    if (value === lastSaved) return
    lastSaved = value
    const saved = await saveModule(m.id, { title: value })
    // The server may add a suffix to keep titles unique ("Budget" -> "Budget 2").
    if (saved && saved.title !== value) {
      lastSaved = saved.title
      if (document.activeElement !== title) {
        title.value = saved.title
        toast(`"${value}" is already taken, so this was saved as "${saved.title}"`)
      }
    }
  }
  const live = ui.debounce(commit, 600)
  const mirror = () => {
    const row = itemEls.get(m.id)
    if (row) row.querySelector('.sidebar-item-title').textContent = title.value.trim() || lastSaved
  }
  title.addEventListener('input', () => {
    mirror()
    live()
  })
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      title.blur()
    } else if (e.key === 'Escape') {
      title.value = lastSaved
      mirror()
      title.blur()
    }
  })
  title.addEventListener('blur', () => {
    live.cancel()
    commit()
  })
  iconBtn.addEventListener('click', () => changeIcon(state.current?.module || m, iconBtn))
  els.pageHeader = { iconBtn, title, meta, setSaved: (v) => { lastSaved = v } }
  updateMeta(m)
  return h('div', { class: 'page-header' }, iconBtn, h('div', { class: 'page-header-text' }, title, meta))
}

function updateMeta(m) {
  const info = typeInfo(m.type)
  els.pageHeader.meta.replaceChildren(
    h('span', { class: `type-badge type-${m.type}` }, icon(hasIcon(info.icon) ? info.icon : 'file', { size: 12, strokeWidth: 2 }), info.label),
    h('span', { class: 'page-meta-item', title: formatDateTime(m.created_at) }, `Created ${formatDate(m.created_at)}`),
    h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h('span', { class: 'page-meta-item', title: formatDateTime(m.updated_at) }, `Edited ${formatRelative(m.updated_at)}`))
}

function updatePageHeader(m) {
  const ph = els.pageHeader
  if (!ph) return
  ph.iconBtn.replaceChildren(moduleIcon(m, m.icon ? 30 : 22))
  ph.iconBtn.classList.toggle('has-emoji', !!m.icon)
  if (document.activeElement !== ph.title) {
    ph.title.value = m.title
    ph.setSaved(m.title)
  }
  updateMeta(m)
}

async function renderModule(el, r, seq) {
  let m = state.byId.get(r.moduleId)
  if (!m) {
    el.append(h('div', { class: 'page' }, h('div', { class: 'list-skeleton' }, [1, 2].map(() => h('span')))))
    try {
      m = await api.get(`/api/modules/${encodeURIComponent(r.moduleId)}`)
    } catch (err) {
      if (seq !== routeSeq) return
      el.replaceChildren(h('div', { class: 'page' }, emptyState('search', 'Module not found', err.status === 404 ? 'It may have been deleted.' : err.message,
        button('Go home', { variant: 'secondary', onClick: () => navigate('#/') }))))
      return
    }
    if (seq !== routeSeq) return
  }
  const cur = state.current
  cur.module = m
  renderBreadcrumb()
  const more = button('', {
    variant: 'ghost', size: 'sm', iconName: 'more', title: 'More actions', 'aria-haspopup': 'menu',
    onClick: () => {
      const mm = cur.module
      menu(more, mm.archived_at
        ? [{ label: 'Restore', icon: 'restore', onClick: async () => { if (await restoreModule(mm)) route(true) } },
          { label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deleteModule(mm).then((ok) => ok && navigate('#/archive')) }]
        : [{ label: 'Change icon', icon: 'smile', onClick: () => changeIcon(cur.module, els.pageHeader.iconBtn) },
          { label: 'Rename', icon: 'edit', onClick: () => els.pageHeader.title.focus() },
          'divider',
          { label: 'Archive', icon: 'archive', onClick: () => archiveModule(mm) },
          { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteModule(mm) }], { align: 'end' })
    },
  })
  els.topbarActions.replaceChildren(more)

  const header = buildPageHeader(m)
  const body = h('div', { class: 'module-body', dataset: { type: m.type } })
  el.replaceChildren()
  if (m.archived_at) {
    el.append(h('div', { class: 'banner banner-warning' }, icon('archive', { size: 16 }),
      h('span', {}, `This ${typeInfo(m.type).label.toLowerCase()} is in the archive.`),
      button('Restore', { variant: 'secondary', size: 'sm', onClick: async () => { if (await restoreModule(m)) route(true) } })))
  }
  el.append(h('div', { class: 'module-head' }, header), body)
  const type = state.types.get(m.type)
  if (!type) {
    const info = typeInfo(m.type)
    body.append(h('div', { class: 'module-placeholder' },
      h('span', { class: `type-tile type-tile-lg type-${m.type}` }, icon(hasIcon(info.icon) ? info.icon : 'file', { size: 26 })),
      h('p', { class: 'module-placeholder-title' }, `${info.plural} are not available yet`),
      h('p', { class: 'module-placeholder-text' }, `The ${info.label.toLowerCase()} editor is not installed in this copy of Truss. "${m.title}" is saved safely and will open here once it is.`)))
    return
  }
  try {
    const mctx = { module: m, route: cur.route, api, ui, registry, navigate }
    const handle = type.mount(body, mctx)
    if (seq !== routeSeq) {
      safeCall(handle?.unmount?.bind(handle))
      return
    }
    cur.handle = handle && typeof handle === 'object' ? handle : { unmount() {} }
    // A sub-route change may have arrived while mounting.
    if (mctx.route !== cur.route) safeCall(cur.handle.onRoute?.bind(cur.handle), cur.route)
  } catch (err) {
    console.warn(`[truss] ${m.type} failed to mount`, err)
    body.replaceChildren(emptyState('alert', 'This module failed to open', err?.message || 'An unexpected error occurred.'))
  }
}

/* ------------------------------------------------------------------ module loading */

async function loadContentModules() {
  const existing = await probeUrls(MODULE_FILES)
  const loaded = await Promise.all(MODULE_FILES.map(async (url) => {
    if (existing && !existing.has(url)) return null
    try {
      return (await import(url)).default
    } catch (err) {
      console.warn(`[truss] could not load ${url}:`, err?.message || err)
      return null
    }
  }))
  for (const [i, mod] of loaded.entries()) {
    if (!mod || typeof mod !== 'object') continue
    if (typeof mod.init === 'function') {
      try {
        await mod.init({ registry, api, ui })
      } catch (err) {
        console.warn(`[truss] init failed for ${MODULE_FILES[i]}:`, err)
      }
    }
    if (mod.type && typeof mod.mount === 'function') state.types.set(mod.type, mod)
  }
  state.typesLoaded = true
}

/* ------------------------------------------------------------------ keyboard */

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey
  if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    openQuickSwitcher()
  } else if (mod && e.key === '\\') {
    e.preventDefault()
    setSidebarCollapsed(!els.app.classList.contains('is-sidebar-collapsed'))
  }
})

/* ------------------------------------------------------------------ boot */

function markReady() {
  document.documentElement.dataset.ready = 'true'
  window.__trussReadyAt = performance.now()
  performance.mark('truss:ready')
}

async function boot() {
  buildLayout()
  renderExtraLinks()
  registry.on('registry:changed', (p) => {
    if (p?.kind === 'sidebar') renderExtraLinks()
    if (p?.kind === 'route' && state.current?.kind === 'notfound') route(true)
  })
  registry.on('modules:changed', (p) => {
    if (p?.source !== 'shell') refreshModules()
  })
  state.typesReady = loadContentModules().catch((err) => {
    console.warn('[truss] module loading failed', err)
    state.typesLoaded = true
  })
  api.get('/api/templates').then((t) => { state.templates = t }, () => {})
  if (!location.hash || location.hash === '#') history.replaceState(null, '', '#/')
  try {
    setModules(await api.get('/api/modules'))
  } catch (err) {
    state.loadError = err
    reportError(err, 'Could not load modules')
  }
  renderSidebarModules()
  window.addEventListener('hashchange', () => route())
  const first = route()
  if (state.current?.kind === 'home' || state.current?.kind === 'archive') markReady()
  await first
  if (!document.documentElement.dataset.ready) markReady()
  state.typesReady.then(() => {
    // Content types may override labels; refresh the labels shown in the sidebar once.
    if ([...state.types.values()].some((t) => t.label)) renderSidebarModules()
  })
}

boot()
