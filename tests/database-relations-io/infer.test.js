import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferType, parseNumber, parseDate, readCsv, planColumns, buildDocument, CONVERT } from '../../web/modules/database/infer.js'
import { CsvError } from '../../web/lib/csv.js'

test('inferType detects number, checkbox, date, select, url, email and text', () => {
  assert.deepEqual(inferType(['1', '2.5', '-3']), { type: 'number', format: 'number' })
  assert.deepEqual(inferType(['$1,250.50', '$3']), { type: 'number', format: 'aud' })
  assert.deepEqual(inferType(['1,000', '25']), { type: 'number', format: 'number_with_commas' })
  assert.deepEqual(inferType(['50%', '12.5%']), { type: 'number', format: 'percent' })
  assert.equal(inferType(['TRUE', 'false', 'Yes']).type, 'checkbox')
  assert.equal(inferType(['14/05/2026', '1/2/2027', '2026-03-04']).type, 'date')
  assert.equal(inferType(['31/02/2026']).type, 'text', 'impossible dates are not dates')
  assert.equal(inferType(['https://a.com', 'http://b.org/x?y=1']).type, 'url')
  assert.equal(inferType(['a@b.co', 'ops@example.com.au']).type, 'email')
  assert.equal(inferType(['Won', 'Lead', 'Won', 'Lost']).type, 'select')
  assert.equal(inferType(['Alpha', 'Beta', 'Gamma']).type, 'text', 'all distinct values stay text')
  assert.equal(inferType(['0412 345 678', '0400111222']).type, 'text', 'leading zeros are not numbers')
  assert.equal(inferType([]).type, 'text')
})

test('cell converters', () => {
  assert.equal(parseNumber(' $1,234.50 '), 1234.5)
  assert.equal(parseNumber('12%'), 12)
  assert.equal(parseNumber('1,2'), null)
  assert.equal(parseDate('9/3/2026'), '2026-03-09')
  assert.equal(parseDate('2026-03-09T10:00:00Z'), '2026-03-09')
  assert.equal(parseDate('2026-13-01'), null)
  assert.equal(CONVERT.checkbox('TRUE'), true)
  assert.equal(CONVERT.checkbox('no'), undefined)
  assert.equal(CONVERT.url('ftp://x'), undefined)
  assert.equal(CONVERT.email('not an email'), undefined)
})

test('readCsv handles BOM, CRLF, semicolons, ragged rows and duplicate headers; rejects junk', () => {
  const { headers, rows, delimiter } = readCsv('\uFEFFName;Qty;Qty\r\nA;1\r\n\r\nB;2;3;4\r\n')
  assert.equal(delimiter, ';')
  assert.deepEqual(headers, ['Name', 'Qty', 'Qty 2'])
  assert.deepEqual(rows, [['A', '1', ''], ['B', '2', '3']])
  assert.throws(() => readCsv('a,b\r\n'), CsvError)
  assert.throws(() => readCsv(''), CsvError)
  assert.throws(() => readCsv('PNG\u0000\u0001'), CsvError)
  assert.throws(() => readCsv('a\n"b'), CsvError)
})

test('planColumns and buildDocument produce a Truss document with options and typed values', () => {
  const parsed = readCsv('Client,Stage,Fee,Tags\nAcme,Won,$10,"x, y"\nBeta,Lead,,y\nGum,Won,$5.50,\n')
  const cols = planColumns(parsed)
  assert.deepEqual(cols.map((c) => c.type), ['title', 'select', 'number', 'text'])
  cols[3].type = 'multi_select'
  const doc = buildDocument({ title: 'T', rows: parsed.rows, columns: cols })
  assert.equal(doc.truss, 1)
  const [title, stage, fee, tags] = doc.database.properties
  assert.deepEqual(stage.config.options.map((o) => o.name), ['Won', 'Lead'])
  assert.deepEqual(tags.config.options.map((o) => o.name), ['x', 'y'])
  assert.deepEqual(fee.config, { format: 'aud' })
  assert.deepEqual(doc.database.rows[0].values, { [title.id]: 'Acme', [stage.id]: stage.config.options[0].id, [fee.id]: 10, [tags.id]: tags.config.options.map((o) => o.id) })
  assert.deepEqual(doc.database.rows[1].values, { [title.id]: 'Beta', [stage.id]: stage.config.options[1].id, [tags.id]: [tags.config.options[1].id] })
  cols[2].type = 'skip'
  assert.equal(buildDocument({ title: 'T', rows: parsed.rows, columns: cols }).database.properties.length, 3)
})
