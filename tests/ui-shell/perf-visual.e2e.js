import { test, expect } from '@playwright/test'
import { watch, boot, apiCall, createModule, uid, shot } from './helpers.js'

test('300 modules: sidebar rendered and interactive within 700 ms of DOMContentLoaded', async ({ page }) => {
  test.setTimeout(120_000)
  await boot(page)
  const existing = (await apiCall(page, 'GET', '/api/modules')).body.length
  const tag = uid()
  await page.evaluate(async ({ n, tag }) => {
    const token = document.querySelector('meta[name="truss-token"]').content
    const types = ['database', 'sheet', 'notebook']
    for (let i = 0; i < n; i += 25) {
      await Promise.all(Array.from({ length: Math.min(25, n - i) }, (_, j) => fetch('/api/modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Truss-Token': token },
        body: JSON.stringify({ type: types[(i + j) % 3], title: `Perf ${tag} ${i + j}` }),
      })))
    }
  }, { n: 300, tag })

  const timings = []
  for (let run = 0; run < 3; run++) {
    await page.reload()
    await expect(page.locator('html[data-ready="true"]')).toHaveCount(1)
    const t = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      return { ready: window.__trussReadyAt - nav.domContentLoadedEventStart, rows: document.querySelectorAll('.sidebar-item').length }
    })
    expect(t.rows).toBe(existing + 300)
    timings.push(t.ready)
  }
  console.log('ready after DOMContentLoaded (ms):', timings.map((x) => Math.round(x)).join(', '))
  expect(Math.min(...timings)).toBeLessThan(700)

  // interactive: the switcher opens and filters immediately
  await page.keyboard.press('Control+k')
  await page.keyboard.type(`perf ${tag} 299`)
  await expect(page.locator('.switcher-item')).toHaveCount(1)
  await page.keyboard.press('Escape')
})

// Text boxes that clip (overflow hidden + ellipsis) must be tall enough for descenders (g, j, p, q, y).
async function expectNoVerticalTextClipping(page, where) {
  const clipped = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((e) => e.childNodes.length && e.textContent.trim() && e.getClientRects().length &&
      getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollHeight > e.clientHeight)
    .map((e) => `${e.className}: "${e.textContent.trim()}" ${e.scrollHeight}>${e.clientHeight}`))
  expect(clipped, where).toEqual([])
}

for (const theme of ['light', 'dark']) {
  for (const [width, height] of [[1440, 900], [1000, 700]]) {
    test(`visual: ${theme} ${width}x${height}`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
      const page = await context.newPage()
      const w = await watch(page)
      await boot(page)
      await page.evaluate((t) => localStorage.setItem('truss.theme', t), theme)
      const tag = `${theme}-${width}`
      const names = ['Client onboarding', 'KYC case tracker', 'Quarterly budget', 'Research notes', 'Fraud patterns', 'Team contacts',
        'Expense claims', 'Meeting minutes', 'A product roadmap with a very long title that has to truncate', 'Reading list',
        'Vendor register', 'Cash flow', 'Incident log', 'Sprint planning', 'Ideas']
      const types = ['database', 'sheet', 'notebook']
      const all = (await apiCall(page, 'GET', '/api/modules')).body
      // keep the sidebar at exactly the 15 modules below for consistent screenshots
      await Promise.all(all.map((m) => apiCall(page, 'POST', `/api/modules/${m.id}/archive`)))
      // guarantee the archive view has content even when this test runs alone
      const old = await createModule(page, { type: 'database', title: 'Old supplier register' })
      await apiCall(page, 'POST', `/api/modules/${old.id}/archive`)
      let first
      for (const [i, name] of names.entries()) {
        const m = await createModule(page, { type: types[i % 3], title: name, icon: i % 5 === 0 ? '📊' : undefined })
        first ??= m
      }
      await page.reload()
      await expect(page.locator('.sidebar-item')).toHaveCount(15)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)

      // Nothing in the sidebar overflows horizontally
      const overflow = await page.locator('.sidebar').evaluate((s) => s.scrollWidth - s.clientWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      await expectNoVerticalTextClipping(page, 'home')
      await shot(page, `${tag}-home`)

      // hover + focus states are visible (background changes)
      const row = page.locator(`.sidebar-item[data-id="${first.id}"]`)
      const before = await row.evaluate((e) => getComputedStyle(e).backgroundColor)
      await row.hover()
      await expect.poll(() => row.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(before)

      await page.locator('.sidebar-new').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expectNoVerticalTextClipping(page, 'template picker')
      await shot(page, `${tag}-template-picker`)
      await page.keyboard.press('Escape')

      await page.goto('/#/archive')
      await expect(page.locator('.archive-row').first()).toBeVisible()
      await expectNoVerticalTextClipping(page, 'archive')
      await shot(page, `${tag}-archive`)

      await page.goto(`/#/m/${first.id}`)
      await row.hover()
      await row.locator('.sidebar-item-more').click()
      await expect(page.getByRole('menu')).toBeVisible()
      await shot(page, `${tag}-menu`)
      await page.getByRole('menuitem', { name: 'Delete' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expectNoVerticalTextClipping(page, 'modal')
      await shot(page, `${tag}-modal`)
      await page.keyboard.press('Escape')

      await page.keyboard.press('Control+k')
      await page.keyboard.type('re')
      await shot(page, `${tag}-switcher`)
      await page.keyboard.press('Escape')

      await page.locator('.sidebar-collapse').click()
      await expect(page.locator('.sidebar')).toBeHidden()
      await shot(page, `${tag}-collapsed`)
      await page.locator('.topbar-expand').click()

      // restore state for other tests
      await Promise.all(all.map((m) => apiCall(page, 'POST', `/api/modules/${m.id}/restore`)))
      expect(w.errors).toEqual([])
      await context.close()
    })
  }
}
