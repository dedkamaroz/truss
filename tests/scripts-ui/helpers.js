import { expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { watch, boot, apiCall, createModule, uid } from '../ui-shell/helpers.js'

export { watch, boot, apiCall, createModule, uid }

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
export const fixture = (name) => path.join(FIXTURES, name)

export const shot = (page, name) => {
  fs.mkdirSync('test-results/scripts-ui', { recursive: true })
  return page.screenshot({ path: `test-results/scripts-ui/${name}.png` })
}

export async function setTheme(page, theme) {
  await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
  await page.waitForTimeout(350) // let colour transitions settle before screenshots
}

export async function registerScript(page, file, extra = {}) {
  const r = await apiCall(page, 'POST', '/api/scripts', { path: fixture(file), ...extra })
  expect(r.status).toBe(201)
  return r.body
}

/** Removes every registered script so each test starts from a known list. */
export async function clearScripts(page) {
  for (const s of (await apiCall(page, 'GET', '/api/scripts')).body) await apiCall(page, 'DELETE', `/api/scripts/${s.id}`)
}

export async function uploadText(page, moduleId, pageId, filename, text) {
  return page.evaluate(async ({ moduleId, pageId, filename, text }) => {
    const token = document.querySelector('meta[name="truss-token"]').content
    const res = await fetch(`/api/attachments?moduleId=${moduleId}&pageId=${pageId}`, { method: 'POST', headers: { 'X-Truss-Token': token, 'X-Filename': encodeURIComponent(filename) }, body: text })
    return res.json()
  }, { moduleId, pageId, filename, text })
}

/** Creates a notebook from a template and returns { module, pages }. */
export async function notebook(page, template) {
  const module = await createModule(page, { type: 'notebook', template, title: `NB ${uid()}` })
  const pages = (await apiCall(page, 'GET', `/api/notebooks/${module.id}/pages`)).body
  return { module, pages }
}

export async function openPage(page, moduleId, pageId) {
  await page.goto(`/#/m/${moduleId}/p/${pageId}`)
  await expect(page.locator(`.nb-page[data-page-id="${pageId}"]`)).toBeVisible()
}

export async function waitRun(page, runId, timeout = 60000) {
  let run
  await expect.poll(async () => {
    run = (await apiCall(page, 'GET', `/api/runs/${runId}`)).body
    return ['queued', 'running'].includes(run.status)
  }, { timeout }).toBe(false)
  return run
}
