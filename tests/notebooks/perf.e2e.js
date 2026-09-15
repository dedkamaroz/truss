import { test, expect } from '@playwright/test'
import { watch, boot, notebook, createPage, openPage, saved, api } from './helpers.js'

const TYPES = ['paragraph', 'heading2', 'bulleted', 'numbered', 'todo', 'quote', 'paragraph', 'callout', 'code', 'paragraph']
const bigContent = (n) => Array.from({ length: n }, (_, i) => {
  const type = TYPES[i % TYPES.length]
  return { id: `b${i}`, type, html: type === 'code' ? `const line${i} = ${i}` : `Block ${i} with <b>bold</b>, <i>italic</i> and <code>code</code> text that wraps onto a second line when the window is narrow enough to need it`, props: type === 'todo' ? { checked: i % 3 === 0 } : type === 'callout' ? { icon: '💡' } : {} }
})

async function timeUntil(page, hash, selector, count) {
  return page.evaluate(({ hash, selector, count }) => new Promise((resolve) => {
    const t0 = performance.now()
    location.hash = hash
    const tick = () => {
      if (document.querySelectorAll(selector).length >= count) {
        // include layout and the next paint
        document.body.getBoundingClientRect()
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0)))
      } else requestAnimationFrame(tick)
    }
    tick()
  }), { hash, selector, count })
}

test('a 1,000-block page opens in under 1.5 s; typing keeps other blocks and debounces saves', async ({ page }) => {
  test.setTimeout(120_000)
  const w = await watch(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await boot(page)
  const { module } = await notebook(page)
  const small = await createPage(page, module.id, { title: 'Small' })
  const big = await createPage(page, module.id, { title: 'Big page', content: bigContent(1000) })
  await openPage(page, module.id, small.id)

  const timings = []
  for (let i = 0; i < 3; i++) {
    timings.push(await timeUntil(page, `#/m/${module.id}/p/${big.id}`, '.nb-blocks > .nb-block', 1000))
    await timeUntil(page, `#/m/${module.id}/p/${small.id}`, `.nb-page[data-page-id="${small.id}"]`, 1)
  }
  console.log('1,000-block page open (ms):', timings.map(Math.round).join(', '))
  expect(Math.min(...timings)).toBeLessThan(1500)
  expect(Math.max(...timings)).toBeLessThan(3000)

  // cold load straight onto the big page (full boot included)
  await page.goto(`/#/m/${module.id}/p/${big.id}`)
  await page.reload()
  await expect(page.locator('.nb-blocks > .nb-block')).toHaveCount(1000)
  const cold = await page.evaluate(() => performance.now())
  console.log('cold load to 1,000 blocks (ms):', Math.round(cold))
  expect(cold).toBeLessThan(3000)

  // typing: no other block is re-rendered, and saves are debounced
  await page.locator('.nb-blocks > .nb-block').first().waitFor()
  await page.evaluate(() => document.querySelectorAll('.nb-blocks > .nb-block').forEach((el, i) => { el.__probe = i }))
  const patches = []
  page.on('request', (r) => r.method() === 'PATCH' && r.url().includes(`/pages/${big.id}`) && patches.push(r.postDataJSON()))
  const target = page.locator('.nb-block[data-id="b500"] .nb-text')
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await page.keyboard.press('End')
  const typed = 'abcdefghijklmnopqrstuvwxyz1234'
  expect(typed).toHaveLength(30)
  await page.keyboard.type(typed, { delay: 25 })
  await saved(page)
  await page.waitForTimeout(1000)
  const identity = await page.evaluate(() => [...document.querySelectorAll('.nb-blocks > .nb-block')].map((el) => el.__probe))
  expect(identity).toEqual(Array.from({ length: 1000 }, (_, i) => i))
  expect(patches.length).toBeGreaterThanOrEqual(1)
  expect(patches.length).toBeLessThanOrEqual(3)
  const stored = (await api(page, 'GET', `/api/notebooks/${module.id}/pages/${big.id}`)).body.content
  expect(stored[500].html).toContain(typed)
  expect(stored).toHaveLength(1000)
  expect(w.errors).toEqual([])
})

test('a notebook with 500 pages renders its tree in under 1 s', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await boot(page)
  const { module } = await notebook(page)
  // 250 top-level pages, 250 subpages under the first 50 (all expanded) = 500 visible rows
  const roots = await page.evaluate(async (moduleId) => {
    const token = document.querySelector('meta[name="truss-token"]').content
    const post = (body) => fetch(`/api/notebooks/${moduleId}/pages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Truss-Token': token }, body: JSON.stringify(body) }).then((r) => r.json())
    const out = []
    for (let i = 0; i < 250; i += 25) out.push(...await Promise.all(Array.from({ length: 25 }, (_, j) => post({ title: `Page ${i + j}`, icon: (i + j) % 7 === 0 ? '📄' : null }))))
    for (let i = 0; i < 50; i++) await Promise.all(Array.from({ length: 5 }, (_, j) => post({ title: `Sub ${i}.${j}`, parent_id: out[i].id })))
    return out.map((p) => p.id)
  }, module.id)
  await page.evaluate(({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids)), { key: `truss.nb.expanded.${module.id}`, ids: roots.slice(0, 50) })
  await page.goto('/#/')
  await page.reload()
  await expect(page.locator('html[data-ready="true"]')).toHaveCount(1)
  const timings = []
  for (let i = 0; i < 3; i++) {
    timings.push(await timeUntil(page, `#/m/${module.id}`, '.nb-tree-row', 500))
    await timeUntil(page, '#/', '.home-title', 1)
  }
  console.log('500-page tree render (ms):', timings.map(Math.round).join(', '))
  expect(await page.locator('.nb-tree-row').count()).toBe(0)
  await page.goto(`/#/m/${module.id}`)
  await expect(page.locator('.nb-tree-row')).toHaveCount(500)
  await expect(page.locator('.nb-tree-row[aria-level="2"]')).toHaveCount(250)
  expect(Math.min(...timings)).toBeLessThan(1000)
})
