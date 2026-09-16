import { test, expect } from '@playwright/test'
import http from 'node:http'

const PREFIX = '/m/truss'
// Must match playwright.config.js's default, or a full `npx playwright test`
// run points this proxy at a port nothing is listening on.
const target = Number(process.env.TRUSS_E2E_PORT || 4799)
let proxy
let base

// A minimal stand-in for the web_server's proxy: strip the prefix, forward, and
// redirect the bare prefix to one with a trailing slash (index.html's relative
// URLs depend on it). Deliberately dumb - the real proxy is tested in
// web_server's own suite; what is under test here is Truss.
test.beforeAll(async () => {
  proxy = http.createServer((req, res) => {
    if (req.url === PREFIX) {
      res.writeHead(307, { Location: PREFIX + '/' })
      return res.end()
    }
    if (!req.url.startsWith(PREFIX + '/')) {
      res.writeHead(404)
      return res.end()
    }
    const path = req.url.slice(PREFIX.length)
    const upstream = http.request(
      { host: '127.0.0.1', port: target, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${target}` } },
      (up) => {
        res.writeHead(up.statusCode, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${proxy.address().port}${PREFIX}`
})

test.afterAll(async () => {
  await new Promise((r) => proxy.close(r))
})

test('the bare prefix redirects to a trailing slash', async ({ page }) => {
  const res = await page.goto(base)
  expect(res.url()).toBe(base + '/')
})

test('the shell, styles and modules all load under a prefix', async ({ page }) => {
  const failed = []
  page.on('requestfailed', (r) => failed.push(r.url()))
  page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`) })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(base + '/')
  // The shell removes app-booting once the sidebar has rendered.
  await expect(page.locator('#app')).not.toHaveClass(/app-booting/, { timeout: 15000 })

  // Styles actually applied, not just requested: tokens.css sets the page background.
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(bg).not.toBe('rgba(0, 0, 0, 0)')

  expect(failed).toEqual([])
  expect(errors).toEqual([])
})

test('an API call resolves against the prefix', async ({ page }) => {
  await page.goto(base + '/')
  const seen = []
  page.on('request', (r) => { if (r.url().includes('/api/')) seen.push(r.url()) })
  await page.evaluate(async () => {
    const { api } = await import('./lib/api.js')
    await api.get('/api/modules')
  })
  expect(seen.length).toBeGreaterThan(0)
  for (const u of seen) expect(u).toContain('/m/truss/api/')
})

test('hosted mode is read from the meta tag the proxy injects', async ({ page }) => {
  // Mirrors what the web_server's proxy does to the HTML it serves: one replace
  // on <head>. addInitScript cannot stand in for it - that runs at document
  // start, when document.head is still null.
  await page.route(base + '/', async (route) => {
    const res = await route.fetch()
    const body = (await res.text()).replace('<head>', '<head><meta name="truss-hosted" content="1">')
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-length': String(Buffer.byteLength(body)) } })
  })
  await page.goto(base + '/')
  const hosted = await page.evaluate(async () => (await import('./lib/api.js')).hosted)
  expect(hosted).toBe(true)
})

test('without the meta tag the client is not in hosted mode', async ({ page }) => {
  await page.goto(base + '/')
  const hosted = await page.evaluate(async () => (await import('./lib/api.js')).hosted)
  expect(hosted).toBe(false)
})

test('every mutating request carries the CSRF header the host injected', async ({ page }) => {
  // The gap this pins: api.js once read the meta tags but never sent the header,
  // so every write 403'd behind the real host. Neither side's suite caught it -
  // Truss's tests have no CSRF guard and the host's tests set the header by hand.
  await page.route(base + '/', async (route) => {
    const res = await route.fetch()
    const body = (await res.text()).replace(
      '<head>',
      '<head><meta name="truss-hosted" content="1"><meta name="truss-csrf" content="csrf-xyz">',
    )
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-length': String(Buffer.byteLength(body)) } })
  })
  await page.goto(base + '/')

  const sent = []
  page.on('request', (r) => {
    if (r.url().includes('/api/') && r.method() !== 'GET') sent.push(r.headers()['x-csrf-token'])
  })
  await page.evaluate(async () => {
    const { api } = await import('./lib/api.js')
    await api.post('/api/modules', { type: 'database', title: 'CSRF probe' })
    await api.upload('/api/attachments?moduleId=x&pageId=y', new Blob(['hi'], { type: 'text/plain' }), 'hi.txt').catch(() => {})
  })
  expect(sent.length).toBeGreaterThanOrEqual(2)
  for (const h of sent) expect(h).toBe('csrf-xyz')
})

test('locally, with no meta tag, no CSRF header is sent', async ({ page }) => {
  await page.goto(base + '/')
  const sent = []
  page.on('request', (r) => {
    if (r.url().includes('/api/') && r.method() !== 'GET') sent.push(r.headers()['x-csrf-token'])
  })
  await page.evaluate(async () => {
    const { api } = await import('./lib/api.js')
    await api.post('/api/modules', { type: 'database', title: 'Local probe' })
  })
  expect(sent.length).toBeGreaterThan(0)
  for (const h of sent) expect(h).toBeUndefined()
})
