import { test, expect } from '@playwright/test'
import { watch, boot, createModule, uid } from './helpers.js'

test('sanitizeHtml strips dangerous markup, keeps the allowlist, and never executes script', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const out = await page.evaluate(async () => {
    const { sanitizeHtml } = await import('/lib/sanitize.js')
    const cases = {
      script: sanitizeHtml('hi<script>window.__xss = 1</script>there'),
      img: sanitizeHtml('<img src=x onerror="window.__xss = 2">pic'),
      iframe: sanitizeHtml('<iframe src="javascript:window.__xss=3"></iframe>frame'),
      style: sanitizeHtml('<b style="color:red" onclick="window.__xss=4">bold</b>'),
      js: sanitizeHtml('<a href="javascript:window.__xss=5">x</a><a href=" JaVa\tScRiPt:alert(1)">y</a>'),
      keep: sanitizeHtml('<b>b</b><strong>s</strong><i>i</i><em>e</em><u>u</u><s>st</s><code>c</code>line<br>next<a href="https://example.com">link</a><a href="mailto:a@b.co">mail</a>'),
      span: sanitizeHtml('<span data-mention="m1" class="evil" style="x">@m</span>'),
      nested: sanitizeHtml('<div><p>para <svg><script>window.__xss=6</script></svg><math><mi>z</mi></math></p></div>'),
      svg: sanitizeHtml('<svg onload="window.__xss=7"><a href="https://example.com">s</a></svg>ok'),
      text: sanitizeHtml('1 &lt; 2 &amp;&amp; <unknown>tag</unknown>'),
    }
    const host = document.createElement('div')
    host.innerHTML = Object.values(cases).join('')
    document.body.append(host)
    await new Promise((r) => setTimeout(r, 300))
    const doc = new DOMParser().parseFromString(cases.keep, 'text/html')
    return {
      cases,
      flag: window.__xss,
      tags: [...doc.body.querySelectorAll('*')].map((e) => e.localName),
      hrefs: [...doc.body.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      hostTags: [...new Set([...host.querySelectorAll('*')].map((e) => e.localName))].sort(),
      attrs: [...host.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.name)),
    }
  })
  expect(out.flag).toBeUndefined()
  expect(out.cases.script).not.toContain('<script')
  expect(out.cases.script).not.toContain('__xss')
  expect(out.cases.img).toBe('pic')
  expect(out.cases.iframe).toBe('frame')
  expect(out.cases.style).toBe('<b>bold</b>')
  expect(out.cases.js).not.toMatch(/javascript/i)
  expect(out.cases.js).toContain('>x</a>')
  expect(out.tags).toEqual(['b', 'strong', 'i', 'em', 'u', 's', 'code', 'br', 'a', 'a'])
  expect(out.hrefs).toEqual(['https://example.com', 'mailto:a@b.co'])
  expect(out.cases.span).toBe('<span data-mention="m1">@m</span>')
  expect(out.cases.nested).toBe('para z')
  expect(out.cases.svg).toBe('ok')
  expect(out.cases.text).toBe('1 &lt; 2 &amp;&amp; tag')
  expect(out.hostTags.every((t) => ['b', 'strong', 'i', 'em', 'u', 's', 'code', 'br', 'a', 'span'].includes(t))).toBe(true)
  expect(out.attrs.every((a) => ['href', 'rel', 'target', 'data-mention'].includes(a))).toBe(true)
  expect(w.errors).toEqual([])
})

test('api.js sends the token, throws ApiError, and api.url lets <img> load an attachment', async ({ page }) => {
  await boot(page)
  const m = await createModule(page, { type: 'notebook', title: `Api ${uid()}` })
  const token = await page.locator('meta[name="truss-token"]').getAttribute('content')

  const headers = []
  page.on('request', (r) => r.url().includes('/api/modules/') && headers.push(r.headers()['x-truss-token']))

  const result = await page.evaluate(async (moduleId) => {
    const { api, ApiError } = await import('/lib/api.js')
    const got = await api.get(`/api/modules/${moduleId}`)
    const patched = await api.patch(`/api/modules/${moduleId}`, { title: 'Patched via api.js' })
    let err
    try {
      await api.get('/api/modules/does-not-exist')
    } catch (e) {
      err = { isApiError: e instanceof ApiError, status: e.status, code: e.code, message: e.message }
    }
    let bad
    try {
      await api.post('/api/modules', { type: 'nope' })
    } catch (e) {
      bad = { status: e.status, code: e.code }
    }
    // 1x1 transparent PNG
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const att = await api.upload(`/api/attachments?moduleId=${moduleId}&pageId=p1`, new Blob([bytes], { type: 'image/png' }), 'dot.png')
    const src = api.url(`/api/attachments/${att.id}/content`)
    const img = new Image()
    const loaded = await new Promise((resolve) => {
      img.onload = () => resolve(img.naturalWidth)
      img.onerror = () => resolve('error')
      img.src = src
    })
    const url2 = api.url('/api/x?a=1')
    const list = await api.get(`/api/attachments?moduleId=${moduleId}`)
    const deleted = await api.del(`/api/attachments/${att.id}`)
    return { got: got.id, patched: patched.title, err, bad, att, src, loaded, url2, list: list.length, deleted, tokenProp: api.token, origin: location.origin }
  }, m.id)

  expect(result.got).toBe(m.id)
  expect(result.patched).toBe('Patched via api.js')
  expect(result.err).toEqual({ isApiError: true, status: 404, code: 'module_not_found', message: 'Module not found' })
  expect(result.bad).toEqual({ status: 400, code: 'invalid_type' })
  expect(result.att.filename).toBe('dot.png')
  // api.url() resolves against api.js's own location rather than the site root,
  // so that it still points at the right place when Truss is served under a path
  // prefix. That makes it absolute; <img src> and download hrefs take it either way.
  expect(result.src).toBe(`${result.origin}/api/attachments/${result.att.id}/content?token=${token}`)
  expect(result.loaded).toBe(1)
  expect(result.url2).toBe(`${result.origin}/api/x?a=1&token=${token}`)
  expect(result.list).toBe(1)
  expect(result.deleted).toEqual({ ok: true })
  expect(result.tokenProp).toBe(token)
  expect(headers.length).toBeGreaterThan(0)
  expect(headers.every((h) => h === token)).toBe(true)
})

test('ui.formatDate and formatDateTime use DD/MM/YYYY and Australia/Sydney time', async ({ page }) => {
  await boot(page)
  const r = await page.evaluate(async () => {
    const { formatDate, formatDateTime } = await import('/lib/ui.js')
    return {
      d: formatDate('2026-05-14T02:00:00Z'),
      plain: formatDate('2026-01-09'),
      lateUtc: formatDate('2026-05-14T15:30:00Z'),
      aest: formatDateTime('2026-05-14T02:00:00Z'),
      aedt: formatDateTime('2026-01-14T13:05:00Z'),
      morning: formatDateTime('2026-07-01T22:07:00Z'),
      empty: formatDate(null),
    }
  })
  expect(r.d).toBe('14/05/2026')
  expect(r.plain).toBe('09/01/2026')
  expect(r.lateUtc).toBe('15/05/2026')
  expect(r.aest).toBe('14/05/2026 12:00 pm AEST')
  expect(r.aedt).toBe('15/01/2026 12:05 am AEDT')
  expect(r.morning).toBe('02/07/2026 8:07 am AEST')
  expect(r.empty).toBe('')
})

test('ui helpers: h, modal resolves action values, promptDialog, toast, loadCss is idempotent', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  await page.evaluate(async () => {
    const ui = await import('/lib/ui.js')
    const el = ui.h('button', { class: 'x', dataset: { a: '1' }, onClick: () => (window.__clicked = true) }, 'Hi', null, [ui.h('span', {}, '!')])
    document.body.append(el)
    el.click()
    window.__h = el.outerHTML
    window.__prompt = ui.promptDialog({ title: 'Name it', label: 'Name', value: 'old' })
    // Counted on link.href, the resolved absolute URL, because that is the key
    // loadCss actually dedupes on. The href ATTRIBUTE is relative in index.html
    // so that Truss can be served under a path prefix, and an attribute-suffix
    // selector silently matched nothing.
    const links = (suffix) => [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) => l.href.endsWith(suffix)).length
    await ui.loadCss('/styles/tokens.css')
    await ui.loadCss('/styles/tokens.css')
    window.__links = links('/styles/tokens.css')
    await ui.loadCss('/styles/does-not-exist-yet.css')
    await ui.loadCss('/styles/does-not-exist-yet.css')
    window.__newLinks = links('/styles/does-not-exist-yet.css')
  })
  expect(await page.evaluate(() => window.__h)).toBe('<button class="x" data-a="1">Hi<span>!</span></button>')
  expect(await page.evaluate(() => window.__clicked)).toBe(true)
  expect(await page.evaluate(() => window.__links)).toBe(1)
  expect(await page.evaluate(() => window.__newLinks)).toBe(1)
  const input = page.getByRole('dialog').locator('input')
  await expect(input).toBeFocused()
  await input.fill('new name')
  await input.press('Enter')
  expect(await page.evaluate(() => window.__prompt)).toBe('new name')

  await page.evaluate(async () => {
    const ui = await import('/lib/ui.js')
    window.__modal = ui.modal({ title: 'Pick', body: 'Choose', actions: [{ label: 'One', value: 1 }, { label: 'Two', value: 2, variant: 'primary' }] })
    ui.toast('Saved it', { type: 'success' })
  })
  await expect(page.locator('.toast-success')).toContainText('Saved it')
  await page.getByRole('dialog').getByRole('button', { name: 'Two' }).click()
  expect(await page.evaluate(() => window.__modal)).toBe(2)
  expect(w.dialogs).toEqual([])
  // the deliberately missing stylesheet is the only allowed error
  expect(w.errors.filter((e) => !e.includes('404'))).toEqual([])
})
