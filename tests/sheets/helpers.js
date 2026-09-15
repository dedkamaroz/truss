import { expect } from '@playwright/test'
import fs from 'node:fs'

export const uid = () => Math.random().toString(36).slice(2, 8)

export async function shot(page, name) {
  fs.mkdirSync('test-results/sheets', { recursive: true })
  await page.screenshot({ path: `test-results/sheets/${name}.png` })
}

/** Records console errors, page errors and native dialogs. */
export function watch(page) {
  const w = { errors: [], dialogs: [] }
  page.on('console', (m) => m.type() === 'error' && w.errors.push(m.text()))
  page.on('pageerror', (e) => w.errors.push(e.message))
  page.on('dialog', (d) => {
    w.dialogs.push(`${d.type()}: ${d.message()}`)
    d.dismiss().catch(() => {})
  })
  return w
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

export async function boot(page) {
  await page.goto('/#/')
  await expect(page.locator('html[data-ready="true"]')).toHaveCount(1)
}

/** Creates a workbook via the API and opens it. Returns { module, data }. */
export async function openWorkbook(page, { template = 'blank', title } = {}) {
  if (!page.url().includes('127.0.0.1')) await boot(page)
  const r = await apiCall(page, 'POST', '/api/modules', { type: 'sheet', template, title: title || `Book ${uid()}` })
  expect(r.status).toBe(201)
  await page.goto(`/#/m/${r.body.id}`)
  await waitGrid(page)
  return r.body
}

export async function waitGrid(page) {
  await expect(page.locator('.sheet-app .sheet-cell').first()).toBeVisible()
  await page.waitForFunction(() => window.__trussSheet?.model)
}

/** Centre of a visible cell in page coordinates (0-based row/col), located via the rendered headers. */
export async function cellPoint(page, row, col) {
  return page.evaluate(({ row, col }) => {
    let s = ''
    for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
    const grid = document.querySelector('.sheet-grid').getBoundingClientRect()
    const within = (r) => r.width > 0 && r.left >= grid.left - 1 && r.right <= grid.right + 1 && r.top >= grid.top - 1 && r.bottom <= grid.bottom + 1
    const colHead = [...document.querySelectorAll('.head-col .sheet-hcell')].find((e) => e.textContent === s && within(e.getBoundingClientRect()))
    const rowHead = [...document.querySelectorAll('.head-row .sheet-hcell')].find((e) => e.textContent === String(row + 1) && within(e.getBoundingClientRect()))
    if (!colHead || !rowHead) return null
    const a = colHead.getBoundingClientRect()
    const b = rowHead.getBoundingClientRect()
    return { x: a.left + a.width / 2, y: b.top + b.height / 2 }
  }, { row, col })
}

export async function clickCell(page, a1, opts = {}) {
  const { row, col } = parseA1(a1)
  const p = await cellPoint(page, row, col)
  if (!p) throw new Error(`cell ${a1} not visible`)
  await page.mouse.click(p.x, p.y, opts)
}

export function parseA1(a1) {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)
  const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  return { row: Number(m[2]) - 1, col }
}

/** Text of the DOM cell element at a1 (what the user actually sees). */
export async function domCellText(page, a1) {
  const { row, col } = parseA1(a1)
  const p = await cellPoint(page, row, col)
  if (!p) return null
  return page.evaluate(({ x, y }) => {
    const els = document.elementsFromPoint(x, y)
    const cell = els.find((e) => e.classList?.contains('sheet-cell'))
    return cell ? cell.textContent : null
  }, p)
}

export async function rawOf(page, a1, sheetName) {
  const { row, col } = parseA1(a1)
  return page.evaluate(({ row, col, sheetName }) => {
    const h = window.__trussSheet
    const s = sheetName ? h.model.sheetByName(sheetName) : h.sheet
    return h.model.getRaw(s.id, row, col)
  }, { row, col, sheetName })
}

export async function typeInto(page, a1, text, key = 'Enter') {
  await clickCell(page, a1)
  await page.keyboard.type(text)
  await page.keyboard.press(key)
}

export async function flushSaves(page) {
  await page.evaluate(async () => {
    const m = window.__trussSheet.model
    await m.flush()
    await m.chain
  })
}
