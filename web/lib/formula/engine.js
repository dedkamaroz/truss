// Workbook engine: sheets, cells, dependency graph, iterative incremental recalculation, structural rewrites.
import { E, MAX_ROW, MAX_COL, isError, sameValue, parseLiteral } from './values.js';
import { parse, walk, rewriteRefs } from './parser.js';
import { evaluate, scalarOf } from './evaluator.js';
import { isVolatile } from './functions.js';
import { formatValue } from './format.js';

const key = (row, col) => row * MAX_COL + col;
const lower = (s) => String(s).toLowerCase();
// Range listeners are indexed in coarse buckets so an edit only checks nearby ranges.
const BUCKET_ROWS = 256, BUCKET_COLS = 32, MAX_BUCKETS = 64;
const bucketKey = (br, bc) => br * 1024 + bc;
const DATE_RESULT = { DATE: 'date', TODAY: 'date', EDATE: 'date', EOMONTH: 'date', NOW: 'datetime' };

export function createWorkbookEngine({ resolveExternal } = {}) {
  const sheets = new Map(); // lower name -> sheet
  const volatiles = new Set();
  const externals = new Set(); // formula cells with external references

  function makeSheet(name) {
    return { name, cells: new Map(), buckets: new Map(), bigRanges: new Set(), maxRow: -1, maxCol: -1 };
  }
  const sheetOf = (name) => sheets.get(lower(name));
  function requireSheet(name) {
    const s = sheetOf(name);
    if (!s) throw new Error(`Unknown sheet: ${name}`);
    return s;
  }
  function getOrCreate(sheet, row, col) {
    const k = key(row, col);
    let c = sheet.cells.get(k);
    if (!c) {
      c = { sheet, row, col, raw: null, value: null, literal: null, format: undefined, ast: null, formula: false, dependents: new Set(), precCells: [], precRanges: [], extNames: null, missingSheet: false };
      sheet.cells.set(k, c);
    }
    return c;
  }
  function dropIfUnused(c) {
    if (c.raw === null && !c.formula && c.dependents.size === 0 && c.sheet.cells.get(key(c.row, c.col)) === c) c.sheet.cells.delete(key(c.row, c.col));
  }

  // ---------- dependency registration ----------
  function unregister(c) {
    for (const u of c.precCells) { u.dependents.delete(c); dropIfUnused(u); }
    for (const L of c.precRanges) removeRange(L);
    c.precCells = [];
    c.precRanges = [];
    c.extNames = null;
    c.missingSheet = false;
    volatiles.delete(c);
    externals.delete(c);
  }
  function register(c) {
    if (!c.ast) return;
    const seen = new Set();
    walk(c.ast, (node) => {
      if (node.type === 'call' && isVolatile(node.name)) volatiles.add(c);
      if (node.type !== 'ref') return;
      const ref = node.ref;
      if (ref.wb !== null) {
        (c.extNames ||= new Set()).add(lower(ref.wb));
        externals.add(c);
        return;
      }
      const s = ref.sheet ? sheetOf(ref.sheet) : c.sheet;
      if (!s) { c.missingSheet = true; return; }
      if (ref.kind === 'cell') {
        const u = getOrCreate(s, ref.r1, ref.c1);
        if (seen.has(u)) return;
        seen.add(u);
        u.dependents.add(c);
        c.precCells.push(u);
      } else {
        const L = { sheet: s, r1: ref.r1, c1: ref.c1, r2: ref.r2, c2: ref.c2, cell: c };
        addRange(L);
        c.precRanges.push(L);
      }
    });
  }
  function spanBuckets(L, fn) {
    const br1 = Math.floor(L.r1 / BUCKET_ROWS), br2 = Math.floor(L.r2 / BUCKET_ROWS);
    const bc1 = Math.floor(L.c1 / BUCKET_COLS), bc2 = Math.floor(L.c2 / BUCKET_COLS);
    for (let br = br1; br <= br2; br++) for (let bc = bc1; bc <= bc2; bc++) fn(bucketKey(br, bc));
  }
  function isBig(L) {
    return (Math.floor(L.r2 / BUCKET_ROWS) - Math.floor(L.r1 / BUCKET_ROWS) + 1) * (Math.floor(L.c2 / BUCKET_COLS) - Math.floor(L.c1 / BUCKET_COLS) + 1) > MAX_BUCKETS;
  }
  function addRange(L) {
    const { buckets } = L.sheet;
    if (isBig(L)) { L.sheet.bigRanges.add(L); return; }
    spanBuckets(L, (k) => {
      let set = buckets.get(k);
      if (!set) buckets.set(k, (set = new Set()));
      set.add(L);
    });
  }
  function removeRange(L) {
    if (isBig(L)) { L.sheet.bigRanges.delete(L); return; }
    spanBuckets(L, (k) => {
      const set = L.sheet.buckets.get(k);
      if (set) { set.delete(L); if (!set.size) L.sheet.buckets.delete(k); }
    });
  }
  function forEachDependent(u, fn) {
    for (const v of u.dependents) fn(v);
    const { row, col, sheet } = u;
    const near = sheet.buckets.size ? sheet.buckets.get(bucketKey(Math.floor(row / BUCKET_ROWS), Math.floor(col / BUCKET_COLS))) : undefined;
    if (near) for (const L of near) if (row >= L.r1 && row <= L.r2 && col >= L.c1 && col <= L.c2) fn(L.cell);
    // ponytail: large ranges (whole columns etc.) are scanned linearly; fine for the handful a sheet usually has
    for (const L of sheet.bigRanges) if (row >= L.r1 && row <= L.r2 && col >= L.c1 && col <= L.c2) fn(L.cell);
  }

  // ---------- evaluation ----------
  function readRange(s, ref) {
    let { r1, c1, r2, c2 } = ref;
    if (ref.kind === 'cols') r2 = Math.min(r2, s.maxRow);
    if (ref.kind === 'rows') c2 = Math.min(c2, s.maxCol);
    if (r2 < r1 || c2 < c1) return [[null]];
    const out = new Array(r2 - r1 + 1);
    for (let r = r1; r <= r2; r++) {
      const row = new Array(c2 - c1 + 1);
      for (let col = c1; col <= c2; col++) {
        const cell = s.cells.get(key(r, col));
        row[col - c1] = cell ? cell.value : null;
      }
      out[r - r1] = row;
    }
    return out;
  }
  function readExternal(ref) {
    if (!resolveExternal) return E.REF;
    if (ref.kind === 'cols' || ref.kind === 'rows') return E.REF; // ponytail: unbounded external ranges unsupported
    const get = (r, col) => {
      const v = resolveExternal(ref.wb, ref.sheet, r, col);
      return v === undefined ? null : v;
    };
    if (ref.kind === 'cell') return get(ref.r1, ref.c1);
    const out = [];
    for (let r = ref.r1; r <= ref.r2; r++) {
      const row = [];
      for (let col = ref.c1; col <= ref.c2; col++) row.push(get(r, col));
      out.push(row);
    }
    return out;
  }
  function computeCell(c) {
    if (!c.formula) return c.literal;
    if (!c.ast) return E.VALUE;
    const cx = {
      ref(ref) {
        if (ref.wb !== null) {
          try { return readExternal(ref); } catch { return E.REF; }
        }
        const s = ref.sheet ? sheetOf(ref.sheet) : c.sheet;
        if (!s) return E.REF;
        if (ref.kind === 'cell') {
          const u = s.cells.get(key(ref.r1, ref.c1));
          return u ? u.value : null;
        }
        return readRange(s, ref);
      },
    };
    let v = scalarOf(evaluate(c.ast, cx));
    if (v === null || v === undefined) v = 0;
    return v;
  }

  // ---------- recalculation (iterative Kahn + Tarjan for cycles) ----------
  function recalc(seeds, changedOut) {
    for (const v of volatiles) seeds.add(v);
    const indeg = new Map();
    const stack = [];
    for (const s of seeds) { indeg.set(s, 0); stack.push(s); }
    while (stack.length) {
      const u = stack.pop();
      forEachDependent(u, (v) => {
        const d = indeg.get(v);
        if (d === undefined) { indeg.set(v, 1); stack.push(v); } else indeg.set(v, d + 1);
      });
    }
    const needs = new Set(seeds);
    const queue = [];
    for (const [c, d] of indeg) if (d === 0) queue.push(c);
    let done = 0;
    const process = (u, value) => {
      const old = u.value;
      const nv = value !== undefined ? value : needs.has(u) ? computeCell(u) : old;
      const changed = !sameValue(old, nv);
      if (changed) { u.value = nv; changedOut.add(u); }
      forEachDependent(u, (v) => {
        const d = indeg.get(v);
        if (d === undefined || d === 0) return;
        if (changed) needs.add(v);
        indeg.set(v, d - 1);
        if (d === 1) queue.push(v);
      });
    };
    const drain = () => {
      while (queue.length) { process(queue.pop()); done++; }
    };
    drain();
    if (done < indeg.size) {
      // Remaining nodes are cycles or downstream of cycles.
      const remaining = [...indeg].filter(([, d]) => d > 0).map(([c]) => c);
      const members = cycleMembers(remaining, indeg);
      for (const c of members) indeg.set(c, 0);
      for (const c of members) { process(c, E.CYCLE); done++; }
      drain();
    }
  }

  /** Nodes in non-trivial strongly connected components (or self-loops), via iterative Tarjan. */
  function cycleMembers(nodes, indeg) {
    const inSet = new Set(nodes);
    const adj = new Map();
    for (const n of nodes) {
      const list = [];
      forEachDependent(n, (v) => { if (inSet.has(v) && indeg.get(v) > 0) list.push(v); });
      adj.set(n, list);
    }
    const index = new Map(), low = new Map(), onStack = new Set(), st = [], out = [];
    let counter = 0;
    for (const root of nodes) {
      if (index.has(root)) continue;
      const work = [[root, 0]];
      index.set(root, counter); low.set(root, counter); counter++;
      st.push(root); onStack.add(root);
      while (work.length) {
        const frame = work[work.length - 1];
        const [v, i] = frame;
        const edges = adj.get(v);
        if (i < edges.length) {
          frame[1]++;
          const w = edges[i];
          if (!index.has(w)) {
            index.set(w, counter); low.set(w, counter); counter++;
            st.push(w); onStack.add(w);
            work.push([w, 0]);
          } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        } else {
          work.pop();
          if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
          if (low.get(v) === index.get(v)) {
            const comp = [];
            let w;
            do { w = st.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
            if (comp.length > 1 || edges.includes(v)) out.push(...comp);
          }
        }
      }
    }
    return out;
  }

  function toChanges(set) {
    return [...set].map((c) => ({ sheet: c.sheet.name, row: c.row, col: c.col }));
  }

  // ---------- cell content ----------
  function assign(c, raw) {
    unregister(c);
    c.raw = raw === undefined || raw === '' ? null : raw;
    c.format = undefined;
    c.ast = null;
    c.literal = null;
    if (c.raw !== null) {
      if (c.row > c.sheet.maxRow) c.sheet.maxRow = c.row;
      if (c.col > c.sheet.maxCol) c.sheet.maxCol = c.col;
    }
    c.formula = typeof raw === 'string' && raw.length > 1 && raw[0] === '=';
    if (c.formula) {
      try { c.ast = parse(raw.slice(1)); } catch { c.ast = null; }
      register(c);
      if (c.ast && c.ast.type === 'call') c.format = DATE_RESULT[c.ast.name]; // like Excel's automatic date formatting
    } else {
      const lit = parseLiteral(c.raw);
      c.format = lit.format;
      c.literal = lit.value;
    }
  }

  function setCells(entries) {
    const seeds = new Set();
    for (const { sheet, row, col, raw } of entries) {
      if (!(row >= 0 && row < MAX_ROW && col >= 0 && col < MAX_COL)) throw new RangeError(`Cell out of range: ${row},${col}`);
      const s = sheetOf(sheet) || addSheetInternal(String(sheet));
      const c = getOrCreate(s, row, col);
      assign(c, raw);
      seeds.add(c);
    }
    const changed = new Set();
    recalc(seeds, changed);
    for (const c of seeds) dropIfUnused(c);
    return toChanges(changed);
  }

  // ---------- full rebuild (structural changes) ----------
  function snapshot() {
    const vals = new Map();
    for (const s of sheets.values()) for (const c of s.cells.values()) if (c.value !== null) vals.set(`${c.row}|${c.col}|${lower(s.name)}`, c.value);
    return vals;
  }
  function diffSnapshot(before) {
    const after = snapshot();
    const out = [];
    const push = (k) => {
      const [r, c, ...rest] = k.split('|');
      const s = sheets.get(rest.join('|'));
      if (s) out.push({ sheet: s.name, row: Number(r), col: Number(c) });
    };
    for (const [k, v] of after) if (!before.has(k) || !sameValue(before.get(k), v)) push(k);
    for (const k of before.keys()) if (!after.has(k)) push(k);
    return out;
  }
  function rebuildAll() {
    volatiles.clear();
    externals.clear();
    const formulas = [];
    for (const s of sheets.values()) {
      s.buckets.clear();
      s.bigRanges.clear();
      s.maxRow = -1;
      s.maxCol = -1;
      for (const c of s.cells.values()) {
        c.dependents.clear();
        c.precCells = [];
        c.precRanges = [];
        c.extNames = null;
        c.missingSheet = false;
        if (c.raw !== null) { s.maxRow = Math.max(s.maxRow, c.row); s.maxCol = Math.max(s.maxCol, c.col); }
        if (c.formula) formulas.push(c);
      }
    }
    for (const c of formulas) {
      try { c.ast = parse(c.raw.slice(1)); } catch { c.ast = null; }
      register(c);
    }
    for (const s of sheets.values()) for (const c of [...s.cells.values()]) dropIfUnused(c);
    recalc(new Set(formulas), new Set());
  }
  function rewriteAllFormulas(fn) {
    for (const s of sheets.values()) {
      for (const c of s.cells.values()) {
        if (!c.formula) continue;
        try {
          const next = rewriteRefs(c.raw.slice(1), (ref) => fn(ref, s));
          if (next !== c.raw.slice(1)) c.raw = '=' + next;
        } catch { /* unparsable formula text stays as typed */ }
      }
    }
  }

  function shiftSpan(lo, hi, index, count, insert, max) {
    if (insert) {
      if (lo >= index) return [Math.min(lo + count, max - 1), Math.min(hi + count, max - 1)];
      if (hi >= index) return [lo, Math.min(hi + count, max - 1)];
      return [lo, hi];
    }
    const end = index + count - 1;
    if (lo >= index && hi <= end) return null;
    const nlo = lo < index ? lo : lo <= end ? index : lo - count;
    const nhi = hi < index ? hi : hi <= end ? index - 1 : hi - count;
    return [nlo, nhi];
  }

  function structural(sheetName, axis, index, count, insert) {
    const target = requireSheet(sheetName);
    if (!(count > 0) || !(index >= 0)) return [];
    const before = snapshot();
    const isRow = axis === 'row';
    const max = isRow ? MAX_ROW : MAX_COL;
    rewriteAllFormulas((ref, host) => {
      if (ref.wb !== null) return undefined;
      const s = ref.sheet ? sheetOf(ref.sheet) : host;
      if (s !== target) return undefined;
      if ((isRow && ref.kind === 'cols') || (!isRow && ref.kind === 'rows')) return undefined;
      const lo = isRow ? ref.r1 : ref.c1, hi = isRow ? ref.r2 : ref.c2;
      const span = shiftSpan(lo, hi, index, count, insert, max);
      if (span === null) return null;
      if (span[0] === lo && span[1] === hi) return undefined;
      return isRow ? { ...ref, r1: span[0], r2: span[1] } : { ...ref, c1: span[0], c2: span[1] };
    });
    const moved = new Map();
    for (const c of target.cells.values()) {
      let p = isRow ? c.row : c.col;
      if (insert) { if (p >= index) p += count; }
      else if (p >= index && p < index + count) continue;
      else if (p >= index + count) p -= count;
      if (p >= max) continue;
      if (isRow) c.row = p; else c.col = p;
      moved.set(key(c.row, c.col), c);
    }
    target.cells = moved;
    rebuildAll();
    return diffSnapshot(before);
  }

  function addSheetInternal(name) {
    const k = lower(name);
    if (!String(name).trim()) throw new Error('Sheet name required');
    if (sheets.has(k)) throw new Error(`Sheet already exists: ${name}`);
    const s = makeSheet(String(name));
    sheets.set(k, s);
    let pending = false;
    for (const t of sheets.values()) for (const c of t.cells.values()) if (c.missingSheet) pending = true;
    if (pending) rebuildAll();
    return s;
  }

  const cellAt = (sheet, row, col) => {
    const s = sheetOf(sheet);
    return s ? s.cells.get(key(row, col)) : undefined;
  };

  return {
    addSheet(name) {
      return addSheetInternal(name).name;
    },
    hasSheet: (name) => sheets.has(lower(name)),
    sheetNames: () => [...sheets.values()].map((s) => s.name),
    renameSheet(oldName, newName) {
      const s = requireSheet(oldName);
      const nk = lower(newName);
      if (!String(newName).trim()) throw new Error('Sheet name required');
      if (sheets.has(nk) && sheets.get(nk) !== s) throw new Error(`Sheet already exists: ${newName}`);
      const before = snapshot();
      rewriteAllFormulas((ref) => (ref.wb === null && ref.sheet && sheetOf(ref.sheet) === s ? { ...ref, sheet: String(newName) } : undefined));
      sheets.delete(lower(s.name));
      s.name = String(newName);
      sheets.set(nk, s);
      rebuildAll();
      return diffSnapshot(before);
    },
    removeSheet(name) {
      const s = requireSheet(name);
      const before = snapshot();
      rewriteAllFormulas((ref, host) => (ref.wb === null && ref.sheet && host !== s && sheetOf(ref.sheet) === s ? null : undefined));
      sheets.delete(lower(s.name));
      rebuildAll();
      return diffSnapshot(before);
    },
    setCell: (sheet, row, col, raw) => setCells([{ sheet, row, col, raw }]),
    /** Batch variant: [{ sheet, row, col, raw }] with a single recalculation pass. */
    setCells,
    getValue(sheet, row, col) {
      const c = cellAt(sheet, row, col);
      return c ? c.value : null;
    },
    getRaw(sheet, row, col) {
      const c = cellAt(sheet, row, col);
      return c && c.raw !== null ? c.raw : '';
    },
    /** Format inferred from literal input ('date', 'percent', 'currency', 'datetime', 'text') or undefined. */
    getInferredFormat(sheet, row, col) {
      return cellAt(sheet, row, col)?.format;
    },
    getDisplay(sheet, row, col, format) {
      const c = cellAt(sheet, row, col);
      if (!c) return '';
      return formatValue(c.value, format ?? c.format);
    },
    insertRows: (sheet, index, count = 1) => structural(sheet, 'row', index, count, true),
    deleteRows: (sheet, index, count = 1) => structural(sheet, 'row', index, count, false),
    insertCols: (sheet, index, count = 1) => structural(sheet, 'col', index, count, true),
    deleteCols: (sheet, index, count = 1) => structural(sheet, 'col', index, count, false),
    invalidateExternal(workbookName) {
      const wk = lower(workbookName);
      const seeds = new Set([...externals].filter((c) => c.extNames && c.extNames.has(wk)));
      const changed = new Set();
      recalc(seeds, changed);
      return toChanges(changed);
    },
    /** Recalculate volatile cells (TODAY/NOW/RAND) and return changed cells. */
    recalculateVolatile() {
      const changed = new Set();
      recalc(new Set(), changed);
      return toChanges(changed);
    },
  };
}

export { isError };
