/* ================= Truss formula engine (pure, no DOM) ================= */
var FE = (function () {
  var E = { DIV0: '#DIV/0!', REF: '#REF!', NAME: '#NAME?', VALUE: '#VALUE!', NA: '#N/A', NUM: '#NUM!', CYCLE: '#CYCLE!' };
  function err(c) { return { error: c }; }
  function isErr(v) { return v !== null && typeof v === 'object' && typeof v.error === 'string'; }
  function isRange(v) { return v !== null && typeof v === 'object' && Array.isArray(v.rows); }
  function FormulaError(msg) { this.message = msg; }

  function colToLetters(c) { var s = ''; c = c + 1; while (c > 0) { var m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
  function lettersToCol(s) { var n = 0; s = s.toUpperCase(); for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n - 1; }
  function toA1(r, c) { return colToLetters(c) + (r + 1); }
  function fromA1(a) { var m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a).trim()); if (!m) return null; return { row: parseInt(m[2], 10) - 1, col: lettersToCol(m[1]) }; }
  function parseRange(s) {
    var p = String(s).trim().split(':');
    var a = fromA1(p[0]); if (!a) return null;
    var b = p[1] ? fromA1(p[1]) : a; if (!b) return null;
    return { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) };
  }

  /* ---------- tokenizer ---------- */
  var MAXR = 1048575, MAXC = 16383;
  function parseRefAt(src, i) {
    var j = i, wb = null, sheet = null, m, k;
    if (src[j] === '[') { k = src.indexOf(']', j); if (k < 0) return null; wb = src.slice(j + 1, k); j = k + 1; }
    if (src[j] === "'") {
      var k2 = j + 1, name = '';
      while (k2 < src.length) { if (src[k2] === "'") { if (src[k2 + 1] === "'") { name += "'"; k2 += 2; continue; } break; } name += src[k2]; k2++; }
      if (src[k2] !== "'" || src[k2 + 1] !== '!') return null;
      sheet = name; j = k2 + 2;
    } else {
      m = /^([A-Za-z_][A-Za-z0-9_.]*)!/.exec(src.slice(j));
      if (m) { sheet = m[1]; j += m[0].length; } else if (wb !== null) return null;
    }
    var rest = src.slice(j), r;
    m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?/.exec(rest);
    if (m && !/^[A-Za-z0-9_(!]/.test(rest.slice(m[0].length))) {
      r = { kind: m[5] !== undefined ? 'range' : 'cell', wb: wb, sheet: sheet, c1: lettersToCol(m[2]), r1: parseInt(m[4], 10) - 1, ac1: !!m[1], ar1: !!m[3] };
      if (m[5] !== undefined) { r.c2 = lettersToCol(m[6]); r.r2 = parseInt(m[8], 10) - 1; r.ac2 = !!m[5]; r.ar2 = !!m[7]; }
      else { r.c2 = r.c1; r.r2 = r.r1; r.ac2 = r.ac1; r.ar2 = r.ar1; }
      return { len: j - i + m[0].length, ref: r };
    }
    m = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(])/.exec(rest);
    if (m) return { len: j - i + m[0].length, ref: { kind: 'cols', wb: wb, sheet: sheet, c1: lettersToCol(m[2]), c2: lettersToCol(m[4]), r1: 0, r2: MAXR, ac1: !!m[1], ac2: !!m[3] } };
    m = /^(\$?)(\d+):(\$?)(\d+)(?![0-9A-Za-z])/.exec(rest);
    if (m) return { len: j - i + m[0].length, ref: { kind: 'rows', wb: wb, sheet: sheet, r1: parseInt(m[2], 10) - 1, r2: parseInt(m[4], 10) - 1, c1: 0, c2: MAXC, ar1: !!m[1], ar2: !!m[3] } };
    return null;
  }

  function tokenize(src) {
    var toks = [], i = 0, n = src.length, m;
    while (i < n) {
      var ch = src[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
      var st = i;
      if (ch === '"') {
        var s = '', j = i + 1;
        for (;;) {
          if (j >= n) throw new FormulaError('Missing closing quote');
          if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
          s += src[j]; j++;
        }
        toks.push({ t: 'str', v: s, s: st, e: j + 1 }); i = j + 1; continue;
      }
      if (ch === '#') {
        m = /^#(DIV\/0!|REF!|NAME\?|VALUE!|N\/A|NUM!|CYCLE!|NULL!)/i.exec(src.slice(i));
        if (m) { toks.push({ t: 'err', v: m[0].toUpperCase(), s: st, e: i + m[0].length }); i += m[0].length; continue; }
        throw new FormulaError('Unexpected #');
      }
      var rf = (ch === '[' || ch === "'" || /[A-Za-z_$0-9]/.test(ch)) ? parseRefAt(src, i) : null;
      if (rf) { toks.push({ t: 'ref', ref: rf.ref, s: st, e: i + rf.len }); i += rf.len; continue; }
      m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
      if (m) { toks.push({ t: 'num', v: parseFloat(m[0]), s: st, e: i + m[0].length }); i += m[0].length; continue; }
      m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
      if (m) {
        var w = m[0], up = w.toUpperCase(); i += w.length;
        var k = i; while (k < n && src[k] === ' ') k++;
        if (src[k] === '(') toks.push({ t: 'fn', v: up, s: st, e: i });
        else if (up === 'TRUE' || up === 'FALSE') toks.push({ t: 'bool', v: up === 'TRUE', s: st, e: i });
        else toks.push({ t: 'name', v: w, s: st, e: i });
        continue;
      }
      var two = src.substr(i, 2);
      if (two === '<=' || two === '>=' || two === '<>' || two === '!=') { toks.push({ t: 'op', v: two === '!=' ? '<>' : two, s: st, e: i + 2 }); i += 2; continue; }
      if ('+-*/^&%=<>'.indexOf(ch) >= 0) { toks.push({ t: 'op', v: ch, s: st, e: i + 1 }); i++; continue; }
      if (ch === '(') { toks.push({ t: 'lp', s: st, e: i + 1 }); i++; continue; }
      if (ch === ')') { toks.push({ t: 'rp', s: st, e: i + 1 }); i++; continue; }
      if (ch === ',' || ch === ';') { toks.push({ t: 'comma', s: st, e: i + 1 }); i++; continue; }
      throw new FormulaError('Unexpected character "' + ch + '"');
    }
    return toks;
  }

  /* ---------- parser ---------- */
  var BIN = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 };
  var parseCache = new Map();
  function parse(src) {
    if (parseCache.has(src)) { var c = parseCache.get(src); if (c instanceof FormulaError) throw c; return c; }
    var res;
    try { res = parseUncached(src); } catch (e) { res = e instanceof FormulaError ? e : new FormulaError(String(e && e.message || e)); }
    if (parseCache.size > 5000) parseCache.clear();
    parseCache.set(src, res);
    if (res instanceof FormulaError) throw res;
    return res;
  }
  function parseUncached(src) {
    var toks = tokenize(src), p = 0;
    function peek() { return toks[p]; }
    function next() { return toks[p++]; }
    function parseExpr(minP) {
      var left = parseUnary();
      for (;;) {
        var k = peek();
        if (!k || k.t !== 'op') break;
        if (k.v === '%') { next(); left = { t: 'pct', a: left }; continue; }
        var pr = BIN[k.v];
        if (pr === undefined || pr < minP) break;
        next();
        left = { t: 'bin', op: k.v, a: left, b: parseExpr(pr + 1) };
      }
      return left;
    }
    function parseUnary() {
      var k = peek();
      if (k && k.t === 'op' && (k.v === '-' || k.v === '+')) { next(); var a = parseUnary(); return k.v === '-' ? { t: 'neg', a: a } : a; }
      var prim = parsePrimary();
      for (;;) { var q = peek(); if (q && q.t === 'op' && q.v === '%') { next(); prim = { t: 'pct', a: prim }; } else break; }
      return prim;
    }
    function parsePrimary() {
      var k = next();
      if (!k) throw new FormulaError('Formula ends unexpectedly');
      if (k.t === 'num') return { t: 'num', v: k.v };
      if (k.t === 'str') return { t: 'str', v: k.v };
      if (k.t === 'bool') return { t: 'bool', v: k.v };
      if (k.t === 'err') return { t: 'errlit', v: k.v };
      if (k.t === 'ref') return { t: 'ref', ref: k.ref };
      if (k.t === 'name') return { t: 'name', v: k.v };
      if (k.t === 'lp') { var e = parseExpr(1); var r = next(); if (!r || r.t !== 'rp') throw new FormulaError('Missing )'); return e; }
      if (k.t === 'fn') {
        var lp = next(); if (!lp || lp.t !== 'lp') throw new FormulaError('Expected (');
        var args = [];
        if (peek() && peek().t === 'rp') { next(); return { t: 'fn', name: k.v, args: args }; }
        for (;;) {
          if (peek() && (peek().t === 'comma' || peek().t === 'rp')) args.push({ t: 'blank' });
          else args.push(parseExpr(1));
          var q = next();
          if (!q) throw new FormulaError('Missing ) after ' + k.v);
          if (q.t === 'rp') break;
          if (q.t !== 'comma') throw new FormulaError('Expected , or ) in ' + k.v);
        }
        return { t: 'fn', name: k.v, args: args };
      }
      throw new FormulaError('Unexpected ' + (k.v || k.t));
    }
    if (!toks.length) throw new FormulaError('Empty formula');
    var ast = parseExpr(1);
    if (p < toks.length) throw new FormulaError('Unexpected ' + (toks[p].v || toks[p].t));
    return ast;
  }

  /* ---------- dates ---------- */
  var EPOCH = Date.UTC(1899, 11, 30);
  function dateSerial(y, m, d) { return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000); }
  function serialParts(s) {
    var whole = Math.floor(s), frac = s - whole;
    var d = new Date(EPOCH + whole * 86400000);
    var secs = Math.round(frac * 86400);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(), h: Math.floor(secs / 3600), mi: Math.floor(secs / 60) % 60, s: secs % 60 };
  }
  // One formatter, and one answer per second: TODAY()/NOW() and date cells ask for this constantly.
  var NOW_FMT = null, NOW_CACHE = { at: 0, v: null };
  function sydneyNow() {
    var t = Date.now();
    if (NOW_CACHE.v && t - NOW_CACHE.at < 1000) return NOW_CACHE.v;
    NOW_CACHE = { at: t, v: sydneyNowUncached(t) };
    return NOW_CACHE.v;
  }
  function sydneyNowUncached(t) {
    var parts = {};
    try {
      if (!NOW_FMT) NOW_FMT = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      NOW_FMT.formatToParts(new Date(t)).forEach(function (p) { parts[p.type] = p.value; });
    } catch (e) { var d = new Date(); parts = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() }; }
    var h = parseInt(parts.hour, 10) % 24;
    return { y: +parts.year, m: +parts.month, d: +parts.day, h: h, mi: +parts.minute, s: +parts.second };
  }
  function todaySerial() { var n = sydneyNow(); return dateSerial(n.y, n.m, n.d); }
  function nowSerial() { var n = sydneyNow(); return dateSerial(n.y, n.m, n.d) + (n.h * 3600 + n.mi * 60 + n.s) / 86400; }
  function parseDateText(s) {
    s = String(s).trim(); var m;
    m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/.exec(s);
    if (m) { var y = +m[3]; if (y < 100) y += y < 50 ? 2000 : 1900; var mo = +m[2], d = +m[1]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null; return dateSerial(y, mo, d); }
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
    if (m) { if (+m[2] < 1 || +m[2] > 12) return null; return dateSerial(+m[1], +m[2], +m[3]); }
    return null;
  }
  function isoToSerial(iso) { if (!iso) return null; var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? dateSerial(+m[1], +m[2], +m[3]) : null; }
  function serialToIso(s) { var p = serialParts(s); return p.y + '-' + pad2(p.m) + '-' + pad2(p.d); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------- coercion ---------- */
  function parseNumText(s) {
    var t = String(s).trim();
    if (t === '') return null;
    var neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    var pct = /%$/.test(t); if (pct) t = t.slice(0, -1);
    t = t.replace(/^\$/, '').replace(/^-\$/, '-').replace(/,/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
    var v = parseFloat(t); if (pct) v = v / 100; if (neg) v = -v;
    return v;
  }
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) return 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (isErr(v)) return v;
    if (isRange(v)) return toNum(scalar(v));
    var n = parseNumText(v); if (n !== null) return n;
    var d = parseDateText(v); if (d !== null) return d;
    return err(E.VALUE);
  }
  function fmtGeneral(n) {
    if (!isFinite(n)) return '#NUM!';
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    var a = Math.abs(n);
    if (a !== 0 && (a >= 1e15 || a < 1e-9)) return n.toExponential(4).replace(/\.?0+e/, 'E').replace('e', 'E');
    var s = n.toPrecision(11);
    if (s.indexOf('e') >= 0) return String(parseFloat(s));
    return String(parseFloat(s));
  }
  function toStr(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return fmtGeneral(v);
    if (isErr(v)) return v.error;
    if (isRange(v)) return toStr(scalar(v));
    return String(v);
  }
  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (v === null || v === undefined) return false;
    if (isErr(v)) return v;
    if (isRange(v)) return toBool(scalar(v));
    var u = String(v).toUpperCase(); if (u === 'TRUE') return true; if (u === 'FALSE') return false;
    return err(E.VALUE);
  }
  function scalar(v) {
    if (!isRange(v)) return v;
    if (!v.rows.length || !v.rows[0].length) return null;
    if (v.rows.length === 1 && v.rows[0].length === 1) return v.rows[0][0];
    return err(E.VALUE);
  }
  function cmp(a, b) {
    if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
    if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
    var ra = typeof a === 'number' ? 0 : typeof a === 'string' ? 1 : 2;
    var rb = typeof b === 'number' ? 0 : typeof b === 'string' ? 1 : 2;
    if (ra !== rb) return ra - rb;
    if (ra === 1) { a = a.toLowerCase(); b = b.toLowerCase(); }
    if (ra === 2) { a = a ? 1 : 0; b = b ? 1 : 0; }
    return a < b ? -1 : a > b ? 1 : 0;
  }

  /* ---------- evaluation ---------- */
  function evalRef(ref, env) {
    if (!env.cell) return err(E.REF);
    if (ref.kind === 'cell') return env.cell(ref.wb, ref.sheet, ref.r1, ref.c1);
    var r1 = Math.min(ref.r1, ref.r2), r2 = Math.max(ref.r1, ref.r2), c1 = Math.min(ref.c1, ref.c2), c2 = Math.max(ref.c1, ref.c2);
    if (ref.kind === 'cols' || ref.kind === 'rows') {
      var b = env.bounds ? env.bounds(ref.wb, ref.sheet) : null;
      if (isErr(b)) return b;
      if (!b) b = { rows: 0, cols: 0 };
      if (ref.kind === 'cols') { r1 = 0; r2 = Math.max(0, b.rows - 1); } else { c1 = 0; c2 = Math.max(0, b.cols - 1); }
    }
    if ((r2 - r1 + 1) * (c2 - c1 + 1) > 200000) return err(E.NUM);
    var rows = [];
    for (var r = r1; r <= r2; r++) {
      var row = [];
      for (var c = c1; c <= c2; c++) { var v = env.cell(ref.wb, ref.sheet, r, c); if (isErr(v) && v.error === E.REF && v.sheetMissing) return v; row.push(v); }
      rows.push(row);
    }
    return { rows: rows };
  }

  function ev(n, env) {
    switch (n.t) {
      case 'num': case 'str': case 'bool': return n.v;
      case 'errlit': return err(n.v);
      case 'blank': return null;
      case 'name': return err(E.NAME);
      case 'ref': return evalRef(n.ref, env);
      case 'neg': { var a = toNum(scalar(ev(n.a, env))); return isErr(a) ? a : -a; }
      case 'pct': { var p = toNum(scalar(ev(n.a, env))); return isErr(p) ? p : p / 100; }
      case 'bin': return binop(n.op, scalar(ev(n.a, env)), scalar(ev(n.b, env)));
      case 'fn': return callFn(n, env);
    }
    return err(E.VALUE);
  }
  function binop(op, a, b) {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (op === '&') return toStr(a) + toStr(b);
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      var c = cmp(a, b);
      return op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    var x = toNum(a); if (isErr(x)) return x;
    var y = toNum(b); if (isErr(y)) return y;
    var r;
    switch (op) {
      case '+': r = x + y; break;
      case '-': r = x - y; break;
      case '*': r = x * y; break;
      case '/': if (y === 0) return err(E.DIV0); r = x / y; break;
      case '^': r = Math.pow(x, y); break;
    }
    if (!isFinite(r) || isNaN(r)) return err(E.NUM);
    return fixFloat(r);
  }
  function fixFloat(r) { return Math.abs(r) < 1e15 ? parseFloat(r.toPrecision(15)) : r; }

  var FNS = {};
  function reg(name, min, max, fn, desc, sig, lazy) { FNS[name] = { min: min, max: max, fn: fn, desc: desc || '', sig: sig || name + '()', lazy: !!lazy }; }

  function callFn(n, env) {
    var name = n.name;
    var extra = env.fns && env.fns[name];
    var def = extra || FNS[name];
    if (!def) return err(E.NAME);
    var argc = n.args.length;
    if (argc < def.min || (def.max >= 0 && argc > def.max)) return err(E.VALUE);
    if (def.lazy) return def.fn(function (i) { return i < argc ? ev(n.args[i], env) : undefined; }, argc, env);
    var args = [];
    for (var i = 0; i < argc; i++) args.push(ev(n.args[i], env));
    return def.fn(args, env);
  }

  // iterate every value in args (ranges flattened); cb(value, fromRange)
  function each(args, cb) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (isRange(a)) { for (var r = 0; r < a.rows.length; r++) for (var c = 0; c < a.rows[r].length; c++) { if (cb(a.rows[r][c], true) === false) return; } }
      else if (cb(a, false) === false) return;
    }
  }
  function nums(args) {
    var out = [], e = null;
    each(args, function (v, fr) {
      if (isErr(v)) { e = v; return false; }
      if (fr) { if (typeof v === 'number') out.push(v); return; }
      if (v === null) return;
      var x = toNum(v); if (isErr(x)) { e = x; return false; } out.push(x);
    });
    return e || out;
  }
  function flat(v) { var out = []; each([v], function (x) { out.push(x); }); return out; }
  function dims(v) { return isRange(v) ? { r: v.rows.length, c: v.rows.length ? v.rows[0].length : 0 } : { r: 1, c: 1 }; }
  function at(v, r, c) { return isRange(v) ? (v.rows[r] ? v.rows[r][c] : null) : v; }

  function aggr(name, f) {
    reg(name, 1, -1, function (args) { var xs = nums(args); if (isErr(xs)) return xs; return f(xs); });
  }
  aggr('SUM', function (xs) { var s = 0; xs.forEach(function (x) { s += x; }); return fixFloat(s); });
  aggr('AVERAGE', function (xs) { if (!xs.length) return err(E.DIV0); var s = 0; xs.forEach(function (x) { s += x; }); return fixFloat(s / xs.length); });
  aggr('MIN', function (xs) { return xs.length ? Math.min.apply(null, xs) : 0; });
  aggr('MAX', function (xs) { return xs.length ? Math.max.apply(null, xs) : 0; });
  aggr('PRODUCT', function (xs) { var p = xs.length ? 1 : 0; xs.forEach(function (x) { p *= x; }); return fixFloat(p); });
  aggr('MEDIAN', function (xs) { if (!xs.length) return err(E.NUM); xs = xs.slice().sort(function (a, b) { return a - b; }); var m = xs.length >> 1; return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; });
  aggr('STDEV', function (xs) { if (xs.length < 2) return err(E.DIV0); var mu = 0; xs.forEach(function (x) { mu += x; }); mu /= xs.length; var s = 0; xs.forEach(function (x) { s += (x - mu) * (x - mu); }); return Math.sqrt(s / (xs.length - 1)); });
  reg('LARGE', 2, 2, function (a) { var xs = nums([a[0]]); if (isErr(xs)) return xs; var k = toNum(a[1]); if (isErr(k)) return k; xs.sort(function (x, y) { return y - x; }); return k >= 1 && k <= xs.length ? xs[Math.floor(k) - 1] : err(E.NUM); }, 'k-th largest value', 'LARGE(range, k)');
  reg('SMALL', 2, 2, function (a) { var xs = nums([a[0]]); if (isErr(xs)) return xs; var k = toNum(a[1]); if (isErr(k)) return k; xs.sort(function (x, y) { return x - y; }); return k >= 1 && k <= xs.length ? xs[Math.floor(k) - 1] : err(E.NUM); }, 'k-th smallest value', 'SMALL(range, k)');
  reg('COUNT', 1, -1, function (args) { var n = 0; each(args, function (v, fr) { if (typeof v === 'number') n++; else if (!fr && v !== null && !isErr(v) && !isErr(toNum(v))) n++; }); return n; });
  reg('COUNTA', 1, -1, function (args) { var n = 0; each(args, function (v) { if (v !== null && v !== '') n++; }); return n; });
  reg('COUNTBLANK', 1, 1, function (args) { var n = 0; each(args, function (v) { if (v === null || v === '') n++; }); return n; });
  reg('SUMPRODUCT', 1, -1, function (args) {
    var d = dims(args[0]), s = 0;
    for (var i = 0; i < args.length; i++) { var di = dims(args[i]); if (di.r !== d.r || di.c !== d.c) return err(E.VALUE); }
    for (var r = 0; r < d.r; r++) for (var c = 0; c < d.c; c++) { var p = 1; for (var k = 0; k < args.length; k++) { var v = at(args[k], r, c); if (isErr(v)) return v; p *= typeof v === 'number' ? v : 0; } s += p; }
    return fixFloat(s);
  }, 'Sum of products of ranges', 'SUMPRODUCT(range1, range2, ...)');

  function num1(name, f, desc, sig) { reg(name, 1, 1, function (a) { var x = toNum(scalar(a[0])); if (isErr(x)) return x; var r = f(x); return typeof r === 'number' && (!isFinite(r) || isNaN(r)) ? err(E.NUM) : r; }, desc, sig); }
  function roundTo(x, d, mode) {
    var f = Math.pow(10, d), y = x * f;
    y = parseFloat(y.toPrecision(15));
    var r = mode === 'up' ? (y < 0 ? -Math.ceil(-y) : Math.ceil(y)) : mode === 'down' ? (y < 0 ? -Math.floor(-y) : Math.floor(y)) : (y < 0 ? -Math.round(-y) : Math.round(y));
    return fixFloat(r / f);
  }
  function num2(name, f, min, desc, sig) { reg(name, min || 2, 2, function (a) { var x = toNum(scalar(a[0])); if (isErr(x)) return x; var y = a.length > 1 ? toNum(scalar(a[1])) : 0; if (isErr(y)) return y; return f(x, y); }, desc, sig); }
  num2('ROUND', function (x, d) { return roundTo(x, Math.trunc(d)); }, 1, 'Round to digits', 'ROUND(number, digits)');
  num2('ROUNDUP', function (x, d) { return roundTo(x, Math.trunc(d), 'up'); }, 1, 'Round away from zero', 'ROUNDUP(number, digits)');
  num2('ROUNDDOWN', function (x, d) { return roundTo(x, Math.trunc(d), 'down'); }, 1, 'Round towards zero', 'ROUNDDOWN(number, digits)');
  num1('INT', Math.floor, 'Round down to integer', 'INT(number)');
  num1('ABS', Math.abs, 'Absolute value', 'ABS(number)');
  num1('SQRT', function (x) { return x < 0 ? err(E.NUM) : Math.sqrt(x); }, 'Square root', 'SQRT(number)');
  num1('SIGN', Math.sign, 'Sign of a number', 'SIGN(number)');
  num1('EXP', Math.exp, 'e raised to a power', 'EXP(number)');
  num1('LN', function (x) { return x <= 0 ? err(E.NUM) : Math.log(x); }, 'Natural logarithm', 'LN(number)');
  num2('LOG', function (x, b) { if (!b) b = 10; return x <= 0 || b <= 0 || b === 1 ? err(E.NUM) : Math.log(x) / Math.log(b); }, 1, 'Logarithm', 'LOG(number, [base])');
  num2('POWER', function (x, y) { var r = Math.pow(x, y); return isFinite(r) ? fixFloat(r) : err(E.NUM); }, 2, 'Power', 'POWER(number, power)');
  num2('MOD', function (x, y) { if (y === 0) return err(E.DIV0); return fixFloat(x - y * Math.floor(x / y)); }, 2, 'Remainder', 'MOD(number, divisor)');
  num2('CEILING', function (x, s) { if (s === 0) return 0; return fixFloat(Math.ceil(x / s) * s); }, 1, 'Round up to a multiple', 'CEILING(number, [significance])');
  num2('FLOOR', function (x, s) { if (s === 0) return 0; return fixFloat(Math.floor(x / s) * s); }, 1, 'Round down to a multiple', 'FLOOR(number, [significance])');
  reg('PI', 0, 0, function () { return Math.PI; }, 'Pi', 'PI()');
  reg('RAND', 0, 0, function () { return Math.random(); }, 'Random number 0-1 (volatile)', 'RAND()');
  reg('RANDBETWEEN', 2, 2, function (a) { var lo = toNum(scalar(a[0])), hi = toNum(scalar(a[1])); if (isErr(lo)) return lo; if (isErr(hi)) return hi; lo = Math.ceil(lo); hi = Math.floor(hi); if (hi < lo) return err(E.NUM); return lo + Math.floor(Math.random() * (hi - lo + 1)); }, 'Random integer (volatile)', 'RANDBETWEEN(low, high)');

  /* logical (lazy) */
  reg('IF', 1, 3, function (ev_, n) {
    var c = toBool(scalar(ev_(0))); if (isErr(c)) return c;
    if (c) return n > 1 ? nz(ev_(1)) : true;
    return n > 2 ? nz(ev_(2)) : false;
  }, 'Choose a value by a condition', 'IF(condition, then, [else])', true);
  function nz(v) { return v === undefined ? null : v; }
  reg('IFS', 2, -1, function (ev_, n) {
    for (var i = 0; i + 1 < n; i += 2) { var c = toBool(scalar(ev_(i))); if (isErr(c)) return c; if (c) return nz(ev_(i + 1)); }
    return err(E.NA);
  }, 'First true condition wins', 'IFS(cond1, value1, cond2, value2, ...)', true);
  reg('IFERROR', 2, 2, function (ev_) { var v = ev_(0); return isErr(scalar(v)) ? nz(ev_(1)) : v; }, 'Fallback on any error', 'IFERROR(value, fallback)', true);
  reg('IFNA', 2, 2, function (ev_) { var v = ev_(0); var s = scalar(v); return isErr(s) && s.error === E.NA ? nz(ev_(1)) : v; }, 'Fallback on #N/A', 'IFNA(value, fallback)', true);
  reg('SWITCH', 3, -1, function (ev_, n) {
    var x = scalar(ev_(0)); if (isErr(x)) return x;
    var i = 1;
    for (; i + 1 < n; i += 2) { var c = scalar(ev_(i)); if (isErr(c)) return c; if (cmp(x, c) === 0) return nz(ev_(i + 1)); }
    return i < n ? nz(ev_(i)) : err(E.NA);
  }, 'Match a value against cases', 'SWITCH(value, case1, result1, ..., [default])', true);
  reg('CHOOSE', 2, -1, function (ev_, n) { var k = toNum(scalar(ev_(0))); if (isErr(k)) return k; k = Math.floor(k); if (k < 1 || k >= n) return err(E.VALUE); return nz(ev_(k)); }, 'Pick the n-th value', 'CHOOSE(index, value1, value2, ...)', true);
  function logic(name, f, desc, sig) {
    reg(name, 1, -1, function (args) {
      var bs = [], e = null;
      each(args, function (v, fr) { if (isErr(v)) { e = v; return false; } if (fr && typeof v !== 'boolean' && typeof v !== 'number') return; var b = toBool(v); if (isErr(b)) { e = b; return false; } bs.push(b); });
      if (e) return e; if (!bs.length) return err(E.VALUE);
      return f(bs);
    }, desc, sig);
  }
  logic('AND', function (bs) { return bs.every(Boolean); }, 'All true', 'AND(a, b, ...)');
  logic('OR', function (bs) { return bs.some(Boolean); }, 'Any true', 'OR(a, b, ...)');
  logic('XOR', function (bs) { return bs.filter(Boolean).length % 2 === 1; }, 'Odd number true', 'XOR(a, b, ...)');
  reg('NOT', 1, 1, function (a) { var b = toBool(scalar(a[0])); return isErr(b) ? b : !b; }, 'Negate', 'NOT(value)');
  reg('TRUE', 0, 0, function () { return true; });
  reg('FALSE', 0, 0, function () { return false; });

  /* criteria */
  function makeCrit(c) {
    if (isErr(c)) return function () { return false; };
    if (typeof c === 'number' || typeof c === 'boolean') return function (v) { return v !== null && cmp(v, c) === 0; };
    var s = c === null ? '' : String(c), m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(s), op = m[1] || '=', rhs = m[2];
    var rn = parseNumText(rhs), rd = rn === null ? parseDateText(rhs) : null; if (rd !== null) rn = rd;
    var wild = /[*?]/.test(rhs) && rn === null;
    var re = wild ? new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '.') + '$', 'i') : null;
    return function (v) {
      if (op === '=' && rhs === '') return v === null || v === '';
      if (op === '<>' && rhs === '') return !(v === null || v === '');
      if (rn !== null && typeof v === 'number') { var c2 = v < rn ? -1 : v > rn ? 1 : 0; return op === '=' ? c2 === 0 : op === '<>' ? c2 !== 0 : op === '<' ? c2 < 0 : op === '>' ? c2 > 0 : op === '<=' ? c2 <= 0 : c2 >= 0; }
      if (rn !== null && op !== '=' && op !== '<>') return false;
      var sv = v === null ? '' : toStr(v);
      var eq = re ? re.test(sv) : sv.toLowerCase() === rhs.toLowerCase();
      if (op === '=') return eq; if (op === '<>') return !eq;
      if (typeof v !== 'string') return false;
      var c3 = cmp(sv, rhs); return op === '<' ? c3 < 0 : op === '>' ? c3 > 0 : op === '<=' ? c3 <= 0 : c3 >= 0;
    };
  }
  function condIdx(pairs) { // pairs: [[range, crit],...] -> list of [r,c] matching all
    var d = dims(pairs[0][0]), out = [];
    for (var k = 0; k < pairs.length; k++) { var dk = dims(pairs[k][0]); if (dk.r !== d.r || dk.c !== d.c) return null; pairs[k][2] = makeCrit(scalar(pairs[k][1])); }
    for (var r = 0; r < d.r; r++) for (var c = 0; c < d.c; c++) { var ok = true; for (var j = 0; j < pairs.length && ok; j++) ok = pairs[j][2](at(pairs[j][0], r, c)); if (ok) out.push([r, c]); }
    return out;
  }
  function sumOver(range, idx) { var s = 0, n = 0; for (var i = 0; i < idx.length; i++) { var v = at(range, idx[i][0], idx[i][1]); if (isErr(v)) return v; if (typeof v === 'number') { s += v; n++; } } return { s: fixFloat(s), n: n }; }
  reg('COUNTIF', 2, 2, function (a) { var ix = condIdx([[a[0], a[1]]]); return ix ? ix.length : err(E.VALUE); }, 'Count cells matching a criterion', 'COUNTIF(range, criterion)');
  reg('COUNTIFS', 2, -1, function (a) { if (a.length % 2) return err(E.VALUE); var p = []; for (var i = 0; i < a.length; i += 2) p.push([a[i], a[i + 1]]); var ix = condIdx(p); return ix ? ix.length : err(E.VALUE); }, 'Count with several criteria', 'COUNTIFS(range1, crit1, ...)');
  reg('SUMIF', 2, 3, function (a) { var ix = condIdx([[a[0], a[1]]]); if (!ix) return err(E.VALUE); var r = sumOver(a.length > 2 ? a[2] : a[0], ix); return isErr(r) ? r : r.s; }, 'Sum cells matching a criterion', 'SUMIF(range, criterion, [sum_range])');
  reg('SUMIFS', 3, -1, function (a) { if (a.length % 2 === 0) return err(E.VALUE); var p = []; for (var i = 1; i < a.length; i += 2) p.push([a[i], a[i + 1]]); var ix = condIdx(p); if (!ix) return err(E.VALUE); var r = sumOver(a[0], ix); return isErr(r) ? r : r.s; }, 'Sum with several criteria', 'SUMIFS(sum_range, range1, crit1, ...)');
  reg('AVERAGEIF', 2, 3, function (a) { var ix = condIdx([[a[0], a[1]]]); if (!ix) return err(E.VALUE); var r = sumOver(a.length > 2 ? a[2] : a[0], ix); if (isErr(r)) return r; return r.n ? fixFloat(r.s / r.n) : err(E.DIV0); }, 'Average cells matching a criterion', 'AVERAGEIF(range, criterion, [avg_range])');
  reg('AVERAGEIFS', 3, -1, function (a) { if (a.length % 2 === 0) return err(E.VALUE); var p = []; for (var i = 1; i < a.length; i += 2) p.push([a[i], a[i + 1]]); var ix = condIdx(p); if (!ix) return err(E.VALUE); var r = sumOver(a[0], ix); if (isErr(r)) return r; return r.n ? fixFloat(r.s / r.n) : err(E.DIV0); }, 'Average with several criteria', 'AVERAGEIFS(avg_range, range1, crit1, ...)');

  /* lookup */
  function eqLoose(a, b) { if (a === null || b === null) return a === b; return cmp(a, b) === 0; }
  function approxIdx(list, x) { var best = -1; for (var i = 0; i < list.length; i++) { var v = list[i]; if (v === null || typeof v !== typeof x && !(typeof x === 'number' && typeof v === 'number')) continue; if (cmp(v, x) <= 0) best = i; else break; } return best; }
  function matchIn(list, x, exact) {
    if (exact) {
      var wild = typeof x === 'string' && /[*?]/.test(x), crit = wild ? makeCrit(x) : null;
      for (var i = 0; i < list.length; i++) if (wild ? crit(list[i]) : eqLoose(list[i], x)) return i;
      return -1;
    }
    return approxIdx(list, x);
  }
  reg('VLOOKUP', 3, 4, function (a) {
    var x = scalar(a[0]); if (isErr(x)) return x; if (!isRange(a[1])) return err(E.VALUE);
    var col = toNum(scalar(a[2])); if (isErr(col)) return col; col = Math.floor(col);
    var exact = a.length > 3 ? !toBool(scalar(a[3])) : false;
    var t = a[1].rows; if (col < 1 || col > (t[0] || []).length) return err(E.REF);
    var i = matchIn(t.map(function (r) { return r[0]; }), x, exact);
    return i < 0 ? err(E.NA) : t[i][col - 1];
  }, 'Look down the first column', 'VLOOKUP(value, table, col, [approx])');
  reg('HLOOKUP', 3, 4, function (a) {
    var x = scalar(a[0]); if (isErr(x)) return x; if (!isRange(a[1])) return err(E.VALUE);
    var row = toNum(scalar(a[2])); if (isErr(row)) return row; row = Math.floor(row);
    var exact = a.length > 3 ? !toBool(scalar(a[3])) : false;
    var t = a[1].rows; if (row < 1 || row > t.length) return err(E.REF);
    var i = matchIn(t[0], x, exact);
    return i < 0 ? err(E.NA) : t[row - 1][i];
  }, 'Look across the first row', 'HLOOKUP(value, table, row, [approx])');
  reg('XLOOKUP', 3, 5, function (a) {
    var x = scalar(a[0]); if (isErr(x)) return x;
    var look = flat(a[1]), ret = a[2], d = dims(ret), dl = dims(a[1]);
    var mode = a.length > 4 && a[4] !== null ? toNum(scalar(a[4])) : 0;
    var i = mode === -1 || mode === 1 ? -1 : matchIn(look, x, true);
    if (mode === -1) { var best = -1; for (var k = 0; k < look.length; k++) if (look[k] !== null && cmp(look[k], x) <= 0 && (best < 0 || cmp(look[k], look[best]) > 0)) best = k; i = best; }
    if (mode === 1) { var bst = -1; for (var q = 0; q < look.length; q++) if (look[q] !== null && cmp(look[q], x) >= 0 && (bst < 0 || cmp(look[q], look[bst]) < 0)) bst = q; i = bst; }
    if (i < 0) return a.length > 3 && a[3] !== null ? a[3] : err(E.NA);
    if (dl.c === 1) return d.c === 1 ? at(ret, i, 0) : { rows: [isRange(ret) ? ret.rows[i] : [ret]] };
    return d.r === 1 ? at(ret, 0, i) : { rows: ret.rows.map(function (r) { return [r[i]]; }) };
  }, 'Modern lookup', 'XLOOKUP(value, lookup_range, return_range, [if_missing], [mode])');
  reg('MATCH', 2, 3, function (a) {
    var x = scalar(a[0]); if (isErr(x)) return x;
    var type = a.length > 2 ? toNum(scalar(a[2])) : 1; var list = flat(a[1]);
    if (type === 0) { var i = matchIn(list, x, true); return i < 0 ? err(E.NA) : i + 1; }
    if (type === 1) { var j = approxIdx(list, x); return j < 0 ? err(E.NA) : j + 1; }
    var best = -1; for (var k = 0; k < list.length; k++) { if (list[k] !== null && cmp(list[k], x) >= 0) best = k; else break; } return best < 0 ? err(E.NA) : best + 1;
  }, 'Position of a value', 'MATCH(value, range, [type])');
  reg('INDEX', 2, 3, function (a) {
    var d = dims(a[0]); var r = toNum(scalar(a[1])); if (isErr(r)) return r;
    var c = a.length > 2 ? toNum(scalar(a[2])) : (d.r === 1 && d.c > 1 ? r : 1); if (isErr(c)) return c;
    if (d.r === 1 && d.c > 1 && a.length === 2) { c = r; r = 1; }
    r = Math.floor(r); c = Math.floor(c);
    if (r < 0 || c < 0 || r > d.r || c > d.c) return err(E.REF);
    if (r === 0 && isRange(a[0])) return { rows: a[0].rows.map(function (row) { return [row[c - 1]]; }) };
    if (c === 0 && isRange(a[0])) return { rows: [a[0].rows[r - 1]] };
    return at(a[0], r - 1, c - 1);
  }, 'Value at a position', 'INDEX(range, row, [col])');

  /* text */
  function str1(name, f, desc, sig) { reg(name, 1, 1, function (a) { var v = scalar(a[0]); if (isErr(v)) return v; return f(toStr(v)); }, desc, sig); }
  reg('CONCAT', 1, -1, function (args) { var s = '', e = null; each(args, function (v) { if (isErr(v)) { e = v; return false; } s += toStr(v); }); return e || s; }, 'Join text', 'CONCAT(a, b, ...)');
  FNS.CONCATENATE = FNS.CONCAT;
  reg('TEXTJOIN', 3, -1, function (a) {
    var d = toStr(scalar(a[0])), skip = toBool(scalar(a[1])), parts = [], e = null;
    each(a.slice(2), function (v) { if (isErr(v)) { e = v; return false; } if (skip && (v === null || v === '')) return; parts.push(toStr(v)); });
    return e || parts.join(d);
  }, 'Join with a delimiter', 'TEXTJOIN(delimiter, skip_empty, a, b, ...)');
  reg('LEFT', 1, 2, function (a) { var s = toStr(scalar(a[0])), n = a.length > 1 ? toNum(scalar(a[1])) : 1; if (isErr(n)) return n; return n < 0 ? err(E.VALUE) : s.slice(0, n); }, 'Leftmost characters', 'LEFT(text, [n])');
  reg('RIGHT', 1, 2, function (a) { var s = toStr(scalar(a[0])), n = a.length > 1 ? toNum(scalar(a[1])) : 1; if (isErr(n)) return n; return n < 0 ? err(E.VALUE) : n === 0 ? '' : s.slice(-n); }, 'Rightmost characters', 'RIGHT(text, [n])');
  reg('MID', 3, 3, function (a) { var s = toStr(scalar(a[0])), st = toNum(scalar(a[1])), n = toNum(scalar(a[2])); if (isErr(st)) return st; if (isErr(n)) return n; if (st < 1 || n < 0) return err(E.VALUE); return s.substr(st - 1, n); }, 'Characters from the middle', 'MID(text, start, n)');
  str1('LEN', function (s) { return s.length; }, 'Length of text', 'LEN(text)');
  str1('UPPER', function (s) { return s.toUpperCase(); }, 'Upper case', 'UPPER(text)');
  str1('LOWER', function (s) { return s.toLowerCase(); }, 'Lower case', 'LOWER(text)');
  str1('PROPER', function (s) { return s.toLowerCase().replace(/(^|[^a-z'])([a-z])/g, function (m, p, c) { return p + c.toUpperCase(); }); }, 'Capitalise each word', 'PROPER(text)');
  str1('TRIM', function (s) { return s.replace(/\s+/g, ' ').trim(); }, 'Remove extra spaces', 'TRIM(text)');
  reg('SUBSTITUTE', 3, 4, function (a) {
    var s = toStr(scalar(a[0])), o = toStr(scalar(a[1])), nw = toStr(scalar(a[2]));
    if (!o) return s;
    if (a.length > 3) { var k = toNum(scalar(a[3])), idx = -1; for (var i = 0; i < k; i++) { idx = s.indexOf(o, idx + 1); if (idx < 0) return s; } return s.slice(0, idx) + nw + s.slice(idx + o.length); }
    return s.split(o).join(nw);
  }, 'Replace text by match', 'SUBSTITUTE(text, old, new, [instance])');
  reg('REPLACE', 4, 4, function (a) { var s = toStr(scalar(a[0])), st = toNum(scalar(a[1])), n = toNum(scalar(a[2])); if (isErr(st)) return st; if (isErr(n)) return n; return s.slice(0, st - 1) + toStr(scalar(a[3])) + s.slice(st - 1 + n); }, 'Replace text by position', 'REPLACE(text, start, n, new)');
  function findFn(ci) { return function (a) { var f = toStr(scalar(a[0])), s = toStr(scalar(a[1])), st = a.length > 2 ? toNum(scalar(a[2])) : 1; if (isErr(st)) return st; var i = ci ? s.toLowerCase().indexOf(f.toLowerCase(), st - 1) : s.indexOf(f, st - 1); return i < 0 ? err(E.VALUE) : i + 1; }; }
  reg('FIND', 2, 3, findFn(false), 'Position of text (case-sensitive)', 'FIND(find, within, [start])');
  reg('SEARCH', 2, 3, findFn(true), 'Position of text', 'SEARCH(find, within, [start])');
  reg('REPT', 2, 2, function (a) { var n = toNum(scalar(a[1])); if (isErr(n)) return n; return n < 0 ? err(E.VALUE) : toStr(scalar(a[0])).repeat(Math.min(n, 32767)); }, 'Repeat text', 'REPT(text, n)');
  reg('EXACT', 2, 2, function (a) { return toStr(scalar(a[0])) === toStr(scalar(a[1])); }, 'Identical text', 'EXACT(a, b)');
  reg('VALUE', 1, 1, function (a) { var v = scalar(a[0]); if (typeof v === 'number') return v; return toNum(v === null ? '0' : String(v)); }, 'Text to number', 'VALUE(text)');
  reg('TEXT', 2, 2, function (a) { var v = scalar(a[0]); if (isErr(v)) return v; var x = typeof v === 'number' ? v : toNum(v); if (isErr(x)) return toStr(v); return formatPattern(x, toStr(scalar(a[1]))); }, 'Format a number as text', 'TEXT(value, "format")');

  /* dates */
  function d1(name, f, desc, sig) { reg(name, 1, 1, function (a) { var x = toNum(scalar(a[0])); if (isErr(x)) return x; if (x < 0) return err(E.NUM); return f(serialParts(x), x); }, desc, sig); }
  reg('TODAY', 0, 0, function () { return todaySerial(); }, "Today's date (Sydney)", 'TODAY()');
  reg('NOW', 0, 0, function () { return nowSerial(); }, 'Current date and time (Sydney)', 'NOW()');
  reg('DATE', 3, 3, function (a) { var y = toNum(scalar(a[0])), m = toNum(scalar(a[1])), d = toNum(scalar(a[2])); if (isErr(y)) return y; if (isErr(m)) return m; if (isErr(d)) return d; if (y < 100) y += 1900; return dateSerial(Math.floor(y), Math.floor(m), Math.floor(d)); }, 'Build a date', 'DATE(year, month, day)');
  d1('YEAR', function (p) { return p.y; }, 'Year of a date', 'YEAR(date)');
  d1('MONTH', function (p) { return p.m; }, 'Month of a date', 'MONTH(date)');
  d1('DAY', function (p) { return p.d; }, 'Day of a date', 'DAY(date)');
  d1('HOUR', function (p) { return p.h; }, 'Hour of a time', 'HOUR(datetime)');
  d1('MINUTE', function (p) { return p.mi; }, 'Minute of a time', 'MINUTE(datetime)');
  reg('WEEKDAY', 1, 2, function (a) { var x = toNum(scalar(a[0])); if (isErr(x)) return x; var t = a.length > 1 ? toNum(scalar(a[1])) : 1; var d = serialParts(x).dow; if (t === 2) return d === 0 ? 7 : d; if (t === 3) return d === 0 ? 6 : d - 1; return d + 1; }, 'Day of week', 'WEEKDAY(date, [type])');
  function addMonths(x, n) { var p = serialParts(x); var t = new Date(Date.UTC(p.y, p.m - 1 + n, 1)); var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); return dateSerial(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(p.d, last)); }
  reg('EDATE', 2, 2, function (a) { var x = toNum(scalar(a[0])), n = toNum(scalar(a[1])); if (isErr(x)) return x; if (isErr(n)) return n; return addMonths(x, Math.trunc(n)); }, 'Date n months away', 'EDATE(date, months)');
  reg('EOMONTH', 2, 2, function (a) { var x = toNum(scalar(a[0])), n = toNum(scalar(a[1])); if (isErr(x)) return x; if (isErr(n)) return n; var p = serialParts(x); return Math.round((Date.UTC(p.y, p.m + Math.trunc(n), 0) - EPOCH) / 86400000); }, 'End of month', 'EOMONTH(date, months)');
  reg('DAYS', 2, 2, function (a) { var e = toNum(scalar(a[0])), s = toNum(scalar(a[1])); if (isErr(e)) return e; if (isErr(s)) return s; return Math.floor(e) - Math.floor(s); }, 'Days between dates', 'DAYS(end, start)');
  reg('DATEDIF', 3, 3, function (a) {
    var s = toNum(scalar(a[0])), e = toNum(scalar(a[1])); if (isErr(s)) return s; if (isErr(e)) return e; if (s > e) return err(E.NUM);
    var u = toStr(scalar(a[2])).toUpperCase(), ps = serialParts(s), pe = serialParts(e);
    var months = (pe.y - ps.y) * 12 + (pe.m - ps.m) - (pe.d < ps.d ? 1 : 0);
    if (u === 'D') return Math.floor(e) - Math.floor(s);
    if (u === 'M') return months;
    if (u === 'Y') return Math.floor(months / 12);
    if (u === 'YM') return months % 12;
    if (u === 'MD') { var md = pe.d - ps.d; if (md < 0) { md += new Date(Date.UTC(pe.y, pe.m - 1, 0)).getUTCDate(); } return md; }
    if (u === 'YD') { var yd = Math.floor(e) - dateSerial(pe.y - ((pe.m < ps.m || (pe.m === ps.m && pe.d < ps.d)) ? 1 : 0), ps.m, ps.d); return yd; }
    return err(E.NUM);
  }, 'Difference in units', 'DATEDIF(start, end, "D"|"M"|"Y"|"YM"|"MD"|"YD")');
  reg('NETWORKDAYS', 2, 3, function (a) {
    var s = toNum(scalar(a[0])), e = toNum(scalar(a[1])); if (isErr(s)) return s; if (isErr(e)) return e;
    var hol = {}; if (a.length > 2) flat(a[2]).forEach(function (h) { if (typeof h === 'number') hol[Math.floor(h)] = 1; });
    var sign = 1; if (s > e) { var t = s; s = e; e = t; sign = -1; }
    var n = 0; for (var d = Math.floor(s); d <= Math.floor(e); d++) { var w = serialParts(d).dow; if (w !== 0 && w !== 6 && !hol[d]) n++; }
    return n * sign;
  }, 'Working days between dates', 'NETWORKDAYS(start, end, [holidays])');

  /* info */
  reg('ISBLANK', 1, 1, function (a) { var v = scalar(a[0]); return v === null; }, 'Is empty', 'ISBLANK(value)');
  reg('ISNUMBER', 1, 1, function (a) { return typeof scalar(a[0]) === 'number'; }, 'Is a number', 'ISNUMBER(value)');
  reg('ISTEXT', 1, 1, function (a) { return typeof scalar(a[0]) === 'string'; }, 'Is text', 'ISTEXT(value)');
  reg('ISLOGICAL', 1, 1, function (a) { return typeof scalar(a[0]) === 'boolean'; }, 'Is TRUE/FALSE', 'ISLOGICAL(value)');
  reg('ISERROR', 1, 1, function (a) { return isErr(scalar(a[0])); }, 'Is any error', 'ISERROR(value)');
  reg('ISNA', 1, 1, function (a) { var v = scalar(a[0]); return isErr(v) && v.error === E.NA; }, 'Is #N/A', 'ISNA(value)');
  reg('NA', 0, 0, function () { return err(E.NA); }, 'The #N/A error', 'NA()');

  /* finance */
  function fin(a, i, d) { if (a.length <= i || a[i] === null) return d; return toNum(scalar(a[i])); }
  reg('PMT', 3, 5, function (a) { var r = fin(a, 0), n = fin(a, 1), pv = fin(a, 2), fv = fin(a, 3, 0), t = fin(a, 4, 0); var bad = [r, n, pv, fv, t].filter(isErr)[0]; if (bad) return bad; if (n === 0) return err(E.NUM); if (r === 0) return -(pv + fv) / n; var f = Math.pow(1 + r, n); return -(r * (pv * f + fv)) / ((1 + r * t) * (f - 1)); }, 'Loan payment per period', 'PMT(rate, periods, pv, [fv], [type])');
  reg('FV', 3, 5, function (a) { var r = fin(a, 0), n = fin(a, 1), pmt = fin(a, 2), pv = fin(a, 3, 0), t = fin(a, 4, 0); var bad = [r, n, pmt, pv, t].filter(isErr)[0]; if (bad) return bad; if (r === 0) return -(pv + pmt * n); var f = Math.pow(1 + r, n); return -(pv * f + pmt * (1 + r * t) * (f - 1) / r); }, 'Future value', 'FV(rate, periods, pmt, [pv], [type])');
  reg('PV', 3, 5, function (a) { var r = fin(a, 0), n = fin(a, 1), pmt = fin(a, 2), fv = fin(a, 3, 0), t = fin(a, 4, 0); var bad = [r, n, pmt, fv, t].filter(isErr)[0]; if (bad) return bad; if (r === 0) return -(fv + pmt * n); var f = Math.pow(1 + r, n); return -(fv + pmt * (1 + r * t) * (f - 1) / r) / f; }, 'Present value', 'PV(rate, periods, pmt, [fv], [type])');
  reg('NPV', 2, -1, function (a) { var r = toNum(scalar(a[0])); if (isErr(r)) return r; var xs = nums(a.slice(1)); if (isErr(xs)) return xs; var s = 0; xs.forEach(function (x, i) { s += x / Math.pow(1 + r, i + 1); }); return s; }, 'Net present value', 'NPV(rate, value1, ...)');

  // descriptions for aggregates
  var DESC = { SUM: ['Add numbers', 'SUM(a, b, ...)'], AVERAGE: ['Mean', 'AVERAGE(a, b, ...)'], MIN: ['Smallest', 'MIN(a, b, ...)'], MAX: ['Largest', 'MAX(a, b, ...)'], PRODUCT: ['Multiply', 'PRODUCT(a, b, ...)'], MEDIAN: ['Middle value', 'MEDIAN(a, b, ...)'], STDEV: ['Sample standard deviation', 'STDEV(a, b, ...)'], COUNT: ['Count numbers', 'COUNT(a, b, ...)'], COUNTA: ['Count non-empty', 'COUNTA(a, b, ...)'], COUNTBLANK: ['Count empty', 'COUNTBLANK(range)'], CONCATENATE: ['Join text', 'CONCATENATE(a, b, ...)'], TRUE: ['TRUE', 'TRUE()'], FALSE: ['FALSE', 'FALSE()'] };
  Object.keys(DESC).forEach(function (k) { if (FNS[k] && (k === 'CONCATENATE' || !FNS[k].desc)) { FNS[k] = Object.assign({}, FNS[k], { desc: DESC[k][0], sig: DESC[k][1] }); } });

  function registerFunction(name, impl, o) { o = o || {}; reg(name.toUpperCase(), o.minArgs || 0, o.maxArgs === undefined ? -1 : o.maxArgs, impl, o.description, o.signature); }
  function listFunctions() { return Object.keys(FNS).filter(function (k) { return k !== 'TRUE' && k !== 'FALSE'; }).sort().map(function (k) { return { name: k, desc: FNS[k].desc, sig: FNS[k].sig }; }); }

  /* ---------- formats ---------- */
  function group3(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function fixed(n, dp, sep) { var neg = n < 0; var s = Math.abs(n).toFixed(dp); var p = s.split('.'); if (sep) p[0] = group3(p[0]); var out = p.join('.'); return (neg && parseFloat(s) !== 0 ? '-' : '') + out; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function fmtDate(x) { var p = serialParts(x); return pad2(p.d) + '/' + pad2(p.m) + '/' + p.y; }
  function fmtTime(x) { var p = serialParts(x); var h = p.h % 12 || 12; return h + ':' + pad2(p.mi) + ' ' + (p.h < 12 ? 'am' : 'pm'); }
  function format(v, f, dp) {
    if (isErr(v)) return v.error;
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'string') return v;
    if (isRange(v)) return format(scalar(v), f, dp);
    f = f || 'general';
    switch (f) {
      case 'number': return fixed(v, dp === undefined ? 2 : dp, true);
      case 'currency': { var s = fixed(Math.abs(v), dp === undefined ? 2 : dp, true); return (v < 0 && parseFloat(s.replace(/,/g, '')) !== 0 ? '-$' : '$') + s; }
      case 'percent': return fixed(v * 100, dp === undefined ? 1 : dp, true) + '%';
      case 'date': return fmtDate(v);
      case 'datetime': return fmtDate(v) + ' ' + fmtTime(v);
      case 'time': return fmtTime(v);
      default: return dp !== undefined ? fixed(v, dp, false) : fmtGeneral(v);
    }
  }
  function formatPattern(x, pat) {
    var p = pat;
    if (/[dmyhs]/i.test(p.replace(/"[^"]*"/g, '')) && !/[0#]/.test(p)) {
      var d = serialParts(x);
      return p.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|am\/pm/gi, function (t) {
        var l = t.toLowerCase();
        switch (l) {
          case 'yyyy': return String(d.y); case 'yy': return pad2(d.y % 100);
          case 'mmmm': return MONL[d.m - 1]; case 'mmm': return MON[d.m - 1]; case 'mm': return pad2(d.m); case 'm': return String(d.m);
          case 'dddd': return DOWL[d.dow]; case 'ddd': return DOW[d.dow]; case 'dd': return pad2(d.d); case 'd': return String(d.d);
          case 'hh': return pad2(d.h); case 'h': return String(d.h); case 'ss': return pad2(d.s); case 'am/pm': return d.h < 12 ? 'am' : 'pm';
        }
        return t;
      }).replace(/:mm|:m/g, function () { return ':' + pad2(d.mi); });
    }
    var pct = /%/.test(p), cur = /\$/.test(p), sep = /,/.test(p);
    var m = /\.([0#]+)/.exec(p), dp = m ? m[1].length : 0;
    var val = pct ? x * 100 : x;
    var s = fixed(Math.abs(val), dp, sep);
    return (val < 0 && parseFloat(s.replace(/,/g, '')) !== 0 ? '-' : '') + (cur ? '$' : '') + s + (pct ? '%' : '');
  }

  // Raw cell input -> literal value (+ suggested format)
  function literal(raw) {
    if (raw === null || raw === undefined || raw === '') return { v: null };
    var s = String(raw);
    if (s[0] === "'") return { v: s.slice(1) };
    var t = s.trim(), u = t.toUpperCase();
    if (u === 'TRUE') return { v: true }; if (u === 'FALSE') return { v: false };
    var n = parseNumText(t);
    if (n !== null) return { v: n, fmt: /^-?\$|^\(\$/.test(t) ? 'currency' : /%$/.test(t) ? 'percent' : null };
    var d = parseDateText(t); if (d !== null) return { v: d, fmt: 'date' };
    return { v: s };
  }

  /* ---------- reference rewriting ---------- */
  function refText(ref, orig) {
    function cellT(c, r, ac, ar) { return (ac ? '$' : '') + colToLetters(c) + (ar ? '$' : '') + (r + 1); }
    var prefix = orig.slice(0, orig.lastIndexOf('!') + 1);
    if (ref.kind === 'cell') return prefix + cellT(ref.c1, ref.r1, ref.ac1, ref.ar1);
    if (ref.kind === 'range') return prefix + cellT(ref.c1, ref.r1, ref.ac1, ref.ar1) + ':' + cellT(ref.c2, ref.r2, ref.ac2, ref.ar2);
    if (ref.kind === 'cols') return prefix + (ref.ac1 ? '$' : '') + colToLetters(ref.c1) + ':' + (ref.ac2 ? '$' : '') + colToLetters(ref.c2);
    return prefix + (ref.ar1 ? '$' : '') + (ref.r1 + 1) + ':' + (ref.ar2 ? '$' : '') + (ref.r2 + 1);
  }
  // mapRef(ref) -> null (keep), '#REF!' or new ref object
  function rewrite(src, mapRef) {
    var toks; try { toks = tokenize(src); } catch (e) { return src; }
    var out = '', last = 0, changed = false;
    toks.forEach(function (t) {
      if (t.t !== 'ref') return;
      var r = mapRef(Object.assign({}, t.ref));
      if (r === null || r === undefined) return;
      var orig = src.slice(t.s, t.e);
      out += src.slice(last, t.s) + (r === '#REF!' ? '#REF!' : refText(r, orig));
      last = t.e; changed = true;
    });
    return changed ? out + src.slice(last) : src;
  }
  // shift for insert/delete along axis ('row'|'col') at index by count (+ insert, - delete)
  function shiftRef(ref, axis, index, count) {
    var a1 = axis === 'row' ? 'r1' : 'c1', a2 = axis === 'row' ? 'r2' : 'c2';
    if ((axis === 'row' && ref.kind === 'cols') || (axis === 'col' && ref.kind === 'rows')) return null;
    var lo = ref[a1], hi = ref[a2], changed = false;
    if (count > 0) {
      if (lo >= index) { lo += count; changed = true; }
      if (hi >= index) { hi += count; changed = true; }
    } else {
      var n = -count, end = index + n - 1;
      if (lo >= index && hi <= end) return '#REF!';
      if (lo > end) { lo -= n; changed = true; } else if (lo >= index) { lo = index; changed = true; }
      if (hi > end) { hi -= n; changed = true; } else if (hi >= index) { hi = index - 1; changed = true; }
    }
    if (!changed) return null;
    ref[a1] = lo; ref[a2] = hi; return ref;
  }
  function quoteSheet(name) { return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : "'" + name.replace(/'/g, "''") + "'"; }
  function renameSheetIn(src, oldName, newName, isLocal) {
    var toks; try { toks = tokenize(src); } catch (e) { return src; }
    var out = '', last = 0, changed = false;
    toks.forEach(function (t) {
      if (t.t !== 'ref' || !t.ref.sheet || t.ref.sheet.toLowerCase() !== oldName.toLowerCase()) return;
      if (!isLocal(t.ref.wb)) return;
      var orig = src.slice(t.s, t.e), bang = orig.lastIndexOf('!');
      var wbPart = t.ref.wb !== null ? '[' + t.ref.wb + ']' : '';
      out += src.slice(last, t.s) + wbPart + quoteSheet(newName) + '!' + orig.slice(bang + 1);
      last = t.e; changed = true;
    });
    return changed ? out + src.slice(last) : src;
  }

  function evaluate(src, env) {
    var ast;
    try { ast = parse(src); } catch (e) { return { error: E.NAME, message: e.message }; }
    var v = ev(ast, env || {});
    return v === undefined ? null : v;
  }
  function topFn(src) { try { var a = parse(src); return a.t === 'fn' ? a.name : null; } catch (e) { return null; } }
  function parseError(src) { try { parse(src); return null; } catch (e) { return e.message; } }
  function hasVolatile(src) { return /\b(RAND|RANDBETWEEN|NOW|TODAY)\s*\(/i.test(src); }

  return {
    E: E, err: err, isErr: isErr, isRange: isRange, scalar: scalar, cmp: cmp, toNum: toNum, toStr: toStr, toBool: toBool,
    colToLetters: colToLetters, lettersToCol: lettersToCol, toA1: toA1, fromA1: fromA1, parseRange: parseRange,
    tokenize: tokenize, parse: parse, evaluate: evaluate, topFn: topFn, parseError: parseError, hasVolatile: hasVolatile,
    format: format, formatPattern: formatPattern, literal: literal, fmtDate: fmtDate, fmtTime: fmtTime,
    dateSerial: dateSerial, serialParts: serialParts, isoToSerial: isoToSerial, serialToIso: serialToIso, parseDateText: parseDateText, todaySerial: todaySerial, nowSerial: nowSerial, sydneyNow: sydneyNow,
    rewrite: rewrite, shiftRef: shiftRef, renameSheetIn: renameSheetIn, quoteSheet: quoteSheet,
    registerFunction: registerFunction, listFunctions: listFunctions, MON: MON, MONL: MONL, DOW: DOW, pad2: pad2
  };
})();

/* Custom functions (the spec's custom.js equivalent): add your own with FE.registerFunction. */
// Matches the previous Truss so existing formulas keep their results: GST to add to an amount, default 10%.
//   =GST(100) -> 10     =GST(A1, 0.15) -> A1 * 0.15
FE.registerFunction('GST', function (a) {
  var x = FE.toNum(FE.scalar(a[0])); if (FE.isErr(x)) return x;
  var r = a.length > 1 && a[1] !== null && a[1] !== undefined && a[1] !== '' ? FE.toNum(FE.scalar(a[1])) : 0.1; if (FE.isErr(r)) return r;
  if (r < 0) return { error: '#NUM!' };
  return x * r;
}, { minArgs: 1, maxArgs: 2, description: 'GST component of an amount (default rate 10%)', signature: 'GST(amount, [rate])' });
