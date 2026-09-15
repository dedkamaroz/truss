import { test, expect } from '@playwright/test'
import zlib from 'node:zlib'
import { watch, openDb, api, load, shot, expectViewConfig } from './helpers.js'

const byName = (data, name) => data.properties.find((p) => p.name === name)
const titleOf = (data, row) => row.values[data.properties.find((p) => p.type === 'title').id]

async function drag(page, from, to, { dy = 0 } = {}) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(a.x + a.width / 2 + 8, a.y + a.height / 2 + 8, { steps: 3 })
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + dy, { steps: 10 })
  await page.mouse.up()
}

/** A small gradient PNG, built with zlib only. */
function png(w = 96, h = 60) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
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
    const i = y * (w * 3 + 1) + 1 + x * 3
    raw[i] = 60 + (x * 120) / w; raw[i + 1] = 120 + (y * 80) / h; raw[i + 2] = 200
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

test('board: drag a card to another column updates the row, order within a column persists, adding a card pre-fills the group', async ({ page }) => {
  const w = await watch(page)
  const { module, data } = await openDb(page, { template: 'task_tracker' })
  const status = byName(data, 'Status')
  const [notStarted, inProgress, done] = status.config.options.map((o) => o.id)
  const rowByTitle = (d, t) => d.rows.find((r) => titleOf(d, r) === t)

  await page.locator('.db-tab[data-type="board"]').click()
  await expect(page.locator('.db-board-col')).toHaveCount(4)
  const col = (key) => page.locator(`.db-board-col[data-group="${key}"]`)
  const card = (title) => page.locator('.db-card', { hasText: title })
  const cardTitles = (key) => col(key).locator('.db-card .db-card-title').allTextContents()
  await expect.poll(() => cardTitles(inProgress)).toEqual(['Draft onboarding checklist', 'Reconcile March expenses'])

  // move a card from Not started to Done (dropped below the existing card)
  await drag(page, card('Review supplier contracts'), col(done).locator('.db-board-new'))
  await expect.poll(async () => rowByTitle(await load(page, module.id), 'Review supplier contracts').values[status.id]).toBe(done)
  await expect.poll(() => cardTitles(done)).toEqual(['Book quarterly planning session', 'Review supplier contracts'])
  await expect(col(done).locator('.db-group-count')).toHaveText('2')
  await expect(col(notStarted).locator('.db-group-count')).toHaveText('1')

  // reorder within In progress: Reconcile above Draft
  await drag(page, card('Reconcile March expenses'), card('Draft onboarding checklist'), { dy: -18 })
  await expect.poll(() => cardTitles(inProgress)).toEqual(['Reconcile March expenses', 'Draft onboarding checklist'])
  await expect.poll(async () => {
    const d = await load(page, module.id)
    return rowByTitle(d, 'Reconcile March expenses').sort_order < rowByTitle(d, 'Draft onboarding checklist').sort_order
  }).toBe(true)
  await page.reload()
  await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1)
  await expect(page.locator('.db-tab.is-active')).toHaveAttribute('data-type', 'board')
  await expect.poll(() => cardTitles(inProgress)).toEqual(['Reconcile March expenses', 'Draft onboarding checklist'])
  await expect.poll(() => cardTitles(done)).toEqual(['Book quarterly planning session', 'Review supplier contracts'])

  // add a card in a column: the new row carries that column's status
  await col(inProgress).locator('.db-board-new').click()
  const peekTitle = page.locator('.db-peek .db-row-title')
  await expect(peekTitle).toBeFocused()
  await page.keyboard.type('Prepare board papers')
  await page.keyboard.press('Enter')
  await expect.poll(async () => rowByTitle(await load(page, module.id), 'Prepare board papers')?.values[status.id]).toBe(inProgress)
  await page.keyboard.press('Escape')
  await expect(page.locator('.db-peek')).toHaveCount(0)
  await expect.poll(() => cardTitles(inProgress)).toContain('Prepare board papers')

  // clicking a card opens the row peek
  await card('Reconcile March expenses').click()
  await expect(page.locator('.db-peek .db-row-title')).toHaveValue('Reconcile March expenses')
  await shot(page, 'board-peek')
  expect(w.errors).toEqual([])
})

test('list and gallery render; gallery uses the first image in a files property as the cover', async ({ page }) => {
  const w = await watch(page)
  let imageId
  let rowId
  const { module } = await openDb(page, {
    template: 'contacts',
    setup: async ({ module, base, data }) => {
      const photo = byName(data, 'Photo')
      rowId = data.rows[1].id
      const doc = await page.evaluate(async ({ url }) => {
        const token = document.querySelector('meta[name="truss-token"]').content
        const res = await fetch(url, { method: 'POST', headers: { 'X-Truss-Token': token, 'X-Filename': 'notes.txt' }, body: 'text' })
        return res.json()
      }, { url: `/api/attachments?moduleId=${module.id}&pageId=${rowId}` })
      const img = await page.evaluate(async ({ url, bytes }) => {
        const token = document.querySelector('meta[name="truss-token"]').content
        const res = await fetch(url, { method: 'POST', headers: { 'X-Truss-Token': token, 'X-Filename': 'portrait.png' }, body: new Uint8Array(bytes) })
        return res.json()
      }, { url: `/api/attachments?moduleId=${module.id}&pageId=${rowId}`, bytes: [...png()] })
      imageId = img.id
      // the first file is not an image; the cover must use the first image
      await api(page, 'PATCH', `${base}/rows/${rowId}`, { values: { [photo.id]: [doc.id, img.id] } })
    },
  })

  await page.locator('.db-tab[data-type="gallery"]').click()
  const cards = page.locator('.db-gallery-card[data-row-id]')
  await expect(cards).toHaveCount(3)
  const withImage = page.locator(`.db-gallery-card[data-row-id="${rowId}"] .db-gallery-cover img`)
  await expect(withImage).toHaveAttribute('src', new RegExp(`/api/attachments/${imageId}/content`))
  await expect.poll(() => withImage.evaluate((img) => img.complete && img.naturalWidth)).toBe(96)
  await expect(page.locator('.db-gallery-cover img')).toHaveCount(1)
  await expect(page.locator('.db-gallery-cover.is-empty')).toHaveCount(2)
  await expect(cards.first().locator('.db-gallery-title')).toHaveText('Casey Nguyen')
  await expect(cards.first().locator('.db-gallery-field a.db-link[href^="mailto:"]')).toHaveText('casey@example.com')
  await shot(page, 'gallery')

  // list view through the add-view menu
  await page.locator('.db-add-view').click()
  await page.getByRole('menuitem', { name: 'List' }).click()
  await expect(page.locator('.db-tab.is-active')).toHaveAttribute('data-type', 'list')
  await expect(page.locator('.db-list-row')).toHaveCount(3)
  await expect(page.locator('.db-list-row .db-list-title')).toHaveText(['Casey Nguyen', 'Morgan Lee', 'Riley Patel'])
  await expect(page.locator('.db-list-row').first().locator('.db-tag')).toHaveText('Client')
  await page.locator('.db-list-row').nth(2).click()
  await expect(page.locator('.db-peek .db-row-title')).toHaveValue('Riley Patel')
  await page.keyboard.press('Escape')
  await shot(page, 'list')
  const views = (await load(page, module.id)).views
  expect(views.map((v) => v.type)).toEqual(['table', 'gallery', 'list'])
  expect(w.errors).toEqual([])
})

test('calendar: month grid starting Monday, month navigation, drag an item to another day updates its date', async ({ page }) => {
  const w = await watch(page)
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  let rowId
  const { module, data } = await openDb(page, {
    template: 'task_tracker',
    setup: async ({ base, data }) => {
      const title = data.properties.find((p) => p.type === 'title')
      const due = byName(data, 'Due')
      rowId = (await api(page, 'POST', `${base}/rows`, { values: { [title.id]: 'Calendar item', [due.id]: { start: `${ym}-10` } } })).id
    },
  })
  const due = byName(data, 'Due')

  await page.locator('.db-add-view').click()
  await page.getByRole('menuitem', { name: 'Calendar' }).click()
  await expect(page.locator('.db-calendar')).toBeVisible()
  await expect(page.locator('.db-cal-dow')).toHaveText(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  const days = page.locator('.db-cal-day')
  await expect(days).toHaveCount(42)
  const first = await days.first().getAttribute('data-date')
  expect(new Date(`${first}T00:00:00Z`).getUTCDay()).toBe(1)
  const monthName = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(now)
  await expect(page.locator('.db-cal-month')).toHaveText(monthName)
  await expect(page.locator(`.db-cal-day[data-date="${ym}-10"] .db-cal-item[data-row-id="${rowId}"]`)).toBeVisible()
  await expect(page.locator(`.db-cal-day.is-today`)).toHaveCount(1)
  await shot(page, 'calendar')

  // drag to the 17th
  await drag(page, page.locator(`.db-cal-item[data-row-id="${rowId}"]`), page.locator(`.db-cal-day[data-date="${ym}-17"]`))
  await expect.poll(async () => (await load(page, module.id)).rows.find((r) => r.id === rowId).values[due.id]).toEqual({ start: `${ym}-17` })
  await expect(page.locator(`.db-cal-day[data-date="${ym}-17"] .db-cal-item[data-row-id="${rowId}"]`)).toBeVisible()
  await expect(page.locator(`.db-cal-day[data-date="${ym}-10"] .db-cal-item[data-row-id="${rowId}"]`)).toHaveCount(0)

  // month navigation
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const fmt = (d) => new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(d)
  await page.locator('.db-cal-next').click()
  await expect(page.locator('.db-cal-month')).toHaveText(fmt(next))
  await expect(page.locator(`.db-cal-item[data-row-id="${rowId}"]`)).toHaveCount(next.getMonth() === now.getMonth() ? 1 : 0)
  await page.locator('.db-cal-prev').click()
  await page.locator('.db-cal-prev').click()
  await expect(page.locator('.db-cal-month')).toHaveText(fmt(prev))
  await page.locator('.db-cal-today').click()
  await expect(page.locator('.db-cal-month')).toHaveText(monthName)

  // clicking an item opens the peek; adding on a day pre-fills the date
  await page.locator(`.db-cal-item[data-row-id="${rowId}"]`).click()
  await expect(page.locator('.db-peek .db-row-title')).toHaveValue('Calendar item')
  await page.keyboard.press('Escape')
  const day = page.locator(`.db-cal-day[data-date="${ym}-21"]`)
  await day.hover()
  await day.locator('.db-cal-add').click()
  await expect(page.locator('.db-peek .db-row-title')).toBeFocused()
  await page.keyboard.type('Added on the 21st')
  await page.keyboard.press('Enter')
  await expect.poll(async () => {
    const d = await load(page, module.id)
    return d.rows.find((r) => titleOf(d, r) === 'Added on the 21st')?.values[due.id]
  }).toEqual({ start: `${ym}-21` })
  expect(w.errors).toEqual([])
})

test('row peek edits every property and notes; open as page and back; view tabs add, rename, duplicate and delete with independent configs', async ({ page }) => {
  const w = await watch(page)
  const { module, data } = await openDb(page, { template: 'task_tracker' })
  const P = Object.fromEntries(data.properties.map((p) => [p.name, p]))
  const target = data.rows[0]
  const row = async () => (await load(page, module.id)).rows.find((r) => r.id === target.id)

  const tr = page.locator(`.db-tr[data-row-id="${target.id}"]`)
  await tr.hover()
  await tr.locator('.db-open-btn').click()
  const peek = page.locator('.db-peek')
  await expect(peek).toBeVisible()
  await expect(peek.locator('.db-row-title')).toHaveValue('Draft onboarding checklist')
  await expect(peek.locator('.db-field')).toHaveCount(data.properties.length - 1)

  // title
  await peek.locator('.db-row-title').fill('Draft the onboarding checklist')
  await peek.locator('.db-row-title').press('Enter')
  await expect.poll(async () => (await row()).values[P.Name.id]).toBe('Draft the onboarding checklist')
  await expect(tr.locator('.db-title-text')).toHaveText('Draft the onboarding checklist')
  // text
  await peek.locator(`.db-field-value[data-prop="${P.Assignee.id}"]`).click()
  await peek.locator('.db-inline-input').fill('Jamie')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await row()).values[P.Assignee.id]).toBe('Jamie')
  // status
  await peek.locator(`.db-field-value[data-prop="${P.Status.id}"]`).click()
  await page.locator('.db-opt-row[data-name="Done"]').click()
  await expect.poll(async () => (await row()).values[P.Status.id]).toBe(P.Status.config.options[2].id)
  // select
  await peek.locator(`.db-field-value[data-prop="${P.Priority.id}"]`).click()
  await page.locator('.db-opt-row[data-name="Low"]').click()
  await expect.poll(async () => (await row()).values[P.Priority.id]).toBe(P.Priority.config.options[0].id)
  // date
  await peek.locator(`.db-field-value[data-prop="${P.Due.id}"]`).click()
  await page.locator('.db-date-input').first().fill('01/12/2026')
  await page.locator('.db-date-input').first().press('Enter')
  await expect.poll(async () => (await row()).values[P.Due.id]).toEqual({ start: '2026-12-01' })
  await page.keyboard.press('Escape')
  await expect(peek.locator(`.db-field-value[data-prop="${P.Due.id}"]`)).toHaveText('01/12/2026')
  // notes
  await peek.locator('.db-notes').fill('Call the bank on Monday.\nSecond line.')
  await expect.poll(async () => (await row()).notes).toBe('Call the bank on Monday.\nSecond line.')
  await shot(page, 'row-peek')

  // open as page and back
  await peek.locator('.db-open-page').click()
  await expect(page).toHaveURL(new RegExp(`#/m/${module.id}/r/${target.id}$`))
  const rowPage = page.locator('.db-row-page')
  await expect(rowPage).toBeVisible()
  await expect(page.locator('.db-peek')).toHaveCount(0)
  await expect(page.locator('.db-toolbar')).toBeHidden()
  await expect(rowPage.locator('.db-notes')).toHaveValue('Call the bank on Monday.\nSecond line.')
  await rowPage.locator('.db-back').click()
  await expect(page).toHaveURL(new RegExp(`#/m/${module.id}$`))
  await expect(page.locator('.db-table')).toBeVisible()
  // direct navigation to the row route, then browser back
  await page.goto(`/#/m/${module.id}/r/${target.id}`)
  await expect(page.locator('.db-row-page .db-row-title')).toHaveValue('Draft the onboarding checklist')
  await shot(page, 'row-page')
  await page.goBack()
  await expect(page.locator('.db-table')).toBeVisible()

  // view tabs: add, rename, duplicate with independent config, delete
  await page.locator('.db-add-view').click()
  await page.getByRole('menuitem', { name: 'List' }).click()
  await expect(page.locator('.db-tab')).toHaveCount(3)
  await page.locator('.db-tab.is-active').click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.getByRole('dialog').locator('input').fill('Reading list')
  await page.getByRole('dialog').getByRole('button', { name: 'Rename' }).click()
  await expect(page.locator('.db-tab.is-active .db-tab-name')).toHaveText('Reading list')
  await expect.poll(async () => (await load(page, module.id)).views.map((v) => v.name)).toEqual(['Table', 'Board', 'Reading list'])

  // configure the table, duplicate it, change the copy only
  await page.locator('.db-tab').first().click()
  await page.locator('.db-sort-btn').click()
  await page.keyboard.press('Escape')
  const tableId = data.views[0].id
  await expectViewConfig(page, module.id, tableId, (c) => c.sorts?.length === 1)
  await page.locator('.db-tab.is-active').click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(page.locator('.db-tab')).toHaveCount(4)
  await expect(page.locator('.db-tab.is-active .db-tab-name')).toHaveText('Table copy')
  let views = (await load(page, module.id)).views
  const copy = views.find((v) => v.name === 'Table copy')
  expect(copy.config.sorts).toEqual(views.find((v) => v.id === tableId).config.sorts)
  await page.locator(`.db-th[data-prop="${P.Assignee.id}"]`).click()
  await page.getByRole('button', { name: 'Hide in view' }).click()
  await expectViewConfig(page, module.id, copy.id, (c) => c.hidden?.includes(P.Assignee.id))
  views = (await load(page, module.id)).views
  expect(views.find((v) => v.id === tableId).config.hidden || []).toEqual([])
  await page.locator('.db-tab').first().click()
  await expect(page.locator(`.db-th[data-prop="${P.Assignee.id}"]`)).toBeVisible()

  // delete the copy
  await page.locator(`.db-tab[data-view-id="${copy.id}"]`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete view' }).click()
  await expect(page.locator('.db-tab')).toHaveCount(3)
  await expect.poll(async () => (await load(page, module.id)).views.map((v) => v.id)).not.toContain(copy.id)
  expect(w.errors).toEqual([])
})
