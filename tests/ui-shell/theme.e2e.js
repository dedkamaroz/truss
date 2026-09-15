import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { watch, boot } from './helpers.js'

const SHELL_FILES = ['web/index.html', 'web/app.js', 'web/lib/api.js', 'web/lib/ui.js', 'web/lib/icons.js', 'web/lib/registry.js', 'web/lib/sanitize.js']

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
}

test('theme toggle switches light/dark and persists across reload', async ({ page }) => {
  const w = await watch(page)
  await page.emulateMedia({ colorScheme: 'light' })
  await boot(page)
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'light')
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const sidebarBg = () => page.locator('.sidebar').evaluate((e) => getComputedStyle(e).backgroundColor)
  const lightBg = await bg()
  const lightSidebar = await sidebarBg()

  await page.locator('.theme-toggle').click()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  expect(await bg()).not.toBe(lightBg)
  expect(await sidebarBg()).not.toBe(lightSidebar)
  expect(await page.evaluate(() => localStorage.getItem('truss.theme'))).toBe('dark')

  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('.theme-toggle')).toContainText('Light mode')

  await page.locator('.theme-toggle').click()
  await expect(html).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'light')
  expect(await bg()).toBe(lightBg)
  expect(w.errors).toEqual([])
})

test('colours live only in tokens.css and no em dash appears under web/', () => {
  const styles = fs.readdirSync('web/styles').filter((f) => f.endsWith('.css'))
  expect(styles).toContain('tokens.css')
  const offenders = []
  for (const file of [...styles.filter((f) => f !== 'tokens.css').map((f) => `web/styles/${f}`), ...SHELL_FILES]) {
    const src = fs.readFileSync(file, 'utf8')
    const hex = src.match(/#[0-9a-fA-F]{3,8}\b/g) || []
    const fns = src.match(/\b(?:rgba?|hsla?|oklch|lab|lch)\(/g) || []
    const named = file.endsWith('.css') ? src.match(/:\s*(?:white|black|red|blue|green|gray|grey)\b/g) || [] : []
    if (hex.length || fns.length || named.length) offenders.push(`${file}: ${[...hex, ...fns, ...named].join(', ')}`)
  }
  expect(offenders).toEqual([])

  const tokens = fs.readFileSync('web/styles/tokens.css', 'utf8')
  expect(tokens).toMatch(/:root\s*\{[^}]*--color-bg:/)
  expect(tokens).toMatch(/:root\[data-theme="dark"\]\s*\{[^}]*--color-bg:/)

  const dash = walk('web').filter((f) => fs.readFileSync(f, 'utf8').includes('—'))
  expect(dash).toEqual([])
})
