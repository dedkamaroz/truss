// Shared registry: routes, sidebar items, page actions and a tiny event bus.

const routes = new Map() // normalised prefix ('/scripts') -> { prefix, title, mount }
const sidebarItems = new Map() // id -> { id, label, icon, href }
const pageActions = new Map() // id -> { id, label, icon, isAvailable, run }
const listeners = new Map() // event -> Set<fn>

function normalisePrefix(prefix) {
  let p = String(prefix || '').replace(/^#/, '')
  if (!p.startsWith('/')) p = '/' + p
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event).add(fn)
  return () => off(event, fn)
}

export function off(event, fn) {
  listeners.get(event)?.delete(fn)
}

export function emit(event, payload) {
  for (const fn of [...(listeners.get(event) || [])]) {
    try {
      fn(payload)
    } catch (err) {
      console.warn(`[truss] "${event}" listener failed:`, err)
    }
  }
}

export function registerRoute(prefix, { title, mount } = {}) {
  if (typeof mount !== 'function') throw new Error('registerRoute: mount(el, ctx) is required')
  const p = normalisePrefix(prefix)
  routes.set(p, { prefix: p, title: title || p.slice(1), mount })
  emit('registry:changed', { kind: 'route', prefix: p })
}

/** Finds the registered route for a hash path such as '/scripts/abc'. Longest prefix wins. */
export function matchRoute(path) {
  let best = null
  for (const r of routes.values()) {
    if (path === r.prefix || path.startsWith(r.prefix + '/')) {
      if (!best || r.prefix.length > best.prefix.length) best = r
    }
  }
  return best
}

export function getRoutes() {
  return [...routes.values()]
}

export function registerSidebarItem({ id, label, icon, href } = {}) {
  if (!id) throw new Error('registerSidebarItem: id is required')
  sidebarItems.set(id, { id, label: label || id, icon, href: href || '#/' })
  emit('registry:changed', { kind: 'sidebar', id })
}

export function getSidebarItems() {
  return [...sidebarItems.values()]
}

export function registerPageAction({ id, label, icon, isAvailable, run } = {}) {
  if (!id) throw new Error('registerPageAction: id is required')
  if (typeof run !== 'function') throw new Error('registerPageAction: run(ctx) is required')
  pageActions.set(id, { id, label: label || id, icon, isAvailable, run })
  emit('registry:changed', { kind: 'pageAction', id })
}

export function getPageActions(ctx) {
  return [...pageActions.values()].filter((a) => {
    if (typeof a.isAvailable !== 'function') return true
    try {
      return !!a.isAvailable(ctx)
    } catch (err) {
      console.warn(`[truss] page action "${a.id}" isAvailable failed:`, err)
      return false
    }
  })
}

export const registry = {
  registerRoute,
  matchRoute,
  getRoutes,
  registerSidebarItem,
  getSidebarItems,
  registerPageAction,
  getPageActions,
  on,
  off,
  emit,
}

export default registry
