// Tokeniser, recursive-descent parser (Excel precedence) and reference text rewriting.
import { MAX_ROW, MAX_COL, ERROR_LITERALS, colToLetters, lettersToCol } from './values.js';

const SHEET_PREFIX = /(?:\[([^\]]+)\])?(?:'((?:[^']|'')+)'|([A-Za-z_À-￿][\w.À-￿]*))!/y;
const CELL_RANGE = /(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?(?![\w.(!])/y;
const COL_RANGE = /(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![\w.(!])/y;
const ROW_RANGE = /(\$?)(\d+):(\$?)(\d+)(?![\w.(!])/y;
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_À-￿][\w.À-￿]*/y;
const OPS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '%', '=', '<', '>', '(', ')', ','];

function exec(re, src, i) {
  re.lastIndex = i;
  return re.exec(src);
}

function validRow(n) { return n >= 1 && n <= MAX_ROW; }
function validCol(letters) { return lettersToCol(letters) < MAX_COL; }

/** Try to read a reference body (no sheet prefix) at i. Returns { ref, end } or null. */
function readRefBody(src, i) {
  let m = exec(CELL_RANGE, src, i);
  if (m && validRow(+m[4]) && validCol(m[2]) && (!m[6] || (validRow(+m[8]) && validCol(m[6])))) {
    const r1 = +m[4] - 1, c1 = lettersToCol(m[2]);
    const ref = { kind: 'cell', r1, c1, r2: r1, c2: c1, ar1: !!m[3], ac1: !!m[1], ar2: !!m[3], ac2: !!m[1] };
    if (m[6]) {
      Object.assign(ref, { kind: 'range', r2: +m[8] - 1, c2: lettersToCol(m[6]), ar2: !!m[7], ac2: !!m[5] });
      normalise(ref);
    }
    return { ref, end: CELL_RANGE.lastIndex };
  }
  m = exec(COL_RANGE, src, i);
  if (m && validCol(m[2]) && validCol(m[4])) {
    const ref = { kind: 'cols', r1: 0, r2: MAX_ROW - 1, c1: lettersToCol(m[2]), c2: lettersToCol(m[4]), ar1: false, ar2: false, ac1: !!m[1], ac2: !!m[3] };
    return { ref: normalise(ref), end: COL_RANGE.lastIndex };
  }
  m = exec(ROW_RANGE, src, i);
  if (m && validRow(+m[2]) && validRow(+m[4])) {
    const ref = { kind: 'rows', c1: 0, c2: MAX_COL - 1, r1: +m[2] - 1, r2: +m[4] - 1, ac1: false, ac2: false, ar1: !!m[1], ar2: !!m[3] };
    return { ref: normalise(ref), end: ROW_RANGE.lastIndex };
  }
  return null;
}

function normalise(ref) {
  if (ref.r1 > ref.r2) [ref.r1, ref.r2, ref.ar1, ref.ar2] = [ref.r2, ref.r1, ref.ar2, ref.ar1];
  if (ref.c1 > ref.c2) [ref.c1, ref.c2, ref.ac1, ref.ac2] = [ref.c2, ref.c1, ref.ac2, ref.ac1];
  return ref;
}

export class FormulaSyntaxError extends Error {}

/** Tokens: { t: 'num'|'str'|'bool'|'err'|'ref'|'ident'|'op', v, s, e }. */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    const s = i;
    // Reference with optional [Workbook] and sheet prefix
    if (ch === '[' || ch === "'" || /[A-Za-z_$\dÀ-￿]/.test(ch)) {
      let wb = null, sheet = null, bodyAt = i;
      const pm = exec(SHEET_PREFIX, src, i);
      if (pm) {
        wb = pm[1] ?? null;
        sheet = pm[2] !== undefined ? pm[2].replace(/''/g, "'") : pm[3];
        if (pm[2] !== undefined && wb === null) {
          const inner = /^\[([^\]]+)\](.+)$/.exec(sheet); // '[Book]My Sheet'!A1
          if (inner) { wb = inner[1]; sheet = inner[2]; }
        }
        bodyAt = SHEET_PREFIX.lastIndex;
      }
      const body = readRefBody(src, bodyAt);
      if (body) {
        out.push({ t: 'ref', v: { wb, sheet, ...body.ref }, s, e: body.end });
        i = body.end;
        continue;
      }
      if (pm) {
        // Sheet prefix followed by #REF! (e.g. after a structural delete)
        if (src.startsWith('#REF!', bodyAt)) { out.push({ t: 'err', v: '#REF!', s, e: bodyAt + 5 }); i = bodyAt + 5; continue; }
        throw new FormulaSyntaxError(`Invalid reference at ${i}`);
      }
    }
    if (ch === '"') {
      let j = i + 1, str = '';
      for (;;) {
        if (j >= n) throw new FormulaSyntaxError('Unterminated string');
        if (src[j] === '"') {
          if (src[j + 1] === '"') { str += '"'; j += 2; continue; }
          break;
        }
        str += src[j++];
      }
      out.push({ t: 'str', v: str, s, e: j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === '#') {
      const lit = ERROR_LITERALS.find((c) => src.substr(i, c.length).toUpperCase() === c);
      if (!lit) throw new FormulaSyntaxError(`Unexpected # at ${i}`);
      out.push({ t: 'err', v: lit, s, e: i + lit.length });
      i += lit.length;
      continue;
    }
    let m = exec(NUMBER, src, i);
    if (m && /[\d.]/.test(ch)) {
      out.push({ t: 'num', v: Number(m[0]), s, e: NUMBER.lastIndex });
      i = NUMBER.lastIndex;
      continue;
    }
    m = exec(IDENT, src, i);
    if (m) {
      const up = m[0].toUpperCase();
      i = IDENT.lastIndex;
      if (up === 'TRUE' || up === 'FALSE') {
        // TRUE() / FALSE() are also accepted as functions
        let k = i;
        while (src[k] === ' ') k++;
        if (src[k] !== '(') { out.push({ t: 'bool', v: up === 'TRUE', s, e: i }); continue; }
      }
      out.push({ t: 'ident', v: m[0], s, e: i });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaSyntaxError(`Unexpected character "${ch}" at ${i}`);
    out.push({ t: 'op', v: op, s, e: i + op.length });
    i += op.length;
  }
  return out;
}

/**
 * Parse formula source (without the leading "=") into an AST.
 * Precedence (low to high): comparison, &, + -, * /, ^ (left-assoc), % postfix, unary +/-.
 */
export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v) => toks[p] && toks[p].t === 'op' && toks[p].v === v;
  const expectOp = (v) => {
    if (!isOp(v)) throw new FormulaSyntaxError(`Expected "${v}"`);
    p++;
  };
  const binary = (next, ops) => () => {
    let left = next();
    while (toks[p] && toks[p].t === 'op' && ops.includes(toks[p].v)) {
      const op = toks[p++].v;
      left = { type: 'binary', op, left, right: next() };
    }
    return left;
  };
  function unary() {
    if (isOp('-') || isOp('+')) {
      const op = toks[p++].v;
      return { type: 'unary', op, arg: unary() };
    }
    return primary();
  }
  function postfix() {
    let node = unary();
    while (isOp('%')) { p++; node = { type: 'percent', arg: node }; }
    return node;
  }
  const power = binary(postfix, ['^']);
  const mult = binary(power, ['*', '/']);
  const add = binary(mult, ['+', '-']);
  const concat = binary(add, ['&']);
  const comparison = binary(concat, ['=', '<>', '<', '<=', '>', '>=']);
  function primary() {
    const t = peek();
    if (!t) throw new FormulaSyntaxError('Unexpected end of formula');
    p++;
    switch (t.t) {
      case 'num': return { type: 'num', v: t.v };
      case 'str': return { type: 'str', v: t.v };
      case 'bool': return { type: 'bool', v: t.v };
      case 'err': return { type: 'err', v: t.v };
      case 'ref': return { type: 'ref', ref: t.v };
      case 'ident': {
        if (!isOp('(')) return { type: 'name', name: t.v };
        p++;
        const args = [];
        if (isOp(')')) { p++; return { type: 'call', name: t.v.toUpperCase(), args }; }
        for (;;) {
          if (isOp(',') || isOp(')')) args.push({ type: 'missing' });
          else args.push(comparison());
          if (isOp(',')) { p++; if (isOp(')')) { args.push({ type: 'missing' }); p++; break; } continue; }
          expectOp(')');
          break;
        }
        return { type: 'call', name: t.v.toUpperCase(), args };
      }
      case 'op':
        if (t.v === '(') {
          const inner = comparison();
          expectOp(')');
          return inner;
        }
    }
    throw new FormulaSyntaxError(`Unexpected "${t.v}"`);
  }
  const ast = comparison();
  if (p < toks.length) throw new FormulaSyntaxError(`Unexpected "${toks[p].v}"`);
  return ast;
}

/** Visit every node of an AST (iterative). */
export function walk(ast, fn) {
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    fn(node);
    if (node.args) stack.push(...node.args);
    if (node.arg) stack.push(node.arg);
    if (node.left) stack.push(node.left, node.right);
  }
}

export function quoteSheet(name) {
  if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(TRUE|FALSE)$/i.test(name)) return name;
  return `'${name.replace(/'/g, "''")}'`;
}

export function refToString(ref) {
  let prefix = '';
  if (ref.wb !== null && ref.wb !== undefined) {
    const inner = `[${ref.wb}]${ref.sheet ?? ''}`;
    prefix = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(ref.sheet ?? '') ? `${inner}!` : `'${inner.replace(/'/g, "''")}'!`;
  } else if (ref.sheet) prefix = quoteSheet(ref.sheet) + '!';
  const col = (c, abs) => (abs ? '$' : '') + colToLetters(c);
  const row = (r, abs) => (abs ? '$' : '') + (r + 1);
  if (ref.kind === 'cols') return `${prefix}${col(ref.c1, ref.ac1)}:${col(ref.c2, ref.ac2)}`;
  if (ref.kind === 'rows') return `${prefix}${row(ref.r1, ref.ar1)}:${row(ref.r2, ref.ar2)}`;
  const a = col(ref.c1, ref.ac1) + row(ref.r1, ref.ar1);
  if (ref.kind === 'cell') return prefix + a;
  return `${prefix}${a}:${col(ref.c2, ref.ac2)}${row(ref.r2, ref.ar2)}`;
}

/**
 * Rewrite reference tokens in formula text. fn(ref) returns undefined (keep), null (becomes #REF!)
 * or a new ref object. Everything else (spacing, case) is preserved.
 */
export function rewriteRefs(src, fn) {
  const toks = tokenize(src);
  let out = '', last = 0, changed = false;
  for (const t of toks) {
    if (t.t !== 'ref') continue;
    const next = fn(t.v);
    if (next === undefined) continue;
    out += src.slice(last, t.s) + (next === null ? '#REF!' : refToString(next));
    last = t.e;
    changed = true;
  }
  return changed ? out + src.slice(last) : src;
}
