import { test, expect } from '@playwright/test'
import { watch, boot, notebook, createPage, openPage, saved, blockText, storedBlocks, uid } from './helpers.js'

const EVIL = [
  '<p>safe <b>bold</b> text</p>',
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=1</script>',
  '<a href="javascript:window.__pwned=1">bad link</a>',
  '<span style="color:red" onclick="window.__pwned=1" data-ok="1">styled</span>',
  '<svg><script>window.__pwned=1</script></svg><iframe src="javascript:window.__pwned=1"></iframe>',
  '<details open ontoggle="window.__pwned=1">x</details>',
].join('')

const ALLOWED = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'code', 'a', 'br', 'span'])

function expectOnlyAllowlisted(html) {
  const tags = [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase())
  for (const t of tags) expect(ALLOWED.has(t), `tag <${t}> in ${html}`).toBe(true)
  expect(html).not.toMatch(/\son[a-z]+\s*=/i)
  expect(html).not.toMatch(/javascript:/i)
  expect(html).not.toMatch(/style=/i)
  for (const m of html.matchAll(/<(a|span)\b([^>]*)>/g)) {
    const attrs = [...m[2].matchAll(/([a-zA-Z-]+)=/g)].map((a) => a[1])
    for (const a of attrs) expect(['href', 'rel', 'target'].includes(a) || a.startsWith('data-'), `attribute ${a}`).toBe(true)
  }
}

const pwned = (page) => page.evaluate(() => window.__pwned)

test('pasting and dropping hostile HTML never runs script and stores only allowlisted markup', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const w = await watch(page)
  await boot(page)
  const { module } = await notebook(page)
  const p = await createPage(page, module.id, { title: 'Paste', content: [
    { id: 'a', type: 'paragraph', html: 'start ', props: {} },
    { id: 'b', type: 'paragraph', html: '', props: {} },
    { id: 'c', type: 'toggle', html: 'toggle', props: { open: true, body: '' } },
  ] })
  await openPage(page, module.id, p.id)

  // 1. synthetic paste event with hostile text/html
  const first = blockText(page, 0)
  await first.click()
  await page.keyboard.press('End')
  await first.evaluate((el, html) => {
    const dt = new DataTransfer()
    dt.setData('text/html', html)
    dt.setData('text/plain', 'plain fallback')
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, EVIL)
  await expect(first).toContainText('safe bold text')
  await expect(page.locator('.nb-editor img, .nb-editor script, .nb-editor iframe, .nb-editor svg:not(.icon), .nb-editor details')).toHaveCount(0)

  // 2. a real Ctrl+V from the system clipboard
  await page.evaluate(async (html) => {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob(['plain'], { type: 'text/plain' }),
    })])
  }, EVIL)
  await blockText(page, 1).click()
  await page.keyboard.press('Control+v')
  await expect(blockText(page, 1)).toContainText('safe bold text')

  // 3. hostile HTML dropped into the toggle body
  const body = page.locator('.nb-block[data-type="toggle"] .nb-text[data-field="body"]')
  await body.evaluate((el, html) => {
    const dt = new DataTransfer()
    dt.setData('text/html', html)
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 5, clientY: r.top + 5 }))
  }, EVIL)
  await expect(body).toContainText('safe bold text')

  await page.waitForTimeout(300)
  expect(await pwned(page)).toBeUndefined()
  await expect(page.locator('.nb-editor img, .nb-editor script, .nb-editor iframe')).toHaveCount(0)
  await saved(page)

  const stored = await storedBlocks(page, module.id, p.id)
  expect(stored[0].html).toContain('<b>bold</b>')
  for (const b of stored) {
    expectOnlyAllowlisted(b.html)
    if (b.props.body != null) expectOnlyAllowlisted(b.props.body)
  }
  expect(JSON.stringify(stored)).not.toMatch(/onerror|<script|<img|javascript:/i)

  await page.reload()
  await expect(blockText(page, 0)).toContainText('safe bold text')
  await page.waitForTimeout(300)
  expect(await pwned(page)).toBeUndefined()
  await expect(page.locator('.nb-editor img, .nb-editor script, .nb-editor iframe')).toHaveCount(0)
  expect(w.dialogs).toEqual([])
  expect(w.errors).toEqual([])
  await context.close()
})

test('hostile content written straight to the API is rendered inert everywhere', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { module } = await notebook(page)
  const evilTitle = `<img src=x onerror="window.__pwned=1"> Title ${uid()}`
  const p = await createPage(page, module.id, { title: evilTitle, icon: '<img src=x onerror="window.__pwned=1">', content: [
    { id: 'a', type: 'paragraph', html: EVIL, props: {} },
    { id: 'b', type: 'heading1', html: '<img src=x onerror="window.__pwned=1">heading', props: {} },
    { id: 'c', type: 'toggle', html: 'x', props: { open: true, body: EVIL } },
    { id: 'd', type: 'callout', html: 'c', props: { icon: '<img src=x onerror="window.__pwned=1">' } },
    { id: 'e', type: 'code', html: '&lt;img src=x onerror="window.__pwned=1"&gt;', props: {} },
    { id: 'f', type: 'table', html: '', props: { columns: [{ id: 'c1', name: '<img src=x onerror="window.__pwned=1">' }], rows: [{ id: 'r1', cells: { c1: '<img src=x onerror="window.__pwned=1">' } }] } },
    { id: 'g', type: 'file', html: '', props: { attachmentId: '"><img src=x onerror="window.__pwned=1">', name: '<img src=x onerror="window.__pwned=1">' } },
  ] })
  await openPage(page, module.id, p.id)
  await expect(page.locator('.nb-page-title')).toHaveText(evilTitle)
  await expect(page.locator('.nb-block[data-type="code"] .nb-text')).toHaveText('<img src=x onerror="window.__pwned=1">')
  await expect(page.locator('.nb-cell').first()).toHaveText('<img src=x onerror="window.__pwned=1">')
  await page.waitForTimeout(400)
  expect(await pwned(page)).toBeUndefined()
  await expect(page.locator('.nb img:not(.nb-att-thumb img)')).toHaveCount(0)
  // search results render snippets as text too
  await page.locator('.nb-search-input').fill('safe bold')
  await expect(page.locator('.nb-search-result')).toHaveCount(1)
  await page.waitForTimeout(200)
  expect(await pwned(page)).toBeUndefined()
  expect(w.errors).toEqual([])
})
