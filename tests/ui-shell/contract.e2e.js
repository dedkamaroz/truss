import { test, expect } from '@playwright/test'
import { watch, boot, createModule, uid } from './helpers.js'

const FAKE_NOTEBOOK = `
const log = (window.__fake = window.__fake || { imports: 0, init: 0, initArgs: null, mounts: [], routes: [], unmounts: 0, changes: [] })
log.imports++
export default {
  type: 'notebook',
  label: 'Notebook',
  icon: 'notebook',
  init({ registry, api, ui }) {
    log.init++
    log.initArgs = [typeof registry.registerRoute, typeof api.get, typeof ui.h, typeof ui.toast]
    registry.registerRoute('#/fake', {
      title: 'Fake route',
      mount(el, ctx) {
        const div = document.createElement('div')
        div.id = 'fake-route'
        div.textContent = 'Fake route body ' + ctx.route.sub.join(',')
        el.append(div)
        return { unmount() { log.routeUnmounts = (log.routeUnmounts || 0) + 1 } }
      },
    })
    registry.registerSidebarItem({ id: 'fake-item', label: 'Fake item', icon: 'play', href: '#/fake' })
    registry.registerPageAction({ id: 'yes', label: 'Available', isAvailable: (ctx) => ctx.module?.type === 'notebook', run() {} })
    registry.registerPageAction({ id: 'no', label: 'Unavailable', isAvailable: () => false, run() {} })
    registry.registerPageAction({ id: 'always', label: 'Always', run() {} })
  },
  mount(el, mctx) {
    window.__lastMctx = mctx
    log.mounts.push({ id: mctx.module.id, title: mctx.module.title, route: mctx.route, keys: Object.keys(mctx).sort(),
      types: [typeof mctx.api.get, typeof mctx.ui.modal, typeof mctx.registry.on, typeof mctx.navigate] })
    const body = document.createElement('div')
    body.className = 'fake-notebook'
    body.textContent = 'Fake notebook ' + mctx.module.title
    el.append(body)
    return {
      unmount() { log.unmounts++ },
      onRoute(route) { log.routes.push(route) },
      onModuleChange(module) { log.changes.push(module.title) },
    }
  },
}
`

test('module contract: init once, mount/onRoute/unmount, registry routes, sidebar items, page actions, broken module tolerated', async ({ page }) => {
  const w = await watch(page)
  await page.route('**/modules/notebook/index.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_NOTEBOOK }))
  await page.route('**/modules/database/index.js', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("database module exploded at import")' }))

  await boot(page)
  const nb = await createModule(page, { type: 'notebook', title: `Contract ${uid()}` })
  const nb2 = await createModule(page, { type: 'notebook', title: `Contract two ${uid()}` })
  const db = await createModule(page, { type: 'database', title: `Broken db ${uid()}` })
  await page.goto('/#/')
  await page.reload()
  await expect(page.locator('html[data-ready="true"]')).toHaveCount(1)
  await expect(page.locator(`.sidebar-item[data-id="${nb.id}"]`)).toBeVisible()

  await expect.poll(() => page.evaluate(() => window.__fake?.init)).toBe(1)
  expect(await page.evaluate(() => window.__fake.initArgs)).toEqual(['function', 'function', 'function', 'function'])

  // mount with the full mctx
  await page.goto(`/#/m/${nb.id}/p/x`)
  await expect(page.locator('.fake-notebook')).toContainText(nb.title)
  let log = await page.evaluate(() => window.__fake)
  expect(log.mounts).toHaveLength(1)
  expect(log.mounts[0].id).toBe(nb.id)
  expect(log.mounts[0].route).toEqual({ moduleId: nb.id, sub: ['p', 'x'] })
  expect(log.mounts[0].keys).toEqual(['api', 'module', 'navigate', 'registry', 'route', 'ui'])
  expect(log.mounts[0].types).toEqual(['function', 'function', 'function', 'function'])

  // sub-route change calls onRoute, not a remount
  await page.goto(`/#/m/${nb.id}/p/y`)
  await expect.poll(() => page.evaluate(() => window.__fake.routes.length)).toBe(1)
  log = await page.evaluate(() => window.__fake)
  expect(log.routes[0]).toEqual({ moduleId: nb.id, sub: ['p', 'y'] })
  expect(log.mounts).toHaveLength(1)
  expect(log.unmounts).toBe(0)

  // renaming from the shell notifies the mounted module
  await page.locator('.page-title').fill('Renamed by shell')
  await page.locator('.page-title').press('Enter')
  await expect.poll(() => page.evaluate(() => window.__fake.changes.at(-1))).toBe('Renamed by shell')

  // another module: unmount then mount
  await page.goto(`/#/m/${nb2.id}`)
  await expect(page.locator('.fake-notebook')).toContainText(nb2.title)
  log = await page.evaluate(() => window.__fake)
  expect(log.unmounts).toBe(1)
  expect(log.mounts).toHaveLength(2)

  // mctx.navigate moves the hash
  await page.evaluate(() => window.__lastMctx.navigate('#/archive'))
  await expect(page).toHaveURL(/#\/archive$/)
  expect(await page.evaluate(() => window.__fake.unmounts)).toBe(2)

  // registered sidebar item and route
  const item = page.locator('.sidebar-link', { hasText: 'Fake item' })
  await expect(item).toBeVisible()
  await item.click()
  await expect(page).toHaveURL(/#\/fake$/)
  await expect(page.locator('#fake-route')).toBeVisible()
  await expect(item).toHaveClass(/is-active/)
  await expect(page.locator('.breadcrumb')).toContainText('Fake route')
  await page.goto('/#/fake/a/b')
  await expect(page.locator('#fake-route')).toBeVisible()

  // page actions filtered by isAvailable
  const ids = await page.evaluate(async () => {
    const { getPageActions } = await import('/lib/registry.js')
    return {
      notebook: getPageActions({ module: { type: 'notebook' }, pageId: 'p1', attachments: [] }).map((a) => a.id),
      sheet: getPageActions({ module: { type: 'sheet' }, pageId: null, attachments: [] }).map((a) => a.id),
    }
  })
  expect(ids.notebook.sort()).toEqual(['always', 'yes'])
  expect(ids.sheet).toEqual(['always'])

  // the module that threw at import did not break the shell: its type shows the placeholder
  await page.goto(`/#/m/${db.id}`)
  await expect(page.locator('.module-placeholder')).toBeVisible()
  expect(await page.evaluate(() => window.__fake.imports)).toBe(1)

  // direct boot onto a module sub-route mounts once with the sub-route
  await page.goto(`/#/m/${nb.id}/p/deep`)
  await page.reload()
  await expect(page.locator('.fake-notebook')).toBeVisible()
  const fresh = await page.evaluate(() => window.__fake)
  expect(fresh.init).toBe(1)
  expect(fresh.mounts).toHaveLength(1)
  expect(fresh.mounts[0].route).toEqual({ moduleId: nb.id, sub: ['p', 'deep'] })

  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})

test('event bus on/off/emit', async ({ page }) => {
  await boot(page)
  const result = await page.evaluate(async () => {
    const { on, off, emit } = await import('/lib/registry.js')
    const seen = []
    const fn = (p) => seen.push(p)
    on('attachments:changed', fn)
    emit('attachments:changed', { moduleId: 'm', pageId: 'p' })
    off('attachments:changed', fn)
    emit('attachments:changed', { moduleId: 'x' })
    return seen
  })
  expect(result).toEqual([{ moduleId: 'm', pageId: 'p' }])
})
