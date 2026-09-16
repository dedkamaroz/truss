// Notebook content type: page tree + page view (block editor or full-page table), attachments and page actions.

import { h, confirmDialog, emojiPicker, menu, toast, formatDate, debounce, loadCss } from '../../lib/ui.js'
import { icon, hasIcon } from '../../lib/icons.js'
import { createBlockEditor } from './blocks.js'
import { createTableEditor, newTable } from './table.js'
import { createHistory, historyKey, formatSize } from './util.js'

const CSS_URL = new URL('./notebook.css', import.meta.url).href
const SAVE_DELAY = 700

export default {
  type: 'notebook',
  // No `label`: the shell already calls this type "Notebook", and a label makes it re-render the sidebar after boot.
  icon: 'notebook',
  init({ ui }) {
    ui.loadCss(CSS_URL)
  },
  mount(el, mctx) {
    loadCss(CSS_URL)
    return mountNotebook(el, mctx)
  },
}

const store = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {}
  },
}

const iconBtn = (name, label, attrs = {}) =>
  h('button', { type: 'button', class: 'nb-icon-btn', title: label, 'aria-label': label, ...attrs }, icon(name, { size: 16 }))

function mountNotebook(el, mctx) {
  const { api, registry, navigate } = mctx
  let module = mctx.module
  const enc = encodeURIComponent
  const base = `/api/notebooks/${enc(module.id)}`
  const expandKey = `truss.nb.expanded.${module.id}`
  const state = {
    pages: [],
    byId: new Map(),
    expanded: new Set(store.get(expandKey, [])),
    currentId: null,
    archivedOpen: false,
    loaded: false,
  }
  let view = null
  let destroyed = false
  let openSeq = 0
  let dragPageId = null

  /* ------------------------------------------------------------ layout */

  const addRootBtn = iconBtn('plus', 'New page', { class: 'nb-icon-btn nb-new-page', onClick: () => createPage(null) })
  const searchInput = h('input', { type: 'search', class: 'nb-search-input', placeholder: 'Search pages', 'aria-label': 'Search pages', spellcheck: 'false' })
  const treeHost = h('div', { class: 'nb-tree', role: 'tree', 'aria-label': 'Pages' })
  const searchHost = h('div', { class: 'nb-search-results', hidden: true })
  const archivedHost = h('div', { class: 'nb-archived' })
  const treePanel = h('aside', { class: 'nb-tree-panel', 'aria-label': 'Page tree' },
    h('div', { class: 'nb-tree-head' }, h('span', { class: 'nb-tree-heading' }, 'Pages'), addRootBtn),
    h('label', { class: 'nb-search' }, icon('search', { size: 14 }), searchInput),
    h('div', { class: 'nb-tree-scroll' }, treeHost, searchHost, archivedHost))
  const pageHost = h('section', { class: 'nb-page-host' })
  const root = h('div', { class: 'nb', dataset: { style: module.data?.style === 'table' ? 'table' : 'text' } }, treePanel, pageHost)
  el.append(root)

  /* ------------------------------------------------------------ page state */

  function setPages(list) {
    state.pages = list
    state.byId = new Map(list.map((p) => [p.id, p]))
  }

  function upsertMeta(meta) {
    const existing = state.byId.get(meta.id)
    if (existing) Object.assign(existing, meta)
    else {
      state.pages.push(meta)
      state.byId.set(meta.id, meta)
    }
  }

  const childrenMap = () => {
    const map = new Map()
    const sorted = [...state.pages].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    for (const p of sorted) {
      const k = p.parent_id || ''
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(p)
    }
    return map
  }

  function ancestors(id) {
    const out = []
    for (let p = state.byId.get(state.byId.get(id)?.parent_id); p; p = state.byId.get(p.parent_id)) out.unshift(p)
    return out
  }

  const isHidden = (p) => !!p.archived_at || ancestors(p.id).some((a) => a.archived_at)

  function subtreeIds(id) {
    const map = childrenMap()
    const out = []
    const walk = (pid) => {
      out.push(pid)
      for (const c of map.get(pid) || []) walk(c.id)
    }
    walk(id)
    return out
  }

  const pageTitle = (p) => p?.title || 'Untitled'
  const pageIcon = (p, size = 16) => (p?.icon ? h('span', { class: 'nb-emoji', style: { fontSize: `${Math.round(size * 0.95)}px` } }, p.icon) : icon('page', { size }))
  const pageHref = (id) => `#/m/${enc(module.id)}/p/${enc(id)}`

  /* ------------------------------------------------------------ tree */

  function renderTree() {
    const map = childrenMap()
    const frag = document.createDocumentFragment()
    const walk = (parentId, depth) => {
      for (const p of map.get(parentId) || []) {
        if (p.archived_at) continue
        const kids = (map.get(p.id) || []).some((c) => !c.archived_at)
        const open = kids && state.expanded.has(p.id)
        frag.appendChild(treeRow(p, depth, kids, open))
        if (open) walk(p.id, depth + 1)
      }
    }
    walk('', 0)
    if (!frag.childNodes.length) {
      frag.appendChild(h('div', { class: 'nb-tree-empty' }, state.loaded ? 'No pages yet' : ''))
    }
    treeHost.replaceChildren(frag)
    renderArchived()
  }

  function treeRow(p, depth, kids, open) {
    const active = p.id === state.currentId
    return h('div', {
      class: `nb-tree-row${active ? ' is-active' : ''}`,
      role: 'treeitem',
      'aria-level': String(depth + 1),
      'aria-expanded': kids ? String(open) : null,
      'aria-selected': String(active),
      tabindex: active ? '0' : '-1',
      draggable: 'true',
      dataset: { id: p.id },
      style: `--depth: ${depth}`,
      title: pageTitle(p),
    },
    h('button', { type: 'button', class: `nb-tree-toggle${kids ? '' : ' is-leaf'}`, tabindex: '-1', 'aria-label': open ? 'Collapse' : 'Expand' },
      kids ? icon(open ? 'chevron-down' : 'chevron-right', { size: 14, strokeWidth: 2 }) : null),
    h('span', { class: 'nb-tree-icon' }, pageIcon(p, 16)),
    h('span', { class: `nb-tree-label${p.title ? '' : ' is-untitled'}` }, pageTitle(p)),
    h('span', { class: 'nb-tree-actions' },
      iconBtn('more', 'Page options', { class: 'nb-icon-btn nb-tree-more', tabindex: '-1' }),
      iconBtn('plus', 'Add subpage', { class: 'nb-icon-btn nb-tree-add', tabindex: '-1' })))
  }

  function renderArchived() {
    const archived = state.pages.filter((p) => p.archived_at).sort((a, b) => b.archived_at.localeCompare(a.archived_at))
    if (!archived.length) {
      archivedHost.replaceChildren()
      return
    }
    archivedHost.replaceChildren(
      h('button', { type: 'button', class: 'nb-archived-toggle', 'aria-expanded': String(state.archivedOpen), onClick: () => {
        state.archivedOpen = !state.archivedOpen
        renderArchived()
      } }, icon(state.archivedOpen ? 'chevron-down' : 'chevron-right', { size: 14, strokeWidth: 2 }), icon('archive', { size: 14 }),
      h('span', {}, 'Archived'), h('span', { class: 'nb-count' }, String(archived.length))),
      state.archivedOpen ? h('div', { class: 'nb-archived-list' }, archived.map((p) => h('div', {
        class: `nb-archived-row${p.id === state.currentId ? ' is-active' : ''}`, dataset: { id: p.id },
      },
      h('a', { class: 'nb-archived-link', href: pageHref(p.id), title: pageTitle(p) }, h('span', { class: 'nb-tree-icon' }, pageIcon(p, 14)), h('span', { class: 'nb-tree-label' }, pageTitle(p))),
      iconBtn('restore', 'Restore', { class: 'nb-icon-btn nb-restore', onClick: () => restorePage(p) }),
      iconBtn('trash', 'Delete permanently', { class: 'nb-icon-btn nb-delete', onClick: () => deletePage(p) })))) : '')
  }

  function markActive() {
    for (const row of treeHost.querySelectorAll('.nb-tree-row.is-active')) {
      row.classList.remove('is-active')
      row.setAttribute('aria-selected', 'false')
      row.tabIndex = -1
    }
    const row = treeHost.querySelector(`.nb-tree-row[data-id="${CSS.escape(state.currentId || '')}"]`)
    if (row) {
      row.classList.add('is-active')
      row.setAttribute('aria-selected', 'true')
      row.tabIndex = 0
    }
    renderArchived()
  }

  function setExpanded(id, open) {
    if (open) state.expanded.add(id)
    else state.expanded.delete(id)
    store.set(expandKey, [...state.expanded])
  }

  function revealInTree(id) {
    let changed = false
    for (const a of ancestors(id)) {
      if (!state.expanded.has(a.id)) {
        setExpanded(a.id, true)
        changed = true
      }
    }
    return changed
  }

  function updateTitleEverywhere(p) {
    const row = treeHost.querySelector(`.nb-tree-row[data-id="${CSS.escape(p.id)}"]`)
    if (row) {
      row.title = pageTitle(p)
      const label = row.querySelector('.nb-tree-label')
      label.textContent = pageTitle(p)
      label.classList.toggle('is-untitled', !p.title)
      row.querySelector('.nb-tree-icon').replaceChildren(pageIcon(p, 16))
    }
    if (view) view.refreshCrumbs()
  }

  treeHost.addEventListener('click', (e) => {
    const row = e.target.closest('.nb-tree-row')
    if (!row || row.classList.contains('is-renaming')) return
    const p = state.byId.get(row.dataset.id)
    if (!p) return
    if (e.target.closest('.nb-tree-toggle')) {
      if (!e.target.closest('.nb-tree-toggle').classList.contains('is-leaf')) {
        setExpanded(p.id, !state.expanded.has(p.id))
        renderTree()
        return
      }
    }
    if (e.target.closest('.nb-tree-add')) return createPage(p.id)
    if (e.target.closest('.nb-tree-more')) return pageMenu(p, e.target.closest('.nb-tree-more'))
    navigate(pageHref(p.id))
  })

  treeHost.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.nb-tree-row')
    if (row && e.target.closest('.nb-tree-label')) startRename(row.dataset.id)
  })

  treeHost.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.nb-tree-row')
    const p = row && state.byId.get(row.dataset.id)
    if (!p) return
    e.preventDefault()
    pageMenu(p, { getBoundingClientRect: () => new DOMRect(e.clientX, e.clientY, 0, 0) })
  })

  treeHost.addEventListener('keydown', (e) => {
    const row = e.target.closest('.nb-tree-row')
    if (!row || e.target !== row) return
    const rows = [...treeHost.querySelectorAll('.nb-tree-row')]
    const i = rows.indexOf(row)
    const p = state.byId.get(row.dataset.id)
    const focusRow = (r) => {
      if (!r) return
      rows.forEach((x) => (x.tabIndex = -1))
      r.tabIndex = 0
      r.focus()
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusRow(rows[i + (e.key === 'ArrowDown' ? 1 : -1)])
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const open = e.key === 'ArrowRight'
      if (row.hasAttribute('aria-expanded') && (row.getAttribute('aria-expanded') === 'true') !== open) {
        setExpanded(p.id, open)
        renderTree()
        treeHost.querySelector(`.nb-tree-row[data-id="${CSS.escape(p.id)}"]`)?.focus()
      } else if (!open && p.parent_id) {
        focusRow(treeHost.querySelector(`.nb-tree-row[data-id="${CSS.escape(p.parent_id)}"]`))
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      navigate(pageHref(p.id))
    } else if (e.key === 'F2') {
      e.preventDefault()
      startRename(p.id)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      deletePage(p)
    }
  })

  // Drag to reorder (top/bottom quarter) or nest (middle)
  const clearTreeDrop = () => treeHost.querySelectorAll('.is-drop-before, .is-drop-after, .is-drop-inside').forEach((r) => r.classList.remove('is-drop-before', 'is-drop-after', 'is-drop-inside'))
  const treeDropSpot = (e) => {
    const row = e.target.closest?.('.nb-tree-row')
    if (!row || !dragPageId || subtreeIds(dragPageId).includes(row.dataset.id)) return null
    const rect = row.getBoundingClientRect()
    const y = (e.clientY - rect.top) / rect.height
    return { row, id: row.dataset.id, pos: y < 0.28 ? 'before' : y > 0.72 ? 'after' : 'inside' }
  }
  treeHost.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('.nb-tree-row')
    if (!row) return
    dragPageId = row.dataset.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-truss-page', dragPageId)
    row.classList.add('is-dragging')
  })
  treeHost.addEventListener('dragover', (e) => {
    if (!dragPageId) return
    const spot = treeDropSpot(e)
    clearTreeDrop()
    if (!spot) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    spot.row.classList.add(`is-drop-${spot.pos}`)
  })
  treeHost.addEventListener('dragleave', (e) => {
    if (!treeHost.contains(e.relatedTarget)) clearTreeDrop()
  })
  treeHost.addEventListener('drop', async (e) => {
    const spot = treeDropSpot(e)
    const moving = dragPageId
    clearTreeDrop()
    dragPageId = null
    if (!spot || !moving) return
    e.preventDefault()
    const target = state.byId.get(spot.id)
    const map = childrenMap()
    let body
    if (spot.pos === 'inside') body = { parent_id: target.id, before_id: null }
    else if (spot.pos === 'before') body = { parent_id: target.parent_id, before_id: target.id }
    else {
      const sibs = (map.get(target.parent_id || '') || []).filter((s) => s.id !== moving)
      body = { parent_id: target.parent_id, before_id: sibs[sibs.indexOf(target) + 1]?.id ?? null }
    }
    try {
      await api.post(`${base}/pages/${enc(moving)}/move`, body)
      if (body.parent_id) setExpanded(body.parent_id, true)
      await reloadPages()
    } catch (err) {
      toast(err.message || 'Could not move the page', { type: 'error' })
    }
  })
  treeHost.addEventListener('dragend', () => {
    treeHost.querySelector('.is-dragging')?.classList.remove('is-dragging')
    dragPageId = null
    clearTreeDrop()
  })

  function startRename(id) {
    const p = state.byId.get(id)
    const row = treeHost.querySelector(`.nb-tree-row[data-id="${CSS.escape(id)}"]`)
    if (!p || !row) return
    const label = row.querySelector('.nb-tree-label')
    const input = h('input', { class: 'nb-tree-rename', type: 'text', value: p.title, placeholder: 'Untitled', 'aria-label': 'Rename page' })
    let done = false
    const finish = async (commit) => {
      if (done) return
      done = true
      row.classList.remove('is-renaming')
      row.draggable = true
      input.replaceWith(label)
      const value = input.value.trim()
      if (commit && value !== p.title) await renamePage(p, value)
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') {
        e.preventDefault()
        finish(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    row.classList.add('is-renaming')
    row.draggable = false
    label.replaceWith(input)
    input.focus()
    input.select()
  }

  async function renamePage(p, title) {
    p.title = title
    updateTitleEverywhere(p)
    if (view?.id === p.id) view.setTitle(title)
    try {
      upsertMeta(await api.patch(`${base}/pages/${enc(p.id)}`, { title }))
    } catch (err) {
      toast(err.message || 'Could not rename', { type: 'error' })
    }
  }

  async function changePageIcon(p, anchor) {
    const value = await emojiPicker(anchor, { allowRemove: !!p.icon })
    if (value === null) return
    try {
      upsertMeta(await api.patch(`${base}/pages/${enc(p.id)}`, { icon: value || null }))
      updateTitleEverywhere(p)
      if (view?.id === p.id) view.refreshHeader()
    } catch (err) {
      toast(err.message || 'Could not change the icon', { type: 'error' })
    }
  }

  function pageMenu(p, anchor) {
    const archived = !!p.archived_at
    menu(anchor, archived
      ? [
        { label: 'Restore', icon: 'restore', onClick: () => restorePage(p) },
        { label: 'Delete permanently', icon: 'trash', danger: true, onClick: () => deletePage(p) },
      ]
      : [
        { label: 'Rename', icon: 'edit', shortcut: 'F2', onClick: () => startRename(p.id) },
        { label: 'Change icon', icon: 'smile', onClick: () => changePageIcon(p, treeHost.querySelector(`.nb-tree-row[data-id="${CSS.escape(p.id)}"]`) || anchor) },
        { label: 'Add subpage', icon: 'plus', onClick: () => createPage(p.id) },
        'divider',
        { label: 'Archive', icon: 'archive', onClick: () => archivePage(p) },
        { label: 'Delete', icon: 'trash', danger: true, onClick: () => deletePage(p) },
      ], { align: 'start' })
  }

  async function reloadPages() {
    setPages(await api.get(`${base}/pages`))
    renderTree()
  }

  async function createPage(parentId) {
    try {
      const page = await api.post(`${base}/pages`, { parent_id: parentId })
      const { content, ...meta } = page
      upsertMeta(meta)
      if (parentId) setExpanded(parentId, true)
      renderTree()
      navigate(pageHref(page.id))
      return page
    } catch (err) {
      toast(err.message || 'Could not create a page', { type: 'error' })
    }
  }

  async function archivePage(p) {
    try {
      upsertMeta(await api.post(`${base}/pages/${enc(p.id)}/archive`))
      renderTree()
      toast(`Moved "${pageTitle(p)}" to Archived`, { type: 'success' })
      if (view && subtreeIds(p.id).includes(view.id)) view.refreshHeader()
    } catch (err) {
      toast(err.message || 'Could not archive', { type: 'error' })
    }
  }

  async function restorePage(p) {
    try {
      upsertMeta(await api.post(`${base}/pages/${enc(p.id)}/restore`))
      revealInTree(p.id)
      renderTree()
      toast(`Restored "${pageTitle(p)}"`, { type: 'success' })
      if (view && subtreeIds(p.id).includes(view.id)) view.refreshHeader()
    } catch (err) {
      toast(err.message || 'Could not restore', { type: 'error' })
    }
  }

  async function deletePage(p) {
    const ids = subtreeIds(p.id)
    const subs = ids.length - 1
    const ok = await confirmDialog({
      title: `Delete "${pageTitle(p)}" permanently?`,
      message: `${subs ? `This page, its ${subs} subpage${subs === 1 ? '' : 's'} and all of their` : 'This page and all of its'} attachments will be removed from disk. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    })
    if (!ok) return
    try {
      await api.del(`${base}/pages/${enc(p.id)}`)
    } catch (err) {
      toast(err.message || 'Could not delete', { type: 'error' })
      return
    }
    setPages(state.pages.filter((x) => !ids.includes(x.id)))
    renderTree()
    toast(`Deleted "${pageTitle(p)}"`, { type: 'success' })
    if (view && ids.includes(view.id)) {
      view.discard()
      const next = firstVisible()
      if (next) navigate(pageHref(next.id))
      else {
        history.replaceState(null, '', `#/m/${enc(module.id)}`)
        showEmpty()
      }
    }
  }

  function firstVisible() {
    const map = childrenMap()
    return (map.get('') || []).find((p) => !p.archived_at) || null
  }

  /* ------------------------------------------------------------ search */

  const runSearch = debounce(async () => {
    const q = searchInput.value.trim()
    if (!q) {
      searchHost.hidden = true
      treeHost.hidden = false
      archivedHost.hidden = false
      return
    }
    let results
    try {
      results = await api.get(`${base}/search?q=${enc(q)}`)
    } catch (err) {
      return toast(err.message || 'Search failed', { type: 'error' })
    }
    if (searchInput.value.trim() !== q || destroyed) return
    treeHost.hidden = true
    archivedHost.hidden = true
    searchHost.hidden = false
    searchHost.replaceChildren(
      h('div', { class: 'nb-search-summary' }, `${results.length} result${results.length === 1 ? '' : 's'}`),
      ...results.map((r) => h('a', { class: 'nb-search-result', href: pageHref(r.id), dataset: { id: r.id, match: r.match } },
        h('span', { class: 'nb-search-result-head' }, h('span', { class: 'nb-tree-icon' }, pageIcon(r, 14)), h('span', { class: 'nb-search-result-title' }, pageTitle(r)),
          r.archived_at ? h('span', { class: 'nb-tag' }, 'Archived') : null),
        r.snippet ? h('span', { class: 'nb-search-snippet' }, r.snippet) : null)),
      ...(results.length ? [] : [h('div', { class: 'nb-tree-empty' }, 'No pages match')]))
  }, 180)
  searchInput.addEventListener('input', runSearch)
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation()
      searchInput.value = ''
      runSearch()
    }
  })

  /* ------------------------------------------------------------ page view */

  function showEmpty() {
    view?.destroy()
    view = null
    state.currentId = null
    markActive()
    pageHost.replaceChildren(h('div', { class: 'nb-empty' },
      h('span', { class: 'nb-empty-icon' }, icon('page', { size: 22 })),
      h('p', { class: 'nb-empty-title' }, 'No pages yet'),
      h('p', { class: 'nb-empty-text' }, 'Create the first page of this notebook.'),
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => createPage(null) }, icon('plus', { size: 16 }), h('span', { class: 'btn-label' }, 'New page'))))
  }

  async function openPage(pageId) {
    if (view?.id === pageId) return
    const seq = ++openSeq
    if (view) {
      view.flush()
      view.destroy()
      view = null
    }
    state.currentId = pageId
    if (revealInTree(pageId)) renderTree()
    else markActive()
    pageHost.replaceChildren(h('div', { class: 'nb-page-loading' }, h('span'), h('span'), h('span')))
    let page
    let attachments
    try {
      ;[page, attachments] = await Promise.all([
        api.get(`${base}/pages/${enc(pageId)}`),
        api.get(`/api/attachments?moduleId=${enc(module.id)}&pageId=${enc(pageId)}`),
      ])
    } catch (err) {
      if (seq !== openSeq || destroyed) return
      pageHost.replaceChildren(h('div', { class: 'nb-empty' },
        h('span', { class: 'nb-empty-icon' }, icon('search', { size: 22 })),
        h('p', { class: 'nb-empty-title' }, err.status === 404 ? 'Page not found' : 'Could not open this page'),
        h('p', { class: 'nb-empty-text' }, err.status === 404 ? 'It may have been deleted.' : err.message)))
      return
    }
    if (seq !== openSeq || destroyed) return
    const { content, ...meta } = page
    upsertMeta(meta)
    view = createPageView(page, attachments)
    pageHost.replaceChildren(view.el)
    view.mounted()
  }

  function routeTo(route) {
    const sub = route?.sub || []
    const pid = sub[0] === 'p' && sub[1] ? sub[1] : null
    if (pid) return openPage(pid)
    const first = firstVisible()
    if (first) {
      history.replaceState(null, '', pageHref(first.id))
      return openPage(first.id)
    }
    showEmpty()
  }

  function createPageView(page, initialAttachments) {
    const id = page.id
    const meta = state.byId.get(id)
    let attachments = initialAttachments
    let destroyedView = false
    const isTable = page.content && !Array.isArray(page.content) && Array.isArray(page.content.columns)
      ? true
      : Array.isArray(page.content) && page.content.length ? false : module.data?.style === 'table'
    const saveUrl = `${base}/pages/${enc(id)}`

    /* ---- saving */
    const dirty = new Set()
    let timer = null
    let inflight = null
    let editor = null
    let tableEditor = null
    const status = h('span', { class: 'nb-save-status', 'aria-live': 'polite' })
    const setStatus = (s) => {
      pageEl.dataset.saveState = s
      status.textContent = s === 'saved' ? 'Saved' : s === 'error' ? 'Not saved' : 'Saving...'
      status.classList.toggle('is-error', s === 'error')
    }
    const bodyFor = (fields) => {
      const body = {}
      if (fields.has('title')) body.title = meta.title
      if (fields.has('content')) body.content = isTable ? tableEditor.data : editor.blocks
      return body
    }
    const schedule = (field) => {
      dirty.add(field)
      setStatus('saving')
      clearTimeout(timer)
      timer = setTimeout(flush, SAVE_DELAY)
    }
    async function flush() {
      clearTimeout(timer)
      if (inflight) await inflight
      if (!dirty.size) return
      const fields = new Set(dirty)
      dirty.clear()
      inflight = api.patch(saveUrl, bodyFor(fields)).then((saved) => {
        upsertMeta(saved)
        setStatus(dirty.size ? 'saving' : 'saved')
      }, (err) => {
        for (const f of fields) dirty.add(f)
        setStatus('error')
        toast(err.message || 'Could not save the page', { type: 'error' })
      }).finally(() => {
        inflight = null
      })
      await inflight
    }
    // Last-chance save when the window closes or reloads during the debounce window.
    const onPageHide = () => {
      if (!dirty.size) return
      clearTimeout(timer)
      try {
        fetch(saveUrl, { method: 'PATCH', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Truss-Token': api.token }, body: JSON.stringify(bodyFor(dirty)) })
        dirty.clear()
      } catch {}
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('beforeunload', onPageHide)

    /* ---- header */
    const crumbs = h('nav', { class: 'nb-crumbs', 'aria-label': 'Page path' })
    const actionsHost = h('div', { class: 'nb-page-actions' })
    const uploadInput = h('input', { type: 'file', multiple: true, class: 'nb-hidden-input', tabindex: '-1', 'aria-hidden': 'true' })
    uploadInput.addEventListener('change', () => {
      uploadFiles([...uploadInput.files])
      uploadInput.value = ''
    })
    const uploadBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm nb-upload', onClick: () => uploadInput.click() }, icon('upload', { size: 14 }), h('span', { class: 'btn-label' }, 'Upload'))
    const moreBtn = iconBtn('more', 'More page actions', { class: 'nb-icon-btn nb-page-more', onClick: () => pageMenu(meta, moreBtn) })
    const toolbar = h('div', { class: 'nb-page-toolbar' }, crumbs, h('span', { class: 'nb-spacer' }), status, actionsHost, uploadBtn, moreBtn, uploadInput)

    const iconHost = h('div', { class: 'nb-page-icon-row' })
    const titleEl = h('div', { class: 'nb-page-title', contenteditable: 'plaintext-only', role: 'textbox', 'aria-label': 'Page title', spellcheck: 'true', dataset: { placeholder: 'Untitled' } }, meta.title)
    const banner = h('div', { class: 'nb-banner', hidden: true })
    const attachmentsEl = h('section', { class: 'nb-attachments', 'aria-label': 'Attachments' })
    const contentHost = h('div', { class: 'nb-page-content' })
    const inner = h('div', { class: `nb-page-inner${isTable ? ' is-wide' : ''}` }, banner, iconHost, titleEl, attachmentsEl, contentHost)
    const dropOverlay = h('div', { class: 'nb-drop-overlay', 'aria-hidden': 'true' }, h('div', { class: 'nb-drop-card' }, icon('upload', { size: 22 }), h('span', {}, 'Drop files to attach them to this page')))
    const pageEl = h('article', { class: `nb-page${isTable ? ' is-table' : ' is-text'}`, dataset: { pageId: id, saveState: 'saved' } }, toolbar, inner, dropOverlay)

    function refreshCrumbs() {
      const chain = [...ancestors(id), meta]
      crumbs.replaceChildren(...chain.flatMap((p, i) => [
        i ? h('span', { class: 'nb-crumb-sep', 'aria-hidden': 'true' }, '/') : null,
        i < chain.length - 1
          ? h('a', { class: 'nb-crumb', href: pageHref(p.id) }, h('span', { class: 'nb-crumb-icon' }, pageIcon(p, 14)), h('span', { class: 'nb-crumb-title' }, pageTitle(p)))
          : h('span', { class: 'nb-crumb is-current', 'aria-current': 'page' }, h('span', { class: 'nb-crumb-icon' }, pageIcon(p, 14)), h('span', { class: 'nb-crumb-title' }, pageTitle(p))),
      ]).filter(Boolean))
    }

    function refreshHeader() {
      refreshCrumbs()
      iconHost.replaceChildren(meta.icon
        ? h('button', { type: 'button', class: 'nb-page-emoji', title: 'Change icon', 'aria-label': 'Change page icon', onClick: (e) => changePageIcon(meta, e.currentTarget) }, meta.icon)
        : h('button', { type: 'button', class: 'nb-add-icon', onClick: (e) => changePageIcon(meta, e.currentTarget) }, icon('smile', { size: 14 }), h('span', {}, 'Add icon')))
      iconHost.classList.toggle('has-icon', !!meta.icon)
      const archivedSelf = !!meta.archived_at
      const hidden = isHidden(meta)
      banner.hidden = !hidden
      if (hidden) {
        banner.replaceChildren(icon('archive', { size: 16 }),
          h('span', { class: 'nb-banner-text' }, archivedSelf ? 'This page is archived.' : 'This page is inside an archived page.'),
          ...(archivedSelf ? [h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onClick: () => restorePage(meta) }, 'Restore'),
            h('button', { type: 'button', class: 'btn btn-danger-ghost btn-sm', onClick: () => deletePage(meta) }, 'Delete permanently')] : []))
      }
    }

    titleEl.addEventListener('input', () => {
      if (titleEl.innerHTML === '<br>') titleEl.textContent = ''
      meta.title = titleEl.textContent.replace(/\s+/g, ' ').trim()
      updateTitleEverywhere(meta)
      schedule('title')
    })
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (isTable) tableEditor.focusCell(-1, 0)
        else editor.focusStart()
      }
    })

    /* ---- page actions */
    const actionCtx = () => ({ module, pageId: id, attachments })
    function renderActions() {
      actionsHost.replaceChildren(...registry.getPageActions(actionCtx()).map((a) =>
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm nb-page-action', dataset: { actionId: a.id }, title: a.label,
          onClick: async () => {
            try {
              await a.run(actionCtx())
            } catch (err) {
              toast(err?.message || `${a.label} failed`, { type: 'error' })
            }
          },
        }, a.icon && hasIcon(a.icon) ? icon(a.icon, { size: 14 }) : a.icon ? h('span', { class: 'nb-emoji' }, a.icon) : null, h('span', { class: 'btn-label' }, a.label))))
    }

    /* ---- attachments */
    const contentUrl = (attId) => api.url(`/api/attachments/${enc(attId)}/content`)
    async function uploadFiles(files) {
      if (!files.length) return []
      const out = []
      for (const file of files) {
        try {
          out.push(await api.upload(`/api/attachments?moduleId=${enc(module.id)}&pageId=${enc(id)}`, file, file.name))
        } catch (err) {
          toast(`Could not upload "${file.name}": ${err.message}`, { type: 'error' })
        }
      }
      if (out.length) {
        registry.emit('attachments:changed', { moduleId: module.id, pageId: id })
        toast(out.length === 1 ? `Attached "${out[0].filename}"` : `Attached ${out.length} files`, { type: 'success' })
      }
      return out
    }

    const attAction = async (att, action) => {
      // Hosted there is no desktop to open the file on, and the server does not
      // register these routes at all - so open the file's own URL instead. The
      // content route already sends Content-Disposition and an inert CSP.
      if (api.hosted) {
        if (action === 'open') globalThis.open(contentUrl(att.id), '_blank', 'noopener')
        return
      }
      try {
        await api.post(`/api/attachments/${enc(att.id)}/${action}`)
      } catch (err) {
        toast(err.message || 'Could not open the file', { type: 'error' })
      }
    }

    async function deleteAttachment(att) {
      const ok = await confirmDialog({ title: `Delete "${att.filename}"?`, message: 'The file will be removed from disk. This cannot be undone.', confirmLabel: 'Delete', danger: true })
      if (!ok) return
      try {
        await api.del(`/api/attachments/${enc(att.id)}`)
        registry.emit('attachments:changed', { moduleId: module.id, pageId: id })
      } catch (err) {
        toast(err.message || 'Could not delete the attachment', { type: 'error' })
      }
    }

    function renderAttachments() {
      const isImage = (a) => /^image\//.test(a.mime || '')
      const ext = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] || 'file').toUpperCase()
      attachmentsEl.replaceChildren(
        h('div', { class: 'nb-att-head' },
          icon('paperclip', { size: 14 }),
          h('span', { class: 'nb-att-heading' }, 'Attachments'),
          attachments.length ? h('span', { class: 'nb-count' }, String(attachments.length)) : null),
        attachments.length
          ? h('div', { class: 'nb-att-grid' }, attachments.map((a) => h('div', { class: `nb-att${isImage(a) ? ' is-image' : ''}`, dataset: { id: a.id } },
            h('div', { class: 'nb-att-thumb' }, isImage(a)
              ? h('img', { src: contentUrl(a.id), alt: '', loading: 'lazy', draggable: 'false' })
              : h('span', { class: 'nb-att-type' }, icon('file', { size: 18 }), h('span', { class: 'nb-att-ext' }, ext(a.filename)))),
            h('div', { class: 'nb-att-info' },
              h('span', { class: 'nb-att-name', title: a.filename }, a.filename),
              h('span', { class: 'nb-att-meta' }, h('span', { class: 'nb-att-size' }, formatSize(a.size)), h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'nb-att-date' }, formatDate(a.created_at)),
                a.source === 'script-output' ? h('span', { class: 'nb-tag' }, 'Output') : null)),
            h('div', { class: 'nb-att-actions' },
              iconBtn('external-link', 'Open', { class: 'nb-icon-btn nb-att-open', onClick: () => attAction(a, 'open') }),
              api.hosted ? null : iconBtn('folder', 'Show in folder', { class: 'nb-icon-btn nb-att-reveal', onClick: () => attAction(a, 'reveal') }),
              isTable ? null : iconBtn(isImage(a) ? 'image' : 'plus', isImage(a) ? 'Insert image into page' : 'Insert file into page', { class: 'nb-icon-btn nb-att-insert', onClick: () => editor.insertAttachment(a) }),
              iconBtn('trash', 'Delete attachment', { class: 'nb-icon-btn nb-att-delete', onClick: () => deleteAttachment(a) })))))
          : h('p', { class: 'nb-att-empty' }, 'No attachments yet. Drop files onto the page or ', h('button', { type: 'button', class: 'nb-link-btn', onClick: () => uploadInput.click() }, 'upload'), '.'))
    }

    async function reloadAttachments() {
      try {
        const list = await api.get(`/api/attachments?moduleId=${enc(module.id)}&pageId=${enc(id)}`)
        if (destroyedView) return
        attachments = list
        renderAttachments()
        renderActions()
      } catch (err) {
        console.warn('[notebook] could not reload attachments', err)
      }
    }
    const onAttachmentsChanged = (p) => {
      if (p?.moduleId === module.id && p?.pageId === id) reloadAttachments()
    }
    const onRegistryChanged = (p) => {
      if (p?.kind === 'pageAction') renderActions()
    }
    registry.on('attachments:changed', onAttachmentsChanged)
    registry.on('registry:changed', onRegistryChanged)

    // File drop and file paste anywhere on the page
    let dragDepth = 0
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files')
    pageEl.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return
      dragDepth++
      pageEl.classList.add('is-file-over')
    })
    pageEl.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (!dragDepth) pageEl.classList.remove('is-file-over')
    })
    pageEl.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    })
    pageEl.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth = 0
      pageEl.classList.remove('is-file-over')
      uploadFiles([...e.dataTransfer.files])
    })
    pageEl.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files || [])]
      if (!files.length || e.target.closest?.('.nb-page-title')) return
      e.preventDefault()
      uploadFiles(files)
    })

    /* ---- content */
    if (isTable) {
      const data = page.content && !Array.isArray(page.content) ? page.content : newTable(3, 3)
      let hist
      tableEditor = createTableEditor({ data, full: true, record: (k) => hist.record(k), onChange: () => schedule('content') })
      hist = createHistory({
        capture: () => JSON.stringify(tableEditor.data),
        restore: (json) => {
          const a = document.activeElement
          const at = a?.classList.contains('nb-cell') ? [Number(a.dataset.r), Number(a.dataset.c)] : null
          tableEditor.setData(JSON.parse(json))
          if (at) tableEditor.focusCell(...at)
          schedule('content')
        },
      })
      tableEditor.el.addEventListener('keydown', (e) => {
        const hk = historyKey(e)
        if (!hk) return
        e.preventDefault()
        hist[hk]()
      })
      contentHost.append(tableEditor.el)
    } else {
      editor = createBlockEditor({
        blocks: page.content,
        onChange: () => schedule('content'),
        upload: async (file) => {
          const [att] = await uploadFiles([file])
          if (!att) throw new Error('Upload failed')
          return att
        },
        attachmentUrl: contentUrl,
        openAttachment: (attId) => attAction({ id: attId }, 'open'),
      })
      contentHost.append(editor.el)
    }

    refreshHeader()
    renderActions()
    renderAttachments()

    return {
      id,
      el: pageEl,
      get attachments() {
        return attachments
      },
      editor,
      tableEditor,
      flush,
      refreshCrumbs,
      refreshHeader,
      setTitle(title) {
        if (document.activeElement !== titleEl) titleEl.textContent = title
      },
      mounted() {
        if (!meta.title && !isTable) titleEl.focus()
      },
      discard() {
        dirty.clear()
        clearTimeout(timer)
      },
      destroy() {
        destroyedView = true
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('beforeunload', onPageHide)
        registry.off('attachments:changed', onAttachmentsChanged)
        registry.off('registry:changed', onRegistryChanged)
        editor?.destroy()
      },
    }
  }

  /* ------------------------------------------------------------ boot */

  ;(async () => {
    try {
      setPages(await api.get(`${base}/pages`))
    } catch (err) {
      if (destroyed) return
      pageHost.replaceChildren(h('div', { class: 'nb-empty' }, h('p', { class: 'nb-empty-title' }, 'Could not load this notebook'), h('p', { class: 'nb-empty-text' }, err.message)))
      return
    }
    if (destroyed) return
    state.loaded = true
    renderTree()
    routeTo(mctx.route)
  })()

  return {
    unmount() {
      destroyed = true
      runSearch.cancel()
      if (view) {
        view.flush()
        view.destroy()
      }
      view = null
      root.remove()
    },
    onRoute(route) {
      if (state.loaded) routeTo(route)
      else mctx.route = route
    },
    onModuleChange(m) {
      module = m
      root.dataset.style = m.data?.style === 'table' ? 'table' : 'text'
    },
  }
}
