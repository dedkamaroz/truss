import { test, expect } from '@playwright/test'
import { watch, boot, notebook, createPage, openPage, saved, block, blockText, caret, storedBlocks, api, shot } from './helpers.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHElEQVR42mNkYPj/n4EIwDiqEF8oYhgGGgAAeYcH/f0Xb1cAAAAASUVORK5CYII=', 'base64')

async function freshPage(page, content) {
  const { module } = await notebook(page)
  const p = await createPage(page, module.id, { title: 'Editor test', content })
  await openPage(page, module.id, p.id)
  return { module, p }
}

const types = (page) => page.locator('.nb-blocks > .nb-block').evaluateAll((els) => els.map((e) => e.dataset.type))
const texts = (page) => page.locator('.nb-blocks > .nb-block').evaluateAll((els) => els.map((e) => e.querySelector('.nb-text[data-field="html"]')?.textContent ?? null))

test('slash menu creates every block type, with type-to-filter and keyboard selection', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { module, p } = await freshPage(page)
  const first = blockText(page, 0)
  await first.click()

  // Full menu, then filtering
  await page.keyboard.type('/')
  const menu = page.locator('.nb-slash')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.nb-slash-item')).toHaveCount(15)
  await shot(page, 'slash-menu')
  await page.keyboard.type('head')
  await expect(menu.locator('.nb-slash-item')).toHaveText([/Heading 1/, /Heading 2/, /Heading 3/])
  await page.keyboard.press('ArrowDown')
  await expect(menu.locator('.nb-slash-item.is-active')).toContainText('Heading 2')
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(block(page, 0)).toHaveAttribute('data-type', 'heading2')
  await expect(first).toHaveText('')
  await page.keyboard.type('Section')
  await page.keyboard.press('Enter')

  // Escape closes without changing the block; the typed text stays
  await page.keyboard.type('/quo')
  await expect(menu.locator('.nb-slash-item')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(block(page, 1)).toHaveAttribute('data-type', 'paragraph')
  await expect(blockText(page, 1)).toHaveText('/quo')
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')

  const textual = [
    ['paragraph', 'text', 'Plain words'],
    ['heading1', 'heading 1', 'Big'],
    ['heading3', 'heading 3', 'Small'],
    ['bulleted', 'bulleted', 'Bullet'],
    ['numbered', 'numbered', 'Number'],
    ['todo', 'to-do', 'Task'],
    ['quote', 'quote', 'Quoted'],
    ['callout', 'callout', 'Heads up'],
    ['toggle', 'toggle', 'More'],
  ]
  for (const [type, query, text] of textual) {
    await page.keyboard.type(`/${query}`)
    await expect(menu.locator('.nb-slash-item').first()).toHaveAttribute('data-type', type)
    await page.keyboard.press('Enter')
    await page.keyboard.type(text)
    await page.keyboard.press('Enter')
    // lists continue on Enter; an empty list item turns back into a paragraph on a second Enter
    if (['bulleted', 'numbered', 'todo'].includes(type)) await page.keyboard.press('Enter')
  }
  await page.keyboard.type('/code')
  await page.keyboard.press('Enter')
  await page.keyboard.type('const a = 1')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('const b = 2')
  await page.keyboard.press('ArrowDown') // leave the code block: moves to the next block if any
  // add the remaining block types from a fresh paragraph after the code block
  await page.locator('.nb-editor-tail').click()
  await page.keyboard.type('/divider')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/table')
  await page.keyboard.press('Enter')
  await expect(page.locator('.nb-block[data-type="table"] .nb-cell').first()).toBeFocused()
  await page.keyboard.type('Col A')
  await page.locator('.nb-editor-tail').click()

  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.type('/image')
  await page.keyboard.press('Enter')
  await (await chooser).setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.locator('.nb-block[data-type="image"] img')).toBeVisible()
  await expect.poll(() => page.locator('.nb-block[data-type="image"] img').evaluate((img) => img.naturalWidth)).toBe(8)

  await page.locator('.nb-editor-tail').click()
  const chooser2 = page.waitForEvent('filechooser')
  await page.keyboard.type('/file')
  await expect(menu.locator('.nb-slash-item').first()).toHaveAttribute('data-type', 'file')
  await page.keyboard.press('Enter')
  await (await chooser2).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
  await expect(page.locator('.nb-block[data-type="file"]')).toContainText('notes.txt')
  await saved(page)

  const expected = ['heading2', 'paragraph', 'heading1', 'heading3', 'bulleted', 'numbered', 'todo', 'quote', 'callout', 'toggle', 'code', 'divider', 'table', 'image', 'file']
  const got = await types(page)
  for (const t of expected) expect(got, `has ${t}`).toContain(t)
  const stored = await storedBlocks(page, module.id, p.id)
  expect(stored.map((b) => b.type)).toEqual(got)
  expect(stored.find((b) => b.type === 'code').html).toBe('const a = 1\nconst b = 2')
  expect(stored.find((b) => b.type === 'table').props.columns[0].name).toBe('Col A')
  const img = stored.find((b) => b.type === 'image')
  const atts = (await api(page, 'GET', `/api/attachments?moduleId=${module.id}&pageId=${p.id}`)).body
  expect(atts.map((a) => a.filename).sort()).toEqual(['dot.png', 'notes.txt'])
  expect(img.props.attachmentId).toBe(atts.find((a) => a.filename === 'dot.png').id)

  // Everything survives a reload
  await page.reload()
  await expect(page.locator('.nb-blocks > .nb-block')).toHaveCount(got.length)
  expect(await types(page)).toEqual(got)
  await expect(page.locator('.nb-block[data-type="image"] img')).toBeVisible()
  expect(w.errors).toEqual([])
  expect(w.dialogs).toEqual([])
})

test('markdown shortcuts, Enter split, Backspace merge, drag reorder and to-do persistence', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { module, p } = await freshPage(page)
  await blockText(page, 0).click()
  const shortcuts = [['# ', 'heading1'], ['## ', 'heading2'], ['- ', 'bulleted'], ['1. ', 'numbered'], ['[] ', 'todo'], ['> ', 'quote'], ['```', 'code']]
  for (const [i, [md, type]] of shortcuts.entries()) {
    if (i > 0) {
      await page.locator('.nb-editor-tail').click()
    }
    await page.keyboard.type(md)
    await expect(block(page, i)).toHaveAttribute('data-type', type)
    await expect(blockText(page, i)).toHaveText('')
    await page.keyboard.type(`item ${i}`)
  }
  expect(await texts(page)).toEqual(shortcuts.map((_, i) => `item ${i}`))
  // a shortcut typed mid-text does nothing
  await page.locator('.nb-editor-tail').click()
  await page.keyboard.type('a # b')
  await expect(block(page, 7)).toHaveAttribute('data-type', 'paragraph')

  // Enter splits at the caret
  await page.keyboard.press('Control+a')
  await page.keyboard.type('HelloWorld')
  const para = blockText(page, 7)
  await caret(para, 5)
  await page.keyboard.press('Enter')
  expect((await texts(page)).slice(7)).toEqual(['Hello', 'World'])
  await expect(blockText(page, 8)).toBeFocused()

  // Backspace at the start merges into the previous block with the caret at the join
  await page.keyboard.press('Backspace')
  expect((await texts(page)).slice(7)).toEqual(['HelloWorld'])
  await page.keyboard.type('_')
  await expect(para).toHaveText('Hello_World')

  // Enter at the end of a list item continues the list
  await caret(blockText(page, 2))
  await page.keyboard.press('Enter')
  await expect(block(page, 3)).toHaveAttribute('data-type', 'bulleted')
  await page.keyboard.press('Backspace')
  await expect(block(page, 3)).toHaveAttribute('data-type', 'numbered')

  // Ctrl+B on a collapsed caret toggles bold for the text typed next
  await caret(para)
  await page.keyboard.press('Control+b')
  await page.keyboard.type('Bold')
  await page.keyboard.press('Control+b')
  await page.keyboard.type('x')
  await expect.poll(() => para.innerHTML()).toBe('Hello_World<b>Bold</b>x')

  // To-do checkbox persists
  const todo = page.locator('.nb-block[data-type="todo"]')
  await todo.locator('.nb-check').check()
  await expect(todo).toHaveClass(/is-checked/)

  // Drag the last block (paragraph) above the first via its handle
  const identity = await block(page, 1).evaluate((el) => (el.__probe = Math.random()))
  const last = block(page, 7)
  await last.hover()
  await last.locator('.nb-handle').dragTo(block(page, 0), { targetPosition: { x: 60, y: 4 } })
  expect((await texts(page))[0]).toBe('Hello_WorldBoldx')
  expect((await texts(page))[1]).toBe('item 0')
  expect(await block(page, 2).evaluate((el) => el.__probe)).toBe(identity) // moved, not re-rendered

  await saved(page)
  const before = await page.locator('.nb-blocks > .nb-block').evaluateAll((els) => els.map((e) => [e.dataset.type, e.querySelector('.nb-text')?.innerHTML]))
  await page.reload()
  await expect(page.locator('.nb-blocks > .nb-block')).toHaveCount(before.length)
  const after = await page.locator('.nb-blocks > .nb-block').evaluateAll((els) => els.map((e) => [e.dataset.type, e.querySelector('.nb-text')?.innerHTML]))
  expect(after).toEqual(before)
  await expect(page.locator('.nb-block[data-type="todo"] .nb-check')).toBeChecked()
  const stored = await storedBlocks(page, module.id, p.id)
  expect(stored.find((b) => b.type === 'todo').props.checked).toBe(true)
  expect(w.errors).toEqual([])
})

test('Ctrl+K in a block opens only the link dialog, not the shell quick switcher', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { module, p } = await freshPage(page)
  const ed = blockText(page, 0)
  await ed.click()
  await page.keyboard.type('visit site')
  await ed.evaluate((el) => {
    const r = document.createRange()
    r.setStart(el.firstChild, 6)
    r.setEnd(el.firstChild, 10)
    getSelection().removeAllRanges()
    getSelection().addRange(r)
  })
  await page.keyboard.press('Control+k')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCount(1)
  await expect(dialog).toContainText('link', { ignoreCase: true })
  await expect(page.locator('.modal-switcher')).toHaveCount(0)
  await expect(dialog.getByRole('textbox')).toBeFocused()
  await page.keyboard.type('https://example.com/k')
  await page.keyboard.press('Enter')
  await expect(ed.locator('a')).toHaveAttribute('href', 'https://example.com/k')
  await expect(ed.locator('a')).toHaveText('site')
  await expect(page.locator('.modal-switcher')).toHaveCount(0)
  await saved(page)
  expect((await storedBlocks(page, module.id, p.id))[0].html).toContain('href="https://example.com/k"')

  // Outside the editor the shell shortcut still works.
  await page.evaluate(() => document.activeElement?.blur())
  await page.keyboard.press('Control+k')
  await expect(page.locator('.modal-switcher')).toHaveCount(1)
  expect(w.errors).toEqual([])
})

test('inline formatting via shortcuts and the selection toolbar survives reload; undo/redo covers typing and block operations', async ({ page }) => {
  const w = await watch(page)
  await boot(page)
  const { module, p } = await freshPage(page)
  const ed = blockText(page, 0)
  await ed.click()
  await page.keyboard.type('one two three four five six')

  const select = async (start, end) => {
    await ed.evaluate((el, [s, e]) => {
      el.focus()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const nodes = []
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n)
      const find = (off) => {
        for (const n of nodes) {
          if (off <= n.data.length) return [n, off]
          off -= n.data.length
        }
      }
      const r = document.createRange()
      r.setStart(...find(s))
      r.setEnd(...find(e))
      getSelection().removeAllRanges()
      getSelection().addRange(r)
    }, [start, end])
  }
  const bar = page.locator('.nb-selbar')

  await select(0, 3)
  await page.keyboard.press('Control+b')
  await select(4, 7)
  await page.keyboard.press('Control+i')
  await select(8, 13)
  await page.keyboard.press('Control+u')
  await select(14, 18)
  await expect(bar).toBeVisible()
  await shot(page, 'selection-toolbar')
  await bar.getByRole('button', { name: 'Strikethrough' }).click()
  await select(19, 23)
  await bar.getByRole('button', { name: 'Inline code' }).click()
  await select(24, 27)
  await bar.getByRole('button', { name: 'Link' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox').fill('https://example.com/x')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(ed.locator('a')).toHaveAttribute('href', 'https://example.com/x')
  await page.locator('.nb-page-title').click()
  await expect(bar).toBeHidden()

  const html = '<b>one</b> <i>two</i> <u>three</u> <s>four</s> <code>five</code> <a href="https://example.com/x" rel="noopener noreferrer" target="_blank">six</a>'
  await expect.poll(() => ed.innerHTML()).toBe(html)
  await saved(page)
  expect((await storedBlocks(page, module.id, p.id))[0].html).toBe(html)
  await page.reload()
  await expect(blockText(page, 0)).toBeVisible()
  expect(await blockText(page, 0).innerHTML()).toBe(html)

  // Toggling a mark off again
  await select(0, 3)
  await expect(bar.getByRole('button', { name: 'Bold' })).toHaveClass(/is-active/)
  await bar.getByRole('button', { name: 'Bold' }).click()
  await expect.poll(() => blockText(page, 0).innerHTML()).toMatch(/^one <i>two<\/i>/)

  // Undo / redo typing
  await caret(blockText(page, 0))
  await page.keyboard.press('Enter')
  await page.keyboard.type('typed words')
  await expect(blockText(page, 1)).toHaveText('typed words')
  await page.keyboard.press('Control+z')
  await expect(blockText(page, 1)).toHaveText('')
  await page.keyboard.press('Control+y')
  await expect(blockText(page, 1)).toHaveText('typed words')

  // Undo / redo a block split and a type change
  await caret(blockText(page, 1), 5)
  await page.keyboard.press('Enter')
  await expect(page.locator('.nb-blocks > .nb-block')).toHaveCount(3)
  const untouched = await block(page, 0).evaluate((el) => (el.__probe = 42))
  await page.keyboard.press('Control+z')
  await expect(page.locator('.nb-blocks > .nb-block')).toHaveCount(2)
  await expect(blockText(page, 1)).toHaveText('typed words')
  expect(await block(page, 0).evaluate((el) => el.__probe)).toBe(untouched)
  await page.keyboard.press('Control+Shift+z')
  await expect(page.locator('.nb-blocks > .nb-block')).toHaveCount(3)
  expect(await texts(page)).toEqual([expect.stringMatching(/^one two/), 'typed', ' words'])

  await caret(blockText(page, 2), 0)
  await page.keyboard.press('Backspace')
  await caret(blockText(page, 1), 0)
  await page.keyboard.type('# ')
  await expect(block(page, 1)).toHaveAttribute('data-type', 'heading1')
  await page.keyboard.press('Control+z')
  await expect(block(page, 1)).toHaveAttribute('data-type', 'paragraph')
  await page.keyboard.press('Control+y')
  await expect(block(page, 1)).toHaveAttribute('data-type', 'heading1')
  await saved(page)
  const stored = await storedBlocks(page, module.id, p.id)
  expect(stored.map((b) => [b.type, b.html.replace(/<[^>]+>/g, '')])).toEqual([['paragraph', 'one two three four five six'], ['heading1', 'typed words']])
  expect(w.errors).toEqual([])
})
