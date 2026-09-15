import { test, expect } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

test('the CLI server registers a script and runs it against page attachments', async ({ page, request }) => {
  await page.goto('/')
  const token = await page.locator('meta[name="truss-token"]').getAttribute('content')
  const headers = { 'X-Truss-Token': token }

  const mod = await (await request.post('/api/modules', { headers, data: { type: 'notebook', title: 'Scripts E2E' } })).json()
  const pageId = 'page-e2e'
  const upload = await request.post(`/api/attachments?moduleId=${mod.id}&pageId=${pageId}`, {
    headers: { ...headers, 'X-Filename': encodeURIComponent('input.txt'), 'Content-Type': 'application/octet-stream' },
    data: Buffer.from('e2e payload'),
  })
  const att = await upload.json()

  const bad = await request.post('/api/scripts', { headers, data: { path: 'relative.bat' } })
  expect(bad.status()).toBe(400)

  const script = await (await request.post('/api/scripts', { headers, data: { path: path.join(FIXTURES, 'copy-inputs.ps1') } })).json()
  expect(script.kind).toBe('ps1')
  const run = await (await request.post(`/api/scripts/${script.id}/run`, { headers, data: { moduleId: mod.id, pageId, attachmentIds: [att.id] } })).json()

  await expect.poll(async () => (await (await request.get(`/api/runs/${run.id}`, { headers })).json()).status, { timeout: 30000 }).toBe('succeeded')
  const finished = await (await request.get(`/api/runs/${run.id}`, { headers })).json()
  expect(finished.output_attachment_ids).toHaveLength(2)

  const listed = await (await request.get(`/api/attachments?moduleId=${mod.id}&pageId=${pageId}`, { headers })).json()
  const copy = listed.find((a) => a.source === 'script-output' && a.filename === 'input.txt')
  expect(copy).toBeTruthy()
  const body = await (await request.get(`/api/attachments/${copy.id}/content`, { headers })).text()
  expect(body).toBe('e2e payload')

  // The CLI server is not in dry-run mode, so browse is not exercised here (it would open a real dialog).
  const runs = await (await request.get(`/api/runs?moduleId=${mod.id}&pageId=${pageId}`, { headers })).json()
  expect(runs.map((r) => r.id)).toEqual([run.id])
})
