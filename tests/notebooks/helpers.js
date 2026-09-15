import { expect } from '@playwright/test'
import fs from 'node:fs'
import { watch, boot, apiCall, createModule, uid } from '../ui-shell/helpers.js'

export { watch, boot, apiCall, createModule, uid }

export const shot = (page, name) => {
  fs.mkdirSync('test-results/notebooks', { recursive: true })
  return page.screenshot({ path: `test-results/notebooks/${name}.png` })
}

export const api = (page, method, path, body) => apiCall(page, method, path, body)

/** Creates a notebook (optionally from a template) and returns { module, pages }. */
export async function notebook(page, { template = 'blank', title = `NB ${uid()}` } = {}) {
  const module = await createModule(page, { type: 'notebook', template, title })
  const pages = (await apiCall(page, 'GET', `/api/notebooks/${module.id}/pages`)).body
  return { module, pages }
}

export async function createPage(page, moduleId, body = {}) {
  const r = await apiCall(page, 'POST', `/api/notebooks/${moduleId}/pages`, body)
  expect(r.status).toBe(201)
  return r.body
}

export async function getPage(page, moduleId, pageId) {
  return (await apiCall(page, 'GET', `/api/notebooks/${moduleId}/pages/${pageId}`)).body
}

/** Opens a page and waits for its view to render. */
export async function openPage(page, moduleId, pageId) {
  await page.goto(`/#/m/${moduleId}/p/${pageId}`)
  await expect(page.locator(`.nb-page[data-page-id="${pageId}"]`)).toBeVisible()
}

/** Waits until the open page reports all edits saved. */
export async function saved(page) {
  await expect(page.locator('.nb-page')).toHaveAttribute('data-save-state', 'saved', { timeout: 5000 })
}

export const block = (page, i) => page.locator('.nb-blocks > .nb-block').nth(i)
export const blockText = (page, i) => block(page, i).locator('.nb-text[data-field="html"]')

/** Places the caret at a text offset inside an element (Infinity = end). */
export async function caret(locator, offset = Infinity) {
  await locator.evaluate((el, off) => {
    el.focus()
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let left = off === null ? Infinity : off
    let node = null
    let pos = 0
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      node = n
      if (left <= n.data.length) {
        pos = left
        break
      }
      left -= n.data.length
      pos = n.data.length
    }
    const r = document.createRange()
    if (node) r.setStart(node, Math.min(pos, node.data.length))
    else r.setStart(el, 0)
    r.collapse(true)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
  }, offset === Infinity ? null : offset)
}

/** Blocks as stored on the server: [{ type, html, props }]. */
export async function storedBlocks(page, moduleId, pageId) {
  return (await getPage(page, moduleId, pageId)).content.map(({ type, html, props }) => ({ type, html, props }))
}
