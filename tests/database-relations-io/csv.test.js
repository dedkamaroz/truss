import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, stringify, CsvError } from '../../web/lib/csv.js'

test('parses quoted fields with commas, escaped quotes and embedded CRLF/LF newlines', () => {
  const text = 'name,notes,amount\r\n"Smith, Jane","She said ""hi""",12\r\n"multi\r\nline","lf\nonly",\r\nplain,"",""\n'
  assert.deepEqual(parse(text), [
    ['name', 'notes', 'amount'],
    ['Smith, Jane', 'She said "hi"', '12'],
    ['multi\r\nline', 'lf\nonly', ''],
    ['plain', '', ''],
  ])
})

test('strips a UTF-8 BOM, keeps empty fields, accepts LF, CRLF and CR line endings', () => {
  assert.deepEqual(parse('\uFEFFa,b\n1,2'), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parse(',,\r\n,x,'), [['', '', ''], ['', 'x', '']])
  assert.deepEqual(parse('a\rb\r\nc\n'), [['a'], ['b'], ['c']])
  assert.deepEqual(parse(''), [])
  assert.deepEqual(parse('"\uFEFF"'), [['\uFEFF']], 'a BOM inside a field is data')
  assert.deepEqual(parse('x;"y;z"', { delimiter: ';' }), [['x', 'y;z']])
})

test('malformed input throws CsvError with a line number', () => {
  assert.throws(() => parse('a,b\n"open,c\nd'), (e) => e instanceof CsvError && /line 2/.test(e.message))
  assert.throws(() => parse('"ok"junk,1'), CsvError)
  assert.throws(() => parse(42), CsvError)
})

test('stringify quotes only when needed, uses CRLF and can add a BOM', () => {
  assert.equal(stringify([['a', 'b,c', 'say "x"'], ['1', null, 'l1\nl2']]), 'a,"b,c","say ""x"""\r\n1,,"l1\nl2"\r\n')
  assert.equal(stringify([['x']], { bom: true }), '\uFEFFx\r\n')
  assert.equal(stringify([['']]), '""\r\n')
})

// Seeded generator: the seed changes every run (printed on failure) so the data is never a fixed table.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('stringify then parse round-trips 500 generated rows with commas, quotes, newlines, unicode and empty strings', () => {
  const seed = (Date.now() ^ (Math.random() * 2 ** 31)) >>> 0
  const rand = rng(seed)
  const pieces = [',', '"', '""', '\n', '\r\n', '\r', ' ', 'Brisbane', 'Zoë', '日本語', '🦘', 'naïve café', '\t', "O'Neil", '1,234.50', '=SUM(A1)', '']
  const pick = (a) => a[Math.floor(rand() * a.length)]
  const cols = 3 + Math.floor(rand() * 6)
  const rows = Array.from({ length: 500 }, () => Array.from({ length: cols }, () => {
    if (rand() < 0.15) return ''
    let s = ''
    const len = 1 + Math.floor(rand() * 6)
    for (let k = 0; k < len; k++) s += rand() < 0.5 ? pick(pieces) : String.fromCodePoint(32 + Math.floor(rand() * 0x2fff))
    return s
  }))
  const kinds = { comma: 0, quote: 0, newline: 0, unicode: 0, empty: 0 }
  for (const r of rows) for (const c of r) {
    if (c.includes(',')) kinds.comma++
    if (c.includes('"')) kinds.quote++
    if (/[\r\n]/.test(c)) kinds.newline++
    if (/[^\x00-\x7f]/.test(c)) kinds.unicode++
    if (c === '') kinds.empty++
  }
  for (const [k, n] of Object.entries(kinds)) assert.ok(n > 0, `generator produced no ${k} cells (seed ${seed})`)
  for (const bom of [false, true]) {
    const text = stringify(rows, { bom })
    assert.deepEqual(parse(text), rows, `round trip failed (seed ${seed}, bom ${bom})`)
  }
  assert.deepEqual(parse(stringify(rows, { eol: '\n' })), rows, `LF round trip failed (seed ${seed})`)
})
