// UI toolkit: DOM builder, layered overlays (modals, menus, popovers), toasts, formatting.
// Never uses alert/confirm/prompt.

import { icon, hasIcon } from './icons.js'

/* ---------------------------------------------------------------- DOM builder */

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue
      if (k === 'class' || k === 'className') el.className = v
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'indeterminate') el[k] = v
      else if (k === 'text') el.textContent = v
      else el.setAttribute(k, v === true ? '' : v)
    }
  }
  append(el, children)
  return el
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false || c === true) continue
    if (Array.isArray(c)) append(el, c)
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

/* ---------------------------------------------------------------- helpers */

export function debounce(fn, ms = 200) {
  let t
  const d = function (...args) {
    clearTimeout(t)
    t = setTimeout(() => fn.apply(this, args), ms)
  }
  d.cancel = () => clearTimeout(t)
  return d
}

const loadedCss = new Map()
export function loadCss(href) {
  const url = new URL(href, location.href).href
  if (loadedCss.has(url)) return loadedCss.get(url)
  const existing = [...document.querySelectorAll('link[rel="stylesheet"]')].find((l) => l.href === url)
  const p = existing ? Promise.resolve(existing) : new Promise((resolve) => {
    const link = h('link', { rel: 'stylesheet', href: url })
    link.addEventListener('load', () => resolve(link))
    link.addEventListener('error', () => resolve(link))
    document.head.appendChild(link)
  })
  loadedCss.set(url, p)
  return p
}

/* ---------------------------------------------------------------- dates (Australia/Sydney) */

const TZ = 'Australia/Sydney'
const dateFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
const dateTimeFmt = new Intl.DateTimeFormat('en-AU', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
})

function toDate(iso) {
  if (iso == null || iso === '') return null
  const d = iso instanceof Date ? iso : new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDate(iso) {
  const m = typeof iso === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (m) return `${m[3]}/${m[2]}/${m[1]}` // plain calendar date, no timezone shift
  const d = toDate(iso)
  if (!d) return ''
  const p = Object.fromEntries(dateFmt.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.day}/${p.month}/${p.year}`
}

export function formatDateTime(iso) {
  const d = toDate(iso)
  if (!d) return ''
  const p = Object.fromEntries(dateTimeFmt.formatToParts(d).map((x) => [x.type, x.value]))
  let tz = p.timeZoneName || ''
  if (tz !== 'AEST' && tz !== 'AEDT') tz = /11/.test(tz) ? 'AEDT' : 'AEST'
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${(p.dayPeriod || '').toLowerCase()} ${tz}`
}

/** "just now", "5 min ago", "3 h ago", "yesterday", else DD/MM/YYYY. */
export function formatRelative(iso) {
  const d = toDate(iso)
  if (!d) return ''
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 172800) return 'yesterday'
  return formatDate(iso)
}

/* ---------------------------------------------------------------- layer stack */

const layers = [] // { el, close(value), trap, restoreFocus, dismissOnOutside }
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"], [contenteditable="plaintext-only"]'

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
}

export function hasOpenLayer() {
  return layers.length > 0
}

function pushLayer(layer) {
  layer.restoreFocus = document.activeElement
  layers.push(layer)
}

function removeLayer(layer) {
  const i = layers.indexOf(layer)
  if (i < 0) return false
  layers.splice(i, 1)
  layer.el.remove()
  const target = layer.restoreFocus
  if (target && target.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true })
  return true
}

document.addEventListener('keydown', (e) => {
  const top = layers[layers.length - 1]
  if (!top) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    top.close(null)
    return
  }
  if (e.key === 'Tab' && top.trap) {
    const items = focusables(top.el)
    if (!items.length) {
      e.preventDefault()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const inside = top.el.contains(document.activeElement)
    if (e.shiftKey && (document.activeElement === first || !inside)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
      e.preventDefault()
      first.focus()
    }
  }
}, true)

// Focus must not escape a trapped layer (e.g. via mouse clicks on the backdrop).
document.addEventListener('focusin', (e) => {
  const top = layers[layers.length - 1]
  if (top?.trap && !top.el.contains(e.target)) {
    const items = focusables(top.el)
    ;(items[0] || top.el).focus({ preventScroll: true })
  }
})

document.addEventListener('mousedown', (e) => {
  const top = layers[layers.length - 1]
  if (top?.dismissOnOutside && !top.el.contains(e.target) && !top.anchor?.contains(e.target)) top.close(null)
}, true)

/* ---------------------------------------------------------------- buttons */

export function button(label, { variant = 'secondary', size, iconName, onClick, title, type = 'button', ...rest } = {}) {
  const cls = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', !label ? 'btn-icon' : ''].filter(Boolean).join(' ')
  return h('button', { type, class: cls, title, 'aria-label': !label ? title : null, onClick, ...rest },
    iconName ? icon(iconName, { size: size === 'sm' ? 14 : 16 }) : null,
    label ? h('span', { class: 'btn-label' }, label) : null)
}

/* ---------------------------------------------------------------- modal */

let modalSeq = 0

/**
 * modal({ title, body, actions, size, onOpen }) -> Promise<value|null>
 * body: string | Node | (close) => Node. actions: [{ label, value, variant: 'primary'|'danger'|'secondary', autofocus }]
 * Resolves with the chosen action value, or null when dismissed (Esc, backdrop, close button).
 */
export function modal({ title = '', description, body, actions = [{ label: 'Close', value: null }], size = 'md', onOpen, className = '' } = {}) {
  return new Promise((resolve) => {
    const id = `modal-title-${++modalSeq}`
    let settled = false
    const layer = { trap: true }
    const close = (value = null) => {
      if (settled) return
      settled = true
      removeLayer(layer)
      resolve(value)
    }
    layer.close = close
    const content = typeof body === 'function' ? body(close) : body
    const footer = actions?.length
      ? h('div', { class: 'modal-footer' }, actions.map((a) => {
        const b = button(a.label, { variant: a.variant || 'secondary', onClick: () => close(a.value === undefined ? a.label : a.value) })
        if (a.autofocus) b.dataset.autofocus = ''
        return b
      }))
      : null
    const dialog = h('div', { class: `modal modal-${size} ${className}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': title ? id : null, tabindex: '-1' },
      title ? h('div', { class: 'modal-header' },
        h('div', { class: 'modal-titles' },
          h('h2', { class: 'modal-title', id }, title),
          description ? h('p', { class: 'modal-description' }, description) : null),
        button('', { variant: 'ghost', size: 'sm', iconName: 'close', title: 'Close', class: 'btn btn-ghost btn-sm btn-icon modal-close', onClick: () => close(null) })) : null,
      h('div', { class: 'modal-body' }, typeof content === 'string' ? h('p', { class: 'modal-text' }, content) : content),
      footer)
    const backdrop = h('div', { class: 'modal-backdrop', onMousedown: (e) => { if (e.target === backdrop) close(null) } }, dialog)
    layer.el = backdrop
    pushLayer(layer)
    document.body.appendChild(backdrop)
    const auto = dialog.querySelector('[autofocus], [data-autofocus]') || focusables(dialog.querySelector('.modal-body'))[0] || footer?.querySelector('.btn-primary, .btn-danger') || dialog
    auto.focus({ preventScroll: true })
    onOpen?.({ close, dialog })
  })
}

export async function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  const result = await modal({
    title,
    body: message,
    size: 'sm',
    className: 'modal-confirm',
    actions: [
      { label: cancelLabel, value: false },
      { label: confirmLabel, value: true, variant: danger ? 'danger' : 'primary', autofocus: true },
    ],
  })
  return result === true
}

export async function promptDialog({ title = '', label = '', value = '', placeholder = '', confirmLabel = 'Save' } = {}) {
  const input = h('input', { class: 'input', type: 'text', value, placeholder, 'aria-label': label || title, autofocus: true })
  let submit
  const form = h('form', { class: 'form-field', onSubmit: (e) => { e.preventDefault(); submit?.() } },
    label ? h('label', { class: 'field-label' }, label) : null, input)
  const result = await modal({
    title,
    size: 'sm',
    body: (close) => {
      submit = () => close('__submit__')
      return form
    },
    onOpen: () => input.select(),
    actions: [
      { label: 'Cancel', value: null },
      { label: confirmLabel, value: '__submit__', variant: 'primary' },
    ],
  })
  return result === '__submit__' ? input.value : null
}

/* ---------------------------------------------------------------- popovers & menus */

function position(el, anchor, { align = 'start', gap = 4 } = {}) {
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor
  el.style.left = '0px'
  el.style.top = '0px'
  const w = el.offsetWidth
  const hgt = el.offsetHeight
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  let left = align === 'end' ? r.right - w : r.left
  let top = r.bottom + gap
  if (top + hgt > vh - 8) top = Math.max(8, r.top - hgt - gap)
  left = Math.min(Math.max(8, left), vw - w - 8)
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
}

/** Opens a floating layer next to anchor. Returns { el, close }. Esc and outside clicks close it. */
export function popover(anchorEl, content, { className = '', align, onClose, role } = {}) {
  const layer = { dismissOnOutside: true, anchor: anchorEl instanceof Element ? anchorEl : null }
  const el = h('div', { class: `popover ${className}`.trim(), role })
  el.appendChild(content)
  layer.el = el
  let closed = false
  layer.close = (value) => {
    if (closed) return
    closed = true
    removeLayer(layer)
    anchorEl?.classList?.remove('is-open')
    onClose?.(value)
  }
  pushLayer(layer)
  document.body.appendChild(el)
  anchorEl?.classList?.add('is-open')
  position(el, anchorEl, { align })
  return { el, close: layer.close }
}

/**
 * menu(anchorEl, items) where items are { label, icon?, onClick, danger?, disabled?, shortcut? } or 'divider'.
 * Arrow keys move, Enter/Space activate, Esc closes and restores focus.
 */
export function menu(anchorEl, items, { align = 'start' } = {}) {
  const list = h('div', { class: 'menu', role: 'menu' })
  const buttons = []
  let pop
  for (const item of items) {
    if (!item) continue
    if (item === 'divider') {
      list.appendChild(h('div', { class: 'menu-divider', role: 'separator' }))
      continue
    }
    if (item.header) {
      list.appendChild(h('div', { class: 'menu-header' }, item.header))
      continue
    }
    const iconEl = item.icon ? (hasIcon(item.icon) ? icon(item.icon, { size: 16 }) : h('span', { class: 'menu-emoji' }, item.icon)) : null
    const b = h('button', {
      type: 'button',
      role: 'menuitem',
      class: `menu-item${item.danger ? ' is-danger' : ''}`,
      disabled: item.disabled,
      tabindex: '-1',
      onClick: () => {
        pop.close()
        item.onClick?.()
      },
    }, h('span', { class: 'menu-item-icon' }, iconEl), h('span', { class: 'menu-item-label' }, item.label),
    item.shortcut ? h('kbd', { class: 'menu-item-shortcut' }, item.shortcut) : null)
    buttons.push(b)
    list.appendChild(b)
  }
  const enabled = () => buttons.filter((b) => !b.disabled)
  list.addEventListener('keydown', (e) => {
    const all = enabled()
    const i = all.indexOf(document.activeElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = all.length
      if (!n) return
      const next = e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n
      all[i < 0 ? 0 : next].focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      all[e.key === 'Home' ? 0 : all.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      pop.close()
    }
  })
  list.addEventListener('mousemove', (e) => {
    const b = e.target.closest('.menu-item')
    if (b && !b.disabled && document.activeElement !== b) b.focus({ preventScroll: true })
  })
  pop = popover(anchorEl, list, { className: 'popover-menu', align })
  enabled()[0]?.focus({ preventScroll: true })
  return pop
}

/* ---------------------------------------------------------------- toasts */

let toastRoot
export function toast(message, { type = 'info', duration = 3600 } = {}) {
  if (!toastRoot || !toastRoot.isConnected) {
    toastRoot = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' })
    document.body.appendChild(toastRoot)
  }
  const iconName = type === 'success' ? 'check' : type === 'error' ? 'alert' : 'info'
  const el = h('div', { class: `toast toast-${type}` },
    h('span', { class: 'toast-icon' }, icon(iconName, { size: 16, strokeWidth: 2 })),
    h('span', { class: 'toast-message' }, message),
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onClick: () => dismiss() }, icon('close', { size: 14 })))
  let timer
  const dismiss = () => {
    clearTimeout(timer)
    el.classList.add('is-leaving')
    setTimeout(() => el.remove(), 160)
  }
  toastRoot.appendChild(el)
  while (toastRoot.children.length > 4) toastRoot.firstElementChild.remove()
  timer = setTimeout(dismiss, type === 'error' ? duration * 1.6 : duration)
  el.addEventListener('mouseenter', () => clearTimeout(timer))
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1500) })
  return { dismiss }
}

/* ---------------------------------------------------------------- emoji picker */

const EMOJI = [
  ['📄', 'page document'], ['📝', 'memo note write'], ['📓', 'notebook'], ['📔', 'notebook decorative'], ['📒', 'ledger'], ['📚', 'books library'],
  ['📖', 'book open read'], ['🗂️', 'dividers index'], ['📁', 'folder'], ['🗃️', 'card file box database'], ['🗄️', 'cabinet'], ['📊', 'chart bar'],
  ['📈', 'chart up growth'], ['📉', 'chart down'], ['🧮', 'abacus calculate'], ['💰', 'money bag'], ['💵', 'dollar cash'], ['🧾', 'receipt'],
  ['📅', 'calendar date'], ['🗓️', 'calendar spiral'], ['⏰', 'alarm clock'], ['✅', 'check done'], ['☑️', 'ballot check'], ['📌', 'pin'],
  ['📎', 'paperclip attachment'], ['🔖', 'bookmark'], ['🏷️', 'label tag'], ['🔍', 'search magnify'], ['💡', 'idea bulb'], ['🎯', 'target goal'],
  ['🚀', 'rocket launch'], ['⭐', 'star'], ['🔥', 'fire hot'], ['⚡', 'lightning fast'], ['🧠', 'brain think'], ['🛠️', 'tools build'],
  ['⚙️', 'gear settings'], ['🧪', 'test lab'], ['🔬', 'microscope research'], ['💻', 'laptop computer'], ['🖥️', 'desktop'], ['📱', 'phone mobile'],
  ['🔒', 'lock secure'], ['🔑', 'key'], ['🛡️', 'shield security'], ['🕵️', 'detective investigate'], ['🧩', 'puzzle'], ['📦', 'package box'],
  ['🏠', 'home house'], ['🏢', 'office building'], ['🏦', 'bank'], ['✈️', 'travel plane'], ['🌏', 'globe australia world'], ['🦘', 'kangaroo australia'],
  ['🌿', 'plant leaf'], ['🌸', 'flower blossom'], ['☀️', 'sun'], ['🌙', 'moon night'], ['☕', 'coffee'], ['🍎', 'apple food'],
  ['🎨', 'art palette design'], ['🎵', 'music'], ['📷', 'camera photo'], ['🎬', 'film video'], ['🎓', 'graduation study'], ['🏆', 'trophy award'],
  ['❤️', 'heart love'], ['👋', 'wave hello'], ['👥', 'people team'], ['🤝', 'handshake deal'], ['📞', 'telephone call'], ['✉️', 'envelope email'],
  ['💬', 'speech chat'], ['📣', 'megaphone announce'], ['🗺️', 'map'], ['🧭', 'compass'], ['⚠️', 'warning'], ['❓', 'question'],
  ['🟥', 'red square'], ['🟧', 'orange square'], ['🟨', 'yellow square'], ['🟩', 'green square'], ['🟦', 'blue square'], ['🟪', 'purple square'],
]

/** Opens an emoji grid next to anchor. Resolves with the emoji, '' for "Remove", or null when dismissed. */
export function emojiPicker(anchorEl, { allowRemove = true } = {}) {
  return new Promise((resolve) => {
    let result = null
    const search = h('input', { class: 'input input-sm', type: 'search', placeholder: 'Filter emoji', 'aria-label': 'Filter emoji' })
    const grid = h('div', { class: 'emoji-grid', role: 'listbox', 'aria-label': 'Emoji' })
    const pick = (value) => {
      result = value
      pop.close(value)
    }
    const render = () => {
      const q = search.value.trim().toLowerCase()
      grid.replaceChildren(...EMOJI.filter(([, k]) => !q || k.includes(q)).map(([e, k]) =>
        h('button', { type: 'button', class: 'emoji-option', role: 'option', title: k.split(' ')[0], 'aria-label': k.split(' ')[0], onClick: () => pick(e) }, e)))
      if (!grid.children.length) grid.appendChild(h('div', { class: 'emoji-empty' }, 'No matches'))
    }
    search.addEventListener('input', render)
    grid.addEventListener('keydown', (e) => {
      const opts = [...grid.querySelectorAll('.emoji-option')]
      const i = opts.indexOf(document.activeElement)
      if (i < 0) return
      const cols = 8
      const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key]
      if (delta) {
        e.preventDefault()
        opts[Math.min(opts.length - 1, Math.max(0, i + delta))].focus()
      }
    })
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        const first = grid.querySelector('.emoji-option')
        if (!first) return
        e.preventDefault()
        if (e.key === 'Enter') first.click()
        else first.focus()
      }
    })
    render()
    const content = h('div', { class: 'emoji-picker' },
      h('div', { class: 'emoji-picker-head' }, search,
        allowRemove ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => pick('') }, 'Remove') : null),
      grid)
    const pop = popover(anchorEl, content, { className: 'popover-emoji', onClose: () => resolve(result) })
    search.focus({ preventScroll: true })
  })
}

export { icon }

export const ui = {
  h, button, modal, confirmDialog, promptDialog, toast, menu, popover, emojiPicker, loadCss, debounce,
  formatDate, formatDateTime, formatRelative, icon, hasOpenLayer,
}

export default ui
