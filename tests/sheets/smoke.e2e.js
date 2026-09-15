import { test, expect } from '@playwright/test'
import { watch, openWorkbook, shot, domCellText } from './helpers.js'

test('budget template renders Summary totals in AUD', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const w = watch(page)
  await openWorkbook(page, { template: 'monthly-budget', title: 'Budget smoke' })
  await expect(page.locator('.sheet-tab')).toHaveText(['Income', 'Expenses', 'Summary'])
  await shot(page, 'smoke-income')
  await page.locator('.sheet-tab', { hasText: 'Summary' }).click()
  await expect.poll(() => domCellText(page, 'B3')).toBe('$7,085.00')
  await shot(page, 'smoke-summary')
  expect(w.errors).toEqual([])
})
