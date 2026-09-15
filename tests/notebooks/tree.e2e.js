import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { watch, boot, notebook, createPage, openPage, saved, api, shot } from './helpers.js'

const row = (page, id) => page.locator(`.nb-tree-row[data-id="${id}"]`)
const rootOrder = async (page, moduleId, parent = null) =>
  (await api(page, 'GET', `/api/notebooks/${moduleId}/pages`)).body
    .filter((p) => p.parent_id === parent && !p.archived_at)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((p) => p.title)

// The E2E server's data dir is a fresh temp folder named after the port; find the attachment folder on disk.
function attachmentDirs(id) {
  const port = process.env.TRUSS_E2E_PORT || '4799'
  return fs.readdirSync(os.tmpdir())
    .filter((d) => d.startsWith(`truss-e2e-${port}-`))
    .map((d) => path.join(os.tmpdir(), d, 'attachments', id))
    .filter((p) => fs.existsSync(p))
}

async function upload(page, moduleId, pageId, filename, text) {
  return page.evaluate(async ({ moduleId, pageId, filename, text }) => {
    const token = document.querySelector('meta[name="truss-token"]').content
    const res = await fetch(`/api/attachments?moduleId=${moduleId}&pageId=${pageId}`, { method: 'POST', headers: { 'X-Truss-Token': token, 'X-Filename': filename }, body: text })
    return res.json()
  }, { moduleId, pageId, filename, text })
}

test('create, nest, rename, icon, drag to reorder and nest, archive and restore', async ({ page }) => {
  const w = await watch(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await boot(page)
  const { module } = await notebook(page, { title: 'Tree test' })
  await page.goto(`/#/m/${module.id}`)
  await expect(page.locator('.nb-empty')).toContainText('No pages yet')

  // create a page from the empty state; the title is focused
  await page.locator('.nb-empty').getByRole('button', { name: 'New page' }).click()
  await expect(page).toHaveURL(/\/p\/[0-9a-f-]{36}$/)
  const alphaId = page.url().split('/p/')[1]
  await expect(page.locator('.nb-page-title')).toBeFocused()
  await page.keyboard.type('Project Alpha')
  await expect(row(page, alphaId).locator('.nb-tree-label')).toHaveText('Project Alpha')
  await saved(page)

  // subpage from the tree row
  await row(page, alphaId).hover()
  await row(page, alphaId).getByRole('button', { name: 'Add subpage' }).click()
  await expect(page).not.toHaveURL(new RegExp(`/p/${alphaId}$`))
  const childId = page.url().split('/p/')[1]
  await expect(page.locator(`.nb-page[data-page-id="${childId}"] .nb-page-title`)).toBeFocused()
  await page.keyboard.type('Child page')
  await expect(row(page, childId)).toHaveAttribute('aria-level', '2')
  await expect(row(page, alphaId)).toHaveAttribute('aria-expanded', 'true')
  await saved(page)
  const child = (await api(page, 'GET', `/api/notebooks/${module.id}/pages/${childId}`)).body
  expect(child.parent_id).toBe(alphaId)
  expect(child.title).toBe('Child page')

  // collapse and expand
  await row(page, alphaId).locator('.nb-tree-toggle').click()
  await expect(row(page, childId)).toHaveCount(0)
  await row(page, alphaId).locator('.nb-tree-toggle').click()
  await expect(row(page, childId)).toBeVisible()

  // rename inline in the tree
  await row(page, childId).locator('.nb-tree-label').dblclick()
  const input = page.locator('.nb-tree-rename')
  await expect(input).toBeFocused()
  await input.fill('Renamed child')
  await input.press('Enter')
  await expect(row(page, childId).locator('.nb-tree-label')).toHaveText('Renamed child')
  await expect(page.locator('.nb-page-title')).toHaveText('Renamed child')
  await expect.poll(async () => (await api(page, 'GET', `/api/notebooks/${module.id}/pages/${childId}`)).body.title).toBe('Renamed child')

  // emoji icon from the page header
  await page.locator('.nb-page-inner').hover()
  await page.locator('.nb-add-icon').click()
  await page.locator('.emoji-picker input').fill('kangaroo')
  await page.locator('.emoji-option').first().click()
  await expect(page.locator('.nb-page-emoji')).toHaveText('🦘')
  await expect(row(page, childId).locator('.nb-tree-icon')).toHaveText('🦘')
  await expect.poll(async () => (await api(page, 'GET', `/api/notebooks/${module.id}/pages/${childId}`)).body.icon).toBe('🦘')

  // drag to reorder and to nest
  const b = await createPage(page, module.id, { title: 'Bravo' })
  const c = await createPage(page, module.id, { title: 'Charlie' })
  await page.reload()
  await expect(row(page, c.id)).toBeVisible()
  expect(await rootOrder(page, module.id)).toEqual(['Project Alpha', 'Bravo', 'Charlie'])
  await row(page, c.id).dragTo(row(page, alphaId), { targetPosition: { x: 60, y: 3 } })
  await expect.poll(() => rootOrder(page, module.id)).toEqual(['Charlie', 'Project Alpha', 'Bravo'])
  await expect(page.locator('.nb-tree-row[aria-level="1"] .nb-tree-label')).toHaveText(['Charlie', 'Project Alpha', 'Bravo'])
  await row(page, b.id).dragTo(row(page, c.id), { targetPosition: { x: 60, y: 15 } })
  await expect.poll(() => rootOrder(page, module.id, c.id)).toEqual(['Bravo'])
  await expect(row(page, b.id)).toHaveAttribute('aria-level', '2')
  expect(await rootOrder(page, module.id)).toEqual(['Charlie', 'Project Alpha'])
  // drop below a row: after Project Alpha at the root
  await row(page, b.id).dragTo(row(page, alphaId), { targetPosition: { x: 60, y: 27 } })
  await expect.poll(() => rootOrder(page, module.id)).toEqual(['Charlie', 'Project Alpha', 'Bravo'])
  await shot(page, 'tree-nesting')

  // archive moves the page to the Archived section; restore brings it back
  await row(page, c.id).hover()
  await row(page, c.id).getByRole('button', { name: 'Page options' }).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(row(page, c.id)).toHaveCount(0)
  const archivedToggle = page.locator('.nb-archived-toggle')
  await expect(archivedToggle).toContainText('Archived')
  await expect(archivedToggle.locator('.nb-count')).toHaveText('1')
  await archivedToggle.click()
  const archivedRow = page.locator(`.nb-archived-row[data-id="${c.id}"]`)
  await expect(archivedRow).toContainText('Charlie')
  expect((await api(page, 'GET', `/api/notebooks/${module.id}/pages/${c.id}`)).body.archived_at).toBeTruthy()
  await archivedRow.hover()
  await archivedRow.getByRole('button', { name: 'Restore' }).click()
  await expect(row(page, c.id)).toBeVisible()
  await expect(page.locator('.nb-archived-toggle')).toHaveCount(0)
  expect((await api(page, 'GET', `/api/notebooks/${module.id}/pages/${c.id}`)).body.archived_at).toBeNull()

  // archiving the open page from its toolbar shows a banner with restore
  await row(page, c.id).click()
  await expect(page.locator(`.nb-page[data-page-id="${c.id}"]`)).toBeVisible()
  await page.locator('.nb-page-toolbar').getByRole('button', { name: 'More page actions' }).click()
  await page.getByRole('menuitem', { name: 'Archive' }).click()
  const banner = page.locator('.nb-banner')
  await expect(banner).toContainText('This page is archived.')
  await expect(page.locator('.nb-archived')).toHaveText(/^Archived1Charlie$/)
  await page.locator('.nb-archived-toggle').click()
  await expect(page.locator('.nb-archived')).toHaveText(/^Archived1$/)
  await banner.getByRole('button', { name: 'Restore' }).click()
  await expect(banner).toBeHidden()
  await expect(row(page, c.id)).toBeVisible()

  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})

test('delete uses the custom confirm and removes subpages and their attachment files from disk', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { module } = await notebook(page)
  const keep = await createPage(page, module.id, { title: 'Keep me' })
  const parent = await createPage(page, module.id, { title: 'Doomed parent' })
  const child = await createPage(page, module.id, { title: 'Doomed child', parent_id: parent.id })
  const grandchild = await createPage(page, module.id, { title: 'Doomed grandchild', parent_id: child.id })
  const atts = [
    await upload(page, module.id, parent.id, 'parent.txt', 'p'),
    await upload(page, module.id, child.id, 'child.txt', 'c'),
    await upload(page, module.id, grandchild.id, 'grand.txt', 'g'),
    await upload(page, module.id, keep.id, 'keep.txt', 'k'),
  ]
  for (const a of atts) expect(attachmentDirs(a.id), `${a.filename} on disk`).toHaveLength(1)

  await openPage(page, module.id, child.id)
  await row(page, parent.id).hover()
  await row(page, parent.id).getByRole('button', { name: 'Page options' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('2 subpages')
  await expect(dialog).toContainText('cannot be undone')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(row(page, parent.id)).toBeVisible()

  await row(page, parent.id).hover()
  await row(page, parent.id).getByRole('button', { name: 'Page options' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await dialog.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(row(page, parent.id)).toHaveCount(0)
  await expect(row(page, child.id)).toHaveCount(0)
  // the open page was deleted, so the notebook moves to a remaining page
  await expect(page.locator(`.nb-page[data-page-id="${keep.id}"]`)).toBeVisible()

  for (const id of [parent.id, child.id, grandchild.id]) {
    expect((await api(page, 'GET', `/api/notebooks/${module.id}/pages/${id}`)).status).toBe(404)
  }
  for (const a of atts.slice(0, 3)) {
    expect(attachmentDirs(a.id), `${a.filename} removed from disk`).toHaveLength(0)
    expect((await api(page, 'GET', `/api/attachments/${a.id}/content`)).status).toBe(404)
  }
  expect(attachmentDirs(atts[3].id)).toHaveLength(1)
  expect(w.dialogs).toEqual([])
  expect(w.errors.filter((e) => !e.includes('404'))).toEqual([])
})

test('search finds pages by title and by body text', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { module } = await notebook(page)
  const byTitle = await createPage(page, module.id, { title: 'Quokka facts' })
  const byBody = await createPage(page, module.id, { title: 'Wildlife', content: [
    { id: 'a', type: 'paragraph', html: 'Visit the <b>quokka</b> enclosure on Rottnest', props: {} },
  ] })
  await createPage(page, module.id, { title: 'Unrelated', content: [{ id: 'a', type: 'paragraph', html: 'Nothing to see', props: {} }] })
  await openPage(page, module.id, byTitle.id)

  await page.locator('.nb-search-input').fill('QUOKKA')
  const results = page.locator('.nb-search-result')
  await expect(results).toHaveCount(2)
  await expect(page.locator('.nb-search-results')).not.toContainText('null')
  await expect(page.locator('.nb-tree')).toBeHidden()
  await expect(page.locator(`.nb-search-result[data-id="${byTitle.id}"]`)).toHaveAttribute('data-match', 'title')
  const bodyHit = page.locator(`.nb-search-result[data-id="${byBody.id}"]`)
  await expect(bodyHit).toHaveAttribute('data-match', 'content')
  await expect(bodyHit.locator('.nb-search-snippet')).toContainText('quokka enclosure on Rottnest')
  await shot(page, 'search')
  await bodyHit.click()
  await expect(page.locator(`.nb-page[data-page-id="${byBody.id}"]`)).toBeVisible()

  // text typed in the editor becomes searchable once saved
  await page.locator('.nb-text').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' with numbat burrows')
  await saved(page)
  await page.locator('.nb-search-input').fill('numbat')
  await expect(results).toHaveCount(1)
  await expect(results.first()).toHaveAttribute('data-id', byBody.id)
  await page.locator('.nb-search-input').fill('zzz-nothing')
  await expect(page.locator('.nb-search-results')).toContainText('No pages match')
  await page.locator('.nb-search-input').press('Escape')
  await expect(page.locator('.nb-tree')).toBeVisible()
  expect(w.errors).toEqual([])
})
