import { test, expect } from '@playwright/test'
import zlib from 'node:zlib'
import { watch, boot, createModule, api, load, shot, uid } from './helpers.js'

function png(w, h, [r1, g1, b1], [r2, g2, b2]) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = (x / w + y / h) / 2
    const i = y * (w * 3 + 1) + 1 + x * 3
    raw[i] = r1 + (r2 - r1) * t; raw[i + 1] = g1 + (g2 - g1) * t; raw[i + 2] = b1 + (b2 - b1) * t
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function seed(page) {
  const module = await createModule(page, { type: 'database', title: `Client onboarding ${uid()}`, icon: '🗂️' })
  const base = `/api/databases/${module.id}`
  const data = await load(page, module.id)
  const P = { Name: data.properties[0] }
  await api(page, 'PATCH', `${base}/properties/${P.Name.id}`, { width: 230 })
  const mk = async (name, type, width, config) => (P[name] = await api(page, 'POST', `${base}/properties`, { name, type, width, config }))
  await mk('Status', 'status', 130)
  await mk('Priority', 'select', 100, { options: [{ name: 'High', color: 'red' }, { name: 'Medium', color: 'yellow' }, { name: 'Low', color: 'gray' }] })
  await mk('Tags', 'multi_select', 150, { options: [{ name: 'KYC', color: 'blue' }, { name: 'Contract', color: 'purple' }, { name: 'Renewal', color: 'green' }, { name: 'Urgent', color: 'orange' }] })
  await mk('Due', 'date', 110)
  await mk('Fee', 'number', 100, { format: 'aud' })
  await mk('Verified', 'checkbox', 90)
  await mk('Email', 'email', 140)
  await mk('Logo', 'files', 140)
  const s = Object.fromEntries(P.Status.config.options.map((o) => [o.name, o.id]))
  const pr = Object.fromEntries(P.Priority.config.options.map((o) => [o.name, o.id]))
  const tg = Object.fromEntries(P.Tags.config.options.map((o) => [o.name, o.id]))
  const now = new Date()
  const day = (d) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const rows = [
    ['Harbour Logistics onboarding', 'In progress', 'High', ['KYC', 'Urgent'], day(4), 1250, true, 'ops@harbour.au'],
    ['Blue Gum Advisory refresh', 'Not started', 'Medium', ['KYC'], day(9), 480, false, 'hi@bluegum.au'],
    ['Southern Paper Co contract', 'Done', 'Low', ['Contract'], day(12), 3200, true, 'am@southern.au'],
    ['Coastal Dental identity check', 'In progress', 'High', ['KYC'], day(12), 275.5, false, 'desk@coastal.au'],
    ['Redgum Builders review', 'Not started', 'Low', ['Renewal'], day(18), 990, false, 'team@redgum.au'],
    ['Wattle Street Cafe setup', 'Done', 'Medium', ['Contract', 'KYC'], day(21), 150, true, 'cafe@wattle.au'],
    ['Northside Physio renewal', 'In progress', 'Medium', ['Renewal'], day(25), 640, true, 'admin@nsp.au'],
    ['Bright Solar audit', 'Not started', 'High', ['Urgent'], day(27), 2100, false, 'audit@bright.au'],
  ].map(([n, st, p, tags, due, fee, ok, email]) => ({ values: {
    [P.Name.id]: n, [P.Status.id]: s[st], [P.Priority.id]: pr[p], [P.Tags.id]: tags.map((t) => tg[t]), [P.Due.id]: { start: due }, [P.Fee.id]: fee, [P.Verified.id]: ok, [P.Email.id]: email,
  } }))
  const { created } = await api(page, 'POST', `${base}/rows/batch`, { create: rows })
  const colours = [[[35, 131, 226], [123, 97, 255]], [[43, 138, 100], [160, 214, 120]], [[203, 123, 18], [244, 196, 90]], [[196, 85, 77], [240, 140, 160]]]
  for (let i = 0; i < 4; i++) {
    const att = await page.evaluate(async ({ url, bytes }) => {
      const token = document.querySelector('meta[name="truss-token"]').content
      return (await fetch(url, { method: 'POST', headers: { 'X-Truss-Token': token, 'X-Filename': 'logo.png' }, body: new Uint8Array(bytes) })).json()
    }, { url: `/api/attachments?moduleId=${module.id}&pageId=${created[i].id}`, bytes: [...png(160, 100, ...colours[i])] })
    await api(page, 'PATCH', `${base}/rows/${created[i].id}`, { values: { [P.Logo.id]: [att.id] } })
  }
  const table = data.views[0]
  await api(page, 'PATCH', `${base}/views/${table.id}`, { name: 'All clients', config: { hidden: [P.Logo.id] } })
  const board = await api(page, 'POST', `${base}/views`, { name: 'Pipeline', type: 'board', config: { group_by: P.Status.id, hidden: [P.Logo.id, P.Email.id, P.Verified.id] } })
  const calendar = await api(page, 'POST', `${base}/views`, { name: 'Due dates', type: 'calendar', config: { date_property: P.Due.id } })
  const gallery = await api(page, 'POST', `${base}/views`, { name: 'Clients', type: 'gallery', config: { cover_property: P.Logo.id, hidden: [P.Due.id, P.Fee.id, P.Verified.id, P.Priority.id] } })
  return { module, P, created, views: { table, board, calendar, gallery } }
}

/** Elements that clip their text vertically, or overflow the viewport horizontally. */
async function layoutProblems(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const problems = []
    if (document.documentElement.scrollWidth > vw) problems.push(`page scrolls horizontally ${document.documentElement.scrollWidth}>${vw}`)
    for (const e of document.querySelectorAll('.db-root *, .popover *')) {
      if (!e.getClientRects().length || !e.childNodes.length) continue
      const cs = getComputedStyle(e)
      const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
      if (hasText && (cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis' || cs.overflowY === 'hidden') && e.scrollHeight > e.clientHeight + 1) {
        problems.push(`vertical clip: .${e.className} "${e.textContent.trim().slice(0, 30)}" ${e.scrollHeight}>${e.clientHeight}`)
      }
      const r = e.getBoundingClientRect()
      if (e.closest('.popover') && (r.right > vw + 1 || r.left < -1)) problems.push(`popover content off-screen: .${e.className}`)
    }
    return problems
  })
}

for (const theme of ['light', 'dark']) {
  test(`visual ${theme} 1440x900: table with 8 property types, board, calendar, gallery, row peek, filter menu`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
    const page = await context.newPage()
    const w = await watch(page)
    await boot(page)
    await page.evaluate((t) => localStorage.setItem('truss.theme', t), theme)
    const { module, P, created, views } = await seed(page)
    await page.goto(`/#/m/${module.id}`)
    await page.reload()
    await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator(`.sidebar-item[data-id="${module.id}"]`)).toBeVisible()
    const tab = async (v) => {
      const el = page.locator(`.db-tab[data-view-id="${v.id}"]`)
      if (!(await el.evaluate((e) => e.classList.contains('is-active')))) await el.click()
      await expect(el).toHaveClass(/is-active/)
    }
    await expect(page.locator(`.db-tab[data-view-id="${views.table.id}"]`)).toHaveClass(/is-active/)

    // table: all columns fit, hover state visible
    await expect(page.locator('.db-tr')).toHaveCount(8)
    const fit = await page.locator('.db-table').evaluate((s) => s.scrollWidth - s.clientWidth)
    expect(fit).toBeLessThanOrEqual(0)
    expect(await page.locator('.db-th').evaluateAll((els) => els.map((e) => e.dataset.type))).toEqual(['title', 'status', 'select', 'multi_select', 'date', 'number', 'checkbox', 'email'])
    const td = page.locator(`.db-tr[data-row-id="${created[1].id}"] .db-td`).nth(1)
    const bg = await td.evaluate((e) => getComputedStyle(e).backgroundColor)
    await td.hover()
    await expect.poll(() => td.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(bg)
    expect(await layoutProblems(page)).toEqual([])
    await page.mouse.move(700, 800)
    await shot(page, `${theme}-table`)

    // selection state
    await page.locator(`.db-tr[data-row-id="${created[2].id}"] .db-td[data-prop="${P.Fee.id}"]`).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.db-td.is-selected')).toHaveCount(1)
    const ring = await page.locator('.db-td.is-selected').evaluate((e) => getComputedStyle(e).boxShadow)
    expect(ring).not.toBe('none')

    // filter menu
    await page.locator('.db-filter-btn').click()
    const rules = page.locator('.db-filter-menu > .db-filter-rules > .db-filter-row')
    await rules.nth(0).locator('select[aria-label="Filter property"]').selectOption(P.Status.id)
    await rules.nth(0).locator('select[aria-label="Filter value"]').selectOption(P.Status.config.options[1].id)
    await page.locator('.db-add-filter-group').click()
    await page.locator('.db-filter-group select[aria-label="Filter property"]').selectOption(P.Fee.id)
    await page.locator('.db-filter-group select[aria-label="Filter operator"]').selectOption('gt')
    await page.locator('.db-filter-group input.db-filter-value').fill('500')
    await expect(page.locator('.db-tr')).toHaveCount(2)
    expect(await layoutProblems(page)).toEqual([])
    await shot(page, `${theme}-filter-menu`)
    await page.keyboard.press('Escape')

    // row peek
    await page.locator('.db-filter-btn').click()
    await page.locator('.db-filter-menu > .db-filter-rules > .db-filter-row > button[aria-label="Remove filter"]').first().click()
    await page.locator('.db-filter-menu > .db-filter-rules > .db-filter-row > button[aria-label="Remove filter"]').first().click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.db-tr')).toHaveCount(8)
    const tr = page.locator(`.db-tr[data-row-id="${created[0].id}"]`)
    await tr.hover()
    await tr.locator('.db-open-btn').click()
    await page.locator('.db-peek .db-notes').fill('Collected ASIC extract and director IDs on 02/09/2026.\nWaiting on the signed engagement letter.')
    await page.locator('.db-peek .db-row-title').click()
    expect(await layoutProblems(page)).toEqual([])
    await page.mouse.move(1000, 850)
    await shot(page, `${theme}-row-peek`)
    await page.keyboard.press('Escape')
    await expect(page.locator('.db-peek')).toHaveCount(0)

    // board
    await tab(views.board)
    await expect(page.locator('.db-board-col')).toHaveCount(4)
    expect(await page.locator('.db-board').evaluate((b) => b.scrollWidth - b.clientWidth)).toBeLessThanOrEqual(0)
    const cardEl = page.locator('.db-card').first()
    const shadow = await cardEl.evaluate((e) => getComputedStyle(e).boxShadow)
    await cardEl.hover()
    await expect.poll(() => cardEl.evaluate((e) => getComputedStyle(e).boxShadow)).not.toBe(shadow)
    await page.mouse.move(1300, 850)
    expect(await layoutProblems(page)).toEqual([])
    await shot(page, `${theme}-board`)

    // calendar
    await tab(views.calendar)
    await expect(page.locator('.db-cal-item')).toHaveCount(8)
    expect(await page.locator('.db-calendar').evaluate((c) => c.scrollHeight - c.clientHeight)).toBeLessThanOrEqual(0)
    expect(await layoutProblems(page)).toEqual([])
    await shot(page, `${theme}-calendar`)

    // gallery
    await tab(views.gallery)
    await expect(page.locator('.db-gallery-cover img')).toHaveCount(4)
    await expect.poll(() => page.locator('.db-gallery-cover img').evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth === 160))).toBe(true)
    expect(await layoutProblems(page)).toEqual([])
    await shot(page, `${theme}-gallery`)

    // select editor with colour swatches
    await tab(views.table)
    await page.locator(`.db-tr[data-row-id="${created[3].id}"] .db-td[data-prop="${P.Tags.id}"]`).click()
    await page.locator('.db-opt-input').fill('Priority client')
    expect(await layoutProblems(page)).toEqual([])
    await shot(page, `${theme}-select-editor`)
    await page.keyboard.press('Escape')
    expect(w.errors).toEqual([])
    await context.close()
  })
}
