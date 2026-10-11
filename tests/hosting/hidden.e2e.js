// Browser-level proof of the hidden-database feature, at the layer the API
// tests cannot reach: a NON-ADMIN browser must not see the hidden database in
// the UI, yet a visible database's lookup column must still render the values
// it references from it. The lookup data flows through GET /api/databases/:id
// (fetchRelated in store.js), which stays open on purpose: that endpoint IS the
// referenced-data channel. Hiding removes listings, routes and writes.
//
// The proxy below is a minimal stand-in for the web_server's /m/truss proxy:
// it injects the truss-hosted meta tag and adds X-Truss-Admin only when a test
// asks for the admin browser. The real proxy is tested in web_server's suite.
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { startServer } from '../../server/main.js'

let s
let proxy
let base
let teamTitle
let fi

async function api(method, p, body, admin = false) {
  const res = await fetch(`http://127.0.0.1:${s.port}${p}`, {
    method,
    headers: { 'X-Truss-Token': s.token, 'Content-Type': 'application/json', ...(admin ? { 'X-Truss-Admin': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(json)}`)
  return json
}

test.beforeAll(async () => {
  process.env.TRUSS_HIDDEN_TITLES = 'FI Names'
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-hidden-e2e-'))
  s = await startServer({ port: 0, dataDir, hosted: true })

  // The reference database. Created by an admin: only admins may take the title.
  fi = await api('POST', '/api/modules', { type: 'database', title: 'FI Names' }, true)
  const fiTitle = (await api('GET', `/api/databases/${fi.id}`)).properties[0]
  const email = await api('POST', `/api/databases/${fi.id}/properties`, { name: 'Email', type: 'text' }, true)
  await api('POST', `/api/databases/${fi.id}/rows`, { values: { [fiTitle.id]: 'Alice', [email.id]: 'alice@fi.example' } }, true)
  await api('POST', `/api/databases/${fi.id}/rows`, { values: { [fiTitle.id]: 'Bob', [email.id]: 'bob@fi.example' } }, true)

  // The public database, with a lookup into the reference one.
  const team = await api('POST', '/api/modules', { type: 'database', title: 'Team' }, true)
  teamTitle = (await api('GET', `/api/databases/${team.id}`)).properties[0]
  await api('POST', `/api/databases/${team.id}/properties`, {
    name: 'Email', type: 'lookup',
    config: { sourcePropertyId: teamTitle.id, targetModuleId: fi.id, matchPropertyId: fiTitle.id, returnPropertyId: email.id },
  }, true)
  await api('POST', `/api/databases/${team.id}/rows`, { values: { [teamTitle.id]: 'Alice' } }, true)

  proxy = http.createServer((req, res) => {
    const up = http.request(
      { host: '127.0.0.1', port: s.port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${s.port}` } },
      (r) => {
        if (/text\/html/.test(r.headers['content-type'] || '')) {
          let body = ''
          r.on('data', (c) => (body += c))
          r.on('end', () => {
            const headers = { ...r.headers }
            delete headers['content-length']
            res.writeHead(r.statusCode, headers)
            res.end(body.replace('<head>', '<head><meta name="truss-hosted" content="1">'))
          })
        } else {
          res.writeHead(r.statusCode, r.headers)
          r.pipe(res)
        }
      },
    )
    up.on('error', () => res.destroy())
    req.pipe(up)
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${proxy.address().port}`
})

test.afterAll(async () => {
  delete process.env.TRUSS_HIDDEN_TITLES
  await s.close()
  proxy.closeAllConnections()
  await new Promise((r) => proxy.close(r))
  fs.rmSync(s.ctx.dataDir, { recursive: true, force: true })
})

async function open(page) {
  await page.goto(base)
  await expect(page.locator('#app')).not.toHaveClass(/app-booting/, { timeout: 15000 })
  await expect(page.locator('.load-pane')).toHaveCount(0, { timeout: 15000 })
}

test('a non-admin browser does not see the hidden database but its lookup values still render', async ({ page }) => {
  await open(page)
  await expect(page.locator('.sb-item', { hasText: 'FI Names' })).toHaveCount(0)
  await page.locator('.sb-item', { hasText: 'Team' }).click()
  const row = page.locator('.dbt-row').first()
  await expect(row).toContainText('Alice')
  // The whole point: the referenced data from the hidden database is visible.
  await expect(row).toContainText('alice@fi.example')
  // And nothing leaks into the switcher either.
  await page.keyboard.press('Control+k')
  await page.locator('[data-switcher]').fill('FI')
  await expect(page.locator('.sw-list')).toContainText('No matches.')
})

test('an admin browser still sees and can open the hidden database', async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Truss-Admin': '1' } })
  const page = await ctx.newPage()
  await open(page)
  await page.locator('.sb-item', { hasText: 'FI Names' }).click()
  const row = page.locator('.dbt-row').first()
  await expect(row).toContainText('Alice')
  await expect(row).toContainText('alice@fi.example')
  await ctx.close()
})
