// Function registry and built-in functions.
// Implementations receive evaluated arguments: scalars, or 2D arrays for ranges. They may throw an error
// object (e.g. E.VALUE); the call wrapper turns that into the cell value.
import {
  E, isError, toNumber, toText, toBool, compareValues, parseScalarText,
  dateToSerial, serialToParts, daysInMonth,
} from './values.js';
import { roundHalfAway, formatText } from './format.js';

const registry = new Map();

/**
 * Register (or replace) a function usable in formulas.
 * meta: { minArgs, maxArgs, description, signature, lazy?, acceptErrors?, volatile? }
 * lazy: arguments arrive as thunks; acceptErrors: error arguments are passed through instead of short-circuiting.
 */
export function registerFunction(name, impl, meta = {}) {
  if (typeof impl !== 'function') throw new TypeError('registerFunction: impl must be a function');
  const key = String(name).toUpperCase();
  registry.set(key, { name: key, impl, meta: { minArgs: 0, maxArgs: Infinity, description: '', signature: `${key}()`, ...meta } });
}

export function getFunction(name) {
  return registry.get(name);
}

/** [{ name, description, signature, minArgs, maxArgs, volatile }] sorted by name, for autocomplete. */
export function listFunctions() {
  return [...registry.values()]
    .map(({ name, meta }) => ({ name, description: meta.description, signature: meta.signature, minArgs: meta.minArgs, maxArgs: meta.maxArgs, volatile: !!meta.volatile }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function isVolatile(name) {
  const f = registry.get(name);
  return !!(f && f.meta.volatile);
}

// ---------- argument helpers ----------
const scalar = (v) => {
  if (Array.isArray(v)) {
    if (v.length === 1 && v[0].length === 1) v = v[0][0];
    else throw E.VALUE;
  }
  if (isError(v)) throw v;
  return v;
};
const num = (v) => toNumber(scalar(v));
const int = (v) => Math.trunc(num(v));
const str = (v) => toText(scalar(v));
const bool = (v) => toBool(scalar(v));
const opt = (v, def, conv) => (v === undefined || v === null ? def : conv(v));
const grid = (v) => (Array.isArray(v) ? v : [[v]]);
const flatGrid = (v) => grid(v).flat();

/** Numbers per SUM rules: in ranges only numbers count (errors propagate); direct args are coerced. */
function numbers(args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const row of a) for (const v of row) {
        if (typeof v === 'number') out.push(v);
        else if (isError(v)) throw v;
      }
    } else if (a !== null) out.push(toNumber(a));
  }
  return out;
}

const sum = (ns) => ns.reduce((s, n) => s + n, 0);

function def(name, signature, description, minArgs, maxArgs, impl, extra = {}) {
  registerFunction(name, impl, { minArgs, maxArgs, signature: `${name}(${signature})`, description, ...extra });
}
const INF = Infinity;

// ---------- criteria ----------
function wildcardRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '~' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (ch === '*') re += '[\\s\\S]*';
    else if (ch === '?') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function makeCriteria(c) {
  c = scalar(c);
  if (typeof c === 'number') return (v) => v === c || (typeof v === 'string' && parseScalarText(v)?.value === c);
  if (typeof c === 'boolean') return (v) => v === c;
  if (c === null) c = '';
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(c);
  const op = m[1] || '=';
  const rhs = m[2];
  if (rhs === '') {
    if (op === '=') return (v) => v === null || v === '';
    if (op === '<>') return (v) => v !== null && v !== '';
    return () => false;
  }
  const lit = parseScalarText(rhs);
  const cmp = (c2) => (op === '=' ? c2 === 0 : op === '<>' ? c2 !== 0 : op === '<' ? c2 < 0 : op === '<=' ? c2 <= 0 : op === '>' ? c2 > 0 : c2 >= 0);
  if (lit && typeof lit.value === 'number') {
    const target = lit.value;
    return (v) => {
      if (typeof v === 'string') { const p = parseScalarText(v); if (p && typeof p.value === 'number' && (op === '=' || op === '<>')) v = p.value; }
      if (typeof v !== 'number') return op === '<>';
      return cmp(v < target ? -1 : v > target ? 1 : 0);
    };
  }
  if (lit && typeof lit.value === 'boolean') return (v) => (typeof v === 'boolean' ? cmp(v === lit.value ? 0 : 1) : op === '<>');
  if (op === '=' || op === '<>') {
    const re = wildcardRegex(rhs);
    return (v) => {
      const hit = typeof v === 'string' && re.test(v);
      return op === '=' ? hit : !hit;
    };
  }
  return (v) => typeof v === 'string' && cmp(compareValues(v, rhs));
}

/** Indices (flat) matching all (range, criteria) pairs; ranges must share a shape. */
function matchIndices(pairs, shape) {
  const [rows, cols] = shape;
  const tests = pairs.map(([range, crit]) => {
    const g = grid(range);
    if (g.length !== rows || g[0].length !== cols) throw E.VALUE;
    return [g, makeCriteria(crit)];
  });
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (tests.every(([g, t]) => t(g[r][c]))) out.push([r, c]);
  }
  return out;
}

function pairsFrom(args, start) {
  if ((args.length - start) % 2 !== 0) throw E.VALUE;
  const pairs = [];
  for (let i = start; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  return pairs;
}

const shapeOf = (v) => [grid(v).length, grid(v)[0].length];

function valuesAt(range, idx) {
  const g = grid(range);
  const out = [];
  for (const [r, c] of idx) {
    const v = g[r] && g[r][c];
    if (typeof v === 'number') out.push(v);
    else if (isError(v)) throw v;
  }
  return out;
}

// ---------- lookup helpers ----------
function looseEqual(a, b, wildcard) {
  if (wildcard && typeof a === 'string' && typeof b === 'string' && /[*?~]/.test(a)) return wildcardRegex(a).test(b);
  if (b === null) return false;
  return typeof a === typeof b && compareValues(a, b) === 0;
}

/** Position in a 1D list: mode 0 exact (wildcards), 1 largest <= (sorted asc), -1 smallest >= (sorted desc). */
function findIndex(list, needle, mode) {
  if (mode === 0) return list.findIndex((v) => looseEqual(needle, v, true));
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    if (v === null || typeof v !== typeof needle) continue;
    const c = compareValues(v, needle);
    if (mode === 1 ? c <= 0 : c >= 0) best = i;
    else break;
  }
  return best;
}

// ================= Maths and statistics =================
def('SUM', 'number1, [number2], ...', 'Adds all numbers in the arguments.', 1, INF, (...a) => sum(numbers(a)));
def('AVERAGE', 'number1, [number2], ...', 'Arithmetic mean of the numbers.', 1, INF, (...a) => {
  const ns = numbers(a);
  if (!ns.length) throw E.DIV0;
  return sum(ns) / ns.length;
});
def('MIN', 'number1, [number2], ...', 'Smallest number (0 if none).', 1, INF, (...a) => { const ns = numbers(a); return ns.length ? Math.min(...ns) : 0; });
def('MAX', 'number1, [number2], ...', 'Largest number (0 if none).', 1, INF, (...a) => { const ns = numbers(a); return ns.length ? Math.max(...ns) : 0; });
def('COUNT', 'value1, [value2], ...', 'Counts cells containing numbers.', 1, INF, (...a) => {
  let n = 0;
  for (const x of a) {
    if (Array.isArray(x)) { for (const row of x) for (const v of row) if (typeof v === 'number') n++; }
    else if (typeof x === 'number' || typeof x === 'boolean' || (typeof x === 'string' && typeof parseScalarText(x)?.value === 'number')) n++;
  }
  return n;
}, { acceptErrors: true });
def('COUNTA', 'value1, [value2], ...', 'Counts non-empty values.', 1, INF, (...a) => {
  let n = 0;
  for (const x of a) for (const v of flatGrid(x)) if (v !== null) n++;
  return n;
}, { acceptErrors: true });
def('COUNTBLANK', 'range', 'Counts empty cells.', 1, 1, (r) => flatGrid(r).filter((v) => v === null || v === '').length, { acceptErrors: true });
def('PRODUCT', 'number1, [number2], ...', 'Multiplies the numbers.', 1, INF, (...a) => { const ns = numbers(a); return ns.length ? ns.reduce((p, n) => p * n, 1) : 0; });
def('MEDIAN', 'number1, [number2], ...', 'Middle value of the numbers.', 1, INF, (...a) => {
  const ns = numbers(a).sort((x, y) => x - y);
  if (!ns.length) throw E.NUM;
  const mid = ns.length >> 1;
  return ns.length % 2 ? ns[mid] : (ns[mid - 1] + ns[mid]) / 2;
});
def('STDEV', 'number1, [number2], ...', 'Sample standard deviation.', 1, INF, (...a) => {
  const ns = numbers(a);
  if (ns.length < 2) throw E.DIV0;
  const mean = sum(ns) / ns.length;
  return Math.sqrt(ns.reduce((s, n) => s + (n - mean) ** 2, 0) / (ns.length - 1));
});
def('ROUND', 'number, num_digits', 'Rounds half away from zero.', 1, 2, (n, d) => roundHalfAway(num(n), opt(d, 0, int)));
function roundWith(fn, n, d) {
  const x = num(n), k = opt(d, 0, int);
  const r = fn(Number((Math.abs(x) * 10 ** k).toPrecision(15)));
  const v = k >= 0 ? r / 10 ** k : r * 10 ** -k;
  return x < 0 ? -v : v;
}
def('ROUNDUP', 'number, num_digits', 'Rounds away from zero.', 1, 2, (n, d) => roundWith(Math.ceil, n, d));
def('ROUNDDOWN', 'number, num_digits', 'Rounds towards zero.', 1, 2, (n, d) => roundWith(Math.floor, n, d));
def('INT', 'number', 'Rounds down to the nearest integer.', 1, 1, (n) => Math.floor(num(n)));
def('ABS', 'number', 'Absolute value.', 1, 1, (n) => Math.abs(num(n)));
def('SQRT', 'number', 'Square root.', 1, 1, (n) => { const x = num(n); if (x < 0) throw E.NUM; return Math.sqrt(x); });
def('POWER', 'number, power', 'Raises a number to a power.', 2, 2, (a, b) => {
  const x = num(a), y = num(b);
  if (x === 0 && y < 0) throw E.DIV0;
  const r = x ** y;
  if (Number.isNaN(r)) throw E.NUM;
  return r;
});
def('MOD', 'number, divisor', 'Remainder with the sign of the divisor.', 2, 2, (a, b) => {
  const x = num(a), y = num(b);
  if (y === 0) throw E.DIV0;
  return x - y * Math.floor(x / y);
});
def('CEILING', 'number, significance', 'Rounds up to a multiple of significance.', 1, 2, (a, b) => {
  const x = num(a), s = opt(b, 1, num);
  if (s === 0) return 0;
  if (x > 0 && s < 0) throw E.NUM;
  return Math.ceil(Number((x / s).toPrecision(15))) * s;
});
def('FLOOR', 'number, significance', 'Rounds down to a multiple of significance.', 1, 2, (a, b) => {
  const x = num(a), s = opt(b, 1, num);
  if (s === 0) { if (x === 0) return 0; throw E.DIV0; }
  if (x > 0 && s < 0) throw E.NUM;
  return Math.floor(Number((x / s).toPrecision(15))) * s;
});
def('RAND', '', 'Random number between 0 and 1 (volatile).', 0, 0, () => Math.random(), { volatile: true });
def('RANDBETWEEN', 'bottom, top', 'Random integer between bottom and top (volatile).', 2, 2, (a, b) => {
  const lo = Math.ceil(num(a)), hi = Math.floor(num(b));
  if (lo > hi) throw E.NUM;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}, { volatile: true });

// ================= Logic =================
def('IF', 'logical_test, [value_if_true], [value_if_false]', 'Returns one value if a condition is TRUE and another if FALSE.', 1, 3, (t, a, b) => {
  const c = bool(t());
  if (c) return a ? a() : true;
  return b ? b() : false;
}, { lazy: true });
def('IFS', 'test1, value1, [test2, value2], ...', 'Value for the first TRUE condition.', 2, INF, (...a) => {
  if (a.length % 2) throw E.VALUE;
  for (let i = 0; i < a.length; i += 2) if (bool(a[i]())) return a[i + 1]();
  throw E.NA;
}, { lazy: true });
def('IFERROR', 'value, value_if_error', 'Returns value_if_error if value is an error.', 2, 2, (v, alt) => {
  const x = v();
  return isError(x) ? alt() : x;
}, { lazy: true });
def('IFNA', 'value, value_if_na', 'Returns value_if_na if value is #N/A.', 2, 2, (v, alt) => {
  const x = v();
  return isError(x) && x.error === '#N/A' ? alt() : x;
}, { lazy: true });
function logicalValues(args) {
  const out = [];
  for (const a of args) {
    if (Array.isArray(a)) {
      for (const v of a.flat()) {
        if (isError(v)) throw v;
        if (typeof v === 'number' || typeof v === 'boolean') out.push(!!v);
      }
    } else if (a !== null) out.push(toBool(a));
  }
  if (!out.length) throw E.VALUE;
  return out;
}
def('AND', 'logical1, [logical2], ...', 'TRUE if all arguments are TRUE.', 1, INF, (...a) => logicalValues(a).every(Boolean));
def('OR', 'logical1, [logical2], ...', 'TRUE if any argument is TRUE.', 1, INF, (...a) => logicalValues(a).some(Boolean));
def('XOR', 'logical1, [logical2], ...', 'TRUE if an odd number of arguments are TRUE.', 1, INF, (...a) => logicalValues(a).filter(Boolean).length % 2 === 1);
def('NOT', 'logical', 'Reverses a logical value.', 1, 1, (v) => !bool(v));
def('SWITCH', 'expression, value1, result1, [value2, result2], ..., [default]', 'Returns the result matching the expression.', 3, INF, (e, ...rest) => {
  const x = scalar(e());
  for (let i = 0; i + 1 < rest.length; i += 2) {
    const v = scalar(rest[i]());
    if (compareValues(x, v) === 0 && typeof x === typeof v) return rest[i + 1]();
  }
  if (rest.length % 2) return rest[rest.length - 1]();
  throw E.NA;
}, { lazy: true });
def('TRUE', '', 'The logical value TRUE.', 0, 0, () => true);
def('FALSE', '', 'The logical value FALSE.', 0, 0, () => false);

// ================= Conditional aggregation =================
def('SUMIF', 'range, criteria, [sum_range]', 'Sums cells that meet a criteria.', 2, 3, (range, crit, sumRange) => {
  const idx = matchIndices([[range, crit]], shapeOf(range));
  return sum(valuesAt(sumRange ?? range, idx));
});
def('SUMIFS', 'sum_range, criteria_range1, criteria1, ...', 'Sums cells that meet multiple criteria.', 3, INF, (sumRange, ...rest) =>
  sum(valuesAt(sumRange, matchIndices(pairsFrom(rest, 0), shapeOf(sumRange)))));
def('COUNTIF', 'range, criteria', 'Counts cells that meet a criteria.', 2, 2, (range, crit) => matchIndices([[range, crit]], shapeOf(range)).length);
def('COUNTIFS', 'criteria_range1, criteria1, ...', 'Counts cells that meet multiple criteria.', 2, INF, (...a) => matchIndices(pairsFrom(a, 0), shapeOf(a[0])).length);
def('AVERAGEIF', 'range, criteria, [average_range]', 'Averages cells that meet a criteria.', 2, 3, (range, crit, avgRange) => {
  const ns = valuesAt(avgRange ?? range, matchIndices([[range, crit]], shapeOf(range)));
  if (!ns.length) throw E.DIV0;
  return sum(ns) / ns.length;
});
def('AVERAGEIFS', 'average_range, criteria_range1, criteria1, ...', 'Averages cells that meet multiple criteria.', 3, INF, (avgRange, ...rest) => {
  const ns = valuesAt(avgRange, matchIndices(pairsFrom(rest, 0), shapeOf(avgRange)));
  if (!ns.length) throw E.DIV0;
  return sum(ns) / ns.length;
});

// ================= Lookup =================
def('VLOOKUP', 'lookup_value, table_array, col_index_num, [range_lookup]', 'Looks up a value in the first column and returns a value in the same row.', 3, 4, (look, table, col, approx) => {
  const g = grid(table), c = int(col), x = scalar(look);
  if (c < 1) throw E.VALUE;
  if (c > g[0].length) throw E.REF;
  const i = findIndex(g.map((row) => row[0]), x, opt(approx, true, bool) ? 1 : 0);
  if (i < 0) throw E.NA;
  return g[i][c - 1];
});
def('HLOOKUP', 'lookup_value, table_array, row_index_num, [range_lookup]', 'Looks up a value in the first row and returns a value in the same column.', 3, 4, (look, table, row, approx) => {
  const g = grid(table), r = int(row), x = scalar(look);
  if (r < 1) throw E.VALUE;
  if (r > g.length) throw E.REF;
  const i = findIndex(g[0], x, opt(approx, true, bool) ? 1 : 0);
  if (i < 0) throw E.NA;
  return g[r - 1][i];
});
def('MATCH', 'lookup_value, lookup_array, [match_type]', 'Relative position of a value in a range.', 2, 3, (look, arr, type) => {
  const g = grid(arr);
  if (g.length > 1 && g[0].length > 1) throw E.NA;
  const t = opt(type, 1, num);
  const i = findIndex(g.flat(), scalar(look), t > 0 ? 1 : t < 0 ? -1 : 0);
  if (i < 0) throw E.NA;
  return i + 1;
});
def('XLOOKUP', 'lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode]', 'Searches a range and returns the matching item from another range.', 3, 6, (look, arr, ret, notFound, matchMode, searchMode) => {
  const la = grid(arr), ra = grid(ret), x = scalar(look);
  const vertical = la[0].length === 1;
  if (!vertical && la.length !== 1) throw E.VALUE;
  const list = vertical ? la.map((r) => r[0]) : la[0];
  if (vertical ? ra.length !== list.length : ra[0].length !== list.length) throw E.VALUE;
  const mm = opt(matchMode, 0, int), sm = opt(searchMode, 1, int);
  const order = [...list.keys()];
  if (sm < 0) order.reverse();
  let hit = -1, best = -1;
  for (const i of order) {
    const v = list[i];
    if (looseEqual(x, v, mm === 2)) { hit = i; break; }
    if ((mm === -1 || mm === 1) && v !== null && typeof v === typeof x) {
      const c = compareValues(v, x);
      if ((mm === -1 && c < 0 && (best < 0 || compareValues(v, list[best]) > 0)) || (mm === 1 && c > 0 && (best < 0 || compareValues(v, list[best]) < 0))) best = i;
    }
  }
  const i = hit >= 0 ? hit : best;
  if (i < 0) {
    if (notFound !== undefined) return scalar(notFound);
    throw E.NA;
  }
  const picked = vertical ? [ra[i]] : ra.map((row) => [row[i]]);
  return picked.length === 1 && picked[0].length === 1 ? picked[0][0] : picked;
}, { acceptErrors: true });
def('INDEX', 'array, row_num, [column_num]', 'Value at a given row and column of a range.', 2, 3, (arr, row, col) => {
  const g = grid(arr);
  let r = int(row), c = opt(col, null, int);
  if (c === null) {
    if (g.length === 1) { c = r; r = 1; } else c = 1;
  }
  if (r < 0 || c < 0) throw E.VALUE;
  if (r > g.length || c > g[0].length) throw E.REF;
  if (r === 0 && c === 0) return g;
  if (r === 0) return g.map((rowv) => [rowv[c - 1]]);
  if (c === 0) return [g[r - 1]];
  return g[r - 1][c - 1];
});
def('CHOOSE', 'index_num, value1, [value2], ...', 'Chooses a value from a list by index.', 2, INF, (i, ...vals) => {
  const n = int(i());
  if (n < 1 || n > vals.length) throw E.VALUE;
  return vals[n - 1]();
}, { lazy: true });

// ================= Text =================
def('CONCAT', 'text1, [text2], ...', 'Joins text, including ranges.', 1, INF, (...a) => a.map((x) => flatGrid(x).map((v) => { if (isError(v)) throw v; return toText(v); }).join('')).join(''));
def('CONCATENATE', 'text1, [text2], ...', 'Joins text items.', 1, INF, (...a) => a.map(str).join(''));
def('TEXTJOIN', 'delimiter, ignore_empty, text1, [text2], ...', 'Joins text with a delimiter.', 3, INF, (d, ignore, ...a) => {
  const delim = str(d), skip = bool(ignore);
  const parts = [];
  for (const x of a) for (const v of flatGrid(x)) {
    if (isError(v)) throw v;
    const s = toText(v);
    if (!(skip && s === '')) parts.push(s);
  }
  return parts.join(delim);
});
def('LEFT', 'text, [num_chars]', 'Leftmost characters.', 1, 2, (t, n) => { const k = opt(n, 1, int); if (k < 0) throw E.VALUE; return str(t).slice(0, k); });
def('RIGHT', 'text, [num_chars]', 'Rightmost characters.', 1, 2, (t, n) => { const s = str(t), k = opt(n, 1, int); if (k < 0) throw E.VALUE; return k === 0 ? '' : s.slice(-k); });
def('MID', 'text, start_num, num_chars', 'Characters from the middle of text.', 3, 3, (t, s, n) => {
  const st = int(s), k = int(n);
  if (st < 1 || k < 0) throw E.VALUE;
  return str(t).substr(st - 1, k);
});
def('LEN', 'text', 'Number of characters.', 1, 1, (t) => str(t).length);
def('UPPER', 'text', 'Converts to upper case.', 1, 1, (t) => str(t).toUpperCase());
def('LOWER', 'text', 'Converts to lower case.', 1, 1, (t) => str(t).toLowerCase());
def('PROPER', 'text', 'Capitalises the first letter of each word.', 1, 1, (t) => str(t).toLowerCase().replace(/(^|[^a-zÀ-￿])([a-zÀ-￿])/g, (_, p, c) => p + c.toUpperCase()));
def('TRIM', 'text', 'Removes extra spaces.', 1, 1, (t) => str(t).replace(/ +/g, ' ').trim());
def('SUBSTITUTE', 'text, old_text, new_text, [instance_num]', 'Replaces occurrences of old text with new text.', 3, 4, (t, o, nw, inst) => {
  const s = str(t), old = str(o), rep = str(nw);
  if (old === '') return s;
  if (inst === undefined || inst === null) return s.split(old).join(rep);
  const k = int(inst);
  if (k < 1) throw E.VALUE;
  let pos = -1;
  for (let i = 0; i < k; i++) { pos = s.indexOf(old, pos + 1); if (pos < 0) return s; }
  return s.slice(0, pos) + rep + s.slice(pos + old.length);
});
def('REPLACE', 'old_text, start_num, num_chars, new_text', 'Replaces part of text by position.', 4, 4, (t, s, n, nw) => {
  const text = str(t), st = int(s), k = int(n);
  if (st < 1 || k < 0) throw E.VALUE;
  return text.slice(0, st - 1) + str(nw) + text.slice(st - 1 + k);
});
def('FIND', 'find_text, within_text, [start_num]', 'Case-sensitive position of text.', 2, 3, (f, w, s) => {
  const st = opt(s, 1, int), within = str(w);
  if (st < 1 || st > within.length + 1) throw E.VALUE;
  const i = within.indexOf(str(f), st - 1);
  if (i < 0) throw E.VALUE;
  return i + 1;
});
def('SEARCH', 'find_text, within_text, [start_num]', 'Case-insensitive position of text (wildcards allowed).', 2, 3, (f, w, s) => {
  const st = opt(s, 1, int), within = str(w), find = str(f);
  if (st < 1 || st > within.length + 1) throw E.VALUE;
  const src = wildcardRegex(find).source.slice(1, -1);
  const m = new RegExp(src, 'i').exec(within.slice(st - 1));
  if (!m) throw E.VALUE;
  return m.index + st;
});
def('TEXT', 'value, format_text', 'Formats a number as text, e.g. TEXT(A1, "$#,##0.00").', 2, 2, (v, f) => formatText(scalar(v), str(f)));
def('VALUE', 'text', 'Converts text to a number.', 1, 1, (t) => {
  const v = scalar(t);
  if (typeof v === 'number') return v;
  const p = parseScalarText(toText(v));
  if (!p || typeof p.value !== 'number') throw E.VALUE;
  return p.value;
});
def('REPT', 'text, number_times', 'Repeats text.', 2, 2, (t, n) => { const k = int(n); if (k < 0) throw E.VALUE; return str(t).repeat(k); });
def('EXACT', 'text1, text2', 'Case-sensitive equality of two texts.', 2, 2, (a, b) => str(a) === str(b));

// ================= Dates =================
const serial = (v) => {
  const n = num(v);
  if (n < 0) throw E.NUM;
  return n;
};
function nowParts() {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), secs: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() };
}
def('TODAY', '', "Today's date as a serial (volatile).", 0, 0, () => { const p = nowParts(); return dateToSerial(p.y, p.m, p.d); }, { volatile: true });
def('NOW', '', 'Current date and time as a serial (volatile).', 0, 0, () => { const p = nowParts(); return dateToSerial(p.y, p.m, p.d) + p.secs / 86400; }, { volatile: true });
def('DATE', 'year, month, day', 'Date serial from year, month and day.', 3, 3, (y, m, d) => {
  let yy = int(y);
  if (yy < 1900) yy += 1900;
  if (yy < 1900 || yy > 9999) throw E.NUM;
  const s = dateToSerial(yy, int(m), int(d));
  if (s < 0) throw E.NUM;
  return s;
});
def('YEAR', 'serial_number', 'Year of a date.', 1, 1, (v) => serialToParts(serial(v)).y);
def('MONTH', 'serial_number', 'Month of a date (1-12).', 1, 1, (v) => serialToParts(serial(v)).m);
def('DAY', 'serial_number', 'Day of the month.', 1, 1, (v) => serialToParts(serial(v)).d);
def('HOUR', 'serial_number', 'Hour (0-23).', 1, 1, (v) => serialToParts(serial(v)).hh);
def('MINUTE', 'serial_number', 'Minute (0-59).', 1, 1, (v) => serialToParts(serial(v)).mi);
def('WEEKDAY', 'serial_number, [return_type]', 'Day of the week (1 = Sunday by default).', 1, 2, (v, t) => {
  const wd = serialToParts(serial(v)).wd, type = opt(t, 1, int);
  if (type === 1) return wd + 1;
  if (type === 2) return ((wd + 6) % 7) + 1;
  if (type === 3) return (wd + 6) % 7;
  throw E.NUM;
});
function addMonths(s, months, endOfMonth) {
  const p = serialToParts(s);
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12), m = (total % 12) + 1;
  if (y < 1900 || y > 9999) throw E.NUM;
  const dim = daysInMonth(y, m);
  return dateToSerial(y, m, endOfMonth ? dim : Math.min(p.d, dim));
}
def('EDATE', 'start_date, months', 'Date a number of months before or after a date.', 2, 2, (s, n) => addMonths(Math.floor(serial(s)), int(n), false));
def('EOMONTH', 'start_date, months', 'Last day of the month a number of months away.', 2, 2, (s, n) => addMonths(Math.floor(serial(s)), int(n), true));
def('DATEDIF', 'start_date, end_date, unit', 'Difference between dates in "Y", "M", "D", "MD", "YM" or "YD".', 3, 3, (a, b, u) => {
  const s = Math.floor(serial(a)), e = Math.floor(serial(b)), unit = str(u).toUpperCase();
  if (s > e) throw E.NUM;
  const ps = serialToParts(s), pe = serialToParts(e);
  let months = (pe.y - ps.y) * 12 + pe.m - ps.m;
  if (pe.d < ps.d) months--;
  switch (unit) {
    case 'Y': return Math.floor(months / 12);
    case 'M': return months;
    case 'D': return e - s;
    case 'YM': return months % 12;
    case 'MD': return pe.d >= ps.d ? pe.d - ps.d : e - dateToSerial(pe.y, pe.m - 1, ps.d);
    case 'YD': {
      let y = pe.y;
      if (pe.m < ps.m || (pe.m === ps.m && pe.d < ps.d)) y--;
      return e - dateToSerial(y, ps.m, ps.d);
    }
  }
  throw E.NUM;
});
def('NETWORKDAYS', 'start_date, end_date, [holidays]', 'Whole working days (Mon-Fri) between two dates, inclusive.', 2, 3, (a, b, h) => {
  let s = Math.floor(serial(a)), e = Math.floor(serial(b));
  const sign = s > e ? -1 : 1;
  if (s > e) [s, e] = [e, s];
  const holidays = new Set();
  if (h !== undefined && h !== null) for (const v of flatGrid(h)) { if (isError(v)) throw v; if (v !== null) holidays.add(Math.floor(toNumber(v))); }
  let n = 0;
  // ponytail: O(days) loop; switch to whole-week arithmetic if multi-century ranges matter
  for (let d = s; d <= e; d++) {
    const wd = serialToParts(d).wd;
    if (wd !== 0 && wd !== 6 && !holidays.has(d)) n++;
  }
  return sign * n;
});
def('DAYS', 'end_date, start_date', 'Number of days between two dates.', 2, 2, (e, s) => Math.floor(serial(e)) - Math.floor(serial(s)));

// ================= Information =================
def('ISBLANK', 'value', 'TRUE if the cell is empty.', 1, 1, (v) => v === null, { acceptErrors: true });
def('ISNUMBER', 'value', 'TRUE if the value is a number.', 1, 1, (v) => typeof v === 'number', { acceptErrors: true });
def('ISTEXT', 'value', 'TRUE if the value is text.', 1, 1, (v) => typeof v === 'string', { acceptErrors: true });
def('ISLOGICAL', 'value', 'TRUE if the value is TRUE or FALSE.', 1, 1, (v) => typeof v === 'boolean', { acceptErrors: true });
def('ISERROR', 'value', 'TRUE if the value is any error.', 1, 1, (v) => isError(v), { acceptErrors: true });
def('ISNA', 'value', 'TRUE if the value is #N/A.', 1, 1, (v) => isError(v) && v.error === '#N/A', { acceptErrors: true });
def('NA', '', 'Returns the #N/A error.', 0, 0, () => E.NA);

// ================= Financial =================
def('PMT', 'rate, nper, pv, [fv], [type]', 'Periodic payment for a loan.', 3, 5, (r, n, p, f, t) => {
  const rate = num(r), nper = num(n), pv = num(p), fv = opt(f, 0, num), type = opt(t, 0, num) ? 1 : 0;
  if (nper === 0) throw E.NUM;
  if (rate === 0) return -(pv + fv) / nper;
  const g = (1 + rate) ** nper;
  return -(rate * (fv + pv * g)) / ((1 + rate * type) * (g - 1));
});
def('FV', 'rate, nper, pmt, [pv], [type]', 'Future value of an investment.', 3, 5, (r, n, pm, p, t) => {
  const rate = num(r), nper = num(n), pmt = num(pm), pv = opt(p, 0, num), type = opt(t, 0, num) ? 1 : 0;
  if (rate === 0) return -(pv + pmt * nper);
  const g = (1 + rate) ** nper;
  return -(pv * g + (pmt * (1 + rate * type) * (g - 1)) / rate);
});
def('PV', 'rate, nper, pmt, [fv], [type]', 'Present value of an investment.', 3, 5, (r, n, pm, f, t) => {
  const rate = num(r), nper = num(n), pmt = num(pm), fv = opt(f, 0, num), type = opt(t, 0, num) ? 1 : 0;
  if (rate === 0) return -(fv + pmt * nper);
  const g = (1 + rate) ** nper;
  return -(fv + (pmt * (1 + rate * type) * (g - 1)) / rate) / g;
});
def('NPV', 'rate, value1, [value2], ...', 'Net present value of periodic cash flows.', 2, INF, (r, ...vals) => {
  const rate = num(r);
  if (rate === -1) throw E.DIV0;
  return numbers(vals).reduce((s, v, i) => s + v / (1 + rate) ** (i + 1), 0);
});
