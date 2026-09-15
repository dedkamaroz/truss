import { test, expect } from '@playwright/test'
import { watch, openDb, api, load, rowTitles, expectViewConfig, shot } from './helpers.js'

async function seed(page) {
  const P = {}
  const { module, data } = await openDb(page, {
    setup: async ({ base, data }) => {
      P.Name = data.properties[0]
      P.Priority = await api(page, 'POST', `${base}/properties`, { name: 'Priority', type: 'select', config: { options: [{ name: 'High', color: 'red' }, { name: 'Low', color: 'gray' }] } })
      P.Score = await api(page, 'POST', `${base}/properties`, { name: 'Score', type: 'number' })
      P.Done = await api(page, 'POST', `${base}/properties`, { name: 'Done', type: 'checkbox' })
      P.Due = await api(page, 'POST', `${base}/properties`, { name: 'Due', type: 'date' })
      P.Stage = await api(page, 'POST', `${base}/properties`, { name: 'Stage', type: 'status' })
      const [high, low] = P.Priority.config.options.map((o) => o.id)
      const [todo, doing, done] = P.Stage.config.options.map((o) => o.id)
      const rows = [
        ['Alpha', low, 5, true, '2026-05-01', todo],
        ['Bravo', high, 9, false, '2026-06-01', doing],
        ['Charlie', high, 2, true, '2026-04-01', done],
        ['Delta', low, 9, false, null, done],
        ['Echo', null, 7, true, '2026-05-15', todo],
        ['Foxtrot', high, 5, false, '2026-05-10', null],
      ].map(([n, pr, s, d, due, st]) => ({ values: { [P.Name.id]: n, [P.Priority.id]: pr, [P.Score.id]: s, [P.Done.id]: d, [P.Due.id]: due && { start: due }, [P.Stage.id]: st } }))
      await api(page, 'POST', `${base}/rows/batch`, { create: rows })
    },
  })
  return { module, P, viewId: data.views[0].id, base: `/api/databases/${module.id}` }
}

const titles = (page) => rowTitles(page)
const reload = async (page) => {
  await page.reload()
  await expect(page.locator('.db-root[data-ready="true"]')).toHaveCount(1)
}

test('multi-level sort and AND/OR filter groups work through the UI and survive reload', async ({ page }) => {
  const w = await watch(page)
  const { module, P, viewId } = await seed(page)
  await expect.poll(() => titles(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'])

  // sort: Priority ascending (option order, empty last), then Score descending
  await page.locator('.db-sort-btn').click()
  const sortRows = page.locator('.db-sort-row')
  await expect(sortRows).toHaveCount(1)
  await sortRows.nth(0).locator('select').nth(0).selectOption(P.Priority.id)
  await page.locator('.db-add-sort').click()
  await sortRows.nth(1).locator('select').nth(0).selectOption(P.Score.id)
  await sortRows.nth(1).locator('select').nth(1).selectOption('desc')
  await page.keyboard.press('Escape')
  await expect.poll(() => titles(page)).toEqual(['Bravo', 'Foxtrot', 'Charlie', 'Delta', 'Alpha', 'Echo'])
  await expect(page.locator('.db-sort-btn')).toHaveText('Sort (2)')
  await expectViewConfig(page, module.id, viewId, (c) => c.sorts?.length === 2 && c.sorts[1].direction === 'desc')
  await reload(page)
  await expect.poll(() => titles(page)).toEqual(['Bravo', 'Foxtrot', 'Charlie', 'Delta', 'Alpha', 'Echo'])

  // filter: Score > 4
  await page.locator('.db-filter-btn').click()
  const top = page.locator('.db-filter-menu > .db-filter-rules > .db-filter-row')
  await top.nth(0).locator('select[aria-label="Filter property"]').selectOption(P.Score.id)
  await top.nth(0).locator('select[aria-label="Filter operator"]').selectOption('gt')
  await top.nth(0).locator('input.db-filter-value').fill('4')
  await expect.poll(() => titles(page)).toEqual(['Bravo', 'Foxtrot', 'Delta', 'Alpha', 'Echo'])

  // AND Done is checked
  await page.locator('.db-filter-menu > .db-filter-rules > .db-config-foot .db-add-filter').click()
  await top.nth(1).locator('select[aria-label="Filter property"]').selectOption(P.Done.id)
  await expect(top.nth(1).locator('select[aria-label="Filter operator"]')).toHaveValue('checked')
  await expect.poll(() => titles(page)).toEqual(['Alpha', 'Echo'])
  // switch to OR
  await top.nth(1).locator('.db-filter-op-select').selectOption('or')
  await expect.poll(() => titles(page)).toEqual(['Bravo', 'Foxtrot', 'Charlie', 'Delta', 'Alpha', 'Echo'])
  await top.nth(1).locator('.db-filter-op-select').selectOption('and')
  // replace the checkbox rule with an OR group: Due before 11/05/2026 OR Due is empty
  await top.nth(1).getByRole('button', { name: 'Remove filter' }).click()
  await expect(top).toHaveCount(1)
  await page.locator('.db-add-filter-group').click()
  await expect(top).toHaveCount(2)
  const inner = page.locator('.db-filter-group .db-filter-row')
  await inner.nth(0).locator('select[aria-label="Filter property"]').selectOption(P.Due.id)
  await inner.nth(0).locator('select[aria-label="Filter operator"]').selectOption('before')
  await inner.nth(0).locator('input.db-filter-value').fill('11/05/2026')
  await page.locator('.db-filter-group .db-add-filter').click()
  await inner.nth(1).locator('select[aria-label="Filter property"]').selectOption(P.Due.id)
  await inner.nth(1).locator('select[aria-label="Filter operator"]').selectOption('is_empty')
  await page.locator('.db-filter-group .db-filter-op-select').selectOption('or')
  await expect(page.locator('.db-filter-menu > .db-filter-rules > .db-filter-row .db-filter-op-select').first()).toHaveValue('and')
  await expect.poll(() => titles(page)).toEqual(['Foxtrot', 'Delta', 'Alpha'])
  await shot(page, 'filter-menu')
  await page.keyboard.press('Escape')
  await expect(page.locator('.db-filter-btn')).toHaveText('Filter (3)')
  await expectViewConfig(page, module.id, viewId, (c) => c.filter?.op === 'and' && c.filter.rules[1]?.op === 'or' && c.filter.rules[1].rules.length === 2)

  // quick search on top of the filter
  await page.locator('.db-search-wrap').click()
  await page.locator('.db-search').fill('elt')
  await expect.poll(() => titles(page)).toEqual(['Delta'])
  await expectViewConfig(page, module.id, viewId, (c) => c.search === 'elt')

  await reload(page)
  await expect(page.locator('.db-search')).toHaveValue('elt')
  await expect.poll(() => titles(page)).toEqual(['Delta'])
  await page.locator('.db-search').focus()
  await page.keyboard.press('Escape')
  await expect.poll(() => titles(page)).toEqual(['Foxtrot', 'Delta', 'Alpha'])
  await page.locator('.db-filter-btn').click()
  await expect(page.locator('.db-filter-group input.db-filter-value')).toHaveValue('11/05/2026')
  expect(w.errors).toEqual([])
})

test('group by select, status and checkbox with collapsible groups and counts, stored per view', async ({ page }) => {
  const w = await watch(page)
  const { module, P, viewId } = await seed(page)
  const counts = () => page.locator('.db-group-head').evaluateAll((els) => els.map((e) => `${e.textContent.trim().replace(/\d+$/, '')}:${e.querySelector('.db-group-count').textContent}`))

  await page.locator('.db-group-btn').click()
  await page.getByRole('menuitem', { name: 'Priority' }).click()
  await expect.poll(counts).toEqual(['High:3', 'Low:2', 'No Priority:1'])
  await expect.poll(() => titles(page)).toEqual(['Bravo', 'Charlie', 'Foxtrot', 'Alpha', 'Delta', 'Echo'])

  // collapse High
  await page.locator('.db-group-head[data-group="' + P.Priority.config.options[0].id + '"]').click()
  await expect.poll(() => titles(page)).toEqual(['Alpha', 'Delta', 'Echo'])
  await expectViewConfig(page, module.id, viewId, (c) => c.group_by === P.Priority.id && c.collapsed?.length === 1)
  await shot(page, 'table-grouped')
  await reload(page)
  await expect.poll(counts).toEqual(['High:3', 'Low:2', 'No Priority:1'])
  await expect.poll(() => titles(page)).toEqual(['Alpha', 'Delta', 'Echo'])
  await expect(page.locator('.db-group-head.is-collapsed')).toHaveCount(1)

  // adding a row inside a group pre-fills the group value
  const lowAdd = page.locator(`.db-add-row[data-key="a:${P.Priority.config.options[1].id}"]`)
  await lowAdd.click()
  await expect(page.locator('.db-inline-input')).toBeFocused()
  await page.keyboard.type('Golf')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await load(page, module.id)).rows.find((r) => r.values[P.Name.id] === 'Golf')?.values[P.Priority.id]).toBe(P.Priority.config.options[1].id)
  await expect.poll(counts).toEqual(['High:3', 'Low:3', 'No Priority:1'])

  // status grouping
  await page.locator('.db-group-btn').click()
  await page.getByRole('menuitem', { name: 'Stage' }).click()
  await expect.poll(counts).toEqual(['Not started:2', 'In progress:1', 'Done:2', 'No Stage:2'])

  // checkbox grouping
  await page.locator('.db-group-btn').click()
  await page.getByRole('menuitem', { name: 'Done' }).click()
  await expect.poll(counts).toEqual(['Checked:3', 'Unchecked:4'])
  await page.locator('.db-group-head[data-group="false"]').click()
  await expect.poll(() => titles(page)).toEqual(['Alpha', 'Charlie', 'Echo'])

  // another view keeps its own configuration
  await page.locator('.db-add-view').click()
  await page.getByRole('menuitem', { name: 'Table' }).click()
  await expect(page.locator('.db-tab')).toHaveCount(2)
  await expect(page.locator('.db-group-head')).toHaveCount(0)
  await expect.poll(() => titles(page)).toHaveLength(7)
  await page.locator('.db-tab').first().click()
  await expect.poll(counts).toEqual(['Checked:3', 'Unchecked:4'])
  await expectViewConfig(page, module.id, viewId, (c) => c.group_by === P.Done.id && c.collapsed?.includes('false'))
  expect(w.errors).toEqual([])
})

test('filter operators per type behave correctly (in-page, through the type registry)', async ({ page }) => {
  await openDb(page)
  const results = await page.evaluate(async () => {
    const { matchesRule, sortRows } = await import('/modules/database/query.js')
    const { TYPES } = await import('/modules/database/types.js')
    const props = [
      { id: 't', name: 'T', type: 'text', config: {} },
      { id: 'n', name: 'N', type: 'number', config: {} },
      { id: 's', name: 'S', type: 'select', config: { options: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } },
      { id: 'm', name: 'M', type: 'multi_select', config: { options: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } },
      { id: 'd', name: 'D', type: 'date', config: {} },
      { id: 'c', name: 'C', type: 'checkbox', config: {} },
    ]
    const store = { propById: new Map(props.map((p) => [p.id, p])), properties: props, attachments: new Map() }
    const row = { values: { t: 'Hello World', n: 10, s: 'a', m: ['b'], d: { start: '2026-05-14' }, c: true }, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' }
    const empty = { values: {} }
    const r = (property, operator, value, target = row) => matchesRule(target, { property, operator, value }, store)
    const sorted = sortRows([{ values: { n: 3 } }, { values: {} }, { values: { n: -1 } }, { values: { n: 20 } }], [{ property: 'n', direction: 'desc' }], store).map((x) => x.values.n ?? null)
    return {
      containsYes: r('t', 'contains', 'world'), containsNo: r('t', 'contains', 'xyz'), isYes: r('t', 'is', 'hello world'), isNot: r('t', 'is_not', 'Hello World'),
      emptyYes: r('t', 'is_empty', '', empty), emptyNo: r('t', 'is_empty', ''),
      gt: r('n', 'gt', 9), gtNo: r('n', 'gt', 10), lt: r('n', 'lt', 11), ltNo: r('n', 'lt', 10), ltEmpty: r('n', 'lt', 11, empty),
      selIs: r('s', 'is', 'a'), selIsNot: r('s', 'is_not', 'a'), selEmpty: r('s', 'is_empty', '', empty),
      multi: r('m', 'contains', 'b'), multiNo: r('m', 'contains', 'a'),
      before: r('d', 'before', '2026-05-15'), beforeNo: r('d', 'before', '2026-05-14'), after: r('d', 'after', '2026-05-13'), afterEmpty: r('d', 'after', '2000-01-01', empty),
      checked: r('c', 'checked'), checkedNo: r('c', 'checked', undefined, empty), unchecked: r('c', 'unchecked', undefined, empty),
      incomplete: r('t', 'contains', ''),
      sorted,
      everyTypeComplete: Object.entries(TYPES).filter(([, t]) => !(t.render && t.text && t.filters && t.label && t.icon && (t.readOnly || t.edit) && (t.readOnly || t.compare))).map(([k]) => k),
    }
  })
  expect(results).toEqual({
    containsYes: true, containsNo: false, isYes: true, isNot: false, emptyYes: true, emptyNo: false,
    gt: true, gtNo: false, lt: true, ltNo: false, ltEmpty: false,
    selIs: true, selIsNot: false, selEmpty: true, multi: true, multiNo: false,
    before: true, beforeNo: false, after: true, afterEmpty: false,
    checked: true, checkedNo: false, unchecked: true,
    incomplete: null,
    sorted: [20, 3, -1, null],
    everyTypeComplete: [],
  })
})
