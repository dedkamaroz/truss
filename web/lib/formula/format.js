// Display formatting (named formats) and Excel-style TEXT() format strings.
import { isError, serialToParts, formatGeneralNumber, toText, parseScalarText, E } from './values.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Round half away from zero at `digits` decimals, correcting binary float noise (ROUND semantics). */
export function roundHalfAway(n, digits = 0) {
  const scaled = Number((Math.abs(n) * 10 ** digits).toPrecision(15));
  const r = Math.round(scaled);
  const v = digits >= 0 ? r / 10 ** digits : r * 10 ** -digits;
  return n < 0 ? -v : v;
}

function groupThousands(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatFixed(n, decimals, thousands) {
  const r = roundHalfAway(n, decimals);
  let [ip, dp] = Math.abs(r).toFixed(decimals).split('.');
  if (thousands) ip = groupThousands(ip);
  return (r < 0 ? '-' : '') + ip + (dp ? '.' + dp : '');
}

function formatDateParts(p, withTime) {
  let s = `${pad(p.d)}/${pad(p.m)}/${p.y}`;
  if (withTime) {
    const h12 = p.hh % 12 || 12;
    s += ` ${h12}:${pad(p.mi)} ${p.hh < 12 ? 'am' : 'pm'}`;
  }
  return s;
}

/**
 * Format a value for display. format: 'general' | 'number' | 'currency' | 'percent' | 'date' | 'datetime' | 'text',
 * an object { type, decimals?, thousands? }, or any other string which is treated as a TEXT() pattern.
 */
export function formatValue(value, format) {
  if (value === null || value === undefined) return '';
  if (isError(value)) return value.error;
  const spec = typeof format === 'string' || !format ? { type: format || 'general' } : format;
  const type = spec.type || 'general';
  if (typeof value !== 'number' || type === 'text' || type === 'general') return toText(value);
  switch (type) {
    case 'number': return formatFixed(value, spec.decimals ?? 2, spec.thousands ?? true);
    case 'currency': {
      const s = formatFixed(Math.abs(value), spec.decimals ?? 2, true);
      return (roundHalfAway(value, spec.decimals ?? 2) < 0 ? '-$' : '$') + s;
    }
    case 'percent': {
      if (spec.decimals !== undefined) return formatFixed(value * 100, spec.decimals, true) + '%';
      return formatGeneralNumber(roundHalfAway(value * 100, 2)) + '%';
    }
    case 'date':
    case 'datetime':
      if (value < 0 || value >= 2958466) return formatGeneralNumber(value);
      return formatDateParts(serialToParts(value), type === 'datetime');
  }
  try {
    return formatText(value, type);
  } catch {
    return formatGeneralNumber(value);
  }
}

// ---------- TEXT() format strings ----------
function tokenizeFormat(section) {
  const items = [];
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') {
      const j = section.indexOf('"', i + 1);
      const end = j < 0 ? section.length : j;
      items.push({ lit: section.slice(i + 1, end) });
      i = end;
    } else if (ch === '\\') {
      items.push({ lit: section[++i] ?? '' });
    } else if (ch === '_') {
      i++;
      items.push({ lit: ' ' });
    } else if (ch === '*') {
      i++;
    } else if (ch === '[') {
      const j = section.indexOf(']', i);
      i = j < 0 ? section.length : j; // ponytail: colours/conditions ignored
    } else if (/am\/pm/i.test(section.substr(i, 5))) {
      items.push({ ampm: section.substr(i, 5) });
      i += 4;
    } else if (/a\/p/i.test(section.substr(i, 3))) {
      items.push({ ampm: section.substr(i, 3) });
      i += 2;
    } else if (/[ymdhs]/i.test(ch)) {
      let j = i;
      while (j < section.length && section[j].toLowerCase() === ch.toLowerCase()) j++;
      items.push({ date: ch.toLowerCase(), len: j - i });
      i = j - 1;
    } else {
      items.push({ code: ch });
    }
  }
  return items;
}

function splitSections(fmt) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') q = !q;
    if (ch === '\\' && !q) { cur += ch + (fmt[++i] ?? ''); continue; }
    if (ch === ';' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function renderDate(n, items) {
  const p = serialToParts(n);
  const has12 = items.some((it) => it.ampm);
  let out = '';
  items.forEach((it, idx) => {
    if (it.lit !== undefined) out += it.lit;
    else if (it.code !== undefined) out += it.code;
    else if (it.ampm) {
      const pm = p.hh >= 12;
      const txt = it.ampm.length === 5 ? (pm ? 'PM' : 'AM') : pm ? 'P' : 'A';
      out += it.ampm[0] === it.ampm[0].toLowerCase() ? txt.toLowerCase() : txt;
    } else {
      const { date: k, len } = it;
      if (k === 'y') out += len <= 2 ? pad(p.y % 100) : String(p.y);
      else if (k === 'd') out += len === 1 ? p.d : len === 2 ? pad(p.d) : len === 3 ? DAYS[p.wd].slice(0, 3) : DAYS[p.wd];
      else if (k === 'h') out += len === 1 ? (has12 ? p.hh % 12 || 12 : p.hh) : pad(has12 ? p.hh % 12 || 12 : p.hh);
      else if (k === 's') out += len === 1 ? p.ss : pad(p.ss);
      else if (k === 'm') {
        const prev = items.slice(0, idx).reverse().find((x) => x.date);
        const next = items.slice(idx + 1).find((x) => x.date);
        const minutes = len <= 2 && ((prev && prev.date === 'h') || (next && next.date === 's'));
        if (minutes) out += len === 1 ? p.mi : pad(p.mi);
        else out += len === 1 ? p.m : len === 2 ? pad(p.m) : len === 3 ? MONTHS[p.m - 1].slice(0, 3) : MONTHS[p.m - 1];
      }
    }
  });
  return out;
}

function renderNumber(n, items) {
  const isDigit = (it) => it.code !== undefined && '0#?'.includes(it.code);
  const first = items.findIndex(isDigit);
  let last = -1;
  items.forEach((it, i) => { if (isDigit(it)) last = i; });
  const lit = (it) => (it.lit !== undefined ? it.lit : it.code !== undefined ? it.code : '');
  const percents = items.filter((it) => it.code === '%').length;
  n *= 100 ** percents;
  if (first < 0) return items.map(lit).join('');
  let end = last + 1;
  if (items[end] && items[end].code === '.') end++;
  while (items[end] && items[end].code === ',') { n /= 1000; end++; }
  const region = items.slice(first, end).map((it) => it.code ?? '');
  const dot = region.indexOf('.');
  const intPat = dot < 0 ? region : region.slice(0, dot);
  const decPat = dot < 0 ? [] : region.slice(dot + 1).filter((c) => '0#?'.includes(c));
  const decMax = decPat.length;
  const decMin = decPat.lastIndexOf('0') + 1;
  const intMin = intPat.filter((c) => c === '0' || c === '?').length;
  const r = roundHalfAway(n, decMax);
  let [ip, dp = ''] = Math.abs(r).toFixed(decMax).split('.');
  while (dp.length > decMin && dp.endsWith('0')) dp = dp.slice(0, -1);
  if (ip === '0' && intMin === 0) ip = '';
  ip = ip.padStart(intMin, '0');
  if (intPat.includes(',')) ip = groupThousands(ip);
  const numStr = ip + (dot >= 0 ? '.' + dp : '');
  return items.slice(0, first).map(lit).join('') + numStr + items.slice(end).map(lit).join('');
}

/** Excel TEXT(value, format_text). Throws #VALUE! for unusable input. */
export function formatText(value, fmt) {
  if (isError(value)) throw value;
  fmt = String(fmt);
  const sections = splitSections(fmt);
  let n = value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value === null) n = 0;
  if (typeof value === 'string') {
    const p = parseScalarText(value);
    if (!p || typeof p.value !== 'number') {
      const textSec = sections[3] ?? (sections.length === 1 && sections[0].includes('@') ? sections[0] : null);
      return textSec === null ? value : tokenizeFormat(textSec).map((it) => (it.code === '@' ? value : it.lit ?? it.code ?? '')).join('');
    }
    n = p.value;
  }
  if (/^general$/i.test(fmt.trim())) return formatGeneralNumber(n);
  let section = sections[0], neg = false;
  if (n < 0 && sections.length >= 2 && sections[1] !== '') { section = sections[1]; n = -n; }
  else if (n === 0 && sections.length >= 3 && sections[2] !== '') section = sections[2];
  else if (n < 0) neg = true;
  const items = tokenizeFormat(section);
  if (items.some((it) => it.date || it.ampm)) {
    if (n < 0) throw E.VALUE;
    return renderDate(n, items);
  }
  const out = renderNumber(neg ? -n : n, items);
  return neg && /[1-9]/.test(out) ? '-' + out : out;
}
