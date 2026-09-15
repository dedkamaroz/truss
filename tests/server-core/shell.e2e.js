import { test, expect } from '@playwright/test'

test('index page loads with injected token, CSP and a working API', async ({ page }) => {
  const errors = []
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', (e) => errors.push(e.message))

  const res = await page.goto('/')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'")
  const token = await page.locator('meta[name="truss-token"]').getAttribute('content')
  expect(token).toMatch(/^[0-9a-f]{48}$/)

  const result = await page.evaluate(async (tok) => {
    const created = await fetch('/api/modules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Truss-Token': tok },
      body: JSON.stringify({ type: 'notebook', title: 'E2E notebook' }),
    }).then((r) => r.json())
    const noToken = await fetch('/api/modules').then((r) => r.status)
    return { created, noToken }
  }, token)
  expect(result.noToken).toBe(401)
  expect(result.created.title).toBe('E2E notebook')

  await page.screenshot({ path: 'test-results/server-core/index.png' })
  // the deliberate no-token request logs one 401; nothing else (e.g. CSP violations) may appear
  expect(errors.filter((e) => !e.includes('401'))).toEqual([])
})
