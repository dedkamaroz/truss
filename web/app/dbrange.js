/* ================= database table: cell ranges =================
   Drag across cells (or Shift+click) to select a rectangle. With the table focused:
   Delete clears it, Ctrl+C / Ctrl+X / Ctrl+V copy, cut and paste it as tab-separated text
   (so it round-trips with Excel and Google Sheets), arrows move the active cell (Shift extends),
   Enter edits, typing starts an edit, Escape clears the selection.
   Shift+click a header to select whole columns; drag a header to move that column, or the whole
   selected block of columns when it is part of one. Bulk changes can be undone from their toast. */

function tsvField(v) { var s = v == null ? '' : String(v); return /["\t\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function tsvStringify(rows) { return rows.map(function (r) { return r.map(tsvField).join('\t'); }).join('\r\n'); }
// Excel/Sheets clipboard text: tabs between cells, newlines between rows, quotes around cells that hold either.
function tsvParse(text) {
  var rows = [], row = [], f = '', i = 0, q = false, s = String(text == null ? '' : text);
  while (i < s.length) {
    var ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      f += ch; i++; continue;
    }
    if (ch === '"' && f === '') { q = true; i++; continue; }
    if (ch === '\t') { row.push(f); f = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1; continue; }
    f += ch; i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

var DbRangeMix = {
  // The grid exactly as the table last rendered it: rows of expanded groups in order, visible columns.
  tableGrid: function (db) { return (this.tblGrid && this.tblGrid[db.id]) || { rowIds: [], colIds: [] }; },
  selRange: function (db) {
    var s = this.S.cellSel; if (!s || s.dbId !== db.id) return null;
    var g = this.tableGrid(db), ac = g.colIds.indexOf(s.a.propId), fc = g.colIds.indexOf(s.f.propId);
    if (ac < 0 || fc < 0) return null;
    var ar, fr;
    if (s.allRows) { ar = 0; fr = g.rowIds.length - 1; }
    else { ar = g.rowIds.indexOf(s.a.rowId); fr = g.rowIds.indexOf(s.f.rowId); if (ar < 0 || fr < 0) return null; }
    var r1 = Math.min(ar, fr), r2 = Math.max(ar, fr);
    return { r1: r1, r2: r2, c1: Math.min(ac, fc), c2: Math.max(ac, fc), fr: s.allRows ? r1 : fr, fc: fc, rows: g.rowIds.length,
      full: !!s.allRows || (g.rowIds.length > 0 && r1 === 0 && r2 === g.rowIds.length - 1), cells: (r2 - r1 + 1) * (Math.abs(fc - ac) + 1) };
  },
  setCellSel: function (db, a, f, allRows) { this.S.cellSel = { dbId: db.id, a: a, f: f || a, allRows: !!allRows }; },
  // Focus moves at once (so keys typed straight after Enter or Tab are not lost) and again after the render.
  focusTable: function (db) {
    var sel = '[data-dbt="' + db.id + '"]', el = typeof document !== 'undefined' && document.querySelector ? document.querySelector(sel) : null;
    if (el && el.focus) el.focus({ preventScroll: true });
    this.later(function () { var t = document.querySelector(sel), a = document.activeElement; if (t && a !== t && !(a && a.matches && a.matches('[data-cellinput], .pop *'))) t.focus({ preventScroll: true }); }, 0);
  },

  // Adds the selection highlight and the pointer handlers to one rendered table cell.
  decorateCell: function (c, db, row, prop, ri, ci, R) {
    var self = this;
    c.ck = row.id + '|' + prop.id;
    c.down = function (e) { self.cellDown(e, db, row, prop); };
    c.enter = function (e) { self.cellEnter(e, db, row, prop); };
    var click = c.click;
    c.click = function (e) {
      if (self.S.suppressClick) { self.S.suppressClick = false; return; }
      self.setCellSel(db, { rowId: row.id, propId: prop.id });
      click(e);
    };
    if (!R || ri < R.r1 || ri > R.r2 || ci < R.c1 || ci > R.c2) return;
    var multi = R.r2 > R.r1 || R.c2 > R.c1, edge = 'var(--accent)', sh = [];
    if (multi) c.cls += ' csel';
    if (ri === R.r1) sh.push('inset 0 2px 0 0 ' + edge);
    if (ri === R.r2) sh.push('inset 0 -2px 0 0 ' + edge);
    if (ci === R.c1) sh.push('inset 2px 0 0 0 ' + edge);
    if (ci === R.c2) sh.push('inset -2px 0 0 0 ' + edge);
    if (sh.length && !c.editing) c.style += ' box-shadow: ' + sh.join(', ') + ';';
  },
  decorateHeader: function (co, db, p, ci, R) {
    var self = this, S = this.S, D = S.colDrag;
    co.cls = 'dbt-th' + (R && R.full && ci >= R.c1 && ci <= R.c2 ? ' hl' : '');
    if (D && D.moved && D.dbId === db.id) {
      if (D.ids.indexOf(p.id) >= 0) co.cls += ' dragging';
      if (D.target === p.id) co.cls += D.side === 'after' ? ' drop-after' : ' drop-before';
    }
    co.down = function (e) { self.headerDown(e, db, p); };
    var open = co.open;
    co.open = function (e) { if (S.suppressClick) { S.suppressClick = false; return; } open(e); };
  },

  cellDown: function (e, db, row, prop) {
    var S = this.S;
    if (e.button !== 0) return;
    var t = e.target;
    if (t && t.closest && t.closest('input, button, a, textarea, select, label')) return;
    if (e.shiftKey && S.cellSel && S.cellSel.dbId === db.id) {
      e.preventDefault();
      if (S.cellEdit) this.commitCellEdit();
      if (S.cellSel.allRows) { var g = this.tableGrid(db); S.cellSel = { dbId: db.id, a: { rowId: g.rowIds[0], propId: S.cellSel.a.propId }, f: { rowId: row.id, propId: prop.id } }; }
      else S.cellSel.f = { rowId: row.id, propId: prop.id };
      S.pop = null; S.suppressClick = true;
      this.bump(); this.focusTable(db);
      return;
    }
    S.cellDrag = { dbId: db.id, rowId: row.id, propId: prop.id, moved: false };
  },
  cellEnter: function (e, db, row, prop) {
    var S = this.S, D = S.cellDrag;
    if (!D || D.dbId !== db.id) return;
    if (!(e.buttons & 1)) { S.cellDrag = null; return; }
    if (!D.moved && D.rowId === row.id && D.propId === prop.id) return;
    if (!D.moved) { D.moved = true; if (S.cellEdit) this.commitCellEdit(); S.pop = null; S.menu = null; }
    this.setCellSel(db, { rowId: D.rowId, propId: D.propId }, { rowId: row.id, propId: prop.id });
    try { window.getSelection().removeAllRanges(); } catch (x) { /* no selection API */ }
    this.bump();
  },
  headerDown: function (e, db, p) {
    var S = this.S;
    if (e.button !== 0) return;
    if (e.shiftKey) {
      e.preventDefault();
      var g = this.tableGrid(db), anchor = S.cellSel && S.cellSel.dbId === db.id && S.cellSel.allRows ? S.cellSel.a.propId : p.id;
      S.cellSel = { dbId: db.id, a: { rowId: g.rowIds[0] || null, propId: anchor }, f: { rowId: g.rowIds[g.rowIds.length - 1] || null, propId: p.id }, allRows: true };
      S.suppressClick = true;
      this.bump(); this.focusTable(db);
      return;
    }
    var R = this.selRange(db), g2 = this.tableGrid(db), ci = g2.colIds.indexOf(p.id);
    var ids = R && R.full && ci >= R.c1 && ci <= R.c2 ? g2.colIds.slice(R.c1, R.c2 + 1) : [p.id];
    S.colDrag = { dbId: db.id, propId: p.id, ids: ids, x: e.clientX, y: e.clientY, moved: false, target: null, side: 'before' };
  },
  // Called from the root pointer handlers in core.js.
  rangePointerMove: function (e) {
    var S = this.S, D = S.colDrag;
    if (!D) return false;
    if (!D.moved && Math.abs(e.clientX - D.x) < 5 && Math.abs(e.clientY - D.y) < 5) return true;
    D.moved = true;
    var el = document.elementFromPoint ? document.elementFromPoint(e.clientX, e.clientY) : null;
    var th = el && el.closest ? el.closest('[data-th]') : null;
    var target = null, side = 'before';
    if (th) { var r = th.getBoundingClientRect(); target = th.getAttribute('data-th'); side = e.clientX > r.left + r.width / 2 ? 'after' : 'before'; }
    if (target !== D.target || side !== D.side) { D.target = target; D.side = side; this.bump(); }
    return true;
  },
  rangePointerUp: function () {
    var S = this.S, D = S.cellDrag, C = S.colDrag;
    if (D) {
      S.cellDrag = null;
      if (D.moved) { S.suppressClick = true; var self = this; setTimeout(function () { self.S.suppressClick = false; }, 0); var db = this.db(D.dbId); if (db) this.focusTable(db); }
    }
    if (D || C) this.bump();
    if (C) {
      S.colDrag = null;
      if (C.moved) {
        S.suppressClick = true;
        var me = this; setTimeout(function () { me.S.suppressClick = false; }, 0);
        var db2 = this.db(C.dbId);
        if (db2 && C.target && C.ids.indexOf(C.target) < 0) this.moveColumns(db2, C.ids, C.target, C.side);
        else this.bump();
      }
    }
  },
  moveColumns: function (db, ids, targetId, side) {
    var moving = db.props.filter(function (p) { return ids.indexOf(p.id) >= 0; });
    var rest = db.props.filter(function (p) { return ids.indexOf(p.id) < 0; });
    var ti = idxById(rest, targetId); if (ti < 0) return;
    if (side === 'after') ti++;
    Array.prototype.splice.apply(rest, [ti, 0].concat(moving));
    db.props.length = 0;
    rest.forEach(function (p) { db.props.push(p); });
    this.changed(db);
  },

  /* ---------- keyboard and clipboard (on the focused table) ---------- */
  tableKey: function (e, db) {
    if (e.target !== e.currentTarget) return;
    var S = this.S, k = e.key, mod = e.ctrlKey || e.metaKey, E = S.cellEdit;
    // Keys typed before the cell editor has taken focus still belong to the edit.
    if (E && E.dbId === db.id && E.where === 'table') {
      if (k.length === 1 && !mod && !e.altKey) { e.preventDefault(); E.draft += k; this.bump(); this.focusSel('[data-cellinput]', 'end'); }
      else if (k === 'Enter' || k === 'Tab' || (E.enter && /^Arrow/.test(k))) { e.preventDefault(); this.leaveEdit(db, k, e.shiftKey); }
      else if (k === 'Escape') { e.preventDefault(); this.cancelEdit(db); }
      return;
    }
    var R = this.selRange(db); if (!R) return;
    var g = this.tableGrid(db);
    if (k === 'Escape') { S.cellSel = null; this.bump(); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); this.clearRange(db, R); return; }
    if (mod && (k === 'a' || k === 'A')) { e.preventDefault(); if (g.rowIds.length) this.setCellSel(db, { rowId: g.rowIds[0], propId: g.colIds[0] }, { rowId: g.rowIds[g.rowIds.length - 1], propId: g.colIds[g.colIds.length - 1] }); this.bump(); return; }
    if (k === 'Tab' && g.rowIds.length && !S.cellSel.allRows) {
      e.preventDefault();
      var t = this.stepFrom(db, g.rowIds[R.fr], g.colIds[R.fc], 'Tab', e.shiftKey);
      if (t) { this.setCellSel(db, t); this.bump(); this.scrollToCell(t); }
      return;
    }
    var moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[k] && g.rowIds.length) {
      e.preventDefault();
      S.tabRun = null;
      var fr = clamp(R.fr + moves[k][0], 0, g.rowIds.length - 1), fc = clamp(R.fc + moves[k][1], 0, g.colIds.length - 1);
      var f = { rowId: g.rowIds[fr], propId: g.colIds[fc] };
      if (e.shiftKey && !S.cellSel.allRows) S.cellSel.f = f; else this.setCellSel(db, f);
      this.bump(); this.scrollToCell(f);
      return;
    }
    if (!g.rowIds.length || S.cellSel.allRows) return;
    var row = byId(db.rows, g.rowIds[R.fr]), prop = byId(db.props, g.colIds[R.fc]);
    if (!row || !prop) return;
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); this.editCellAt(db, row, prop, null); return; }
    var typeable = { title: 1, text: 1, url: 1, email: 1, phone: 1, number: 1 };
    if (k.length === 1 && !mod && !e.altKey && typeable[prop.type]) { e.preventDefault(); this.editCellAt(db, row, prop, k); }
  },
  scrollToCell: function (f) {
    this.later(function () { var el = document.querySelector('[data-ck="' + f.rowId + '|' + f.propId + '"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, 0);
  },
  editCellAt: function (db, row, prop, typed) {
    this.setCellSel(db, { rowId: row.id, propId: prop.id });
    var el = document.querySelector('[data-ck="' + row.id + '|' + prop.id + '"]');
    this.startCellEdit({ currentTarget: el || document.body, stopPropagation: function () {} }, db, row, prop, 'table');
    // Started by typing (Excel's Enter mode): arrow keys finish the edit and move, as Tab and Enter do.
    if (typed != null && this.S.cellEdit) { this.S.cellEdit.draft = typed; this.S.cellEdit.enter = true; this.bump(); this.focusSel('[data-cellinput]', 'end'); }
  },
  /* Excel-style moves. Tab goes right and wraps to the first cell of the next row (Shift+Tab goes back).
     Enter goes down; after a run of Tabs it returns to the column the run started in, as Excel does. */
  stepFrom: function (db, rowId, propId, key, shift) {
    var S = this.S, g = this.tableGrid(db), r = g.rowIds.indexOf(rowId), c = g.colIds.indexOf(propId);
    var nr = g.rowIds.length, nc = g.colIds.length;
    if (r < 0 || c < 0) return null;
    if (key === 'Tab') {
      if (!S.tabRun || S.tabRun.dbId !== db.id || S.tabRun.rowId !== rowId) S.tabRun = { dbId: db.id, col: c };
      if (!shift) { if (c < nc - 1) c++; else if (r < nr - 1) { r++; c = 0; S.tabRun.col = 0; } }
      else { if (c > 0) c--; else if (r > 0) { r--; c = nc - 1; S.tabRun.col = c; } }
      S.tabRun.rowId = g.rowIds[r];
    } else if (key === 'Enter') {
      if (S.tabRun && S.tabRun.dbId === db.id && S.tabRun.rowId === rowId) c = clamp(S.tabRun.col, 0, nc - 1);
      S.tabRun = null;
      r = clamp(r + (shift ? -1 : 1), 0, nr - 1);
    } else {
      var mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[key];
      if (!mv) return null;
      S.tabRun = null;
      r = clamp(r + mv[0], 0, nr - 1); c = clamp(c + mv[1], 0, nc - 1);
    }
    return { rowId: g.rowIds[r], propId: g.colIds[c] };
  },
  // Commits the edit in progress and moves the selection as the key says, with the table focused for more typing.
  leaveEdit: function (db, key, shift) {
    var E = this.S.cellEdit; if (!E) return;
    var here = { rowId: E.rowId, propId: E.propId };
    this.commitCellEdit();
    var f = this.stepFrom(db, here.rowId, here.propId, key, shift) || here;
    this.setCellSel(db, f);
    this.focusTable(db);
    this.scrollToCell(f);
    this.bump();
  },
  cancelEdit: function (db) {
    var E = this.S.cellEdit; if (!E) return;
    this.S.cellEdit = null;
    this.setCellSel(db, { rowId: E.rowId, propId: E.propId });
    this.focusTable(db);
    this.bump();
  },
  rangeCells: function (db, R) {
    var g = this.tableGrid(db), out = [];
    for (var r = R.r1; r <= R.r2; r++) {
      var row = byId(db.rows, g.rowIds[r]); if (!row) continue;
      var line = [];
      for (var c = R.c1; c <= R.c2; c++) { var p = byId(db.props, g.colIds[c]); if (p) line.push({ row: row, prop: p }); }
      out.push(line);
    }
    return out;
  },
  rangeText: function (db, R) {
    var self = this;
    return tsvStringify(this.rangeCells(db, R).map(function (line) { return line.map(function (x) { return self.cellText(db, x.row, x.prop); }); }));
  },
  // Clipboard events fire on the node holding the text selection, which may be a cell's text inside the
  // table; they are ours when the table itself has focus and no editor is involved.
  tableOwns: function (e) {
    var t = e.target, w = e.currentTarget;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return false;
    return t === w || (typeof document !== 'undefined' && document.activeElement === w);
  },
  tableCopy: function (e, db) {
    if (!this.tableOwns(e)) return;
    var R = this.selRange(db); if (!R || R.r2 < R.r1) return;
    e.preventDefault();
    try { e.clipboardData.setData('text/plain', this.rangeText(db, R)); } catch (x) { /* clipboard unavailable */ }
    this.toast('Copied ' + plural(R.cells, 'cell'), 'info');
  },
  tableCut: function (e, db) {
    if (!this.tableOwns(e)) return;
    var R = this.selRange(db); if (!R || R.r2 < R.r1) return;
    e.preventDefault();
    try { e.clipboardData.setData('text/plain', this.rangeText(db, R)); } catch (x) { /* clipboard unavailable */ }
    this.clearRange(db, R, 'Cut');
  },
  tablePaste: function (e, db) {
    if (!this.tableOwns(e)) return;
    var R = this.selRange(db); if (!R) return;
    var t = ''; try { t = e.clipboardData.getData('text/plain'); } catch (x) { /* clipboard unavailable */ }
    if (!t) return;
    e.preventDefault();
    this.pasteGrid(db, R, t);
  },

  /* ---------- bulk edits with undo ---------- */
  // Databases a bulk edit can touch: this one, plus the other side of any two-way relation in it.
  snapshotDbs: function (db) {
    var self = this, list = [db];
    db.props.forEach(function (p) { if (p.type === 'relation' && p.config.reversePropId) { var t = self.db(p.config.targetId); if (t && list.indexOf(t) < 0) list.push(t); } });
    return list.map(function (d) { return { id: d.id, props: clone(d.props), rows: clone(d.rows) }; });
  },
  restoreDbs: function (snap) {
    var self = this;
    snap.forEach(function (s) { var d = self.db(s.id); if (!d) return; d.props = s.props; d.rows = s.rows; self.changed(d); });
    this.calc = new Map();
    this.bump();
  },
  undoToast: function (text, snap) {
    var self = this;
    this.toast(text, 'success', { label: 'Undo', run: function () { self.restoreDbs(snap); } });
  },
  writeCell: function (db, row, prop, v) {
    if (prop.type === 'relation') { this.setRelation(db, row, prop, v || []); return; }
    if (v === null && prop.type !== 'title') delete row.cells[prop.id]; else row.cells[prop.id] = v;
    row.updatedAt = nowIso();
  },
  clearRange: function (db, R, verb) {
    if (R.r2 < R.r1) return;
    var self = this, snap = this.snapshotDbs(db), n = 0;
    this.rangeCells(db, R).forEach(function (line) {
      line.forEach(function (x) {
        if (COMPUTED[x.prop.type]) return;
        var empty = x.prop.type === 'title' ? '' : x.prop.type === 'checkbox' ? false : (x.prop.type === 'multi_select' || x.prop.type === 'relation' || x.prop.type === 'files') ? [] : null;
        self.writeCell(db, x.row, x.prop, empty); n++;
      });
    });
    this.calc = new Map();
    this.changed(db);
    if (n) this.undoToast((verb || 'Cleared') + ' ' + plural(n, 'cell'), snap);
  },
  // Turns pasted text into a value for a property; undefined means "leave the cell alone".
  textToCell: function (db, prop, t) {
    t = String(t == null ? '' : t);
    var s = t.trim();
    switch (prop.type) {
      case 'title': case 'text': return t;
      case 'url': case 'email': case 'phone': return s;
      case 'number': { if (!s) return null; var n = parseFloat(s.replace(/[$,%\s]/g, '')); return isNaN(n) ? null : n; }
      case 'checkbox': return /^(yes|y|true|1|x|done|checked|ticked)$/i.test(s);
      case 'date': {
        if (!s) return null;
        var parts = s.split(/\s+(?:-|to)\s+/i), a = FE.parseDateText(parts[0]), b = parts[1] ? FE.parseDateText(parts[1]) : null;
        return a === null ? undefined : mkDate(FE.serialToIso(a), b === null ? null : FE.serialToIso(b));
      }
      case 'select': case 'status': {
        if (!s) return null;
        var name = s.split(',')[0].trim(), op = optByName(prop, name);
        if (!op) { op = mkOpt(name, OPT_COLORS[(prop.config.options || []).length % OPT_COLORS.length]); (prop.config.options = prop.config.options || []).push(op); }
        return op.id;
      }
      case 'multi_select':
        return s.split(',').map(function (x) { return x.trim(); }).filter(Boolean).map(function (name) {
          var o = optByName(prop, name);
          if (!o) { o = mkOpt(name, OPT_COLORS[(prop.config.options || []).length % OPT_COLORS.length]); (prop.config.options = prop.config.options || []).push(o); }
          return o.id;
        });
      case 'relation': {
        var target = this.db(prop.config.targetId); if (!target) return undefined;
        var tp = this.titleProp(target), names = s.split(',').map(function (x) { return lc(x.trim()); }).filter(Boolean);
        return target.rows.filter(function (r) { return names.indexOf(lc(r.cells[tp.id])) >= 0; }).map(function (r) { return r.id; });
      }
      default: return undefined; // files and computed properties
    }
  },
  pasteGrid: function (db, R, text) {
    var self = this, grid = tsvParse(text), g = this.tableGrid(db);
    if (!grid.length) return;
    var snap = this.snapshotDbs(db), n = 0, rowIds = g.rowIds.slice();
    var fill = grid.length === 1 && grid[0].length === 1 && R.cells > 1;
    var h = fill ? R.r2 - R.r1 + 1 : grid.length, w = fill ? R.c2 - R.c1 + 1 : grid[0].length;
    var start = Math.max(0, R.r1);
    for (var i = 0; i < h; i++) {
      var rid = rowIds[start + i], row = rid && byId(db.rows, rid);
      if (!row) { row = this.addRow(db, {}); rowIds.splice(start + i, 0, row.id); }
      for (var j = 0; j < w; j++) {
        var pid = g.colIds[R.c1 + j]; if (!pid) break;
        var prop = byId(db.props, pid);
        var raw = fill ? grid[0][0] : (grid[i] || [])[j];
        if (!prop || raw === undefined) continue;
        var v = this.textToCell(db, prop, raw);
        if (v === undefined) continue;
        this.writeCell(db, row, prop, v); n++;
      }
    }
    var last = byId(db.rows, rowIds[start + h - 1]);
    if (last && g.colIds[R.c1] && rowIds[start]) this.setCellSel(db, { rowId: rowIds[start], propId: g.colIds[R.c1] }, { rowId: last.id, propId: g.colIds[Math.min(R.c1 + w - 1, g.colIds.length - 1)] });
    this.calc = new Map();
    this.changed(db);
    if (n) this.undoToast('Pasted ' + plural(n, 'cell'), snap);
  }
};

Object.assign(Component.prototype, DbRangeMix);
