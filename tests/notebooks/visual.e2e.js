import { test, expect } from '@playwright/test'
import { watch, boot, notebook, createPage, openPage, api, shot, blockText } from './helpers.js'


async function expectNoClipping(page, where) {
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.nb *')]
    .filter((e) => e.childNodes.length && e.textContent.trim() && e.getClientRects().length &&
      getComputedStyle(e).textOverflow === 'ellipsis' && e.scrollHeight > e.clientHeight + 1)
    .map((e) => `${e.className}: "${e.textContent.trim()}" ${e.scrollHeight}>${e.clientHeight}`))
  expect(clipped, where).toEqual([])
  const overflow = await page.evaluate(() => ['.nb-tree-panel', '.nb-page-toolbar', '.nb-page-inner', '.nb-attachments']
    .map((s) => document.querySelector(s))
    .filter(Boolean)
    .map((e) => [e.className, e.scrollWidth - e.clientWidth])
    .filter(([, d]) => d > 1))
  expect(overflow, `${where}: horizontal overflow`).toEqual([])
}

for (const theme of ['light', 'dark']) {
  test(`visual: ${theme} 1440x900`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
    const page = await context.newPage()
    const w = await watch(page)
    await boot(page)
    await page.evaluate((t) => localStorage.setItem('truss.theme', t), theme)

    const { module, pages } = await notebook(page, { template: 'text', title: 'Research notes' })
    const welcome = pages.find((p) => p.title === 'Welcome')
    const sub = pages.find((p) => p.parent_id === welcome.id)
    await createPage(page, module.id, { title: 'Quarterly review', icon: '📊', parent_id: sub.id })
    await createPage(page, module.id, { title: 'Supplier onboarding checklist for new vendors', icon: '✅' })
    await createPage(page, module.id, { title: 'Reading list' })
    await page.evaluate(({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids)), { key: `truss.nb.expanded.${module.id}`, ids: [welcome.id, sub.id] })

    const upload = (name, type, base64) => page.evaluate(async ({ moduleId, pageId, name, type, base64 }) => {
      const token = document.querySelector('meta[name="truss-token"]').content
      let bytes = base64 && Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      if (!base64) {
        // a small landscape picture drawn on a canvas
        const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 })
        const g = c.getContext('2d')
        const sky = g.createLinearGradient(0, 0, 0, 360)
        sky.addColorStop(0, '#8ec5fc')
        sky.addColorStop(1, '#f9d29d')
        g.fillStyle = sky
        g.fillRect(0, 0, 640, 360)
        g.fillStyle = '#f6c453'
        g.beginPath()
        g.arc(470, 120, 46, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = '#3f7d58'
        g.beginPath()
        g.moveTo(0, 360); g.lineTo(0, 250); g.quadraticCurveTo(160, 170, 330, 250); g.quadraticCurveTo(470, 310, 640, 230); g.lineTo(640, 360)
        g.fill()
        bytes = await new Promise((r) => c.toBlob(r, 'image/png'))
      }
      const res = await fetch(`/api/attachments?moduleId=${moduleId}&pageId=${pageId}`, { method: 'POST', headers: { 'X-Truss-Token': token, 'X-Filename': name, 'Content-Type': type }, body: bytes })
      return res.json()
    }, { moduleId: module.id, pageId: welcome.id, name, type, base64 })
    const img = await upload('site-photo.png', 'image/png', '')
    const doc = await upload('Signed agreement 2026.pdf', 'application/pdf', btoa('x'.repeat(40000)))
    await upload('notes.txt', 'text/plain', btoa('hello'))
    const content = (await api(page, 'GET', `/api/notebooks/${module.id}/pages/${welcome.id}`)).body.content
    content.find((b) => b.type === 'toggle').props.open = true
    content.splice(content.length - 1, 0,
      { id: 'img1', type: 'image', html: '', props: { attachmentId: img.id, name: img.filename, size: img.size, mime: img.mime } },
      { id: 'file1', type: 'file', html: '', props: { attachmentId: doc.id, name: doc.filename, size: doc.size, mime: doc.mime } })
    await api(page, 'PATCH', `/api/notebooks/${module.id}/pages/${welcome.id}`, { content })
    await page.reload()
    await openPage(page, module.id, welcome.id)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator('.nb-att')).toHaveCount(3)
    await expect.poll(() => page.locator('.nb-att.is-image img').evaluate((i) => i.naturalWidth)).toBeGreaterThan(0)
    await page.mouse.move(0, 890)
    await page.waitForTimeout(200)
    await expectNoClipping(page, 'text page')
    await shot(page, `visual-${theme}-text-top`)

    // the rest of the blocks
    await page.locator('.nb-block[data-type="heading3"]').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(150)
    await shot(page, `visual-${theme}-text-blocks`)
    await page.locator('.nb-block[data-type="table"]').evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await page.waitForTimeout(150)
    await shot(page, `visual-${theme}-text-media`)

    // hover gutter + slash menu
    await page.locator('.nb-page-host').evaluate((el) => { el.scrollTop = 0 })
    const para = page.locator('.nb-blocks > .nb-block[data-type="paragraph"]').first()
    await para.hover()
    await blockText(page, 3).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/')
    await expect(page.locator('.nb-slash')).toBeVisible()
    await expectNoClipping(page, 'slash menu')
    await shot(page, `visual-${theme}-slash`)
    await page.keyboard.type('li')
    await shot(page, `visual-${theme}-slash-filtered`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect(page.locator('.nb-blocks > .nb-block').nth(4)).toHaveAttribute('data-type', 'bulleted')

    // selection toolbar
    await blockText(page, 1).evaluate((el) => {
      el.focus()
      const r = document.createRange()
      const t = el.firstChild
      r.setStart(t, 0)
      r.setEnd(t, 9)
      getSelection().removeAllRanges()
      getSelection().addRange(r)
    })
    await expect(page.locator('.nb-selbar')).toBeVisible()
    await blockText(page, 1).hover()
    await shot(page, `visual-${theme}-selection`)

    // tree menu
    await page.locator(`.nb-tree-row[data-id="${sub.id}"]`).hover()
    await page.locator(`.nb-tree-row[data-id="${sub.id}"] .nb-tree-more`).click()
    await shot(page, `visual-${theme}-tree-menu`)
    await page.keyboard.press('Escape')

    // table notebook
    const table = await notebook(page, { template: 'table', title: 'Registers' })
    await openPage(page, table.module.id, table.pages[0].id)
    await page.locator('.nb-cell[data-r="1"][data-c="1"]').click()
    await expectNoClipping(page, 'table page')
    await shot(page, `visual-${theme}-table`)

    expect(w.errors).toEqual([])
    await context.close()
  })
}
