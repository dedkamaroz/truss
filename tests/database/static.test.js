// Static checks: property types are defined in one registry, colours come from tokens (plus one option palette).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MOD = path.join(REPO, 'web', 'modules', 'database')
const read = (f) => fs.readFileSync(path.join(MOD, f), 'utf8')
const jsFiles = fs.readdirSync(MOD).filter((f) => f.endsWith('.js'))
const TYPE_NAMES = ['title', 'text', 'number', 'select', 'multi_select', 'status', 'date', 'checkbox', 'url', 'email', 'phone', 'files', 'created_time', 'last_edited_time']

test('types.js registers every property type with render, text, compare, filters and editing', () => {
  const src = read('types.js')
  const registry = src.slice(src.indexOf('export const TYPES = {'), src.indexOf('export const typeOf'))
  for (const name of TYPE_NAMES) assert.match(registry, new RegExp(`\\n  ${name}: `), `${name} missing from TYPES`)
  for (const key of ['render', 'text', 'filters', 'compare', 'label', 'icon']) assert.match(registry, new RegExp(`\\b${key}\\b`))
})

test('views, peek, sort and filter code never branch on specific property type names', () => {
  const offenders = []
  for (const f of jsFiles.filter((f) => f !== 'types.js')) {
    const src = read(f)
    if (/\bswitch\s*\(/.test(src)) offenders.push(`${f}: switch statement`)
    const re = new RegExp(`\\.type\\s*[!=]==?\\s*'(${TYPE_NAMES.filter((t) => t !== 'title').join('|')})'`, 'g')
    for (const m of src.matchAll(re)) offenders.push(`${f}: ${m[0]}`)
    for (const m of src.matchAll(/case\s+'(\w+)'/g)) offenders.push(`${f}: ${m[0]}`)
  }
  assert.deepEqual(offenders, [])
})

test('no hard-coded colours outside the option palette; no em dash characters', () => {
  const css = read('database.css')
  // every declaration holding a hex colour must be an option palette variable (--db-tag-<colour>-bg|text|dot)
  const offenders = css.split(/[;{}]/).filter((d) => /#[0-9a-f]{3,8}\b/i.test(d) && !/^\s*--db-tag-[a-z]+-(bg|text|dot)\s*:/.test(d))
  assert.deepEqual(offenders, [])
  for (const f of jsFiles) assert.doesNotMatch(read(f), /['"`]#[0-9a-f]{3,8}['"`]|rgba?\(/i, `${f} has a colour literal`)
  const dash = String.fromCharCode(0x2014)
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const files = [...jsFiles.map((f) => path.join(MOD, f)), path.join(MOD, 'database.css'), path.join(REPO, 'server', 'routes', 'database.js'),
    ...fs.readdirSync(testDir).map((f) => path.join(testDir, f))]
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').includes(dash), `${f} contains an em dash`)
})
