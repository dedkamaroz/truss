import { expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { watch, boot, apiCall, createModule, uid, api, load, cell } from '../database/helpers.js'

export { watch, boot, apiCall, createModule, uid, api, load, cell }

export const OUT = 'test-results/database-relations-io'

export const shot = (page, name) => {
  fs.mkdirSync(OUT, { recursive: true })
  return page.screenshot({ path: `${OUT}/${name}.png` })
}

/** Writes a scratch file under test-results and returns its absolute path. */
export function scratch(name, content) {
  fs.mkdirSync(`${OUT}/files`, { recursive: true })
  const p = path.resolve(`${OUT}/files/${name}`)
  fs.writeFileSync(p, content)
  return p
}

export async function newDb(page, title, props = {}) {
  const module = await createModule(page, { type: 'database', title })
  const base = `/api/databases/${module.id}`
  const data = await load(page, module.id)
  const P = { Name: data.properties[0] }
  for (const [name, [type, config]] of Object.entries(props)) P[name] = await api(page, 'POST', `${base}/properties`, { name, type, config })
  return { module, base, P, view: data.views[0] }
}

export async function addRows(page, db, rows) {
  const { created } = await api(page, 'POST', `${db.base}/rows/batch`, {
    create: rows.map((r) => ({ values: Object.fromEntries(Object.entries(r).map(([k, v]) => [db.P[k].id, v])) })),
  })
  return created
}

export async function open(page, db) {
  const url = `/#/m/${db.module.id}`
  if (page.url().endsWith(url)) await page.reload()
  else await page.goto(url)
  await expect(page.locator(`.db-root[data-module-id="${db.module.id}"][data-ready="true"]`)).toHaveCount(1)
}

export async function setTheme(page, theme) {
  await page.evaluate((t) => localStorage.setItem('truss.theme', t), theme)
}

export const rowValues = async (page, db) => new Map((await load(page, db.module.id)).rows.map((r) => [r.id, r.values]))

/** Elements that clip text vertically or leave the viewport (same rule as the database visual suite). */
export async function layoutProblems(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const problems = []
    if (document.documentElement.scrollWidth > vw) problems.push(`page scrolls horizontally ${document.documentElement.scrollWidth}>${vw}`)
    for (const e of document.querySelectorAll('.db-root *, .popover *, .modal *')) {
      if (!e.getClientRects().length || !e.childNodes.length) continue
      const cs = getComputedStyle(e)
      const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (hasText && (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis' || cs.overflowY === 'hidden') && e.scrollHeight > e.clientHeight + 1) {
        problems.push(`vertical clip: .${e.className} "${e.textContent.trim().slice(0, 30)}" ${e.scrollHeight}>${e.clientHeight}`)
      }
      const r = e.getBoundingClientRect()
      if (e.closest('.popover, .modal') && (r.right > vw + 1 || r.left < -1)) problems.push(`overlay content off-screen: .${e.className}`)
    }
    return problems
  })
}
