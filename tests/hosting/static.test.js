import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// Truss is served from "/" locally and from "/m/truss/" on the web_server. A
// root-absolute asset URL resolves against the site root in both cases, so it
// 404s everywhere but locally. Asset URLs must be relative, or resolved through
// import.meta.url. API paths are exempt: they all funnel through api.js, which
// resolves them against BASE.
test('no root-absolute asset URLs in web/', () => {
  const offenders = []
  for (const file of walk(WEB)) {
    if (!/\.(js|html)$/.test(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    for (const [i, line] of text.split(/\r?\n/).entries()) {
      // "/lib/...", "/modules/...", "/styles/...", "/app.js" in any quote style.
      const m = line.match(/['"`]\/(lib|modules|styles|app\.js)/)
      if (m) offenders.push(`${path.relative(WEB, file)}:${i + 1}: ${line.trim()}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('index.html references no root-absolute src or href', () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
  const offenders = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(offenders, [])
})
