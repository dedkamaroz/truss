import { expect } from '@playwright/test'
import fs from 'node:fs'
import { watch, boot, apiCall, createModule, uid } from '../ui-shell/helpers.js'

export { watch, boot, apiCall, createModule, uid }

export const shot = (page, name) => {
  fs.mkdirSync('test-results/database', { recursive: true })
  return page.screenshot({ path: `test-results/database/${name}.png` })
}

export async function api(page, method, path, body, status) {
  const r = await apiCall(page, method, path, body)
  if (status) expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBe(status)
  else expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300)
  return r.body
}

export const load = (page, id) => api(page, 'GET', `/api/databases/${id}`)

/** Creates a database module (via API) and opens it. Returns { module, data, base }. */
export async function openDb(page, { template = 'blank', title, setup } = {}) {
  await boot(page)
  const module = await createModule(page, { type: 'database', template, title: title || `DB ${uid()}` })
  const base = `/api/databases/${module.id}`
  if (setup) await setup({ module, base, data: await load(page, module.id) })
  await page.goto(`/#/m/${module.id}`)
  await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1)
  return { module, base, data: await load(page, module.id) }
}

/** Waits until the server has the view config matching predicate (view saves are debounced). */
export async function expectViewConfig(page, moduleId, viewId, predicate) {
  await expect.poll(async () => {
    const d = await load(page, moduleId)
    return predicate(d.views.find((v) => v.id === viewId)?.config || {})
  }, { timeout: 5000 }).toBe(true)
}

export const cell = (page, rowId, propId) => page.locator(`.db-tr[data-row-id="${rowId}"] .db-td[data-prop="${propId}"]`)
export const rowTitles = (page) => page.locator('.db-tr .db-td[data-type="title"] .db-title-text').allTextContents()
