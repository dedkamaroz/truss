import { expect } from '@playwright/test'
import fs from 'node:fs'

export const uid = () => Math.random().toString(36).slice(2, 8)

export const shot = (page, name) => {
  fs.mkdirSync('test-results/ui-shell', { recursive: true })
  return page.screenshot({ path: `test-results/ui-shell/${name}.png` })
}

/** Records console errors, page errors, CSP violations and any native dialog. */
export async function watch(page) {
  const w = { errors: [], dialogs: [] }
  page.on('console', (m) => m.type() === 'error' && w.errors.push(m.text()))
  page.on('pageerror', (e) => w.errors.push(e.message))
  page.on('dialog', (d) => {
    w.dialogs.push(`${d.type()}: ${d.message()}`)
    d.dismiss().catch(() => {})
  })
  await page.addInitScript(() => {
    window.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
  })
  return w
}

export async function boot(page, hash = '#/') {
  await page.goto('/' + hash)
  await expect(page.locator('html[data-ready="true"]')).toHaveCount(1)
}

export async function apiCall(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const token = document.querySelector('meta[name="truss-token"]').content
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Truss-Token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }, { method, path, body })
}

export async function createModule(page, body) {
  const r = await apiCall(page, 'POST', '/api/modules', body)
  expect(r.status).toBe(201)
  return r.body
}
