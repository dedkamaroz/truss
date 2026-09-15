import { test, expect } from '@playwright/test'
import { watch, boot, apiCall, clickCell, cellPoint, typeInto, waitGrid, shot, uid } from './helpers.js'

for (const theme of ['light', 'dark']) {
  test(`visual: ${theme} 1440x900`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
    const page = await context.newPage()
    const w = watch(page)
    await boot(page)
    await page.evaluate((t) => localStorage.setItem('truss.theme', t), theme)
    const budget = (await apiCall(page, 'POST', '/api/modules', { type: 'sheet', template: 'monthly-budget', title: 'Household budget' })).body
    await page.goto(`/#/m/${budget.id}`)
    await page.reload()
    await waitGrid(page)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await shot(page, `${theme}-budget-income`)

    await page.locator('.sheet-tab', { hasText: 'Summary' }).click()
    await clickCell(page, 'B5')
    await shot(page, `${theme}-budget-summary`)

    // formula edit with autocomplete and reference highlights
    await clickCell(page, 'D3')
    await page.keyboard.type('=')
    await clickCell(page, 'B3')
    await page.keyboard.type('-')
    const a = await cellPoint(page, 3, 1)
    const b = await cellPoint(page, 5, 1)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 3 })
    await page.mouse.up()
    await page.keyboard.type('+SU')
    await expect(page.locator('.sheet-ac')).toBeVisible()
    await shot(page, `${theme}-formula-autocomplete`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')

    // formatted cells
    await page.locator('.sheet-tab-add').click()
    const rows = [['Region', 'Revenue', 'Growth', 'Updated', 'Status'], ['Sydney', '184250.5', '0.124', '14/05/2026', 'On track'], ['Melbourne', '152900', '-0.031', '02/04/2026', 'Review'], ['Brisbane', '98410.75', '0.268', '28/03/2026', 'Ahead']]
    for (let r = 0; r < rows.length; r++) {
      await clickCell(page, `A${r + 1}`)
      for (const v of rows[r]) {
        await page.keyboard.type(v)
        await page.keyboard.press('Tab')
      }
    }
    await typeInto(page, 'A6', 'Total')
    await typeInto(page, 'B6', '=SUM(B2:B4)')
    await typeInto(page, 'C6', '=AVERAGE(C2:C4)')
    await typeInto(page, 'E6', '=B6/0')
    const selectRange = async (from, to) => {
      const p = await cellPoint(page, from[0], from[1])
      const q = await cellPoint(page, to[0], to[1])
      await page.mouse.move(p.x, p.y)
      await page.mouse.down()
      await page.mouse.move(q.x, q.y, { steps: 3 })
      await page.mouse.up()
    }
    await selectRange([0, 0], [0, 4])
    await page.keyboard.press('Control+b')
    await page.locator('.sheet-tb[title="Fill colour"]').click()
    await page.locator('.sheet-swatch[data-colour="blue"]').click()
    await selectRange([1, 1], [5, 1])
    await page.locator('.sheet-nf').click()
    await page.locator('.popover .menu-item', { hasText: 'Currency (AUD)' }).click()
    await selectRange([1, 2], [5, 2])
    await page.locator('.sheet-nf').click()
    await page.locator('.popover .menu-item', { hasText: 'Percent' }).click()
    await clickCell(page, 'E3')
    await page.locator('.sheet-tb[title="Text colour"]').click()
    await page.locator('.sheet-swatch[data-colour="orange"]').click()
    await clickCell(page, 'E4')
    await page.locator('.sheet-tb[title="Text colour"]').click()
    await page.locator('.sheet-swatch[data-colour="green"]').click()
    await selectRange([5, 0], [5, 4])
    await page.keyboard.press('Control+b')
    await page.locator('.sheet-tb[title="Fill colour"]').click()
    await page.locator('.sheet-swatch[data-colour="yellow"]').click()
    await selectRange([1, 1], [3, 2])
    await shot(page, `${theme}-formatted`)

    // context menu
    const p = await cellPoint(page, 2, 1)
    await page.mouse.click(p.x, p.y, { button: 'right' })
    await expect(page.locator('.popover .menu')).toBeVisible()
    await shot(page, `${theme}-context-menu`)
    await page.keyboard.press('Escape')

    // error tooltip and tabs
    const e = await cellPoint(page, 5, 4)
    await page.mouse.move(e.x, e.y)
    await expect(page.locator('.sheet-tooltip')).toBeVisible()
    await page.locator('.sheet-tab', { hasText: 'Sheet4' }).dblclick()
    await page.locator('.sheet-tab-input').fill(`Regions ${uid()}`)
    await page.locator('.sheet-tab-input').press('Enter')
    await page.mouse.move(e.x, e.y + 2)
    await expect(page.locator('.sheet-tooltip')).toBeVisible()
    await shot(page, `${theme}-tabs-tooltip`)

    // Nothing that clips text vertically
    const clipped = await page.evaluate(() => [...document.querySelectorAll('.sheet-app *')]
      .filter((el) => el.childNodes.length && el.textContent.trim() && getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.className))
    expect(clipped).toEqual([])
    expect(w.errors).toEqual([])
    await context.close()
  })
}
