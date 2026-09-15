// Values, errors, coercion, A1 helpers, Excel 1900 date serials and literal input parsing.

export const MAX_ROW = 1048576;
export const MAX_COL = 16384;

const ERROR_CODES = ['#DIV/0!', '#REF!', '#NAME?', '#VALUE!', '#N/A', '#NUM!', '#CYCLE!'];
const ERRORS = Object.fromEntries(ERROR_CODES.map((code) => [code, Object.freeze({ error: code })]));

/** Shared frozen error object for a code, e.g. err('#N/A'). */
export function err(code) {
  return ERRORS[code] || Object.freeze({ error: code });
}
export const E = {
  DIV0: ERRORS['#DIV/0!'], REF: ERRORS['#REF!'], NAME: ERRORS['#NAME?'], VALUE: ERRORS['#VALUE!'],
  NA: ERRORS['#N/A'], NUM: ERRORS['#NUM!'], CYCLE: ERRORS['#CYCLE!'],
};
export const ERROR_LITERALS = ERROR_CODES;

export function isError(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.error === 'string';
}

export function sameValue(a, b) {
  if (a === b) return true;
  if (isError(a) && isError(b)) return a.error === b.error;
  return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
}

// ---------- A1 helpers ----------
export function colToLetters(col) {
  let s = '';
  let n = col + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
export function lettersToCol(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function toA1(row, col) {
  return colToLetters(col) + (row + 1);
}
export function fromA1(a1) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a1).trim());
  if (!m) return null;
  return { row: Number(m[2]) - 1, col: lettersToCol(m[1]) };
}

// ---------- Dates (Excel 1900 system, with the fake 29/02/1900) ----------
const DAY_MS = 86400000;
const EPOCH_AFTER = Date.UTC(1899, 11, 30); // serial 61 = 01/03/1900
const EPOCH_BEFORE = Date.UTC(1899, 11, 31); // serial 1 = 01/01/1900

/** Serial for a (possibly overflowing) year/month(1-12)/day, like DATE(). */
export function dateToSerial(y, m, d) {
  if (y === 1900 && m === 2 && d === 29) return 60;
  const ms = Date.UTC(y, m - 1, d); // callers pass years >= 1900
  return ms >= Date.UTC(1900, 2, 1) ? Math.round((ms - EPOCH_AFTER) / DAY_MS) : Math.round((ms - EPOCH_BEFORE) / DAY_MS);
}

/** { y, m (1-12), d, wd (0=Sun), hh, mi, ss } for a serial. */
export function serialToParts(serial) {
  let day = Math.floor(serial);
  let secs = Math.round((serial - day) * 86400);
  if (secs >= 86400) { day += 1; secs -= 86400; }
  const hh = Math.floor(secs / 3600), mi = Math.floor((secs % 3600) / 60), ss = secs % 60;
  if (day === 60) return { y: 1900, m: 2, d: 29, wd: 3, hh, mi, ss };
  const ms = day < 60 ? EPOCH_BEFORE + day * DAY_MS : EPOCH_AFTER + day * DAY_MS;
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay(), hh, mi, ss };
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ---------- Literal parsing ----------
const NUM_RE = /^([+-])?(\$)?([+-])?(\d{1,3}(?:,\d{3})+|\d+|(?=\.\d))(\.\d*)?(?:[eE]([+-]?\d+))?(%)?$/;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

function buildDate(y, m, d, hh, mi, ss, ampm) {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m) || y < 1900 || y > 9999) return undefined;
  let h = hh ? Number(hh) : 0;
  if (ampm) {
    if (h < 1 || h > 12) return undefined;
    const pm = /p/i.test(ampm);
    h = (h % 12) + (pm ? 12 : 0);
  }
  const min = mi ? Number(mi) : 0, sec = ss ? Number(ss) : 0;
  if (h > 23 || min > 59 || sec > 59) return undefined;
  const hasTime = hh !== undefined;
  return { value: dateToSerial(y, m, d) + (h * 3600 + min * 60 + sec) / 86400, format: hasTime ? 'datetime' : 'date' };
}

/** Parse trimmed text that looks like a number/boolean/date. Returns { value, format? } or undefined. */
export function parseScalarText(text) {
  const s = text.trim();
  if (!s) return undefined;
  const up = s.toUpperCase();
  if (up === 'TRUE') return { value: true };
  if (up === 'FALSE') return { value: false };
  let m = NUM_RE.exec(s);
  if (m && (m[1] === undefined || m[3] === undefined) && (m[4] || m[5]?.length > 1)) {
    const sign = m[1] === '-' || m[3] === '-' ? -1 : 1;
    let n = sign * Number((m[4] || '0').replace(/,/g, '') + (m[5] && m[5] !== '.' ? m[5] : '') + (m[6] ? 'e' + m[6] : ''));
    if (m[3] !== undefined && !m[2]) return undefined; // "+-5"
    if (m[7]) n /= 100;
    if (!Number.isFinite(n)) return undefined;
    return { value: n, format: m[7] ? 'percent' : m[2] ? 'currency' : undefined };
  }
  m = DATE_RE.exec(s);
  if (m) {
    let y = Number(m[3]);
    if (m[3].length === 2) y += y < 30 ? 2000 : 1900;
    return buildDate(y, Number(m[2]), Number(m[1]), m[4], m[5], m[6], m[7]);
  }
  m = ISO_RE.exec(s);
  if (m) return buildDate(Number(m[1]), Number(m[2]), Number(m[3]), m[4], m[5], m[6]);
  return undefined;
}

/**
 * Parse raw (non-formula) cell input like Excel with Australian conventions.
 * Returns { value, format? }: "14/05/2026" -> date serial, "1,234.5" -> number, "50%" -> 0.5,
 * "TRUE" -> true, "'007" -> text "007", anything else -> text.
 */
export function parseLiteral(raw) {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw === 'number') return { value: Number.isFinite(raw) ? raw : E.NUM };
  if (typeof raw === 'boolean') return { value: raw };
  const s = String(raw);
  if (s === '') return { value: null };
  if (s[0] === "'") return { value: s.slice(1), format: 'text' };
  return parseScalarText(s) || { value: s };
}

// ---------- Coercion (throw error objects; the function-call wrapper turns them into values) ----------
export function toNumber(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const p = parseScalarText(v);
    if (p && typeof p.value === 'number') return p.value;
    throw E.VALUE;
  }
  if (isError(v)) throw v;
  throw E.VALUE;
}

export function formatGeneralNumber(n) {
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const s = String(Number(n.toPrecision(15)));
  return s.replace('e', 'E');
}

export function toText(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatGeneralNumber(v);
  if (isError(v)) throw v;
  throw E.VALUE;
}

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const u = v.trim().toUpperCase();
    if (u === 'TRUE') return true;
    if (u === 'FALSE') return false;
    throw E.VALUE;
  }
  if (isError(v)) throw v;
  throw E.VALUE;
}

const RANK = { number: 0, string: 1, boolean: 2 };
/** Excel comparison: numbers < text < booleans, text case-insensitive. Returns -1/0/1. */
export function compareValues(a, b) {
  if (a === null || a === undefined) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null || b === undefined) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = RANK[typeof a], rb = RANK[typeof b];
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'string') {
    a = a.toLowerCase();
    b = b.toLowerCase();
  } else if (typeof a === 'number' && a !== b && Math.abs(a - b) <= 1e-15 * Math.max(Math.abs(a), Math.abs(b))) {
    return 0; // Excel compares numbers at 15 significant digits: 0.1+0.2=0.3 is TRUE
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
