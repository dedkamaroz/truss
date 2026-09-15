import { test, expect } from '@playwright/test'
import { watch, openDb, api, load, cell, shot, expectViewConfig } from './helpers.js'

const propByName = (data, name) => data.properties.find((p) => p.name === name)

test('header: add property via "+", rename, change type, reorder by drag, resize and hide persist after reload', async ({ page }) => {
  const w = await watch(page)
  const { module } = await openDb(page)
  const id = module.id

  // add via "+" and rename in the menu that opens
  await page.locator('.db-th-add').click()
  await page.locator('.db-type-item[data-type="text"]').click()
  const nameInput = page.locator('.db-prop-name')
  await expect(nameInput).toBeFocused()
  await nameInput.fill('Owner')
  await nameInput.press('Enter')
  await expect(page.locator('.db-th .db-th-name', { hasText: 'Owner' })).toBeVisible()
  await expect.poll(async () => propByName(await load(page, id), 'Owner')?.type).toBe('text')
  let data = await load(page, id)
  const owner = propByName(data, 'Owner')
  const title = data.properties.find((p) => p.type === 'title')

  // rename again via header click
  await page.locator(`.db-th[data-prop="${owner.id}"]`).click()
  await page.locator('.db-prop-name').fill('Budget')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await load(page, id)).properties.find((p) => p.id === owner.id).name).toBe('Budget')

  // change type to number
  await page.locator(`.db-th[data-prop="${owner.id}"]`).click()
  await page.locator('.db-prop-type').click()
  await page.locator('.db-type-item[data-type="number"]').click()
  await expect.poll(async () => (await load(page, id)).properties.find((p) => p.id === owner.id).type).toBe('number')
  await expect(page.locator(`.db-th[data-prop="${owner.id}"][data-type="number"]`)).toBeVisible()

  // a second property, dragged before the title column
  await page.locator('.db-th-add').click()
  await page.locator('.db-type-item[data-type="checkbox"]').click()
  await page.locator('.db-prop-name').fill('Done')
  await page.keyboard.press('Enter')
  await expect.poll(async () => !!propByName(await load(page, id), 'Done')).toBe(true)
  const done = propByName(await load(page, id), 'Done')
  const doneTh = page.locator(`.db-th[data-prop="${done.id}"]`)
  const titleTh = page.locator(`.db-th[data-prop="${title.id}"]`)
  const tb = await titleTh.boundingBox()
  const db = await doneTh.boundingBox()
  await page.mouse.move(db.x + 30, db.y + db.height / 2)
  await page.mouse.down()
  await page.mouse.move(db.x + 10, db.y + db.height / 2, { steps: 4 })
  await page.mouse.move(tb.x + 10, tb.y + tb.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(async () => (await load(page, id)).properties.map((p) => p.id)).toEqual([done.id, title.id, owner.id])
  await expect(page.locator('.db-th').first()).toHaveAttribute('data-prop', done.id)
  await expect(page.getByRole('menu')).toHaveCount(0) // a drag is not a click

  // resize the Budget column by +90px
  const th = page.locator(`.db-th[data-prop="${owner.id}"]`)
  const before = (await th.boundingBox()).width
  const handle = th.locator('.db-resize')
  const hb = await handle.boundingBox()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + 40, hb.y + 5, { steps: 3 })
  await page.mouse.move(hb.x + hb.width / 2 + 90, hb.y + 5, { steps: 3 })
  await page.mouse.up()
  await expect(page.getByRole('menu')).toHaveCount(0)
  expect(Math.round((await th.boundingBox()).width)).toBe(Math.round(before + 90))
  const viewId = data.views[0].id
  await expectViewConfig(page, id, viewId, (c) => Math.round(c.widths?.[owner.id]) === Math.round(before + 90))

  // hide Done
  await doneTh.click()
  await page.getByRole('button', { name: 'Hide in view' }).click()
  await expect(doneTh).toHaveCount(0)
  await expectViewConfig(page, id, viewId, (c) => (c.hidden || []).includes(done.id))

  await page.reload()
  await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1)
  await expect(page.locator(`.db-th[data-prop="${done.id}"]`)).toHaveCount(0)
  expect(Math.round((await page.locator(`.db-th[data-prop="${owner.id}"]`).boundingBox()).width)).toBe(Math.round(before + 90))
  await expect(page.locator('.db-th').first()).toHaveAttribute('data-prop', title.id)

  // show it again from the Properties menu
  await page.locator('.db-props-btn').click()
  await page.getByRole('button', { name: 'Show Done' }).click()
  await expect(page.locator(`.db-th[data-prop="${done.id}"]`)).toBeVisible()
  await page.keyboard.press('Escape')
  expect(w.errors).toEqual([])
})

test('inline editing works for every property type; read-only times; add and delete rows', async ({ page, context }) => {
  const w = await watch(page)
  let P = {}
  let rowId
  const { module } = await openDb(page, {
    setup: async ({ base, data }) => {
      const mk = async (name, type, config) => (P[name] = await api(page, 'POST', `${base}/properties`, { name, type, config }))
      P.Name = data.properties[0]
      await mk('Notes', 'text')
      await mk('Amount', 'number', { format: 'aud' })
      await mk('Stage', 'select', { options: [{ name: 'Lead', color: 'blue' }] })
      await mk('Tags', 'multi_select', { options: [{ name: 'Alpha', color: 'green' }, { name: 'Beta', color: 'orange' }] })
      await mk('Status', 'status')
      await mk('Due', 'date')
      await mk('Done', 'checkbox')
      await mk('Site', 'url')
      await mk('Email', 'email')
      await mk('Phone', 'phone')
      await mk('Files', 'files')
      await mk('Created', 'created_time')
      await mk('Edited', 'last_edited_time')
      rowId = (await api(page, 'POST', `${base}/rows`, { values: {} })).id
    },
  })
  const id = module.id
  const row = async () => (await load(page, id)).rows.find((r) => r.id === rowId)
  const value = async (name) => (await row())?.values[P[name].id]
  await page.setViewportSize({ width: 1440, height: 900 })

  // title and text
  await cell(page, rowId, P.Name.id).click()
  await page.locator('.db-inline-input').fill('Quarterly review')
  await page.keyboard.press('Enter')
  await expect.poll(() => value('Name')).toBe('Quarterly review')
  await cell(page, rowId, P.Notes.id).click()
  await page.locator('.db-inline-input').fill('Bring figures')
  await page.keyboard.press('Tab')
  await expect.poll(() => value('Notes')).toBe('Bring figures')

  // number with AUD format; invalid input is rejected client-side
  await cell(page, rowId, P.Amount.id).click()
  await page.locator('.db-inline-input').fill('1234.5')
  await page.keyboard.press('Enter')
  await expect.poll(() => value('Amount')).toBe(1234.5)
  await expect(cell(page, rowId, P.Amount.id)).toHaveText('$1,234.50')
  await cell(page, rowId, P.Amount.id).click()
  await page.locator('.db-inline-input').fill('abc')
  await page.keyboard.press('Enter')
  await expect(page.locator('.toast-error')).toContainText('number')
  await page.keyboard.press('Escape')
  await expect(page.locator('.db-inline-input')).toHaveCount(0)
  expect(await value('Amount')).toBe(1234.5)

  // select: create a new option with a colour
  await cell(page, rowId, P.Stage.id).click()
  const optInput = page.locator('.db-opt-input')
  await expect(optInput).toBeFocused()
  await optInput.fill('Qualified')
  await page.locator('.db-swatch[data-color="purple"]').click()
  await optInput.press('Enter')
  await expect(page.locator('.db-opt-editor')).toHaveCount(0)
  await expect.poll(async () => {
    const prop = (await load(page, id)).properties.find((p) => p.id === P.Stage.id)
    const opt = prop.config.options.find((o) => o.name === 'Qualified')
    return opt && opt.color === 'purple' && (await value('Stage')) === opt.id
  }).toBe(true)
  await expect(cell(page, rowId, P.Stage.id).locator('.db-tag[data-color="purple"]')).toHaveText('Qualified')

  // multi-select chips
  await cell(page, rowId, P.Tags.id).click()
  await page.locator('.db-opt-row[data-name="Alpha"]').click()
  await page.locator('.db-opt-row[data-name="Beta"]').click()
  await expect(page.locator('.db-opt-chips .db-tag')).toHaveCount(2)
  await shot(page, 'editor-multi-select')
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await value('Tags'))?.length).toBe(2)
  await expect(cell(page, rowId, P.Tags.id).locator('.db-tag')).toHaveText(['Alpha', 'Beta'])

  // status
  await cell(page, rowId, P.Status.id).click()
  await page.locator('.db-opt-row[data-name="Done"]').click()
  const doneOpt = P.Status.config.options.find((o) => o.name === 'Done')
  await expect.poll(() => value('Status')).toBe(doneOpt.id)

  // date picker shows DD/MM/YYYY
  await cell(page, rowId, P.Due.id).click()
  const start = page.locator('.db-date-input').first()
  await start.fill('14/05/2026')
  await start.press('Enter')
  await expect.poll(() => value('Due')).toEqual({ start: '2026-05-14' })
  await expect(start).toHaveValue('14/05/2026')
  await page.locator('.db-cal-mini-day[data-date="2026-05-20"]').click()
  await expect.poll(() => value('Due')).toEqual({ start: '2026-05-20' })
  await expect(start).toHaveValue('20/05/2026')
  await shot(page, 'editor-date')
  await page.keyboard.press('Escape')
  await expect(cell(page, rowId, P.Due.id)).toHaveText('20/05/2026')

  // checkbox toggles
  await cell(page, rowId, P.Done.id).click()
  await expect.poll(() => value('Done')).toBe(true)
  await expect(cell(page, rowId, P.Done.id).locator('.db-checkbox')).toHaveAttribute('aria-checked', 'true')
  await cell(page, rowId, P.Done.id).click()
  await expect.poll(() => value('Done')).toBeUndefined()

  // url / email / phone are clickable links
  for (const [name, input, href] of [['Site', 'example.com/report', 'https://example.com/report'], ['Email', 'kim@example.com.au', 'mailto:kim@example.com.au'], ['Phone', '+61 412 345 678', 'tel:+61412345678']]) {
    await cell(page, rowId, P[name].id).click()
    await page.locator('.db-inline-input').fill(input)
    await page.keyboard.press('Enter')
    await expect.poll(() => value(name)).toBe(input)
    await expect(cell(page, rowId, P[name].id).locator('a.db-link')).toHaveAttribute('href', href)
  }
  await expect(cell(page, rowId, P.Site.id).locator('a.db-link')).toHaveAttribute('target', '_blank')
  await page.route('https://example.com/**', (r) => r.fulfill({ status: 200, body: 'ok' }))
  const popup = context.waitForEvent('page')
  await cell(page, rowId, P.Site.id).locator('a.db-link').click()
  expect((await popup).url()).toContain('example.com/report')
  await expect(page.locator('.db-inline-input')).toHaveCount(0) // clicking the link did not start editing

  // file upload into a files cell creates an attachment for the row
  await cell(page, rowId, P.Files.id).click()
  await page.locator('.db-files-input').setInputFiles({ name: 'minutes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect.poll(async () => (await value('Files'))?.length).toBe(1)
  const atts = await api(page, 'GET', `/api/attachments?moduleId=${id}&pageId=${rowId}`)
  expect(atts.map((a) => [a.filename, a.page_id])).toEqual([['minutes.txt', rowId]])
  expect(await value('Files')).toEqual([atts[0].id])
  await expect(page.locator('.db-files-row .db-files-name')).toHaveText('minutes.txt')
  await page.keyboard.press('Escape')
  await expect(cell(page, rowId, P.Files.id)).toContainText('minutes.txt')

  // created / last edited are read-only
  for (const name of ['Created', 'Edited']) {
    await cell(page, rowId, P[name].id).click()
    await expect(page.locator('.db-inline-input, .popover')).toHaveCount(0)
    await expect(cell(page, rowId, P[name].id)).toHaveText(/^\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (am|pm) AE(S|D)T$/)
  }

  // add a row from the table and delete one from the row menu
  await page.locator('.db-add-row').click()
  await expect(page.locator('.db-inline-input')).toBeFocused()
  await page.keyboard.type('Second row')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await load(page, id)).rows.map((r) => r.values[P.Name.id])).toEqual(['Quarterly review', 'Second row'])
  await shot(page, 'table-all-types')
  const tr = page.locator(`.db-tr[data-row-id="${rowId}"]`)
  await tr.hover()
  await tr.locator('.db-row-menu').click()
  await page.getByRole('menuitem', { name: 'Delete row' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(tr).toHaveCount(0)
  await expect.poll(async () => (await load(page, id)).rows.map((r) => r.values[P.Name.id])).toEqual(['Second row'])
  expect((await api(page, 'GET', `/api/attachments?moduleId=${id}&pageId=${rowId}`)).length).toBe(0)
  expect(w.errors.filter((e) => !/example\.com/.test(e))).toEqual([])
})

test('keyboard navigation: arrows, Enter to edit, Esc to cancel, Tab to move', async ({ page }) => {
  const w = await watch(page)
  let P = {}
  let rows
  const { module } = await openDb(page, {
    setup: async ({ base, data }) => {
      P.Name = data.properties[0]
      P.Text = await api(page, 'POST', `${base}/properties`, { name: 'Text', type: 'text' })
      P.Num = await api(page, 'POST', `${base}/properties`, { name: 'Num', type: 'number' })
      rows = (await api(page, 'POST', `${base}/rows/batch`, { create: [{ values: { [P.Name.id]: 'One' } }, { values: { [P.Name.id]: 'Two' } }] })).created
    },
  })
  const id = module.id
  const vals = async (i) => (await load(page, id)).rows.find((r) => r.id === rows[i].id).values
  const selected = page.locator('.db-td.is-selected')

  // Esc cancels an edit and keeps the original value
  await cell(page, rows[0].id, P.Name.id).click()
  await page.locator('.db-inline-input').fill('Changed')
  await page.keyboard.press('Escape')
  await expect(page.locator('.db-inline-input')).toHaveCount(0)
  await expect(cell(page, rows[0].id, P.Name.id)).toContainText('One')
  await expect(selected).toHaveAttribute('data-prop', P.Name.id)
  expect((await vals(0))[P.Name.id]).toBe('One')

  // arrows move the selection
  await page.keyboard.press('ArrowRight')
  await expect(selected).toHaveAttribute('data-prop', P.Text.id)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator(`.db-tr[data-row-id="${rows[1].id}"] .db-td.is-selected`)).toHaveAttribute('data-prop', P.Text.id)

  // Enter edits, Tab commits and moves right
  await page.keyboard.press('Enter')
  await expect(page.locator('.db-inline-input')).toBeFocused()
  await page.keyboard.type('typed')
  await page.keyboard.press('Tab')
  await expect.poll(async () => (await vals(1))[P.Text.id]).toBe('typed')
  await expect(page.locator(`.db-tr[data-row-id="${rows[1].id}"] .db-td.is-selected`)).toHaveAttribute('data-prop', P.Num.id)

  // typing on a selected cell starts editing with that character
  await page.keyboard.type('42')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await vals(1))[P.Num.id]).toBe(42)
  await page.keyboard.press('ArrowUp')
  await expect(page.locator(`.db-tr[data-row-id="${rows[0].id}"] .db-td.is-selected`)).toHaveAttribute('data-prop', P.Num.id)
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator(`.db-tr[data-row-id="${rows[0].id}"] .db-td.is-selected`)).toHaveAttribute('data-prop', P.Name.id)
  // Shift+Tab wraps backwards to the end of the previous row
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator(`.db-tr[data-row-id="${rows[0].id}"] .db-td.is-selected`)).toHaveAttribute('data-prop', P.Num.id)
  // Delete clears the selected value
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await vals(1))[P.Num.id]).toBeUndefined()
  expect(w.errors).toEqual([])
})
