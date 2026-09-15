// RFC 4180 CSV parse and stringify. Pure ES module (browser and Node).
// Handles quoted fields, escaped quotes, embedded delimiters and CR/LF/CRLF newlines, and a UTF-8 BOM.

export class CsvError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CsvError'
  }
}

const lineAt = (text, index) => {
  let line = 1
  for (let i = text.indexOf('\n'); i >= 0 && i < index; i = text.indexOf('\n', i + 1)) line++
  return line
}

/**
 * parse(text, { delimiter }) -> string[][]
 * Throws CsvError for an unterminated quoted field or text after a closing quote.
 * A final line break does not create an extra row; empty fields are kept.
 */
export function parse(text, { delimiter = ',' } = {}) {
  if (typeof text !== 'string') throw new CsvError('CSV input must be text')
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') throw new CsvError('Invalid delimiter')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  const rows = []
  const n = text.length
  if (!n) return rows
  const dc = delimiter.charCodeAt(0)
  let row = []
  let i = 0
  for (;;) {
    let field
    if (text.charCodeAt(i) === 34) {
      const start = i
      let j = i + 1
      field = ''
      for (;;) {
        const q = text.indexOf('"', j)
        if (q < 0) throw new CsvError(`Unterminated quoted field starting on line ${lineAt(text, start)}`)
        field += text.slice(j, q)
        if (text.charCodeAt(q + 1) === 34) {
          field += '"'
          j = q + 2
          continue
        }
        i = q + 1
        break
      }
      const c = text.charCodeAt(i)
      if (i < n && c !== dc && c !== 10 && c !== 13) throw new CsvError(`Unexpected text after a closing quote on line ${lineAt(text, i)}`)
    } else {
      let j = i
      while (j < n) {
        const c = text.charCodeAt(j)
        if (c === dc || c === 10 || c === 13) break
        j++
      }
      field = text.slice(i, j)
      i = j
    }
    row.push(field)
    if (i >= n) {
      rows.push(row)
      break
    }
    const c = text.charCodeAt(i)
    if (c === dc) {
      i++
      if (i >= n) {
        row.push('')
        rows.push(row)
        break
      }
      continue
    }
    i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1
    rows.push(row)
    row = []
    if (i >= n) break
  }
  return rows
}

/**
 * stringify(rows, { delimiter, eol, bom }) -> string. Every row ends with eol (CRLF by default).
 * null/undefined cells become empty fields. A row holding one empty field is written as "" so it survives a parse.
 */
export function stringify(rows, { delimiter = ',', eol = '\r\n', bom = false } = {}) {
  const special = new RegExp(`["\\r\\n${delimiter.replace(/[\\\]^-]/g, '\\$&')}]`)
  const parts = bom ? ['\uFEFF'] : []
  for (const row of rows) {
    const cells = row.map((cell) => {
      const s = cell == null ? '' : String(cell)
      return special.test(s) || (row.length === 1 && s === '') ? `"${s.replace(/"/g, '""')}"` : s
    })
    parts.push(cells.join(delimiter), eol)
  }
  return parts.join('')
}

/**
 * Formula-injection guard for CSV opened in a spreadsheet: a cell starting with = + - @ tab or CR
 * gets a leading single quote so Excel treats it as text. Plain numbers (-5, +1.5, -1,200.50) are left alone.
 */
export function neutraliseFormula(cell) {
  const s = cell == null ? '' : String(cell)
  return /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d[\d,]*(\.\d+)?$/.test(s) ? `'${s}` : s
}

export default { parse, stringify, neutraliseFormula, CsvError }
