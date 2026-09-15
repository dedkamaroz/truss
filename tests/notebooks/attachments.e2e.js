import { test, expect } from '@playwright/test'
import { watch, boot, notebook, createPage, openPage, api, shot } from './helpers.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR42mNkYPj/n4EIwDiqEF8oYhgGGgAAeYcH/f0Xb1cAAAAASUVORK5CYII='

const todaySydney = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(new Date()).map((x) => [x.type, x.value]))
  return `${p.day}/${p.month}/${p.year}`
}

async function dropFile(page, selector, { name, type, base64 }) {
  await page.locator(selector).evaluate((el, { name, type, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], name, { type }))
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true }
    el.dispatchEvent(new DragEvent('dragenter', opts))
    el.dispatchEvent(new DragEvent('dragover', opts))
    el.dispatchEvent(new DragEvent('drop', opts))
  }, { name, type, base64 })
}

async function uploadViaApi(page, moduleId, pageId, filename, text) {
  return page.evaluate(async ({ moduleId, pageId, filename, text }) => {
    const token = document.querySelector('meta[name="truss-token"]').content
    const res = await fetch(`/api/attachments?moduleId=${moduleId}&pageId=${pageId}`, { method: 'POST', headers: { 'X-Truss-Token': token, 'X-Filename': filename }, body: text })
    return res.json()
  }, { moduleId, pageId, filename, text })
}

test('attachments: drop and upload, card details, image thumbnail and inline image block, open/reveal, delete with confirm, refresh on attachments:changed', async ({ page }) => {
  const w = await watch(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await boot(page)
  const { module } = await notebook(page)
  const p = await createPage(page, module.id, { title: 'Evidence', content: [{ id: 'a', type: 'paragraph', html: 'Case notes', props: {} }] })
  const other = await createPage(page, module.id, { title: 'Other page' })
  await openPage(page, module.id, p.id)
  const panel = page.locator('.nb-attachments')
  await expect(panel).toContainText('No attachments')

  // drop an image anywhere on the page
  await dropFile(page, '.nb-page-content', { name: 'licence scan.png', type: 'image/png', base64: PNG })
  const imgCard = panel.locator('.nb-att', { hasText: 'licence scan.png' })
  await expect(imgCard).toBeVisible()
  await expect(imgCard.locator('.nb-att-size')).toHaveText('83 B')
  await expect(imgCard.locator('.nb-att-date')).toHaveText(todaySydney())
  await expect(imgCard.locator('.nb-att-date')).toHaveText(/^\d{2}\/\d{2}\/\d{4}$/)
  await expect.poll(() => imgCard.locator('.nb-att-thumb img').evaluate((i) => i.naturalWidth)).toBe(8)
  await expect(page.locator('.nb-page')).not.toHaveClass(/is-file-over/)

  // upload button
  const chooser = page.waitForEvent('filechooser')
  await page.locator('.nb-page-toolbar').getByRole('button', { name: 'Upload' }).click()
  await (await chooser).setFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2048, 1) })
  const pdfCard = panel.locator('.nb-att', { hasText: 'statement.pdf' })
  await expect(pdfCard).toBeVisible()
  await expect(pdfCard.locator('.nb-att-size')).toHaveText('2.0 KB')
  await expect(pdfCard.locator('.nb-att-type svg')).toBeVisible()
  await expect(pdfCard.locator('.nb-att-ext')).toHaveText('PDF')
  await expect(panel.locator('.nb-att-head .nb-count')).toHaveText('2')
  const list = (await api(page, 'GET', `/api/attachments?moduleId=${module.id}&pageId=${p.id}`)).body
  expect(list.map((a) => a.filename).sort()).toEqual(['licence scan.png', 'statement.pdf'])

  // insert the image as an inline image block
  await imgCard.hover()
  await imgCard.getByRole('button', { name: 'Insert image into page' }).click()
  const imageBlock = page.locator('.nb-block[data-type="image"] img')
  await expect(imageBlock).toBeVisible()
  await expect.poll(() => imageBlock.evaluate((i) => i.naturalWidth)).toBe(8)
  await shot(page, 'attachments-panel')

  // Open and Show in folder hit the endpoints (intercepted so nothing launches)
  const calls = []
  await page.route('**/api/attachments/*/open', (route) => {
    calls.push(['open', route.request().method(), route.request().url()])
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  await page.route('**/api/attachments/*/reveal', (route) => {
    calls.push(['reveal', route.request().method(), route.request().url()])
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  const pdf = list.find((a) => a.filename === 'statement.pdf')
  await pdfCard.hover()
  await pdfCard.getByRole('button', { name: 'Open', exact: true }).click()
  await pdfCard.getByRole('button', { name: 'Show in folder' }).click()
  await expect.poll(() => calls.length).toBe(2)
  expect(calls).toEqual([
    ['open', 'POST', expect.stringContaining(`/api/attachments/${pdf.id}/open`)],
    ['reveal', 'POST', expect.stringContaining(`/api/attachments/${pdf.id}/reveal`)],
  ])

  // delete with the custom confirm: cancel keeps, confirm removes
  await pdfCard.getByRole('button', { name: 'Delete attachment' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('statement.pdf')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(pdfCard).toBeVisible()
  await pdfCard.hover()
  await pdfCard.getByRole('button', { name: 'Delete attachment' }).click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(pdfCard).toHaveCount(0)
  expect((await api(page, 'GET', `/api/attachments?moduleId=${module.id}&pageId=${p.id}`)).body.map((a) => a.filename)).toEqual(['licence scan.png'])

  // the panel refreshes when attachments:changed is emitted for this page only
  await uploadViaApi(page, module.id, p.id, 'script-output.txt', 'out')
  await uploadViaApi(page, module.id, other.id, 'elsewhere.txt', 'x')
  await page.waitForTimeout(200)
  await expect(panel.locator('.nb-att', { hasText: 'script-output.txt' })).toHaveCount(0)
  const listRequests = []
  page.on('request', (r) => r.url().includes('/api/attachments?') && listRequests.push(r.url()))
  await page.evaluate(async (moduleId) => {
    const { emit } = await import('/lib/registry.js')
    emit('attachments:changed', { moduleId, pageId: 'someone-else' })
  }, module.id)
  await page.waitForTimeout(300)
  expect(listRequests).toEqual([])
  await page.evaluate(async ({ moduleId, pageId }) => {
    const { emit } = await import('/lib/registry.js')
    emit('attachments:changed', { moduleId, pageId })
  }, { moduleId: module.id, pageId: p.id })
  await expect(panel.locator('.nb-att', { hasText: 'script-output.txt' })).toBeVisible()
  await expect(panel.locator('.nb-att', { hasText: 'elsewhere.txt' })).toHaveCount(0)

  // image block and thumbnail survive a reload
  await page.reload()
  await expect(page.locator('.nb-block[data-type="image"] img')).toBeVisible()
  await expect(panel.locator('.nb-att')).toHaveCount(2)
  expect(w.dialogs).toEqual([])
  expect(w.errors).toEqual([])
})

const FAKE_SCRIPTS = `
window.__runs = []
export default {
  init({ registry }) {
    registry.registerPageAction({
      id: 'fake-run', label: 'Run fake script', icon: 'play',
      isAvailable: (ctx) => ctx.module?.type === 'notebook',
      run(ctx) {
        window.__runs.push({ moduleId: ctx.module.id, type: ctx.module.type, pageId: ctx.pageId,
          attachments: ctx.attachments.map((a) => a.filename), isArray: Array.isArray(ctx.attachments) })
      },
    })
    registry.registerPageAction({
      id: 'needs-files', label: 'Needs files',
      isAvailable: (ctx) => ctx.attachments.length > 0,
      run() {},
    })
  },
}
`

test('page actions from the registry render on text and table pages and run with module, pageId and current attachments', async ({ page }) => {
  const w = await watch(page)
  await page.route('**/modules/scripts/index.js', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_SCRIPTS }))
  await boot(page)
  const text = await notebook(page, { template: 'text' })
  const welcome = text.pages.find((x) => x.title === 'Welcome')
  await uploadViaApi(page, text.module.id, welcome.id, 'input.csv', 'a,b')
  await page.reload()
  await expect(page.locator('html[data-ready="true"]')).toHaveCount(1)

  await openPage(page, text.module.id, welcome.id)
  const toolbar = page.locator('.nb-page-toolbar')
  const run = toolbar.getByRole('button', { name: 'Run fake script' })
  await expect(run).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Needs files' })).toBeVisible()
  await run.click()
  await expect.poll(() => page.evaluate(() => window.__runs.length)).toBe(1)
  expect(await page.evaluate(() => window.__runs[0])).toEqual({ moduleId: text.module.id, type: 'notebook', pageId: welcome.id, attachments: ['input.csv'], isArray: true })

  // after another upload the action receives the refreshed attachments
  const chooser = page.waitForEvent('filechooser')
  await toolbar.getByRole('button', { name: 'Upload' }).click()
  await (await chooser).setFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('2') })
  await expect(page.locator('.nb-att', { hasText: 'second.txt' })).toBeVisible()
  await run.click()
  await expect.poll(() => page.evaluate(() => window.__runs.length)).toBe(2)
  expect((await page.evaluate(() => window.__runs[1])).attachments).toEqual(['input.csv', 'second.txt'])

  // table page: the action is there too; availability follows the attachments and refreshes on attachments:changed
  const table = await notebook(page, { template: 'table' })
  const sheetPage = table.pages[0]
  await openPage(page, table.module.id, sheetPage.id)
  await expect(toolbar.getByRole('button', { name: 'Run fake script' })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Needs files' })).toHaveCount(0)
  await toolbar.getByRole('button', { name: 'Run fake script' }).click()
  await expect.poll(() => page.evaluate(() => window.__runs.length)).toBe(3)
  expect(await page.evaluate(() => window.__runs[2])).toEqual({ moduleId: table.module.id, type: 'notebook', pageId: sheetPage.id, attachments: [], isArray: true })
  await uploadViaApi(page, table.module.id, sheetPage.id, 'output.txt', 'done')
  await page.evaluate(async (ids) => (await import('/lib/registry.js')).emit('attachments:changed', ids), { moduleId: table.module.id, pageId: sheetPage.id })
  await expect(toolbar.getByRole('button', { name: 'Needs files' })).toBeVisible()
  await toolbar.getByRole('button', { name: 'Run fake script' }).click()
  await expect.poll(() => page.evaluate(() => window.__runs.length)).toBe(4)
  expect((await page.evaluate(() => window.__runs[3])).attachments).toEqual(['output.txt'])
  await shot(page, 'page-actions-table')
  expect(w.errors).toEqual([])
})
