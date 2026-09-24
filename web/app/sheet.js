/* ================= workbooks ================= */
var ROW_H = 26, HEAD_H = 26, RH_W = 48, COL_W = 104;
var CELL_FORMATS = [['general', 'General'], ['number', 'Number'], ['currency', 'Currency (AUD)'], ['percent', 'Percent'], ['date', 'Date'], ['datetime', 'Date and time'], ['text', 'Plain text']];
var FILLS = [['', 'No fill'], ['yellow', 'Yellow'], ['orange', 'Orange'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['pink', 'Pink'], ['red', 'Red'], ['brown', 'Brown'], ['gray', 'Grey']];
var FONT_COLORS = [['', 'Default'], ['gray', 'Grey'], ['brown', 'Brown'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'], ['purple', 'Purple'], ['pink', 'Pink'], ['red', 'Red']];
var DATE_FNS = { DATE: 'date', TODAY: 'date', EDATE: 'date', EOMONTH: 'date', NOW: 'datetime' };

var SheetMix = {
  wb: function (id) { var m = this.mod(id); return m && m.type === 'sheet' ? m : null; },
  wbByName: function (name) { var n = lc(name); return this.ws.modules.filter(function (m) { return m.type === 'sheet' && !m.archivedAt && lc(m.title) === n; })[0] || null; },
  sheetByName: function (wb, name) { var n = lc(name); return wb.sheets.filter(function (s) { return lc(s.name) === n; })[0] || null; },
  activeSheet: function (wb) { var s = byId(wb.sheets, wb.activeSheetId); if (!s) { s = wb.sheets[0]; wb.activeSheetId = s.id; } return s; },
  ui: function (wb) {
    var u = this.S.sheetUI[wb.id];
    if (!u) u = this.S.sheetUI[wb.id] = { sel: {}, edit: null, undo: [], redo: [], clip: null, sugIdx: 0 };
    var sh = this.activeSheet(wb);
    if (!u.sel[sh.id]) u.sel[sh.id] = { r: 0, c: 0, r2: 0, c2: 0 };
    return u;
  },
  selOf: function (wb) { var u = this.ui(wb); return u.sel[this.activeSheet(wb).id]; },

  /* ---------- calculation ---------- */
  cellValue: function (wb, sh, r, c) {
    var key = 'S|' + sh.id + '|' + r + ',' + c;
    if (this.calc.has(key)) return this.calc.get(key);
    var raw = sh.cells[r + ',' + c], v;
    if (raw === undefined || raw === '') v = null;
    else if (raw[0] === '=' && raw.length > 1) {
      if (this.calcStack.has(key)) return FE.err('#CYCLE!');
      this.calcStack.add(key);
      try { v = FE.evaluate(raw.slice(1), this.sheetEnv(wb, sh)); } finally { this.calcStack.delete(key); }
      if (FE.isRange(v)) v = FE.scalar(v);
      if (v && v.message) v = { error: v.error, message: v.message };
    } else v = FE.literal(raw).v;
    this.calc.set(key, v);
    return v;
  },
  sheetEnv: function (wb, sh) {
    var self = this;
    function target(wbName, sheetName) {
      var twb = wbName ? self.wbByName(wbName) : wb;
      if (!twb) return null;
      var tsh = sheetName ? self.sheetByName(twb, sheetName) : (wbName ? twb.sheets[0] : sh);
      return tsh ? { wb: twb, sh: tsh } : null;
    }
    return {
      cell: function (wbName, sheetName, r, c) {
        var t = target(wbName, sheetName);
        if (!t) { var e = FE.err('#REF!'); e.sheetMissing = true; return e; }
        var v = self.cellValue(t.wb, t.sh, r, c);
        return v && v.message ? { error: v.error } : v;
      },
      bounds: function (wbName, sheetName) {
        var t = target(wbName, sheetName);
        if (!t) return FE.err('#REF!');
        var mr = 0, mc = 0; Object.keys(t.sh.cells).forEach(function (k) { var p = k.split(','); mr = Math.max(mr, +p[0] + 1); mc = Math.max(mc, +p[1] + 1); });
        return { rows: mr, cols: mc };
      }
    };
  },
  cellFormat: function (sh, r, c) {
    var f = sh.fmt[r + ',' + c] || {}, raw = sh.cells[r + ',' + c];
    if (f.f && f.f !== 'general') return f.f;
    if (raw && raw[0] === '=') { var t = FE.topFn(raw.slice(1)); if (t && DATE_FNS[t]) return DATE_FNS[t]; return 'general'; }
    if (raw) { var l = FE.literal(raw); if (l.fmt) return l.fmt; }
    return 'general';
  },
  cellDisplay: function (wb, sh, r, c) {
    var v = this.cellValue(wb, sh, r, c), f = sh.fmt[r + ',' + c] || {}, fmt = this.cellFormat(sh, r, c);
    var raw = sh.cells[r + ',' + c];
    var text = fmt === 'text' && raw !== undefined ? String(raw) : FE.format(v, fmt, f.dp);
    var isNum = typeof v === 'number' && fmt !== 'text', isErr = FE.isErr(v), isBool = typeof v === 'boolean';
    return { v: v, text: text, align: f.al || (isNum ? 'right' : isBool || isErr ? 'center' : 'left'), isNum: isNum, isErr: isErr };
  },

  /* ---------- undo ---------- */
  snap: function (wb) { return JSON.stringify({ sheets: wb.sheets, active: wb.activeSheetId }); },
  pushUndo: function (wb) { var u = this.ui(wb); u.undo.push(this.snap(wb)); if (u.undo.length > 80) u.undo.shift(); u.redo = []; },
  restoreSnap: function (wb, s) { var o = JSON.parse(s); wb.sheets = o.sheets; wb.activeSheetId = o.active; this.changed(wb); },
  undo: function (wb) { var u = this.ui(wb); if (!u.undo.length) return this.toast('Nothing to undo', 'info'); u.redo.push(this.snap(wb)); this.restoreSnap(wb, u.undo.pop()); },
  redo: function (wb) { var u = this.ui(wb); if (!u.redo.length) return this.toast('Nothing to redo', 'info'); u.undo.push(this.snap(wb)); this.restoreSnap(wb, u.redo.pop()); },

  /* ---------- editing ---------- */
  setRaw: function (wb, sh, r, c, raw, noUndo) {
    if (!noUndo) this.pushUndo(wb);
    var k = r + ',' + c;
    if (raw === '' || raw === null || raw === undefined) delete sh.cells[k]; else sh.cells[k] = String(raw);
    if (r >= sh.rowsN - 1) sh.rowsN = r + 21;
    if (c >= sh.colsN - 1) sh.colsN = c + 3;
  },
  startEdit: function (wb, text, origin) {
    var u = this.ui(wb), sel = this.selOf(wb), sh = this.activeSheet(wb);
    var raw = sh.cells[sel.r + ',' + sel.c];
    u.edit = { r: sel.r, c: sel.c, sheetId: sh.id, text: text === undefined ? (raw === undefined ? '' : raw) : text, origin: origin || 'cell', orig: raw === undefined ? '' : raw };
    u.sugIdx = 0;
    this.bump();
    this.focusSel(origin === 'bar' ? '[data-bar]' : '[data-celled]', 'end');
  },
  commitEdit: function (wb, dr, dc) {
    var u = this.ui(wb), E = u.edit; if (!E) return;
    u.edit = null;
    var sh = byId(wb.sheets, E.sheetId);
    if (sh && E.text !== E.orig) {
      var t = E.text;
      if (t[0] === '=' && t.length > 1) { var opens = (t.match(/\(/g) || []).length - (t.match(/\)/g) || []).length; if (opens > 0 && opens < 6) t += new Array(opens + 1).join(')'); }
      this.setRaw(wb, sh, E.r, E.c, t);
      if (!(sh.fmt[E.r + ',' + E.c] || {}).f) { var l = FE.literal(t); if (l.fmt === 'currency' || l.fmt === 'percent') { sh.fmt[E.r + ',' + E.c] = Object.assign({}, sh.fmt[E.r + ',' + E.c] || {}, { f: l.fmt }); } }
      this.changed(wb);
    }
    if (dr || dc) this.moveSel(wb, dr || 0, dc || 0, false);
    else this.bump();
    this.focusGrid();
  },
  cancelEdit: function (wb) { this.ui(wb).edit = null; this.bump(); this.focusGrid(); },
  // Focus moves at once as well as after the render, so keys typed straight after Enter or Tab reach the grid.
  focusGrid: function () {
    function go(late) {
      var g = typeof document !== 'undefined' && document.querySelector('[data-grid]'), a = document.activeElement;
      // By the time the deferred call runs, a new edit may have started; its editor keeps the focus.
      if (late && a && a.matches && a.matches('[data-celled], [data-bar]')) return;
      if (g && g.focus && a !== g) g.focus({ preventScroll: true });
    }
    go(false); this.later(function () { go(true); }, 0);
  },
  moveSel: function (wb, dr, dc, extend) {
    var sel = this.selOf(wb), sh = this.activeSheet(wb);
    if (extend) { sel.r2 = clamp(sel.r2 + dr, 0, sh.rowsN - 1); sel.c2 = clamp(sel.c2 + dc, 0, sh.colsN - 1); this.scrollCell(sel.r2, sel.c2); }
    else {
      var nr = Math.max(0, sel.r + dr), nc = Math.max(0, sel.c + dc);
      if (nr >= sh.rowsN - 1) sh.rowsN = nr + 21;
      if (nc >= sh.colsN) sh.colsN = nc + 1;
      sel.r = sel.r2 = nr; sel.c = sel.c2 = nc; this.scrollCell(nr, nc);
    }
    this.bump();
  },
  jumpSel: function (wb, dr, dc, extend) {
    var sel = this.selOf(wb), sh = this.activeSheet(wb), r = extend ? sel.r2 : sel.r, c = extend ? sel.c2 : sel.c;
    function has(rr, cc) { return sh.cells[rr + ',' + cc] !== undefined; }
    var maxR = sh.rowsN - 1, maxC = sh.colsN - 1, nr = r, nc = c;
    if (dr) { var cur = has(r, c), nx = has(r + dr, c); nr = r + dr; if (cur && nx) { while (nr + dr >= 0 && nr + dr <= maxR && has(nr + dr, c)) nr += dr; } else { while (nr >= 0 && nr <= maxR && !has(nr, c)) nr += dr; } nr = clamp(nr, 0, maxR); }
    if (dc) { var cu = has(r, c), nx2 = has(r, c + dc); nc = c + dc; if (cu && nx2) { while (nc + dc >= 0 && nc + dc <= maxC && has(r, nc + dc)) nc += dc; } else { while (nc >= 0 && nc <= maxC && !has(r, nc)) nc += dc; } nc = clamp(nc, 0, maxC); }
    if (extend) { sel.r2 = nr; sel.c2 = nc; } else { sel.r = sel.r2 = nr; sel.c = sel.c2 = nc; }
    this.scrollCell(nr, nc); this.bump();
  },
  scrollCell: function (r, c) { this.later(function () { var el = document.querySelector('[data-cell="' + r + ',' + c + '"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 0); },
  rangeOf: function (sel) { return { r1: Math.min(sel.r, sel.r2), r2: Math.max(sel.r, sel.r2), c1: Math.min(sel.c, sel.c2), c2: Math.max(sel.c, sel.c2) }; },
  forSel: function (wb, fn) { var g = this.rangeOf(this.selOf(wb)); for (var r = g.r1; r <= g.r2; r++) for (var c = g.c1; c <= g.c2; c++) fn(r, c); },
  clearSel: function (wb) {
    var sh = this.activeSheet(wb), any = false; this.pushUndo(wb);
    this.forSel(wb, function (r, c) { if (sh.cells[r + ',' + c] !== undefined) { delete sh.cells[r + ',' + c]; any = true; } });
    if (any) this.changed(wb); else this.ui(wb).undo.pop();
  },
  applyFmt: function (wb, patch, toggleKey) {
    var sh = this.activeSheet(wb), sel = this.selOf(wb), cur = sh.fmt[sel.r + ',' + sel.c] || {};
    this.pushUndo(wb);
    var val = toggleKey ? !cur[toggleKey] : null;
    this.forSel(wb, function (r, c) {
      var k = r + ',' + c, f = Object.assign({}, sh.fmt[k] || {});
      if (toggleKey) f[toggleKey] = val; else Object.assign(f, patch);
      Object.keys(f).forEach(function (x) { if (f[x] === null || f[x] === false || f[x] === '' || f[x] === undefined) delete f[x]; });
      if (Object.keys(f).length) sh.fmt[k] = f; else delete sh.fmt[k];
    });
    this.changed(wb);
  },
  bumpDp: function (wb, d) {
    var sh = this.activeSheet(wb), sel = this.selOf(wb), f = sh.fmt[sel.r + ',' + sel.c] || {}, fmt = this.cellFormat(sh, sel.r, sel.c);
    var base = f.dp !== undefined ? f.dp : fmt === 'currency' || fmt === 'number' ? 2 : fmt === 'percent' ? 1 : 0;
    if (fmt === 'general' && f.dp === undefined) { var v = this.cellValue(wb, sh, sel.r, sel.c); if (typeof v === 'number') { var s = String(v); base = s.indexOf('.') >= 0 ? s.split('.')[1].length : 0; } }
    this.applyFmt(wb, { dp: clamp(base + d, 0, 10) });
  },

  /* ---------- reference rewriting ---------- */
  eachFormula: function (fn) {
    this.ws.modules.forEach(function (m) {
      if (m.type !== 'sheet') return;
      m.sheets.forEach(function (s) { Object.keys(s.cells).forEach(function (k) { var raw = s.cells[k]; if (raw && raw[0] === '=') { var n = fn(m, s, raw); if (n !== raw) s.cells[k] = n; } }); });
    });
  },
  refHits: function (ref, fwb, fsh, twb, tsh) {
    var w = ref.wb ? this.wbByName(ref.wb) : fwb; if (w !== twb) return false;
    var s = ref.sheet ? this.sheetByName(w, ref.sheet) : (ref.wb ? w.sheets[0] : fsh);
    return s === tsh;
  },
  structural: function (wb, sh, axis, at, count) {
    var self = this;
    this.pushUndo(wb);
    function move(obj) {
      var out = {};
      Object.keys(obj).forEach(function (k) {
        var p = k.split(','), r = +p[0], c = +p[1], v = axis === 'row' ? r : c;
        if (count < 0 && v >= at && v < at - count) return;
        if (v >= at) v += count;
        out[axis === 'row' ? v + ',' + c : r + ',' + v] = obj[k];
      });
      return out;
    }
    this.eachFormula(function (m, s, raw) {
      return '=' + FE.rewrite(raw.slice(1), function (ref) { return self.refHits(ref, m, s, wb, sh) ? FE.shiftRef(ref, axis, at, count) : null; });
    });
    sh.cells = move(sh.cells); sh.fmt = move(sh.fmt);
    if (axis === 'col') { var w = {}; Object.keys(sh.colW).forEach(function (k) { var c = +k; if (count < 0 && c >= at && c < at - count) return; w[c >= at ? c + count : c] = sh.colW[k]; }); sh.colW = w; sh.colsN = Math.max(1, sh.colsN + count); }
    else sh.rowsN = Math.max(1, sh.rowsN + count);
    this.changed(wb);
  },
  shiftRelative: function (src, dr, dc) {
    return FE.rewrite(src, function (ref) {
      if (ref.kind === 'cols' || ref.kind === 'rows') { if (ref.kind === 'cols') { if (!ref.ac1) ref.c1 += dc; if (!ref.ac2) ref.c2 += dc; } else { if (!ref.ar1) ref.r1 += dr; if (!ref.ar2) ref.r2 += dr; } }
      else { if (!ref.ar1) ref.r1 += dr; if (!ref.ac1) ref.c1 += dc; if (!ref.ar2) ref.r2 += dr; if (!ref.ac2) ref.c2 += dc; }
      if (ref.r1 < 0 || ref.c1 < 0 || ref.r2 < 0 || ref.c2 < 0) return '#REF!';
      return (dr || dc) ? ref : null;
    });
  },
  renameSheet: function (wb, sh, name) {
    var self = this; name = String(name || '').trim();
    if (!name) return;
    if (/[\[\]!']/.test(name)) return this.toast('Sheet names cannot contain [ ] ! or \'', 'error');
    if (wb.sheets.some(function (s) { return s !== sh && lc(s.name) === lc(name); })) return this.toast('A sheet with that name already exists', 'error');
    var old = sh.name; if (old === name) return;
    this.pushUndo(wb);
    this.eachFormula(function (m, s, raw) {
      if (m === wb) return '=' + FE.renameSheetIn(raw.slice(1), old, name, function (w) { return w === null || lc(w) === lc(wb.title); });
      return '=' + FE.renameSheetIn(raw.slice(1), old, name, function (w) { return w !== null && lc(w) === lc(wb.title); });
    });
    sh.name = name;
    this.changed(wb);
  },
  onWorkbookRenamed: function (oldTitle, newTitle) {
    this.eachFormula(function (m, s, raw) {
      var src = raw.slice(1), toks; try { toks = FE.tokenize(src); } catch (e) { return raw; }
      var out = '', last = 0;
      toks.forEach(function (t) { if (t.t === 'ref' && t.ref.wb !== null && lc(t.ref.wb) === lc(oldTitle)) { var orig = src.slice(t.s, t.e); out += src.slice(last, t.s) + '[' + newTitle + ']' + orig.slice(orig.indexOf(']') + 1); last = t.e; } });
      return last ? '=' + out + src.slice(last) : raw;
    });
  },
  addSheet: function (wb) { this.pushUndo(wb); var s = mkSheet(uniqueName('Sheet' + (wb.sheets.length + 1), wb.sheets.map(function (x) { return x.name; })), 60, 14); wb.sheets.push(s); wb.activeSheetId = s.id; this.changed(wb); },
  sheetMenu: function (e, wb, sh) {
    var self = this, i = wb.sheets.indexOf(sh);
    this.openMenu(e, [
      { label: 'Rename', run: function () { self.prompt({ title: 'Rename sheet', value: sh.name }, function (v) { self.renameSheet(wb, sh, v); }); } },
      { label: 'Duplicate', run: function () { self.pushUndo(wb); var c = clone(sh); c.id = uid(); c.name = uniqueName(sh.name + ' copy', wb.sheets.map(function (x) { return x.name; })); wb.sheets.splice(i + 1, 0, c); wb.activeSheetId = c.id; self.changed(wb); } },
      { label: 'Move left', disabled: i === 0, run: function () { wb.sheets.splice(i, 1); wb.sheets.splice(i - 1, 0, sh); self.changed(wb); } },
      { label: 'Move right', disabled: i === wb.sheets.length - 1, run: function () { wb.sheets.splice(i, 1); wb.sheets.splice(i + 1, 0, sh); self.changed(wb); } },
      'divider',
      { label: 'Delete sheet', danger: true, disabled: wb.sheets.length === 1, run: function () { self.confirm({ title: 'Delete sheet "' + sh.name + '"?', message: 'Formulas that point at it will show #REF!. You can undo with Ctrl+Z.', label: 'Delete sheet', danger: true }, function () { self.pushUndo(wb); wb.sheets = wb.sheets.filter(function (s) { return s !== sh; }); wb.activeSheetId = wb.sheets[0].id; self.changed(wb); }); } }
    ], 200);
  },
  colMenu: function (e, wb, c) {
    var self = this, sh = this.activeSheet(wb), L = FE.colToLetters(c);
    this.openMenu(e, [
      { label: 'Insert column left', run: function () { self.structural(wb, sh, 'col', c, 1); } },
      { label: 'Insert column right', run: function () { self.structural(wb, sh, 'col', c + 1, 1); } },
      { label: 'Delete column ' + L, danger: true, run: function () { self.structural(wb, sh, 'col', c, -1); } },
      'divider',
      { label: 'Sort A to Z by ' + L, run: function () { self.sortBy(wb, c, 1); } },
      { label: 'Sort Z to A by ' + L, run: function () { self.sortBy(wb, c, -1); } },
      'divider',
      { label: 'Width: narrow', run: function () { sh.colW[c] = 70; self.changed(wb); } },
      { label: 'Width: normal', run: function () { delete sh.colW[c]; self.changed(wb); } },
      { label: 'Width: wide', run: function () { sh.colW[c] = 200; self.changed(wb); } }
    ], 220);
  },
  rowMenuSheet: function (e, wb, r) {
    var self = this, sh = this.activeSheet(wb);
    this.openMenu(e, [
      { label: 'Insert row above', run: function () { self.structural(wb, sh, 'row', r, 1); } },
      { label: 'Insert row below', run: function () { self.structural(wb, sh, 'row', r + 1, 1); } },
      { label: 'Delete row ' + (r + 1), danger: true, run: function () { self.structural(wb, sh, 'row', r, -1); } }
    ], 200);
  },
  cellMenu: function (e, wb) {
    var self = this, sh = this.activeSheet(wb), sel = this.selOf(wb), g = this.rangeOf(sel);
    this.openMenu(e, [
      { label: 'Copy', hint: 'Ctrl+C', run: function () { var t = self.copySel(wb); self.copyText(t, 'Cells'); } },
      { label: 'Clear contents', hint: 'Del', run: function () { self.clearSel(wb); } },
      { label: 'Clear formatting', run: function () { self.pushUndo(wb); self.forSel(wb, function (r, c) { delete sh.fmt[r + ',' + c]; }); self.changed(wb); } },
      'divider',
      { label: 'Insert row above', run: function () { self.structural(wb, sh, 'row', g.r1, 1); } },
      { label: 'Insert column left', run: function () { self.structural(wb, sh, 'col', g.c1, 1); } },
      { label: 'Delete ' + (g.r2 > g.r1 ? 'rows ' + (g.r1 + 1) + '-' + (g.r2 + 1) : 'row ' + (g.r1 + 1)), danger: true, run: function () { self.structural(wb, sh, 'row', g.r1, -(g.r2 - g.r1 + 1)); } },
      { label: 'Delete ' + (g.c2 > g.c1 ? 'columns ' + FE.colToLetters(g.c1) + '-' + FE.colToLetters(g.c2) : 'column ' + FE.colToLetters(g.c1)), danger: true, run: function () { self.structural(wb, sh, 'col', g.c1, -(g.c2 - g.c1 + 1)); } },
      'divider',
      { label: 'Fill down', hint: 'Ctrl+D', run: function () { self.fill(wb, 'down'); } },
      { label: 'Fill right', hint: 'Ctrl+R', run: function () { self.fill(wb, 'right'); } }
    ], 230);
  },
  sortBy: function (wb, c, dir) {
    var self = this, sh = this.activeSheet(wb), sel = this.selOf(wb), g = this.rangeOf(sel);
    var r1, r2, c1 = 0, c2 = 0;
    Object.keys(sh.cells).forEach(function (k) { var p = k.split(','); c2 = Math.max(c2, +p[1]); });
    if (g.r2 > g.r1) { r1 = g.r1; r2 = g.r2; c1 = g.c1; c2 = Math.max(g.c2, c); }
    else { r1 = 1; r2 = 0; Object.keys(sh.cells).forEach(function (k) { r2 = Math.max(r2, +k.split(',')[0]); }); }
    if (r2 <= r1) return this.toast('Nothing to sort', 'info');
    this.pushUndo(wb);
    var rows = [];
    for (var r = r1; r <= r2; r++) { var cells = {}, fm = {}; for (var cc = c1; cc <= c2; cc++) { cells[cc] = sh.cells[r + ',' + cc]; fm[cc] = sh.fmt[r + ',' + cc]; } rows.push({ r: r, cells: cells, fmt: fm, key: this.cellValue(wb, sh, r, c) }); }
    rows.sort(function (a, b) { if (a.key === null) return 1; if (b.key === null) return -1; return FE.cmp(a.key, b.key) * dir; });
    rows.forEach(function (row, i) {
      var tr = r1 + i;
      for (var cc = c1; cc <= c2; cc++) {
        var k = tr + ',' + cc, raw = row.cells[cc];
        if (raw === undefined) delete sh.cells[k]; else sh.cells[k] = raw && raw[0] === '=' ? '=' + self.shiftRelative(raw.slice(1), tr - row.r, 0) : raw;
        if (row.fmt[cc]) sh.fmt[k] = row.fmt[cc]; else delete sh.fmt[k];
      }
    });
    this.changed(wb);
    this.toast('Sorted rows ' + (r1 + 1) + '-' + (r2 + 1) + ' by column ' + FE.colToLetters(c), 'success');
  },
  fill: function (wb, dir) {
    var self = this, sh = this.activeSheet(wb), g = this.rangeOf(this.selOf(wb));
    if ((dir === 'down' && g.r2 === g.r1) || (dir === 'right' && g.c2 === g.c1)) return this.toast('Select a range to fill first', 'info');
    this.pushUndo(wb);
    for (var r = g.r1; r <= g.r2; r++) for (var c = g.c1; c <= g.c2; c++) {
      var sr = dir === 'down' ? g.r1 : r, sc = dir === 'down' ? c : g.c1;
      if (r === sr && c === sc) continue;
      var raw = sh.cells[sr + ',' + sc], k = r + ',' + c;
      if (raw === undefined) delete sh.cells[k]; else sh.cells[k] = raw[0] === '=' ? '=' + self.shiftRelative(raw.slice(1), r - sr, c - sc) : raw;
      if (sh.fmt[sr + ',' + sc]) sh.fmt[k] = clone(sh.fmt[sr + ',' + sc]); else delete sh.fmt[k];
    }
    this.changed(wb);
  },
  copySel: function (wb) {
    var sh = this.activeSheet(wb), g = this.rangeOf(this.selOf(wb)), lines = [], raws = [];
    for (var r = g.r1; r <= g.r2; r++) { var line = [], rr = []; for (var c = g.c1; c <= g.c2; c++) { line.push(this.cellDisplay(wb, sh, r, c).text); rr.push({ raw: sh.cells[r + ',' + c], fmt: sh.fmt[r + ',' + c] }); } lines.push(line.join('\t')); raws.push(rr); }
    var tsv = lines.join('\n');
    this.ui(wb).clip = { tsv: tsv, raws: raws, r: g.r1, c: g.c1, sheetId: sh.id };
    return tsv;
  },
  pasteText: function (wb, text) {
    var self = this, sh = this.activeSheet(wb), sel = this.selOf(wb), u = this.ui(wb), clip = u.clip;
    var r0 = Math.min(sel.r, sel.r2), c0 = Math.min(sel.c, sel.c2);
    this.pushUndo(wb);
    if (clip && text.replace(/\r/g, '') === clip.tsv) {
      clip.raws.forEach(function (row, i) { row.forEach(function (x, j) { var r = r0 + i, c = c0 + j, k = r + ',' + c; var raw = x.raw; if (raw && raw[0] === '=') raw = '=' + self.shiftRelative(raw.slice(1), r0 - clip.r, c0 - clip.c); self.setRaw(wb, sh, r, c, raw, true); if (x.fmt) sh.fmt[k] = clone(x.fmt); else delete sh.fmt[k]; }); });
      sel.r2 = r0 + clip.raws.length - 1; sel.c2 = c0 + clip.raws[0].length - 1;
    } else {
      var rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(function (l) { return l.split('\t'); });
      rows.forEach(function (row, i) { row.forEach(function (v, j) { self.setRaw(wb, sh, r0 + i, c0 + j, v, true); }); });
      sel.r = r0; sel.c = c0; sel.r2 = r0 + rows.length - 1; sel.c2 = c0 + Math.max.apply(null, rows.map(function (x) { return x.length; })) - 1;
    }
    this.changed(wb);
  },
  insertFunction: function (name) {
    var r = this.S.route, wb = r.name === 'm' ? this.wb(r.id) : null; if (!wb) return;
    var u = this.ui(wb);
    if (u.edit) { u.edit.text = (u.edit.text || '=') + (u.edit.text && /[A-Za-z0-9)"]$/.test(u.edit.text) ? '+' : '') + name + '('; if (u.edit.text[0] !== '=') u.edit.text = '=' + u.edit.text; this.bump(); this.focusSel(u.edit.origin === 'bar' ? '[data-bar]' : '[data-celled]', 'end'); }
    else this.startEdit(wb, '=' + name + '(', 'bar');
  },

  /* ---------- formula assistance ---------- */
  fnContext: function (text) {
    if (!text || text[0] !== '=') return { partial: null, fn: null };
    var body = text.slice(1), m = /(^|[=+\-*/^&(,<>:;\s])([A-Za-z][A-Za-z0-9.]*)$/.exec(body);
    var partial = m && !/^[A-Za-z]{1,3}\d+$/.test(m[2]) ? m[2] : null;
    var stack = [], i = 0, inStr = false, word = '';
    for (; i < body.length; i++) {
      var ch = body[i];
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (/[A-Za-z0-9._]/.test(ch)) { word += ch; continue; }
      if (ch === '(') stack.push(word.toUpperCase()); else if (ch === ')') stack.pop();
      word = '';
    }
    return { partial: partial, fn: stack.length ? stack[stack.length - 1] : null };
  },
  refInsertable: function (text) { return !!text && text[0] === '=' && /[=+\-*/^&(,<>:;]$/.test(text.replace(/\s+$/, '')); },

  /* ---------- grid events ---------- */
  gridTarget: function (e) { var t = e.target && e.target.closest ? e.target.closest('[data-cell],[data-colh],[data-rowh]') : null; return t; },
  onGridDown: function (e, wb) {
    var t = this.gridTarget(e); if (!t) return;
    var u = this.ui(wb), sel = this.selOf(wb), sh = this.activeSheet(wb);
    if (e.button === 2) return;
    if (t.dataset.cell) {
      var p = t.dataset.cell.split(','), r = +p[0], c = +p[1];
      if (u.edit && u.edit.sheetId === sh.id && this.refInsertable(u.edit.text) && !(u.edit.r === r && u.edit.c === c)) {
        e.preventDefault();
        u.edit.text += FE.toA1(r, c); u.refAnchor = { r: r, c: c, len: FE.toA1(r, c).length };
        this.S.sheetRefDrag = true; this.bump(); this.focusSel(u.edit.origin === 'bar' ? '[data-bar]' : '[data-celled]', 'end');
        return;
      }
      if (u.edit) this.commitEdit(wb);
      if (e.shiftKey) { sel.r2 = r; sel.c2 = c; } else { sel.r = sel.r2 = r; sel.c = sel.c2 = c; }
      this.S.sheetSelecting = true;
    } else if (t.dataset.colh !== undefined) {
      if (u.edit) this.commitEdit(wb);
      var cc = +t.dataset.colh;
      if (e.shiftKey) { sel.c2 = cc; } else { sel.c = sel.c2 = cc; sel.r = 0; } sel.r2 = sh.rowsN - 1;
    } else if (t.dataset.rowh !== undefined) {
      if (u.edit) this.commitEdit(wb);
      var rr = +t.dataset.rowh;
      if (e.shiftKey) { sel.r2 = rr; } else { sel.r = sel.r2 = rr; sel.c = 0; } sel.c2 = sh.colsN - 1;
    }
    this.bump();
    this.focusGrid();
  },
  onGridOver: function (e, wb) {
    var t = this.gridTarget(e); if (!t || !t.dataset.cell) return;
    var p = t.dataset.cell.split(','), r = +p[0], c = +p[1], u = this.ui(wb);
    if (this.S.sheetRefDrag && u.edit && u.refAnchor) {
      var a = u.refAnchor, ref = (a.r === r && a.c === c) ? FE.toA1(r, c) : FE.toA1(Math.min(a.r, r), Math.min(a.c, c)) + ':' + FE.toA1(Math.max(a.r, r), Math.max(a.c, c));
      u.edit.text = u.edit.text.slice(0, u.edit.text.length - a.len) + ref; a.len = ref.length; this.bump(); return;
    }
    if (!this.S.sheetSelecting) return;
    var sel = this.selOf(wb);
    if (sel.r2 !== r || sel.c2 !== c) { sel.r2 = r; sel.c2 = c; this.bump(); }
  },
  onGridUp: function () { this.S.sheetSelecting = false; this.S.sheetRefDrag = false; },
  onGridDbl: function (e, wb) { var t = this.gridTarget(e); if (t && t.dataset.cell) this.startEdit(wb, undefined, 'cell'); },
  onGridCtx: function (e, wb) {
    var t = this.gridTarget(e); if (!t) return;
    e.preventDefault();
    if (t.dataset.colh !== undefined) return this.colMenu(e, wb, +t.dataset.colh);
    if (t.dataset.rowh !== undefined) return this.rowMenuSheet(e, wb, +t.dataset.rowh);
    var p = t.dataset.cell.split(','), r = +p[0], c = +p[1], sel = this.selOf(wb), g = this.rangeOf(sel);
    if (r < g.r1 || r > g.r2 || c < g.c1 || c > g.c2) { sel.r = sel.r2 = r; sel.c = sel.c2 = c; }
    this.cellMenu(e, wb);
  },
  onGridKey: function (e, wb) {
    // Keys pressed in the in-cell editor bubble up to the grid; editKey has already handled them.
    if (e.target && e.currentTarget && e.target !== e.currentTarget) return;
    var u = this.ui(wb);
    if (u.edit) {
      // Keys typed before the cell editor has taken focus still belong to the edit.
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); u.edit.text += e.key; this.bump(); this.focusSel(u.edit.origin === 'bar' ? '[data-bar]' : '[data-celled]', 'end'); }
      else if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') this.editKey(e, wb, []);
      return;
    }
    var k = e.key, mod = e.ctrlKey || e.metaKey, sh = this.activeSheet(wb);
    var moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[k]) { e.preventDefault(); if (mod) this.jumpSel(wb, moves[k][0], moves[k][1], e.shiftKey); else this.moveSel(wb, moves[k][0], moves[k][1], e.shiftKey); return; }
    if (k === 'Enter') { e.preventDefault(); this.moveSel(wb, e.shiftKey ? -1 : 1, 0, false); return; }
    if (k === 'Tab') { e.preventDefault(); this.moveSel(wb, 0, e.shiftKey ? -1 : 1, false); return; }
    if (k === 'F2') { e.preventDefault(); this.startEdit(wb, undefined, 'cell'); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.clearSel(wb); return; }
    if (k === 'Home') { e.preventDefault(); var s0 = this.selOf(wb); s0.c = s0.c2 = 0; if (mod) s0.r = s0.r2 = 0; this.scrollCell(s0.r, 0); this.bump(); return; }
    if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); this.moveSel(wb, k === 'PageDown' ? 20 : -20, 0, e.shiftKey); return; }
    if (mod) {
      var lk = k.toLowerCase();
      if (lk === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(wb); else this.undo(wb); return; }
      if (lk === 'y') { e.preventDefault(); this.redo(wb); return; }
      if (lk === 'b') { e.preventDefault(); this.applyFmt(wb, null, 'b'); return; }
      if (lk === 'i') { e.preventDefault(); this.applyFmt(wb, null, 'i'); return; }
      if (lk === 'd') { e.preventDefault(); this.fill(wb, 'down'); return; }
      if (lk === 'r') { e.preventDefault(); this.fill(wb, 'right'); return; }
      if (lk === 'a') { e.preventDefault(); var s = this.selOf(wb); s.r = 0; s.c = 0; s.r2 = sh.rowsN - 1; s.c2 = sh.colsN - 1; this.bump(); return; }
      return;
    }
    if (k === 'Escape') { if (u.clip) { u.clip = null; this.bump(); } return; }
    if (k.length === 1 && !e.altKey) { e.preventDefault(); this.startEdit(wb, k, 'cell'); }
  },
  editKey: function (e, wb, sugs) {
    var u = this.ui(wb), E = u.edit;
    if (!E) { if (e.key === 'Enter') { e.preventDefault(); this.focusGrid(); } return; }
    if (sugs && sugs.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); u.sugIdx = (u.sugIdx + 1) % sugs.length; this.bump(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); u.sugIdx = (u.sugIdx - 1 + sugs.length) % sugs.length; this.bump(); return; }
      if (e.key === 'Tab') { e.preventDefault(); sugs[clamp(u.sugIdx, 0, sugs.length - 1)].pick(); return; }
    }
    if (e.key === 'Enter') { e.preventDefault(); this.commitEdit(wb, e.shiftKey ? -1 : 1, 0); return; }
    if (e.key === 'Tab') { e.preventDefault(); this.commitEdit(wb, 0, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelEdit(wb); return; }
    if (E.origin === 'cell' && !this.refInsertable(E.text) && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && E.text === E.orig) { e.preventDefault(); this.commitEdit(wb, e.key === 'ArrowUp' ? -1 : 1, 0); }
  },

  /* ---------- render ---------- */
  sheetVals: function (wb) {
    var self = this, S = this.S, sh = this.activeSheet(wb), u = this.ui(wb), sel = this.selOf(wb), g = this.rangeOf(sel), E = u.edit && u.edit.sheetId === sh.id ? u.edit : null;
    if (u.edit && !E) u.edit = null;
    var fr = clamp(sh.frozenRows || 0, 0, sh.rowsN), fcN = clamp(sh.frozenCols || 0, 0, sh.colsN);
    var widths = [], lefts = [], x = RH_W;
    for (var c = 0; c < sh.colsN; c++) { var w = sh.colW[c] || COL_W; widths.push(w); lefts.push(x); x += w; }
    var cols = widths.map(function (w, c) {
      var inSel = c >= g.c1 && c <= g.c2;
      return { label: FE.colToLetters(c), i: c, style: 'width: ' + w + 'px;' + (c < fcN ? ' position: sticky; left: ' + lefts[c] + 'px; z-index: 5;' : ''), cls: 'wb-ch' + (inSel ? ' hl' : '') + (inSel && g.r1 === 0 && g.r2 === sh.rowsN - 1 ? ' full' : '') + (c === fcN - 1 ? ' frz-r' : ''),
        resize: function (e) { e.preventDefault(); e.stopPropagation(); S.resize = { kind: 'sheet', id: wb.id, sheetId: sh.id, col: c, x: e.clientX, w: w }; self.bump(); } };
    });
    var clip = u.clip && u.clip.sheetId === sh.id ? u.clip : null;
    var rows = [];
    for (var r = 0; r < sh.rowsN; r++) {
      var rIn = r >= g.r1 && r <= g.r2, cells = [];
      for (var cc = 0; cc < sh.colsN; cc++) {
        var k = r + ',' + cc, f = sh.fmt[k], raw = sh.cells[k], d = raw === undefined ? null : this.cellDisplay(wb, sh, r, cc);
        var inSel = rIn && cc >= g.c1 && cc <= g.c2, act = r === sel.r && cc === sel.c;
        var cls = 'wb-c' + (inSel ? ' sel' : '') + (act ? ' act' : '') + (d && d.isErr ? ' err' : '') + (f && f.b ? ' b' : '') + (f && f.i ? ' i' : '') + (f && f.bg ? ' bg-' + f.bg : '') + (f && f.fc ? ' fc-' + f.fc : '') + (d ? ' al-' + d.align : '') + (cc < fcN ? ' frz' + (cc === fcN - 1 ? ' frz-r' : '') : '') + (r < fr ? ' frz' + (r === fr - 1 ? ' frz-b' : '') : '');
        if (clip && r >= clip.r && r < clip.r + clip.raws.length && cc >= clip.c && cc < clip.c + clip.raws[0].length) cls += ' clip';
        if (E && E.r === r && E.c === cc) cls += ' editing';
        cells.push({ key: k, text: d ? (E && E.r === r && E.c === cc && E.origin === 'bar' ? E.text : d.text) : (E && E.r === r && E.c === cc && E.origin === 'bar' ? E.text : ''), cls: cls, style: 'width: ' + widths[cc] + 'px;' + (cc < fcN ? ' position: sticky; left: ' + lefts[cc] + 'px; z-index: ' + (r < fr ? 3 : 2) + ';' : ''), title: d && d.v && d.v.message ? d.v.message : '' });
      }
      rows.push({ label: r + 1, i: r, cls: 'wb-rh' + (rIn ? ' hl' : '') + (r === fr - 1 ? ' frz-b' : ''), cells: cells, rowCls: 'wb-row' + (r < fr ? ' frz-row' : ''), rowStyle: r < fr ? 'position: sticky; top: ' + (HEAD_H + r * ROW_H) + 'px; z-index: 4;' : '' });
    }
    var activeRaw = sh.cells[sel.r + ',' + sel.c];
    var barText = E ? E.text : activeRaw === undefined ? '' : activeRaw;
    var ctx = E ? this.fnContext(E.text) : { partial: null, fn: null };
    var sugs = [];
    if (ctx.partial) {
      var pu = ctx.partial.toUpperCase();
      sugs = FE.listFunctions().filter(function (f) { return f.name.indexOf(pu) === 0; }).slice(0, 7).map(function (f, i) {
        return { name: f.name, sig: f.sig, desc: f.desc, cls: 'sug' + (i === clamp(u.sugIdx, 0, 6) ? ' on' : ''),
          pick: function () { if (!u.edit) return; u.edit.text = u.edit.text.slice(0, u.edit.text.length - ctx.partial.length) + f.name + '('; u.sugIdx = 0; self.bump(); self.focusSel(u.edit.origin === 'bar' ? '[data-bar]' : '[data-celled]', 'end'); },
          down: function (e) { e.preventDefault(); } };
      });
    }
    var hintFn = ctx.fn && FE.listFunctions().filter(function (f) { return f.name === ctx.fn; })[0];
    var activeVal = this.cellValue(wb, sh, sel.r, sel.c);
    var errMsg = activeVal && activeVal.message ? activeVal.message : '';
    var stats = null;
    if (g.r2 > g.r1 || g.c2 > g.c1) {
      var n = 0, cnt = 0, sum = 0, cellsN = 0;
      var maxR = 0; Object.keys(sh.cells).forEach(function (kk) { maxR = Math.max(maxR, +kk.split(',')[0]); });
      for (var rr = g.r1; rr <= Math.min(g.r2, maxR); rr++) for (var c2 = g.c1; c2 <= g.c2; c2++) { if (sh.cells[rr + ',' + c2] === undefined) continue; cellsN++; var v = this.cellValue(wb, sh, rr, c2); if (typeof v === 'number') { n++; sum += v; } if (v !== null && v !== '') cnt++; }
      var fmtS = this.cellFormat(sh, g.r1 + (g.r2 > g.r1 ? 1 : 0), g.c1);
      var fm = function (val) { return FE.format(Math.round(val * 1e6) / 1e6, fmtS === 'currency' || fmtS === 'percent' ? fmtS : 'general', fmtS === 'general' ? undefined : undefined); };
      stats = n ? 'Sum ' + fm(sum) + '   Average ' + fm(sum / n) + '   Count ' + cnt : cnt ? 'Count ' + cnt : '';
    }
    var fCur = sh.fmt[sel.r + ',' + sel.c] || {};
    var edStyle = '';
    if (E) {
      var ew = Math.max(widths[E.c] || COL_W, Math.min(420, (E.text.length + 2) * 7.6));
      edStyle = 'left: ' + lefts[E.c] + 'px; top: ' + (HEAD_H + E.r * ROW_H) + 'px; width: ' + ew + 'px; height: ' + ROW_H + 'px;';
    }
    return {
      title: wb.title, tile: 'tile tile-' + wb.color,
      titleDraft: S.titleDraft && S.titleDraft.id === wb.id ? S.titleDraft.text : wb.title,
      onTitle: function (e) { S.titleDraft = { id: wb.id, text: e.target.value }; self.bump(); },
      onTitleBlur: function () { if (S.titleDraft && S.titleDraft.id === wb.id) { var t = S.titleDraft.text; S.titleDraft = null; self.renameModule(wb, t); } },
      onTitleKey: function (e) { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      pickColor: function (e) { self.colorMenu(e, wb); }, icon: wb.icon || '', hasIcon: !!wb.icon, noIcon: !wb.icon,
      tabs: wb.sheets.map(function (s) { return { name: s.name, cls: 'stab' + (s === sh ? ' on' : ''), go: function () { if (u.edit) self.commitEdit(wb); wb.activeSheetId = s.id; self.changed(null); self.focusGrid(); }, menu: function (e) { e.preventDefault(); self.sheetMenu(e, wb, s); }, dbl: function () { self.prompt({ title: 'Rename sheet', value: s.name }, function (v) { self.renameSheet(wb, s, v); }); } }; }),
      addSheet: function () { self.addSheet(wb); },
      nameBox: FE.toA1(g.r1, g.c1) + (g.r2 > g.r1 || g.c2 > g.c1 ? ':' + FE.toA1(g.r2, g.c2) : ''),
      barValue: barText,
      onBar: function (e) { if (!u.edit) { u.edit = { r: sel.r, c: sel.c, sheetId: sh.id, text: '', origin: 'bar', orig: activeRaw === undefined ? '' : activeRaw }; } u.edit.text = e.target.value; u.sugIdx = 0; self.bump(); },
      onBarKey: function (e) { self.editKey(e, wb, sugs); },
      onBarFocus: function () { if (!u.edit) { u.edit = { r: sel.r, c: sel.c, sheetId: sh.id, text: activeRaw === undefined ? '' : activeRaw, origin: 'bar', orig: activeRaw === undefined ? '' : activeRaw }; self.bump(); } else if (u.edit.origin !== 'bar') { u.edit.origin = 'bar'; self.bump(); } },
      editing: !!E, edValue: E ? E.text : '', edStyle: edStyle, edIsCell: !!(E && E.origin === 'cell'),
      onEd: function (e) { if (u.edit) { u.edit.text = e.target.value; u.sugIdx = 0; self.bump(); } },
      onEdKey: function (e) { self.editKey(e, wb, sugs); },
      onEdBlur: function () { if (u.edit) self.commitEdit(wb); },
      sugs: sugs, hasSugs: sugs.length > 0,
      hasHint: !!hintFn && !sugs.length, hint: hintFn ? hintFn.sig : '', hintDesc: hintFn ? hintFn.desc : '',
      hasErrMsg: !E && !!errMsg, errMsg: errMsg,
      cols: cols, rows: rows,
      gridStyle: 'width: ' + x + 'px;',
      onDown: function (e) { self.onGridDown(e, wb); },
      onOver: function (e) { self.onGridOver(e, wb); },
      onUp: function () { self.onGridUp(); },
      onDbl: function (e) { self.onGridDbl(e, wb); },
      onCtx: function (e) { self.onGridCtx(e, wb); },
      onKey: function (e) { self.onGridKey(e, wb); },
      onCopy: function (e) { if (u.edit) return; e.preventDefault(); var t = self.copySel(wb); try { e.clipboardData.setData('text/plain', t); } catch (x) { } self.bump(); },
      onCut: function (e) { if (u.edit) return; e.preventDefault(); var t = self.copySel(wb); try { e.clipboardData.setData('text/plain', t); } catch (x) { } u.clip = null; self.clearSel(wb); },
      onPaste: function (e) { if (u.edit) return; e.preventDefault(); var t = ''; try { t = e.clipboardData.getData('text/plain'); } catch (x) { } if (t) self.pasteText(wb, t); },
      addRows: function () { sh.rowsN += 20; self.changed(wb); },
      addCols: function () { sh.colsN += 4; self.changed(wb); },
      stats: stats || '', hasStats: !!stats,
      undo: function () { self.undo(wb); self.focusGrid(); }, redo: function () { self.redo(wb); self.focusGrid(); },
      canUndo: u.undo.length > 0, canRedo: u.redo.length > 0, undoOff: u.undo.length === 0, redoOff: u.redo.length === 0,
      boldCls: 'tb-icon' + (fCur.b ? ' on' : ''), italicCls: 'tb-icon' + (fCur.i ? ' on' : ''),
      bold: function () { self.applyFmt(wb, null, 'b'); self.focusGrid(); }, italic: function () { self.applyFmt(wb, null, 'i'); self.focusGrid(); },
      alL: function () { self.applyFmt(wb, { al: 'left' }); self.focusGrid(); }, alC: function () { self.applyFmt(wb, { al: 'center' }); self.focusGrid(); }, alR: function () { self.applyFmt(wb, { al: 'right' }); self.focusGrid(); },
      alLCls: 'tb-icon' + (fCur.al === 'left' ? ' on' : ''), alCCls: 'tb-icon' + (fCur.al === 'center' ? ' on' : ''), alRCls: 'tb-icon' + (fCur.al === 'right' ? ' on' : ''),
      fmt: fCur.f || 'general', fmts: CELL_FORMATS.map(function (f) { return { value: f[0], label: f[1] }; }),
      onFmt: function (e) { self.applyFmt(wb, { f: e.target.value === 'general' ? null : e.target.value }); self.focusGrid(); },
      dpUp: function () { self.bumpDp(wb, 1); self.focusGrid(); }, dpDown: function () { self.bumpDp(wb, -1); self.focusGrid(); },
      fontColor: function (e) { self.openMenu(e, FONT_COLORS.map(function (f) { return { label: f[1], swatch: f[0] ? 'fcs-' + f[0] : 'bg-none', checked: (fCur.fc || '') === f[0], run: function () { self.applyFmt(wb, { fc: f[0] || null }); self.focusGrid(); } }; }), 180); },
      freezeCls: 'tb-icon' + (fr || fcN ? ' on' : ''),
      freeze: function (e) {
        function set(rr, cc) { sh.frozenRows = rr; sh.frozenCols = cc; if (!rr) delete sh.frozenRows; if (!cc) delete sh.frozenCols; self.changed(wb); self.focusGrid(); }
        self.openMenu(e, [
          { label: 'Freeze top row', checked: fr === 1, run: function () { set(1, fcN); } },
          { label: 'Freeze rows above ' + (sel.r + 1), disabled: sel.r === 0, checked: fr === sel.r && sel.r > 0, run: function () { set(sel.r, fcN); } },
          { label: 'Freeze first column', checked: fcN === 1, run: function () { set(fr, 1); } },
          { label: 'Freeze columns left of ' + FE.colToLetters(sel.c), disabled: sel.c === 0, checked: fcN === sel.c && sel.c > 0, run: function () { set(fr, sel.c); } },
          { label: 'Freeze at ' + FE.toA1(sel.r, sel.c), disabled: sel.r === 0 && sel.c === 0, run: function () { set(sel.r, sel.c); } },
          'divider',
          { label: 'Unfreeze', disabled: !fr && !fcN, run: function () { set(0, 0); } }
        ], 230);
      },
      fill: function (e) { self.openMenu(e, FILLS.map(function (f) { return { label: f[1], swatch: f[0] ? 'bg-' + f[0] : 'bg-none', checked: (fCur.bg || '') === f[0], run: function () { self.applyFmt(wb, { bg: f[0] || null }); self.focusGrid(); } }; }), 180); },
      insertMenu: function (e) { self.openMenu(e, [{ label: 'Row above', run: function () { self.structural(wb, sh, 'row', g.r1, 1); } }, { label: 'Row below', run: function () { self.structural(wb, sh, 'row', g.r2 + 1, 1); } }, { label: 'Column left', run: function () { self.structural(wb, sh, 'col', g.c1, 1); } }, { label: 'Column right', run: function () { self.structural(wb, sh, 'col', g.c2 + 1, 1); } }, 'divider', { label: 'Delete selected rows', danger: true, run: function () { self.structural(wb, sh, 'row', g.r1, -(g.r2 - g.r1 + 1)); } }, { label: 'Delete selected columns', danger: true, run: function () { self.structural(wb, sh, 'col', g.c1, -(g.c2 - g.c1 + 1)); } }], 220); },
      sortAsc: function () { self.sortBy(wb, sel.c, 1); }, sortDesc: function () { self.sortBy(wb, sel.c, -1); },
      fnRef: function () { self.modal('functions', { q: '' }); self.focusSel('[data-fnq]'); },
      sheetCount: plural(wb.sheets.length, 'sheet')
    };
  },

  /* ---------- embedded range (for notebook blocks) ---------- */
  rangeEmbed: function (wbId, sheetId, range) {
    var self = this, wb = this.wb(wbId);
    if (!wb) return { missing: true, ok: false };
    var sh = byId(wb.sheets, sheetId) || wb.sheets[0], g = FE.parseRange(range || 'A1:D6');
    if (!g) return { missing: true, ok: false };
    g.r2 = Math.min(g.r2, g.r1 + 39); g.c2 = Math.min(g.c2, g.c1 + 11);
    var rows = [];
    for (var r = g.r1; r <= g.r2; r++) {
      var cells = [];
      for (var c = g.c1; c <= g.c2; c++) { var d = sh.cells[r + ',' + c] === undefined ? null : this.cellDisplay(wb, sh, r, c), f = sh.fmt[r + ',' + c] || {}; cells.push({ text: d ? d.text : '', cls: 'emb-c' + (d ? ' al-' + d.align : '') + (f.b ? ' b' : '') + (d && d.isErr ? ' err' : '') + (f.bg ? ' bg-' + f.bg : '') + (f.fc ? ' fc-' + f.fc : '') }); }
      rows.push({ cells: cells });
    }
    return { missing: false, ok: true, tile: 'tile tile-' + wb.color, title: wb.title + ' - ' + sh.name + '!' + FE.toA1(g.r1, g.c1) + ':' + FE.toA1(g.r2, g.c2), rows: rows, go: function () { wb.activeSheetId = sh.id; var u = self.ui(wb); u.sel[sh.id] = { r: g.r1, c: g.c1, r2: g.r2, c2: g.c2 }; self.goModule(wb.id); } };
  },
  sheetEmbedModalVals: function (M) {
    var self = this, wbs = this.mods('sheet'), wb = this.wb(M.wbId) || wbs[0];
    if (wb && M.wbId !== wb.id) { M.wbId = wb.id; M.sheetId = wb.sheets[0].id; }
    var sh = wb && (byId(wb.sheets, M.sheetId) || wb.sheets[0]);
    var ok = !!FE.parseRange(M.range || '');
    return {
      noWb: !wb, hasWb: !!wb,
      wbId: wb ? wb.id : '', wbs: wbs.map(function (w) { return { value: w.id, label: w.title }; }),
      onWb: function (e) { M.wbId = e.target.value; var w = self.wb(M.wbId); M.sheetId = w ? w.sheets[0].id : null; self.bump(); },
      sheetId: sh ? sh.id : '', sheets: wb ? wb.sheets.map(function (s) { return { value: s.id, label: s.name }; }) : [],
      onSheet: function (e) { M.sheetId = e.target.value; self.bump(); },
      range: M.range || '', onRange: function (e) { M.range = e.target.value.toUpperCase(); self.bump(); },
      rangeCls: 'input' + (ok ? '' : ' bad'),
      preview: wb && ok ? this.rangeEmbed(wb.id, sh.id, M.range) : { ok: false, missing: true, rows: [] },
      canSave: !!wb && ok, cannotSave: !(wb && ok),
      save: function () { self.S.modal = null; M.onSave.call(self, { ref: wb.id, sheetId: sh.id, range: M.range }); self.bump(); }
    };
  }
};
