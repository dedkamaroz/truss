import { test, expect } from '@playwright/test'
import { watch, boot, apiCall, createModule, uid, fixture, shot, setTheme, clearScripts, registerScript, notebook, openPage } from './helpers.js'

test('init registers the #/scripts route, a Scripts sidebar item and a Run script page action for notebook pages only', async ({ page }) => {
  const w = await watch(page)
  await boot(page)

  const item = page.locator('.sidebar-link', { hasText: 'Scripts' })
  await expect(item).toBeVisible()
  await expect(item).toHaveAttribute('href', '#/scripts')
  await item.click()
  await expect(page).toHaveURL(/#\/scripts$/)
  await expect(page.locator('.sc-page h1')).toHaveText('Scripts')
  await expect(item).toHaveClass(/is-active/)
  await expect(page.locator('.breadcrumb')).toContainText('Scripts')

  // registry: available for notebook modules, never for database or sheet modules
  const avail = await page.evaluate(async () => {
    const { getPageActions, matchRoute } = await import('/lib/registry.js')
    const ids = (type) => getPageActions({ module: { id: 'm-1', type }, pageId: 'p-1', attachments: [] }).map((a) => a.id)
    return { notebook: ids('notebook'), database: ids('database'), sheet: ids('sheet'), route: matchRoute('/scripts')?.title }
  })
  expect(avail.notebook).toContain('run-script')
  expect(avail.database).not.toContain('run-script')
  expect(avail.sheet).not.toContain('run-script')
  expect(avail.route).toBe('Scripts')

  // rendered on text-style and table-style notebook pages
  const text = await notebook(page, 'text')
  await openPage(page, text.module.id, text.pages[0].id)
  await expect(page.locator('.nb-page.is-text')).toBeVisible()
  await expect(page.locator('.nb-page-toolbar').getByRole('button', { name: 'Run script' })).toBeVisible()
  const table = await notebook(page, 'table')
  await openPage(page, table.module.id, table.pages[0].id)
  await expect(page.locator('.nb-page.is-table')).toBeVisible()
  await expect(page.locator('.nb-page-toolbar').getByRole('button', { name: 'Run script' })).toBeVisible()

  // not on database or sheet modules
  for (const type of ['database', 'sheet']) {
    const m = await createModule(page, { type, title: `${type} ${uid()}` })
    await page.goto(`/#/m/${m.id}`)
    await expect(page.locator('.module-body')).toBeVisible()
    await page.waitForTimeout(400)
    await expect(page.getByRole('button', { name: 'Run script' })).toHaveCount(0)
  }
  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})

test('run history keeps the DOM bounded: 50 rows at a time with Show more', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const base = Date.parse('2026-05-14T00:00:00Z')
  const fake = Array.from({ length: 120 }, (_, i) => ({
    id: `run-${i}`, script_id: null, script_name: `Bulk ${i}`, module_id: 'gone', page_id: null, status: 'succeeded', exit_code: 0,
    stdout: '', stderr: '', input_attachment_ids: [], output_attachment_ids: [],
    created_at: new Date(base - i * 60000).toISOString(), started_at: new Date(base - i * 60000).toISOString(), finished_at: new Date(base - i * 60000 + 1500).toISOString(),
  }))
  await page.route('**/api/runs', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fake) }))
  await page.goto('/#/scripts')
  await expect(page.locator('.sc-run-row')).toHaveCount(50)
  await expect(page.locator('.sc-run-row').first().locator('.sc-td-started')).toHaveText('14/05/2026 10:00 am AEST')
  await expect(page.locator('.sc-run-row').first().locator('.sc-td-duration')).toHaveText('1.5 s')
  await page.getByRole('button', { name: 'Show more (70 older)' }).click()
  await expect(page.locator('.sc-run-row')).toHaveCount(100)
  await page.getByRole('button', { name: 'Show more (20 older)' }).click()
  await expect(page.locator('.sc-run-row')).toHaveCount(120)
  await expect(page.getByRole('button', { name: /Show more/ })).toHaveCount(0)
  expect(w.errors).toEqual([])
})

test('scripts manager: add by path with kind badges, inline API errors, Browse, edit, config validation, delete with confirm', async ({ page }) => {
  const w = await watch(page)
  await page.setViewportSize({ width: 1360, height: 900 })
  await boot(page)
  await clearScripts(page)
  await page.goto('/#/scripts')
  await expect(page.locator('.sc-list .empty-state')).toContainText('No scripts yet')

  const input = page.getByRole('textbox', { name: 'Script path' })
  const add = page.getByRole('button', { name: 'Add script' })

  // add a .bat and a .ps1
  await input.fill(fixture('tidy.bat'))
  await add.click()
  await expect(page.locator('.sc-row')).toHaveCount(1)
  await input.fill(fixture('process.ps1'))
  await input.press('Enter')
  await expect(page.locator('.sc-row')).toHaveCount(2)
  const bat = page.locator('.sc-row', { hasText: 'tidy' })
  const ps1 = page.locator('.sc-row', { hasText: 'process' })
  await expect(bat.locator('.sc-kind')).toHaveText('Batch')
  await expect(bat.locator('.sc-kind')).toHaveAttribute('data-kind', 'bat')
  await expect(ps1.locator('.sc-kind')).toHaveText('PowerShell')
  await expect(ps1.locator('.sc-kind')).toHaveAttribute('data-kind', 'ps1')
  await expect(bat.locator('.sc-row-path')).toHaveText(fixture('tidy.bat'))
  await expect(bat.locator('.sc-row-timeout')).toHaveText('30 min')
  expect((await apiCall(page, 'GET', '/api/scripts')).body.map((s) => s.kind).sort()).toEqual(['bat', 'ps1'])
  await expect(input).toHaveValue('')

  // invalid paths: the API message is shown inline, no native dialog, nothing added
  await input.fill(fixture('missing-script.bat'))
  await add.click()
  const error = page.locator('.sc-add .sc-error')
  await expect(error).toBeVisible()
  await expect(error).toHaveText('Script file does not exist')
  await expect(input).toHaveAttribute('aria-invalid', 'true')
  await input.fill(fixture('notes.txt'))
  await add.click()
  await expect(error).toHaveText('Only .bat, .cmd and .ps1 scripts are supported')
  await shot(page, 'manager-error-light')
  await input.fill('relative\\thing.ps1')
  await add.click()
  await expect(error).toHaveText('path must be absolute')
  await expect(page.locator('.sc-row')).toHaveCount(2)
  await input.fill('x')
  await expect(error).toBeHidden()

  // Browse calls POST /api/scripts/browse and fills the path
  const browseCalls = []
  const chosen = fixture('fail.bat')
  await page.route('**/api/scripts/browse', (route) => {
    browseCalls.push(route.request().method())
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ path: chosen }) })
  })
  await page.getByRole('button', { name: 'Browse' }).click()
  await expect(input).toHaveValue(chosen)
  expect(browseCalls).toEqual(['POST'])
  // a cancelled native dialog ({ path: null }) leaves the field alone
  await page.unroute('**/api/scripts/browse')
  await page.route('**/api/scripts/browse', (route) => {
    browseCalls.push(route.request().method())
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"path":null}' })
  })
  await page.getByRole('button', { name: 'Browse' }).click()
  await expect.poll(() => browseCalls.length).toBe(2)
  await expect(input).toHaveValue(chosen)
  await add.click()
  await expect(page.locator('.sc-row')).toHaveCount(3)

  await shot(page, 'manager-light')
  await setTheme(page, 'dark')
  await shot(page, 'manager-dark')
  await setTheme(page, 'light')

  // edit name and timeout; persisted
  const failRow = page.locator('.sc-row', { hasText: 'fail' })
  await failRow.getByRole('button', { name: 'Edit fail' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Edit script')
  await dialog.getByLabel('Name', { exact: true }).fill('Validate statement')
  await dialog.getByLabel('Timeout (seconds)').fill('90')
  await shot(page, 'manager-edit-light')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  const edited = page.locator('.sc-row', { hasText: 'Validate statement' })
  await expect(edited.locator('.sc-row-timeout')).toHaveText('1 min 30 s')
  let saved = (await apiCall(page, 'GET', '/api/scripts')).body.find((s) => s.path === chosen)
  expect(saved).toMatchObject({ name: 'Validate statement', timeout_sec: 90 })

  // invalid config JSON is rejected client-side: message, no PATCH sent
  const patches = []
  page.on('request', (r) => r.method() === 'PATCH' && r.url().includes('/api/scripts/') && patches.push(r.postData()))
  await edited.getByRole('button', { name: 'Edit Validate statement' }).click()
  const config = dialog.getByLabel('Config (JSON)')
  await expect(config).toHaveValue('{}')
  await config.fill('{"mode": "strict",}')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.locator('.sc-error')).toContainText('Config is not valid JSON')
  await expect(config).toHaveAttribute('aria-invalid', 'true')
  await config.fill('[1, 2]')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.locator('.sc-error')).toContainText('Config must be a JSON object')
  await dialog.getByLabel('Timeout (seconds)').fill('0')
  await config.fill('{"mode": "strict"}')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.locator('.sc-error')).toContainText('Timeout must be a whole number')
  await setTheme(page, 'dark')
  await shot(page, 'manager-config-error-dark')
  await setTheme(page, 'light')
  await page.waitForTimeout(200)
  expect(patches).toEqual([])
  await dialog.getByLabel('Timeout (seconds)').fill('120')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
  expect(patches).toHaveLength(1)
  saved = (await apiCall(page, 'GET', '/api/scripts')).body.find((s) => s.path === chosen)
  expect(saved).toMatchObject({ name: 'Validate statement', timeout_sec: 120, config: { mode: 'strict' } })

  // survives a reload
  await page.reload()
  await expect(page.locator('.sc-row', { hasText: 'Validate statement' }).locator('.sc-row-timeout')).toHaveText('2 min')

  // delete uses the custom confirm: cancel keeps it, confirm removes it
  const target = page.locator('.sc-row', { hasText: 'tidy' })
  await target.getByRole('button', { name: 'Delete tidy' }).click()
  await expect(dialog).toContainText('Delete "tidy"?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(target).toHaveCount(1)
  await target.getByRole('button', { name: 'Delete tidy' }).click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(target).toHaveCount(0)
  expect((await apiCall(page, 'GET', '/api/scripts')).body.map((s) => s.name).sort()).toEqual(['Validate statement', 'process'])

  expect(w.dialogs).toEqual([])
  // the only console errors allowed are the deliberate 400 responses from invalid registrations
  expect(w.errors.filter((e) => !e.includes('400'))).toEqual([])
})
