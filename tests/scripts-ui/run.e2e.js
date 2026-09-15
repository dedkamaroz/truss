import { test, expect } from '@playwright/test'
import { watch, boot, apiCall, uid, shot, setTheme, registerScript, uploadText, notebook, openPage, waitRun } from './helpers.js'

test.setTimeout(120000)

/** Records every data-status value the run dialog shows, from before Run is clicked. */
async function recordStatuses(page) {
  await page.evaluate(() => {
    window.__statuses = []
    new MutationObserver(() => {
      const s = document.querySelector('.sc-run')?.dataset.status
      if (s && window.__statuses.at(-1) !== s) window.__statuses.push(s)
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] })
  })
}

const footerClose = (dialog) => dialog.locator('.modal-footer, .sc-dialog-footer').getByRole('button', { name: 'Close', exact: true })

/** Counts requests to /api/runs/<id> (the poll endpoint) from now on. */
function countPolls(page, runId) {
  const hits = []
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === `/api/runs/${runId}`) hits.push(Date.now())
  })
  return hits
}

async function startFromDialog(page, scriptName) {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: new RegExp(scriptName) }).check()
  const posted = page.waitForResponse((r) => /\/api\/scripts\/[^/]+\/run$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  const res = await posted
  expect(res.status()).toBe(201)
  return res.json()
}

test('run from a text page: choose attachments, live status to succeeded, stdout, outputs attached without reload, success toast, polling stops', async ({ page }) => {
  const w = await watch(page)
  await page.setViewportSize({ width: 1360, height: 900 })
  await boot(page)
  const script = await registerScript(page, 'process.ps1', { name: `Process ${uid()}` })
  const { module, pages } = await notebook(page, 'text')
  const target = pages[0]
  const alpha = await uploadText(page, module.id, target.id, 'alpha.csv', 'id,name\n1,Alpha')
  const beta = await uploadText(page, module.id, target.id, 'beta.csv', 'id,name\n2,Beta')
  await openPage(page, module.id, target.id)
  await expect(page.locator('.nb-page.is-text')).toBeVisible()
  await page.evaluate(() => { window.__noReload = true })

  await page.locator('.nb-page-toolbar').getByRole('button', { name: 'Run script' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Run script')
  const boxes = dialog.getByRole('checkbox')
  await expect(boxes).toHaveCount(2)
  await expect(dialog.getByRole('checkbox', { name: 'alpha.csv' })).toBeChecked()
  await expect(dialog.getByRole('checkbox', { name: 'beta.csv' })).toBeChecked()
  await expect(dialog).toContainText('2 of 2 selected')
  await dialog.getByRole('checkbox', { name: 'beta.csv' }).uncheck()
  await expect(dialog).toContainText('1 of 2 selected')
  await shot(page, 'run-dialog-form-light')

  await recordStatuses(page)
  const run = await startFromDialog(page, script.name)
  expect(run.input_attachment_ids).toEqual([alpha.id])
  expect(run.input_attachment_ids).not.toContain(beta.id)

  // live status while running, captured mid-run in both themes
  const status = dialog.locator('.sc-live-status .sc-status')
  await expect(status).toHaveText('Running', { timeout: 15000 })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  await expect(dialog.locator('.sc-log-pre')).toContainText('started', { timeout: 10000 })
  await shot(page, 'run-dialog-running-light')
  await setTheme(page, 'dark')
  await shot(page, 'run-dialog-running-dark')
  await setTheme(page, 'light')

  const polls = countPolls(page, run.id)
  await expect(status).toHaveText('Succeeded', { timeout: 30000 })
  const statuses = await page.evaluate(() => window.__statuses)
  expect(statuses).toContain('running')
  expect(statuses.at(-1)).toBe('succeeded')
  expect(statuses.indexOf('running')).toBeLessThan(statuses.indexOf('succeeded'))
  expect(polls.length).toBeGreaterThan(0)

  // stdout viewer
  await dialog.getByRole('tab', { name: /stdout/ }).click()
  await expect(dialog.locator('.sc-log-pre')).toContainText('processed alpha.csv')
  await expect(dialog.locator('.sc-log-pre')).toContainText('done: 1 inputs')
  await expect(dialog.locator('.sc-log-pre')).not.toContainText('beta.csv')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeHidden()

  // success toast with the output count
  const toast = page.locator('.toast-success', { hasText: script.name })
  await expect(toast).toContainText('2 output files attached')

  // outputs are on the page's attachments panel without a reload
  await footerClose(dialog).click()
  const panel = page.locator('.nb-attachments')
  await expect(panel.locator('.nb-att', { hasText: 'processed-alpha.csv' })).toBeVisible()
  await expect(panel.locator('.nb-att', { hasText: 'summary.txt' })).toBeVisible()
  await expect(panel.locator('.nb-att')).toHaveCount(4)
  expect(await page.evaluate(() => window.__noReload)).toBe(true)
  const finished = (await apiCall(page, 'GET', `/api/runs/${run.id}`)).body
  expect(finished.status).toBe('succeeded')
  expect(finished.output_attachment_ids).toHaveLength(2)

  // polling stopped once the run finished
  const after = polls.length
  await page.waitForTimeout(3000)
  expect(polls.length).toBe(after)

  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})

test('run from a table page: a failing script shows an error toast with exit code and stderr snippet', async ({ page }) => {
  const w = await watch(page)
  await page.setViewportSize({ width: 1360, height: 900 })
  await boot(page)
  const script = await registerScript(page, 'fail.bat', { name: `Failing check ${uid()}` })
  const { module, pages } = await notebook(page, 'table')
  const target = pages[0]
  await uploadText(page, module.id, target.id, 'register.csv', 'a,b')
  await openPage(page, module.id, target.id)
  await expect(page.locator('.nb-page.is-table')).toBeVisible()

  await page.locator('.nb-page-toolbar').getByRole('button', { name: 'Run script' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('checkbox', { name: 'register.csv' })).toBeChecked()
  const run = await startFromDialog(page, script.name)
  const polls = countPolls(page, run.id)
  await expect(dialog.locator('.sc-live-status .sc-status')).toHaveText('Failed', { timeout: 30000 })
  await expect(dialog.locator('.sc-exit')).toHaveText('Exit code 7')
  // stderr is surfaced in the viewer for a failed run
  await expect(dialog.getByRole('tab', { name: /stderr/ })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.locator('.sc-log-pre')).toContainText('Input file is corrupt: header row missing')
  const toast = page.locator('.toast-error', { hasText: script.name })
  await expect(toast).toContainText('exit code 7')
  await expect(toast).toContainText('Input file is corrupt: header row missing')
  await footerClose(dialog).click()
  await expect(dialog).toHaveCount(0)
  await shot(page, 'error-toast-light')
  await setTheme(page, 'dark')
  await shot(page, 'error-toast-dark')
  await setTheme(page, 'light')

  const after = polls.length
  await page.waitForTimeout(3000)
  expect(polls.length).toBe(after)
  expect((await apiCall(page, 'GET', `/api/runs/${run.id}`)).body).toMatchObject({ status: 'failed', exit_code: 7 })
  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})

test('a long-running script can be cancelled from the dialog and ends cancelled; polling stops', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const script = await registerScript(page, 'long.bat', { name: `Long job ${uid()}` })
  const { module, pages } = await notebook(page, 'text')
  await openPage(page, module.id, pages[0].id)
  await page.locator('.nb-page-toolbar').getByRole('button', { name: 'Run script' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('no attachments')
  await recordStatuses(page)
  const run = await startFromDialog(page, script.name)
  const status = dialog.locator('.sc-live-status .sc-status')
  await expect(status).toHaveText('Running', { timeout: 15000 })
  await expect(dialog.locator('.sc-log-pre')).toContainText('long job started', { timeout: 10000 })
  const polls = countPolls(page, run.id)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(status).toHaveText('Cancelled', { timeout: 20000 })
  await expect(page.locator('.toast', { hasText: script.name })).toContainText('cancelled')
  expect((await apiCall(page, 'GET', `/api/runs/${run.id}`)).body.status).toBe('cancelled')
  expect((await page.evaluate(() => window.__statuses)).at(-1)).toBe('cancelled')
  await page.waitForTimeout(300)
  const after = polls.length
  await page.waitForTimeout(3000)
  expect(polls.length).toBe(after)
  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})

const sydney = (iso) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]))
  return { date: `${p.day}/${p.month}/${p.year}`, time: `${p.hour}:${p.minute} ${p.dayPeriod.toLowerCase()}` }
}

test('run history on #/scripts: status badges, DD/MM/YYYY times with AEST/AEDT, durations, page links and log viewer', async ({ page }) => {
  const w = await watch(page)
  await page.setViewportSize({ width: 1360, height: 900 })
  await boot(page)
  const ok = await registerScript(page, 'process.ps1', { name: `History ok ${uid()}` })
  const bad = await registerScript(page, 'fail.bat', { name: `History fail ${uid()}` })
  const long = await registerScript(page, 'long.bat', { name: `History long ${uid()}` })
  const { module, pages } = await notebook(page, 'text')
  const target = pages[0]
  const input = await uploadText(page, module.id, target.id, 'input.txt', 'hello')
  const start = async (s, ids = []) => (await apiCall(page, 'POST', `/api/scripts/${s.id}/run`, { moduleId: module.id, pageId: target.id, attachmentIds: ids })).body
  const r1 = await start(ok, [input.id])
  const r2 = await start(bad)
  const done1 = await waitRun(page, r1.id)
  const done2 = await waitRun(page, r2.id)
  const r3 = await start(long)
  await expect.poll(async () => (await apiCall(page, 'GET', `/api/runs/${r3.id}`)).body.status, { timeout: 15000 }).toBe('running')
  await apiCall(page, 'POST', `/api/runs/${r3.id}/cancel`)
  const done3 = await waitRun(page, r3.id)
  expect([done1.status, done2.status, done3.status]).toEqual(['succeeded', 'failed', 'cancelled'])

  await page.goto('/#/scripts')
  const row = (r) => page.locator(`.sc-run-row[data-id="${r.id}"]`)
  for (const [r, label] of [[done1, 'Succeeded'], [done2, 'Failed'], [done3, 'Cancelled']]) {
    await expect(row(r).locator('.sc-status')).toHaveText(label)
    await expect(row(r).locator('.sc-status')).toHaveAttribute('data-status', r.status)
    const started = (await row(r).locator('.sc-td-started').innerText()).trim()
    expect(started).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (am|pm) (AEST|AEDT)$/)
    const exp = sydney(r.started_at)
    expect(started.startsWith(`${exp.date} ${exp.time} `)).toBe(true)
    const link = row(r).locator('a.sc-page-link')
    await expect(link).toHaveAttribute('href', `#/m/${module.id}/p/${target.id}`)
    await expect(link).toHaveText(target.title)
  }
  await expect(row(done1).locator('.sc-td-script')).toHaveText(ok.name)
  await expect(row(done2).locator('.sc-td-script')).toHaveText(bad.name)

  // durations match the recorded start and finish times
  const secs = (Date.parse(done1.finished_at) - Date.parse(done1.started_at)) / 1000
  const shown = (await row(done1).locator('.sc-td-duration').innerText()).trim()
  expect(shown).toMatch(/^\d+(\.\d)? s$/)
  expect(Math.abs(parseFloat(shown) - secs)).toBeLessThanOrEqual(0.6)
  for (const r of [done2, done3]) await expect(row(r).locator('.sc-td-duration')).toHaveText(/^(\d+ ms|\d+(\.\d)? s|\d+ min( \d+ s)?)$/)
  await expect(page.locator('.sc-history')).not.toContainText('null')
  await page.locator('.sc-history').scrollIntoViewIfNeeded()
  await shot(page, 'history-light')
  await setTheme(page, 'dark')
  await shot(page, 'history-dark')
  await setTheme(page, 'light')

  // log viewer: stdout and stderr
  await row(done2).getByRole('button', { name: 'Logs' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(`Logs: ${bad.name}`)
  await expect(dialog).toContainText('Exit code 7')
  // a failed run opens on stderr
  await expect(dialog.getByRole('tab', { name: /stderr/ })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.locator('.sc-log-pre')).toContainText('Input file is corrupt')
  await dialog.getByRole('tab', { name: /stdout/ }).click()
  await expect(dialog.locator('.sc-log-pre')).toContainText('checking inputs')
  await setTheme(page, 'dark')
  await shot(page, 'log-viewer-dark')
  await setTheme(page, 'light')
  await footerClose(dialog).click()
  await row(done1).getByRole('button', { name: 'Logs' }).click()
  await expect(dialog.locator('.sc-log-pre')).toContainText('processed input.txt')
  await shot(page, 'log-viewer-light')
  await footerClose(dialog).click()

  // the page link goes back to the page
  await row(done1).locator('a.sc-page-link').click()
  await expect(page.locator(`.nb-page[data-page-id="${target.id}"]`)).toBeVisible()
  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})
