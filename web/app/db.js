/* ================= databases ================= */
var CALC_FNS = [['none', 'None'], ['count_all', 'Count all'], ['count_values', 'Count values'], ['count_empty', 'Count empty'], ['percent_empty', 'Percent empty'], ['percent_not_empty', 'Percent not empty'], ['sum', 'Sum'], ['average', 'Average'], ['median', 'Median'], ['min', 'Min'], ['max', 'Max'], ['range', 'Range'], ['checked', 'Checked'], ['unchecked', 'Unchecked'], ['percent_checked', 'Percent checked'], ['earliest', 'Earliest'], ['latest', 'Latest']];
var CALC_LABEL = {}; CALC_FNS.forEach(function (c) { CALC_LABEL[c[0]] = c[1]; });
var ROLLUP_FNS = [['count', 'Count related'], ['count_values', 'Count values'], ['count_unique', 'Count unique values'], ['percent_empty', 'Percent empty'], ['sum', 'Sum'], ['range', 'Range'], ['average', 'Average'], ['median', 'Median'], ['min', 'Min'], ['max', 'Max'], ['percent_checked', 'Percent true'], ['show', 'Show values'], ['earliest', 'Earliest date'], ['latest', 'Latest date']];
var NUM_FORMATS = [['number', 'Number'], ['commas', 'Number with commas'], ['currency', 'Australian dollar'], ['percent', 'Percent']];
var FORMULA_FORMATS = [['auto', 'Automatic'], ['number', 'Number (2 dp)'], ['currency', 'Australian dollar'], ['percent', 'Percent'], ['date', 'Date'], ['text', 'Text']];
var DEFAULT_W = { title: 280, text: 200, number: 120, select: 150, multi_select: 200, status: 150, date: 140, checkbox: 96, url: 200, email: 200, phone: 150, relation: 220, rollup: 130, formula: 150, lookup: 170, created_time: 190, last_edited_time: 190 };

var DbMix = {
  db: function (id) { var m = this.mod(id); return m && m.type === 'database' ? m : null; },
  dbView: function (db) { var v = byId(db.views, db.activeViewId); if (!v) { v = db.views[0]; db.activeViewId = v.id; } return v; },
  titleProp: function (db) { return db.props.filter(function (p) { return p.type === 'title'; })[0] || db.props[0]; },
  propByName: function (db, name) { var n = lc(name).trim(); return db.props.filter(function (p) { return lc(p.name).trim() === n; })[0] || null; },
  rowTitle: function (db, row) { var tp = this.titleProp(db); return row && tp ? (row.cells[tp.id] || '') : ''; },

  /* ---------- values ---------- */
  cellVal: function (db, row, prop, depth) {
    depth = depth || 0;
    if (depth > 8) return FE.err('#CYCLE!');
    var v = row.cells[prop.id];
    switch (prop.type) {
      case 'title': case 'text': case 'url': case 'email': case 'phone': return v == null ? '' : String(v);
      case 'number': return typeof v === 'number' && isFinite(v) ? v : null;
      case 'select': case 'status': return byId(prop.config.options, v);
      case 'multi_select': return (v || []).map(function (id) { return byId(prop.config.options, id); }).filter(Boolean);
      case 'date': return dateStart(v);
      case 'files': return Array.isArray(v) ? v : [];
      case 'checkbox': return !!v;
      case 'created_time': return row.createdAt;
      case 'last_edited_time': return row.updatedAt;
      case 'relation': { var t = this.db(prop.config.targetId); if (!t) return []; return (v || []).map(function (id) { return byId(t.rows, id); }).filter(Boolean); }
      case 'rollup': return this.rollupVal(db, row, prop, depth);
      case 'formula': return this.formulaVal(db, row, prop, depth);
      case 'lookup': return this.lookupVal(db, row, prop, depth);
    }
    return v;
  },
  numFmt: function (v, f, dp) {
    if (v === null || v === undefined || v === '') return '';
    if (FE.isErr(v)) return v.error;
    if (typeof v !== 'number') return String(v);
    var fixed = typeof dp === 'number';
    if (f === 'currency') return FE.format(v, 'currency', fixed ? dp : 2);
    if (f === 'percent') return FE.format(v / 100, 'percent', fixed ? dp : Number.isInteger(v) ? 0 : 1);
    if (f === 'commas') return FE.format(v, 'number', fixed ? dp : Number.isInteger(v) ? 0 : 2);
    if (fixed) return v.toFixed(dp);
    return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(4)));
  },
  dateText: function (raw) { var st = dateStart(raw), en = dateEnd(raw); return st ? fmtDay(st) + (en ? ' - ' + fmtDay(en) : '') : ''; },
  cellText: function (db, row, prop, depth) {
    var self = this, v = this.cellVal(db, row, prop, depth);
    switch (prop.type) {
      case 'number': return this.numFmt(v, prop.config.format, prop.config.decimals);
      case 'select': case 'status': return v ? v.name : '';
      case 'multi_select': return v.map(function (o) { return o.name; }).join(', ');
      case 'date': return this.dateText(row.cells[prop.id]);
      case 'files': return v.map(function (id) { return self.attName(id); }).join(', ');
      case 'checkbox': return v ? 'Yes' : 'No';
      case 'created_time': case 'last_edited_time': return fmtDayTime(v);
      case 'relation': { var t = this.db(prop.config.targetId); return v.map(function (r) { return self.rowTitle(t, r) || 'Untitled'; }).join(', '); }
      case 'rollup': return this.rollupText(db, prop, v);
      case 'formula': return this.formulaText(prop, v);
      case 'lookup': return v == null ? '' : String(v);
    }
    return v == null ? '' : String(v);
  },
  rollupVal: function (db, row, prop, depth) {
    var self = this, c = prop.config, rel = byId(db.props, c.relationPropId);
    if (!rel || rel.type !== 'relation') return null;
    var t = this.db(rel.config.targetId); if (!t) return null;
    var t0 = t, rows = this.cellVal(db, row, rel, depth + 1), fn = c.fn || 'count';
    if (fn === 'count') return rows.length;
    var tp = byId(t.props, c.targetPropId); if (!tp) return null;
    var vals = rows.map(function (r) { return self.cellVal(t, r, tp, depth + 1); });
    var nums = [];
    vals.forEach(function (v) { if (typeof v === 'number' && isFinite(v)) nums.push(v); else if (typeof v === 'string' && v !== '' && isFinite(+v) && tp.type !== 'date') nums.push(+v); });
    function isEmpty(v) { return v === null || v === '' || v === false || (Array.isArray(v) && !v.length) || FE.isErr(v); }
    switch (fn) {
      case 'count_values': return vals.filter(function (v) { return !isEmpty(v); }).length;
      case 'count_unique': { var seen = {}; rows.forEach(function (r) { var t = self.cellText(t0, r, tp, depth + 1); if (t !== '') seen[t] = 1; }); return Object.keys(seen).length; }
      case 'percent_empty': return rows.length ? vals.filter(isEmpty).length / rows.length : null;
      case 'range': return nums.length ? Math.max.apply(null, nums) - Math.min.apply(null, nums) : null;
      case 'sum': return nums.reduce(function (a, b) { return a + b; }, 0);
      case 'average': return nums.length ? nums.reduce(function (a, b) { return a + b; }, 0) / nums.length : null;
      case 'median': { if (!nums.length) return null; var s = nums.slice().sort(function (a, b) { return a - b; }), mid = s.length >> 1; return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2; }
      case 'min': return nums.length ? Math.min.apply(null, nums) : null;
      case 'max': return nums.length ? Math.max.apply(null, nums) : null;
      case 'percent_checked': return rows.length ? vals.filter(function (v) { return v === true; }).length / rows.length : null;
      case 'show': return rows.map(function (r) { return self.cellText(t, r, tp, depth + 1); }).filter(Boolean).join(', ');
      case 'earliest': case 'latest': {
        var ds = vals.map(function (v) { return typeof v === 'string' ? v.slice(0, 10) : null; }).filter(function (v) { return v && /^\d{4}-\d{2}-\d{2}$/.test(v); }).sort();
        return ds.length ? (fn === 'earliest' ? ds[0] : ds[ds.length - 1]) : null;
      }
    }
    return null;
  },
  rollupText: function (db, prop, v) {
    if (v === null || v === undefined) return '';
    var fn = prop.config.fn || 'count';
    if (fn === 'percent_checked' || fn === 'percent_empty') return Math.round(v * 100) + '%';
    if (fn === 'earliest' || fn === 'latest') return fmtDay(v);
    if (fn === 'show') return String(v);
    if (fn === 'sum' || fn === 'average' || fn === 'median' || fn === 'min' || fn === 'max' || fn === 'range') {
      var rel = byId(db.props, prop.config.relationPropId), t = rel && this.db(rel.config.targetId), tp = t && byId(t.props, prop.config.targetPropId);
      if (tp && tp.type === 'number') return this.numFmt(Math.round(v * 100) / 100, tp.config.format, tp.config.decimals);
      return String(Math.round(v * 100) / 100);
    }
    return String(v);
  },
  toFe: function (db, row, p, depth) {
    var v = this.cellVal(db, row, p, depth), self = this;
    switch (p.type) {
      case 'number': return v === null ? '' : v;
      case 'checkbox': return !!v;
      case 'date': return v ? FE.isoToSerial(v) : '';
      case 'created_time': case 'last_edited_time': { var s = sydParts(v); return FE.dateSerial(s.y, s.m, s.d) + (s.h * 60 + s.mi) / 1440; }
      case 'select': case 'status': return v ? v.name : '';
      case 'multi_select': return v.map(function (o) { return o.name; }).join(', ');
      case 'files': return v.map(function (id) { return self.attName(id); }).join(', ');
      case 'relation': { var t = this.db(p.config.targetId); return v.map(function (r) { return self.rowTitle(t, r); }).join(', '); }
      case 'rollup': { if (v === null) return ''; var fn = p.config.fn; if (fn === 'earliest' || fn === 'latest') return FE.isoToSerial(v); return v; }
      case 'formula': return v === null ? '' : v;
    }
    return v == null ? '' : v;
  },
  formulaVal: function (db, row, prop, depth) {
    var key = 'F|' + db.id + '|' + row.id + '|' + prop.id;
    if (this.calc.has(key)) return this.calc.get(key);
    if (this.calcStack.has(key)) return FE.err('#CYCLE!');
    this.calcStack.add(key);
    var self = this, v, expr = String(prop.config.expr || '').replace(/^\s*=/, '');
    try {
      if (!expr.trim()) v = null;
      else v = FE.evaluate(expr, {
        fns: {
          PROP: { min: 1, max: 1, fn: function (a) { var name = FE.toStr(FE.scalar(a[0])); var p = self.propByName(db, name); if (!p) return FE.err('#NAME?'); return self.toFe(db, row, p, depth + 1); } },
          ID: { min: 0, max: 0, fn: function () { return row.id; } }
        }
      });
    } finally { this.calcStack.delete(key); }
    if (FE.isRange(v)) v = FE.scalar(v);
    if (v && v.message) v = { error: v.error };
    this.calc.set(key, v);
    return v;
  },
  formulaText: function (prop, v) {
    if (v === null || v === undefined || v === '') return '';
    if (FE.isErr(v)) return v.error;
    var f = prop.config.format || 'auto';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (typeof v === 'number') {
      if (f === 'currency') return FE.format(v, 'currency');
      if (f === 'percent') return FE.format(v, 'percent', 0);
      if (f === 'date') return FE.fmtDate(v);
      if (f === 'number') return FE.format(v, 'number', 2);
      return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(2)));
    }
    return String(v);
  },
  lookupVal: function (db, row, prop, depth) {
    var self = this, c = prop.config, src = byId(db.props, c.sourcePropId), t = this.db(c.targetId);
    if (!src || !t) return '';
    var mp = byId(t.props, c.matchPropId), rp = byId(t.props, c.returnPropId);
    if (!mp || !rp) return '';
    var key = lc(this.cellText(db, row, src, depth + 1)).trim();
    if (!key) return '';
    var ik = 'L|' + t.id + '|' + mp.id, idx = this.calc.get(ik);
    if (!idx) { idx = new Map(); t.rows.forEach(function (r) { var k = lc(self.cellText(t, r, mp, depth + 1)).trim(); if (k && !idx.has(k)) idx.set(k, r); }); this.calc.set(ik, idx); }
    var hit = idx.get(key);
    return hit ? this.cellText(t, hit, rp, depth + 1) : '#N/A';
  },
  sortKey: function (db, row, prop) {
    var v = this.cellVal(db, row, prop);
    switch (prop.type) {
      case 'number': return v;
      case 'select': case 'status': return v ? idxById(prop.config.options, v.id) : null;
      case 'multi_select': return v.length ? lc(v[0].name) : null;
      case 'date': case 'created_time': case 'last_edited_time': return v || null;
      case 'checkbox': return v ? 1 : 0;
      case 'rollup': return v === null ? null : typeof v === 'number' ? v : lc(v);
      case 'formula': if (v === null || v === '' || FE.isErr(v)) return null; return typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : lc(v);
    }
    var t = lc(this.cellText(db, row, prop)); return t === '' ? null : t;
  },

  /* ---------- filters ---------- */
  filterKind: function (prop) {
    switch (prop.type) {
      case 'number': return 'number';
      case 'select': case 'status': return 'select';
      case 'multi_select': return 'multi';
      case 'date': case 'created_time': case 'last_edited_time': return 'date';
      case 'checkbox': return 'checkbox';
      case 'rollup': return /^(count|count_values|count_unique|percent_empty|range|sum|average|median|min|max|percent_checked)$/.test(prop.config.fn || 'count') ? 'number' : 'text';
    }
    return 'text';
  },
  filterOps: function (kind) {
    return {
      text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['is', 'is'], ['is_not', 'is not'], ['starts', 'starts with'], ['ends', 'ends with'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
      number: [['eq', '='], ['ne', '!='], ['gt', '>'], ['lt', '<'], ['ge', '>='], ['le', '<='], ['empty', 'is empty'], ['not_empty', 'is not empty']],
      select: [['is', 'is'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
      multi: [['has', 'contains'], ['has_not', 'does not contain'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
      date: [['is', 'is'], ['before', 'is before'], ['after', 'is after'], ['on_before', 'is on or before'], ['on_after', 'is on or after'], ['past_week', 'is within the past week'], ['next_week', 'is within the next week'], ['this_month', 'is this month'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
      checkbox: [['checked', 'is checked'], ['unchecked', 'is not checked']]
    }[kind];
  },
  opNeedsValue: function (op) { return ['empty', 'not_empty', 'checked', 'unchecked', 'past_week', 'next_week', 'this_month'].indexOf(op) < 0; },
  rowMatches: function (db, row, f) {
    var prop = byId(db.props, f.propId); if (!prop) return true;
    var kind = this.filterKind(prop), op = f.op, val = f.value;
    if (this.opNeedsValue(op) && (val === '' || val === null || val === undefined)) return true;
    var v = this.cellVal(db, row, prop);
    if (kind === 'text') {
      var t = lc(this.cellText(db, row, prop)), q = lc(val);
      switch (op) { case 'contains': return t.indexOf(q) >= 0; case 'not_contains': return t.indexOf(q) < 0; case 'is': return t === q; case 'is_not': return t !== q; case 'starts': return t.indexOf(q) === 0; case 'ends': return t.slice(-q.length) === q; case 'empty': return t === ''; case 'not_empty': return t !== ''; }
    }
    if (kind === 'number') {
      var n = typeof v === 'number' ? v : null, x = parseFloat(val);
      if (op === 'empty') return n === null; if (op === 'not_empty') return n !== null;
      if (n === null || isNaN(x)) return false;
      switch (op) { case 'eq': return n === x; case 'ne': return n !== x; case 'gt': return n > x; case 'lt': return n < x; case 'ge': return n >= x; case 'le': return n <= x; }
    }
    if (kind === 'select') { var id = v ? v.id : null; switch (op) { case 'is': return id === val; case 'is_not': return id !== val; case 'empty': return !id; case 'not_empty': return !!id; } }
    if (kind === 'multi') { var ids = v.map(function (o) { return o.id; }); switch (op) { case 'has': return ids.indexOf(val) >= 0; case 'has_not': return ids.indexOf(val) < 0; case 'empty': return !ids.length; case 'not_empty': return ids.length > 0; } }
    if (kind === 'checkbox') return op === 'checked' ? v === true : v !== true;
    if (kind === 'date') {
      var d = v ? (prop.type === 'date' ? v : (function (p) { return p.y + '-' + FE.pad2(p.m) + '-' + FE.pad2(p.d); })(sydParts(v))) : null;
      if (op === 'empty') return !d; if (op === 'not_empty') return !!d;
      if (!d) return false;
      var t0 = todayIso();
      switch (op) {
        case 'is': return d === val; case 'before': return d < val; case 'after': return d > val; case 'on_before': return d <= val; case 'on_after': return d >= val;
        case 'past_week': return d <= t0 && d >= addDaysIso(t0, -7);
        case 'next_week': return d >= t0 && d <= addDaysIso(t0, 7);
        case 'this_month': return d.slice(0, 7) === t0.slice(0, 7);
      }
    }
    return true;
  },
  viewRows: function (db, view) {
    var self = this, rows = db.rows.slice(), fs = (view.filters || []).filter(function (f) { return byId(db.props, f.propId); });
    if (fs.length) rows = rows.filter(function (r) { return view.filterMode === 'or' ? fs.some(function (f) { return self.rowMatches(db, r, f); }) : fs.every(function (f) { return self.rowMatches(db, r, f); }); });
    var q = lc(this.S.dbSearch[db.id] || '').trim();
    if (q) rows = rows.filter(function (r) { return db.props.some(function (p) { return lc(self.cellText(db, r, p)).indexOf(q) >= 0; }); });
    var sorts = (view.sorts || []).map(function (s) { return { p: byId(db.props, s.propId), dir: s.dir === 'desc' ? -1 : 1 }; }).filter(function (s) { return s.p; });
    if (sorts.length) {
      var order = new Map(); db.rows.forEach(function (r, i) { order.set(r.id, i); });
      var keys = new Map(); rows.forEach(function (r) { keys.set(r.id, sorts.map(function (s) { return self.sortKey(db, r, s.p); })); });
      rows.sort(function (a, b) {
        var ka = keys.get(a.id), kb = keys.get(b.id);
        for (var i = 0; i < sorts.length; i++) {
          var x = ka[i], y = kb[i];
          if (x === y) continue;
          if (x === null) return 1; if (y === null) return -1;
          var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
          if (c) return c * sorts[i].dir;
        }
        return order.get(a.id) - order.get(b.id);
      });
    }
    return rows;
  },
  groupsFor: function (db, view, rows, gid) {
    var self = this, gp = byId(db.props, gid || view.groupBy);
    if (!gp) return [{ key: '__all', label: null, rows: rows, value: undefined }];
    var groups = [];
    if (gp.type === 'select' || gp.type === 'status' || gp.type === 'multi_select') {
      groups.push({ key: '__none', label: 'No ' + gp.name, color: 'gray', rows: [], value: null, none: true });
      (gp.config.options || []).forEach(function (o) { groups.push({ key: o.id, label: o.name, color: o.color, rows: [], value: o.id }); });
      rows.forEach(function (r) {
        var v = r.cells[gp.id];
        if (gp.type === 'multi_select') { var ids = (v || []).filter(function (id) { return byId(gp.config.options, id); }); if (!ids.length) groups[0].rows.push(r); ids.forEach(function (id) { var g = groups.filter(function (x) { return x.key === id; })[0]; if (g) g.rows.push(r); }); }
        else { var g = groups.filter(function (x) { return x.key === v; })[0] || groups[0]; g.rows.push(r); }
      });
    } else if (gp.type === 'checkbox') {
      groups.push({ key: 'yes', label: 'Checked', color: 'green', rows: [], value: true }, { key: 'no', label: 'Unchecked', color: 'gray', rows: [], value: false });
      rows.forEach(function (r) { (r.cells[gp.id] ? groups[0] : groups[1]).rows.push(r); });
    } else {
      var map = {};
      rows.forEach(function (r) { var t = self.cellText(db, r, gp) || ''; if (!map[t]) { map[t] = { key: 't:' + t, label: t || 'No ' + gp.name, color: 'gray', rows: [], value: t, none: !t }; groups.push(map[t]); } map[t].rows.push(r); });
      groups.sort(function (a, b) { return a.none ? -1 : b.none ? 1 : a.label < b.label ? -1 : 1; });
    }
    if (view.hideEmptyGroups) groups = groups.filter(function (g) { return g.rows.length; });
    else if (gp.type !== 'checkbox') groups = groups.filter(function (g) { return !g.none || g.rows.length; });
    groups.forEach(function (g) { g.prop = gp; });
    return groups;
  },
  calcFor: function (db, prop, rows, fn) {
    var self = this;
    if (!fn || fn === 'none') return '';
    var vals = rows.map(function (r) { return self.cellVal(db, r, prop); });
    function empty(v) { return v === null || v === '' || v === undefined || (Array.isArray(v) && !v.length) || (prop.type === 'checkbox' && v === false); }
    var nums = vals.filter(function (v) { return typeof v === 'number' && isFinite(v); });
    function num(x) { if (prop.type === 'number') return self.numFmt(Math.round(x * 100) / 100, prop.config.format); return String(Math.round(x * 100) / 100); }
    var n = rows.length;
    switch (fn) {
      case 'count_all': return String(n);
      case 'count_values': return String(vals.filter(function (v) { return !empty(v); }).length);
      case 'count_empty': return String(vals.filter(empty).length);
      case 'percent_empty': return n ? Math.round(vals.filter(empty).length / n * 100) + '%' : '0%';
      case 'percent_not_empty': return n ? Math.round(vals.filter(function (v) { return !empty(v); }).length / n * 100) + '%' : '0%';
      case 'sum': return num(nums.reduce(function (a, b) { return a + b; }, 0));
      case 'average': return nums.length ? num(nums.reduce(function (a, b) { return a + b; }, 0) / nums.length) : '';
      case 'median': { if (!nums.length) return ''; var s = nums.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1; return num(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); }
      case 'min': return nums.length ? num(Math.min.apply(null, nums)) : '';
      case 'max': return nums.length ? num(Math.max.apply(null, nums)) : '';
      case 'range': return nums.length ? num(Math.max.apply(null, nums) - Math.min.apply(null, nums)) : '';
      case 'checked': return String(vals.filter(function (v) { return v === true; }).length);
      case 'unchecked': return String(vals.filter(function (v) { return v !== true; }).length);
      case 'percent_checked': return n ? Math.round(vals.filter(function (v) { return v === true; }).length / n * 100) + '%' : '0%';
      case 'earliest': case 'latest': { var ds = vals.filter(function (v) { return typeof v === 'string' && /^\d{4}-/.test(v); }).map(function (v) { return v.slice(0, 10); }).sort(); return ds.length ? fmtDay(fn === 'earliest' ? ds[0] : ds[ds.length - 1]) : ''; }
    }
    return '';
  },
  calcOptions: function (prop) {
    var base = ['none', 'count_all', 'count_values', 'count_empty', 'percent_empty', 'percent_not_empty'];
    if (prop.type === 'number' || prop.type === 'rollup' || prop.type === 'formula') base = base.concat(['sum', 'average', 'median', 'min', 'max', 'range']);
    if (prop.type === 'checkbox' || prop.type === 'formula') base = base.concat(['checked', 'unchecked', 'percent_checked']);
    if (prop.type === 'date' || prop.type === 'created_time' || prop.type === 'last_edited_time') base = base.concat(['earliest', 'latest']);
    return base;
  },

  /* ---------- mutations ---------- */
  touchRow: function (db, row) { row.updatedAt = nowIso(); this.changed(db); },
  setCell: function (db, row, prop, value) {
    if (prop.type === 'relation') return this.setRelation(db, row, prop, value);
    row.cells[prop.id] = value;
    this.touchRow(db, row);
  },
  setRelation: function (db, row, prop, ids) {
    var old = row.cells[prop.id] || [];
    ids = ids.filter(function (x, i) { return ids.indexOf(x) === i; });
    row.cells[prop.id] = ids;
    var t = this.db(prop.config.targetId), rev = t && byId(t.props, prop.config.reversePropId);
    if (t && rev && t !== db) {
      var added = ids.filter(function (x) { return old.indexOf(x) < 0; }), removed = old.filter(function (x) { return ids.indexOf(x) < 0; });
      added.forEach(function (id) { var tr = byId(t.rows, id); if (!tr) return; var a = tr.cells[rev.id] || []; if (a.indexOf(row.id) < 0) tr.cells[rev.id] = a.concat([row.id]); });
      removed.forEach(function (id) { var tr = byId(t.rows, id); if (!tr) return; tr.cells[rev.id] = (tr.cells[rev.id] || []).filter(function (x) { return x !== row.id; }); });
      if (added.length || removed.length) t.updatedAt = nowIso();
    }
    this.touchRow(db, row);
  },
  addRow: function (db, preset, atTop) {
    var view = this.dbView(db), cells = {};
    (view.filters || []).forEach(function (f) {
      var p = byId(db.props, f.propId); if (!p || f.value === '' || f.value == null) return;
      if ((p.type === 'select' || p.type === 'status') && f.op === 'is') cells[p.id] = f.value;
      if (p.type === 'multi_select' && f.op === 'has') cells[p.id] = [f.value];
      if (p.type === 'checkbox') cells[p.id] = f.op === 'checked';
    });
    db.props.forEach(function (p) { if (p.type === 'status' && cells[p.id] === undefined && p.config.options && p.config.options[0] && !(preset && preset[p.id] !== undefined)) cells[p.id] = p.config.options[0].id; });
    Object.assign(cells, preset || {});
    var row = mkRow(cells);
    if (atTop) db.rows.unshift(row); else db.rows.push(row);
    var self = this;
    db.props.forEach(function (p) { if (p.type === 'relation' && (cells[p.id] || []).length) { var ids = cells[p.id]; row.cells[p.id] = []; self.setRelation(db, row, p, ids); } });
    this.changed(db);
    return row;
  },
  newRowAndEdit: function (db, preset) {
    var row = this.addRow(db, preset);
    var tp = this.titleProp(db);
    this.S.cellEdit = { dbId: db.id, rowId: row.id, propId: tp.id, draft: '', where: 'table' };
    this.focusSel('[data-cellinput]', 'end');
    this.bump();
    return row;
  },
  deleteRows: function (db, ids) {
    var self = this, set = {}; ids.forEach(function (id) { set[id] = 1; });
    db.rows = db.rows.filter(function (r) { return !set[r.id]; });
    this.mods('database').concat(this.ws.modules.filter(function (m) { return m.type === 'database' && m.archivedAt; })).forEach(function (o) {
      o.props.forEach(function (p) { if (p.type === 'relation' && p.config.targetId === db.id) o.rows.forEach(function (r) { if (r.cells[p.id]) r.cells[p.id] = r.cells[p.id].filter(function (x) { return !set[x]; }); }); });
    });
    if (this.S.peek && set[this.S.peek.rowId]) this.S.peek = null;
    if (this.S.route.rowId && set[this.S.route.rowId]) this.S.route = { name: 'm', id: db.id };
    this.S.dbSel[db.id] = {};
    this.changed(db);
    self.toast(plural(ids.length, 'row') + ' deleted', 'info');
  },
  duplicateRow: function (db, row) {
    var self = this, c = clone(row);
    c.id = uid(); c.createdAt = c.updatedAt = nowIso();
    var tp = this.titleProp(db); if (c.cells[tp.id]) c.cells[tp.id] += ' copy';
    (c.body || []).forEach(function (b) { b.id = uid(); });
    db.props.forEach(function (p) { if (p.type === 'relation') c.cells[p.id] = []; });
    db.rows.splice(db.rows.indexOf(row) + 1, 0, c);
    db.props.forEach(function (p) { if (p.type === 'relation' && (row.cells[p.id] || []).length) self.setRelation(db, c, p, row.cells[p.id].slice()); });
    this.changed(db);
    return c;
  },
  unlinkDatabase: function (gone) {
    this.ws.modules.forEach(function (o) {
      if (o.type !== 'database') return;
      o.props.forEach(function (p) {
        if (p.type === 'relation' && p.config.targetId === gone.id) { p.config.targetId = null; p.config.reversePropId = null; o.rows.forEach(function (r) { r.cells[p.id] = []; }); }
        if (p.type === 'lookup' && p.config.targetId === gone.id) { p.config.targetId = null; p.config.matchPropId = null; p.config.returnPropId = null; }
      });
    });
  },
  defaultConfig: function (type) {
    if (type === 'select' || type === 'multi_select') return { options: [] };
    if (type === 'status') return { options: [mkOpt('Not started', 'gray'), mkOpt('In progress', 'blue'), mkOpt('Done', 'green')] };
    if (type === 'number') return { format: 'number' };
    if (type === 'files') return {};
    if (type === 'relation') return { targetId: null, reversePropId: null };
    if (type === 'rollup') return { relationPropId: null, targetPropId: null, fn: 'count' };
    if (type === 'formula') return { expr: '', format: 'auto' };
    if (type === 'lookup') return { sourcePropId: null, targetId: null, matchPropId: null, returnPropId: null };
    return {};
  },
  addProp: function (db, type, afterId, name) {
    var p = mkProp(type, uniqueName(name || PROP_LABEL[type], db.props.map(function (x) { return x.name; })), this.defaultConfig(type));
    var i = afterId ? idxById(db.props, afterId) : -1;
    if (i >= 0) db.props.splice(i + 1, 0, p); else db.props.push(p);
    if (type === 'checkbox') db.rows.forEach(function (r) { r.cells[p.id] = false; });
    if (type === 'multi_select' || type === 'relation' || type === 'files') db.rows.forEach(function (r) { r.cells[p.id] = []; });
    this.changed(db);
    return p;
  },
  changePropType: function (db, prop, type) {
    if (prop.type === type || prop.type === 'title') return;
    var self = this, old = db.rows.map(function (r) { return { r: r, t: self.cellText(db, r, prop), v: r.cells[prop.id] }; });
    if (prop.type === 'relation') this.dropReverse(db, prop);
    var keepOpts = (prop.type === 'select' || prop.type === 'multi_select' || prop.type === 'status') && (type === 'select' || type === 'multi_select' || type === 'status');
    var cfg = this.defaultConfig(type);
    if (keepOpts) cfg.options = prop.config.options || [];
    prop.type = type; prop.config = cfg;
    old.forEach(function (o) {
      var t = o.t, v;
      switch (type) {
        case 'text': case 'url': case 'email': case 'phone': v = t; break;
        case 'number': { var n = parseFloat(String(t).replace(/[$,%\s]/g, '')); v = isNaN(n) ? null : n; break; }
        case 'checkbox': v = /^(yes|true|1|x|done|checked)$/i.test(String(t).trim()); break;
        case 'date': { var s = FE.parseDateText(t); v = s === null ? null : FE.serialToIso(s); break; }
        case 'select': case 'status': {
          if (keepOpts) { v = Array.isArray(o.v) ? o.v[0] || null : o.v; break; }
          var name = String(t).split(',')[0].trim(); if (!name) { v = null; break; }
          var op = optByName(prop, name); if (!op) { op = mkOpt(name, OPT_COLORS[prop.config.options.length % OPT_COLORS.length]); prop.config.options.push(op); } v = op.id; break;
        }
        case 'multi_select': {
          if (keepOpts) { v = Array.isArray(o.v) ? o.v : o.v ? [o.v] : []; break; }
          v = String(t).split(',').map(function (x) { return x.trim(); }).filter(Boolean).map(function (name) { var op = optByName(prop, name); if (!op) { op = mkOpt(name, OPT_COLORS[prop.config.options.length % OPT_COLORS.length]); prop.config.options.push(op); } return op.id; });
          break;
        }
        case 'relation': case 'files': v = []; break;
        default: v = undefined;
      }
      if (v === undefined) delete o.r.cells[prop.id]; else o.r.cells[prop.id] = v;
    });
    if (type === 'status' && !keepOpts && !prop.config.options.length) prop.config = this.defaultConfig('status');
    this.changed(db);
  },
  dropReverse: function (db, prop) {
    var t = this.db(prop.config.targetId), rev = t && byId(t.props, prop.config.reversePropId);
    if (rev) { rev.config.reversePropId = null; }
  },
  makeTwoWay: function (db, prop) {
    var t = this.db(prop.config.targetId); if (!t || t === db || prop.config.reversePropId) return;
    var rev = mkProp('relation', uniqueName(db.title, t.props.map(function (x) { return x.name; })), { targetId: db.id, reversePropId: prop.id });
    t.props.push(rev);
    t.rows.forEach(function (r) { r.cells[rev.id] = []; });
    db.rows.forEach(function (r) { (r.cells[prop.id] || []).forEach(function (id) { var tr = byId(t.rows, id); if (tr && tr.cells[rev.id].indexOf(r.id) < 0) tr.cells[rev.id].push(r.id); }); });
    prop.config.reversePropId = rev.id;
    this.changed(t); this.changed(db);
  },
  deleteProp: function (db, prop) {
    var self = this;
    db.props = db.props.filter(function (p) { return p !== prop; });
    db.rows.forEach(function (r) { delete r.cells[prop.id]; });
    db.views.forEach(function (v) {
      v.filters = v.filters.filter(function (f) { return f.propId !== prop.id; });
      v.sorts = v.sorts.filter(function (s) { return s.propId !== prop.id; });
      v.hidden = v.hidden.filter(function (h) { return h !== prop.id; });
      if (v.calcs) delete v.calcs[prop.id];
      if (v.groupBy === prop.id) v.groupBy = null;
      if (v.dateProp === prop.id) v.dateProp = null;
    });
    db.props.forEach(function (p) {
      if (p.type === 'rollup' && p.config.relationPropId === prop.id) p.config.relationPropId = null;
      if (p.type === 'lookup' && p.config.sourcePropId === prop.id) p.config.sourcePropId = null;
    });
    this.ws.modules.forEach(function (o) {
      if (o.type !== 'database') return;
      o.props.forEach(function (p) {
        if (p.type === 'rollup' && p.config.targetPropId === prop.id) { var rel = byId(o.props, p.config.relationPropId); if (rel && rel.config.targetId === db.id) p.config.targetPropId = null; }
        if (p.type === 'lookup' && p.config.targetId === db.id && (p.config.matchPropId === prop.id || p.config.returnPropId === prop.id)) { if (p.config.matchPropId === prop.id) p.config.matchPropId = null; if (p.config.returnPropId === prop.id) p.config.returnPropId = null; }
        if (p.type === 'relation' && p.config.reversePropId === prop.id && p.config.targetId === db.id) p.config.reversePropId = null;
      });
    });
    if (this.S.pop && this.S.pop.propId === prop.id) this.S.pop = null;
    self.changed(db);
  },
  setView: function (db, id) { db.activeViewId = id; this.S.dbSel[db.id] = {}; this.changed(null); },
  addView: function (db, type) {
    var v = mkView(type, uniqueName(VIEW_LABEL[type], db.views.map(function (x) { return x.name; })));
    this.ensureViewNeeds(db, v);
    db.views.push(v); db.activeViewId = v.id;
    this.changed(db);
    return v;
  },
  ensureViewNeeds: function (db, v) {
    if (v.type === 'board' && !byId(db.props, v.groupBy)) {
      var g = db.props.filter(function (p) { return p.type === 'status' || p.type === 'select'; })[0];
      if (!g) g = this.addProp(db, 'status', null, 'Status');
      v.groupBy = g.id;
    }
    if (v.type === 'calendar' && !byId(db.props, v.dateProp)) {
      var d = db.props.filter(function (p) { return p.type === 'date'; })[0];
      if (!d) d = this.addProp(db, 'date', null, 'Date');
      v.dateProp = d.id;
    }
  },
  selectedIds: function (db) { var s = this.S.dbSel[db.id] || {}; return Object.keys(s).filter(function (k) { return s[k]; }); },

  /* ---------- CSV ---------- */
  csvFor: function (db) {
    var self = this, view = this.dbView(db), props = db.props.filter(function (p) { return view.hidden.indexOf(p.id) < 0; });
    var rows = [props.map(function (p) { return p.name; })];
    this.viewRows(db, view).forEach(function (r) { rows.push(props.map(function (p) { return p.type === 'checkbox' ? (r.cells[p.id] ? 'Yes' : 'No') : self.cellText(db, r, p); })); });
    return csvStringify(rows);
  },
  openCsvExport: function (db) { this.modal('csvExport', { dbId: db.id, text: this.csvFor(db) }); },
  openCsvImport: function (db) { this.modal('csvImport', { dbId: db.id, text: '', header: true }); this.focusSel('[data-csvin]'); },
  csvModalVals: function (M) {
    var self = this, db = this.db(M.dbId), v = {};
    if (!db) return v;
    v.dbTitle = db.title;
    if (M.kind === 'csvExport') {
      v.text = M.text; v.copy = function () { self.copyText(M.text, 'CSV'); }; v.selectAll = function (e) { e.target.select(); };
      v.rowsLine = plural(Math.max(0, csvParse(M.text).length - 1), 'row') + ' from the current view';
      return v;
    }
    var parsed = csvParse(M.text), header = M.header && parsed.length ? parsed[0] : null, body = header ? parsed.slice(1) : parsed;
    var cols = header || (parsed[0] || []).map(function (_, i) { return 'Column ' + (i + 1); });
    v.text = M.text; v.headerOn = !!M.header;
    v.onText = function (e) { M.text = e.target.value; self.bump(); };
    v.onHeader = function (e) { M.header = e.target.checked; self.bump(); };
    v.mapping = cols.map(function (c, i) { var p = self.propByName(db, c); return { name: c, target: p ? 'Into "' + p.name + '" (' + PROP_LABEL[p.type] + ')' : (i === 0 && !p ? 'Into the title column' : 'New text property'), cls: p || i === 0 ? 'map-ok' : 'map-new' }; });
    v.hasMapping = parsed.length > 0 && cols.length > 0;
    v.summary = parsed.length ? plural(body.length, 'row') + ', ' + plural(cols.length, 'column') : 'Paste CSV text above (comma separated, quoted fields allowed).';
    v.canImport = body.length > 0; v.cannotImport = body.length === 0;
    v.doImport = function () { var n = self.importCsv(db, parsed, !!M.header); self.S.modal = null; self.toast(plural(n, 'row') + ' imported into ' + db.title, 'success'); self.bump(); };
    return v;
  },
  importCsv: function (db, parsed, hasHeader) {
    var self = this, header = hasHeader ? parsed[0] : (parsed[0] || []).map(function (_, i) { return 'Column ' + (i + 1); });
    var body = hasHeader ? parsed.slice(1) : parsed, tp = this.titleProp(db);
    var targets = header.map(function (name, i) {
      var p = self.propByName(db, name);
      if (!p && i === 0) return tp;
      if (!p) { p = mkProp('text', uniqueName(name || 'Column ' + (i + 1), db.props.map(function (x) { return x.name; }))); db.props.push(p); }
      return p;
    });
    body.forEach(function (line) {
      var row = mkRow({});
      targets.forEach(function (p, i) {
        var t = (line[i] || '').trim(); if (!p || COMPUTED[p.type]) return;
        switch (p.type) {
          case 'number': { var n = parseFloat(t.replace(/[$,%\s]/g, '')); row.cells[p.id] = isNaN(n) ? null : n; break; }
          case 'checkbox': row.cells[p.id] = /^(yes|true|1|x|checked)$/i.test(t); break;
          case 'date': { var s = FE.parseDateText(t); row.cells[p.id] = s === null ? null : FE.serialToIso(s); break; }
          case 'select': case 'status': { if (!t) break; var o = optByName(p, t); if (!o) { o = mkOpt(t, OPT_COLORS[p.config.options.length % OPT_COLORS.length]); p.config.options.push(o); } row.cells[p.id] = o.id; break; }
          case 'multi_select': row.cells[p.id] = t.split(',').map(function (x) { return x.trim(); }).filter(Boolean).map(function (name) { var o = optByName(p, name); if (!o) { o = mkOpt(name, OPT_COLORS[p.config.options.length % OPT_COLORS.length]); p.config.options.push(o); } return o.id; }); break;
          case 'relation': { var tdb = self.db(p.config.targetId); row.cells[p.id] = []; if (tdb) { var ids = t.split(',').map(function (x) { return lc(x.trim()); }).filter(Boolean).map(function (name) { var hit = tdb.rows.filter(function (r) { return lc(self.rowTitle(tdb, r)) === name; })[0]; return hit && hit.id; }).filter(Boolean); row._rel = row._rel || []; row._rel.push([p, ids]); } break; }
          default: row.cells[p.id] = t;
        }
      });
      db.rows.push(row);
      (row._rel || []).forEach(function (x) { self.setRelation(db, row, x[0], x[1]); });
      delete row._rel;
    });
    this.changed(db);
    return body.length;
  },

  /* ---------- peek / row doc ---------- */
  openPeek: function (db, row) { this.S.peek = { dbId: db.id, rowId: row.id }; this.S.cellEdit = null; this.S.pop = null; this.S.menu = null; this.bump(); },
  rowMenu: function (e, db, row) {
    var self = this;
    this.openMenu(e, [
      { label: 'Open in side peek', run: function () { self.openPeek(db, row); } },
      { label: 'Open as full page', run: function () { self.goModule(db.id, null, row.id); } },
      { label: 'Duplicate', run: function () { self.duplicateRow(db, row); } },
      'divider',
      { label: 'Delete', danger: true, run: function () { self.deleteRows(db, [row.id]); } }
    ]);
  },

  /* ---------- cell editing ---------- */
  startCellEdit: function (e, db, row, prop, where) {
    var self = this;
    if (e && e.stopPropagation) e.stopPropagation();
    switch (prop.type) {
      case 'title': case 'text': case 'url': case 'email': case 'phone': case 'number': {
        var raw = row.cells[prop.id];
        this.S.cellEdit = { dbId: db.id, rowId: row.id, propId: prop.id, draft: raw == null ? '' : String(raw), where: where };
        this.S.pop = null; this.S.menu = null;
        this.bump(); this.focusSel('[data-cellinput]', 'end');
        return;
      }
      case 'checkbox': this.setCell(db, row, prop, !row.cells[prop.id]); return;
      case 'select': case 'status': case 'multi_select': this.openPop(e, 'opt', { dbId: db.id, rowId: row.id, propId: prop.id, q: '' }, 260); this.focusSel('[data-popq]'); return;
      case 'date': this.openPop(e, 'date', { dbId: db.id, rowId: row.id, propId: prop.id }, 260); return;
      case 'files': this.openPop(e, 'files', { dbId: db.id, rowId: row.id, propId: prop.id }, 300); return;
      case 'relation': this.openPop(e, 'rel', { dbId: db.id, rowId: row.id, propId: prop.id, q: '' }, 300); this.focusSel('[data-popq]'); return;
      case 'formula': case 'rollup': case 'lookup': this.openPop(e, 'prop', { dbId: db.id, propId: prop.id }, 340); return;
    }
  },
  commitCellEdit: function () {
    var E = this.S.cellEdit; if (!E) return;
    this.S.cellEdit = null;
    var db = this.db(E.dbId), row = db && byId(db.rows, E.rowId), prop = row && byId(db.props, E.propId);
    if (!prop) { this.bump(); return; }
    var v = E.draft;
    if (prop.type === 'number') { var n = parseFloat(String(v).replace(/[$,\s]/g, '')); v = String(v).trim() === '' || isNaN(n) ? null : n; }
    else v = String(v);
    if (row.cells[prop.id] !== v) this.setCell(db, row, prop, v); else this.bump();
  },
  cellVals: function (db, row, prop, where, width) {
    var self = this, E = this.S.cellEdit;
    var editing = !!(E && E.rowId === row.id && E.propId === prop.id && E.where === where);
    var c = {
      cls: 'cell ct-' + prop.type + (editing ? ' editing' : '') + (COMPUTED[prop.type] ? ' ro' : ''),
      style: width ? 'width: ' + width + 'px;' : '',
      editing: editing, showText: false, hasTags: false, tags: [], isCheck: false, checked: false, isLink: false, href: '', isTitle: false, isPlaceholder: false, text: '', placeholder: '', ro: false, label: prop.name, hasBool: false, isErr: false,
      click: function (e) { self.startCellEdit(e, db, row, prop, where); },
      stop: function (e) { e.stopPropagation(); },
      inputType: prop.type === 'number' ? 'text' : 'text'
    };
    if (editing) {
      c.draft = E.draft;
      c.onDraft = function (e) { E.draft = e.target.value; self.bump(); };
      c.onKey = function (e) {
        // In the table, leaving an edit keeps the cell selected with the table focused, so arrows,
        // typing and copy/paste carry on from there. Tab moves one cell across.
        // In the table these behave as in Excel: Tab commits and moves right (wrapping to the next row), Enter
        // commits and moves down, and when the edit was started by typing, the arrow keys commit and move too.
        if (where === 'table' && !(e.key === 'Enter' && prop.type === 'title' && (e.ctrlKey || e.metaKey))) {
          if (e.key === 'Enter' || e.key === 'Tab' || (E.enter && /^Arrow/.test(e.key))) { e.preventDefault(); self.leaveEdit(db, e.key, e.shiftKey); return; }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); self.cancelEdit(db); return; }
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); self.commitCellEdit(); if (where === 'table' && prop.type === 'title') self.openPeek(db, row); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); self.S.cellEdit = null; self.bump(); }
        else if (e.key === 'Tab') { e.preventDefault(); self.commitCellEdit(); }
      };
      c.onBlur = function () { self.commitCellEdit(); };
      return c;
    }
    var v = this.cellVal(db, row, prop);
    switch (prop.type) {
      case 'select': case 'status': if (v) { c.hasTags = true; c.tags = [{ text: v.name, cls: 'tag c-' + v.color + (prop.type === 'status' ? ' status' : '') }]; } break;
      case 'multi_select': if (v.length) { c.hasTags = true; c.tags = v.map(function (o) { return { text: o.name, cls: 'tag c-' + o.color }; }); } break;
      case 'relation': { var t = this.db(prop.config.targetId); if (v.length) { c.hasTags = true; c.tags = v.map(function (r) { return { text: self.rowTitle(t, r) || 'Untitled', cls: 'tag rel' }; }); } else if (!t) { c.isPlaceholder = true; c.placeholder = 'Choose a database'; } break; }
      case 'checkbox': c.isCheck = true; c.checked = !!v; c.toggle = function (e) { e.stopPropagation(); self.setCell(db, row, prop, !row.cells[prop.id]); }; break;
      case 'url': case 'email': case 'phone':
        if (v) { c.isLink = true; c.text = v; c.href = prop.type === 'email' ? 'mailto:' + v : prop.type === 'phone' ? 'tel:' + v.replace(/[^\d+]/g, '') : (/^https?:\/\//i.test(v) ? v : 'https://' + v); }
        break;
      case 'formula': {
        var fv = v;
        if (typeof fv === 'boolean') { c.isCheck = true; c.checked = fv; c.ro = true; c.toggle = function (e) { e.stopPropagation(); }; }
        else { c.showText = true; c.text = this.formulaText(prop, fv); if (FE.isErr(fv)) { c.cls += ' err'; } if (typeof fv === 'number') c.cls += ' num'; }
        break;
      }
      case 'number': c.showText = true; c.text = this.numFmt(v, prop.config.format, prop.config.decimals); c.cls += ' num'; break;
      case 'files': if (this.remote) this.loadAttachments(db.id); if (v.length) { var ft = this.fileThumbs(v, where); c.hasThumbs = ft.thumbs.length > 0; c.thumbs = ft.thumbs; c.hasTags = ft.tags.length > 0; c.tags = ft.tags; } else if (where === 'peek') { c.isPlaceholder = true; c.placeholder = self.remote ? 'Add files' : 'Files need the Truss server'; } break;
      case 'rollup': c.showText = true; c.text = this.rollupText(db, prop, v); if (prop.config.fn === 'percent_checked' && v !== null) { c.hasBar = true; c.barStyle = 'width: ' + Math.round(v * 100) + '%'; } if (typeof v === 'number') c.cls += ' num'; break;
      case 'lookup': c.showText = true; c.text = v; if (v === '#N/A') c.cls += ' err'; break;
      case 'date': c.showText = true; c.text = this.dateText(row.cells[prop.id]); if (v) { var dd = FE.isoToSerial(dateEnd(row.cells[prop.id]) || v) - FE.isoToSerial(todayIso()); if (dd < 0) c.cls += ' past'; } break;
      default: c.showText = true; c.text = this.cellText(db, row, prop);
    }
    if (prop.type === 'title') { c.isTitle = where === 'table'; c.openRow = function (e) { e.stopPropagation(); self.openPeek(db, row); }; if (!c.text) { c.showText = false; c.isPlaceholder = where !== 'table'; c.placeholder = 'Untitled'; if (where === 'table') { c.showText = true; c.text = ''; c.cls += ' untitled'; } } }
    if (!c.showText && !c.hasTags && !c.isCheck && !c.isLink && !c.isPlaceholder && where === 'peek') { c.isPlaceholder = true; c.placeholder = COMPUTED[prop.type] ? '' : 'Empty'; }
    c.hasBar = !!c.hasBar; c.barStyle = c.barStyle || '';
    return c;
  },

  /* ---------- database page ---------- */
  dbVals: function (db) {
    var self = this, S = this.S, view = this.dbView(db);
    this.ensureViewNeeds(db, view);
    var rows = this.viewRows(db, view);
    var visible = db.props.filter(function (p) { return view.hidden.indexOf(p.id) < 0 || p.type === 'title'; });
    var sel = S.dbSel[db.id] || (S.dbSel[db.id] = {});
    var selIds = this.selectedIds(db).filter(function (id) { return byId(db.rows, id); });
    var V = {
      title: db.title, desc: db.description || '', tile: 'tile tile-' + db.color,
      onTitle: function (e) { db.title = e.target.value; self.changed(db); },
      onTitleBlur: function () { self.renameModule(db, db.title); },
      onDesc: function (e) { db.description = e.target.value; self.changed(db); },
      pickColor: function (e) { self.colorMenu(e, db); }, icon: db.icon || '', hasIcon: !!db.icon, noIcon: !db.icon,
      views: db.views.map(function (v) {
        var on = v.id === view.id;
        return { name: v.name, cls: 'vtab' + (on ? ' on' : ''), ic: iconFlags(viewIcon(v.type)), go: function (e) { if (on) self.openPop(e, 'view', { dbId: db.id, viewId: v.id }, 300); else self.setView(db, v.id); } };
      }),
      addView: function (e) { self.openMenu(e, VIEW_TYPES.map(function (t) { return { label: t[1], run: function () { self.addView(db, t[0]); } }; })); },
      viewIs: { table: view.type === 'table', board: view.type === 'board', list: view.type === 'list', gallery: view.type === 'gallery', calendar: view.type === 'calendar' },
      search: S.dbSearch[db.id] || '',
      onSearch: function (e) { S.dbSearch[db.id] = e.target.value; self.bump(); },
      filterCls: 'tb-btn' + (view.filters.length ? ' active' : ''), filterLabel: view.filters.length ? plural(view.filters.length, 'filter') : 'Filter',
      sortCls: 'tb-btn' + (view.sorts.length ? ' active' : ''), sortLabel: view.sorts.length ? plural(view.sorts.length, 'sort') : 'Sort',
      groupCls: 'tb-btn' + (view.groupBy && (view.type === 'table' || view.type === 'board') ? ' active' : ''),
      groupLabel: view.type === 'board' ? 'Group: ' + ((byId(db.props, view.groupBy) || {}).name || 'none') : view.groupBy ? 'Grouped' : 'Group',
      showGroupBtn: view.type === 'table' || view.type === 'board',
      openFilter: function (e) { if (!view.filters.length) self.addFilter(db, view); self.openPop(e, 'filter', { dbId: db.id }, 520); },
      openSort: function (e) { if (!view.sorts.length) { view.sorts.push({ id: uid(), propId: self.titleProp(db).id, dir: 'asc' }); self.changed(db); } self.openPop(e, 'sort', { dbId: db.id }, 420); },
      openGroup: function (e) { self.openPop(e, 'group', { dbId: db.id }, 300); },
      openProps: function (e) { self.openPop(e, 'props', { dbId: db.id }, 300); },
      more: function (e) {
        self.openMenu(e, [
          { label: 'Export view as CSV', run: function () { self.openCsvExport(db); } },
          { label: 'Import CSV...', run: function () { self.openCsvImport(db); } },
          'divider',
          { label: 'Duplicate database', run: function () { self.duplicateModule(db); } },
          { label: 'Move to archive', run: function () { self.archiveModule(db); } }
        ]);
      },
      newRow: function () { if (view.type === 'table') self.newRowAndEdit(db); else { var r = self.addRow(db, self.presetFromView(db, view)); self.openPeek(db, r); self.focusSel('[data-rowtitle]'); } },
      count: plural(rows.length, 'row'),
      selCount: selIds.length, hasSel: selIds.length > 0, selLabel: selIds.length + ' selected',
      deleteSel: function () { self.confirm({ title: 'Delete ' + plural(selIds.length, 'row') + '?', message: 'Rows and their page content are removed.', label: 'Delete', danger: true }, function () { self.deleteRows(db, selIds); }); },
      clearSel: function () { S.dbSel[db.id] = {}; self.bump(); },
      isEmpty: db.rows.length === 0, noMatch: db.rows.length > 0 && rows.length === 0,
      clearFilters: function () { view.filters = []; S.dbSearch[db.id] = ''; self.changed(db); },
      chips: view.filters.map(function (f) {
        var p = byId(db.props, f.propId); if (!p) return null;
        var ops = self.filterOps(self.filterKind(p)), opl = (ops.filter(function (o) { return o[0] === f.op; })[0] || [0, ''])[1];
        var val = f.value;
        if (p.type === 'select' || p.type === 'status' || p.type === 'multi_select') { var o = byId(p.config.options, val); val = o ? o.name : ''; }
        if (p.type === 'date' && val) val = fmtDay(val);
        return { label: p.name + ' ' + opl + (self.opNeedsValue(f.op) ? ' ' + (val === '' || val == null ? '...' : val) : ''), open: function (e) { self.openPop(e, 'filter', { dbId: db.id }, 520); }, remove: function () { view.filters = view.filters.filter(function (x) { return x !== f; }); self.changed(db); } };
      }).filter(Boolean)
    };
    V.hasChips = V.chips.length > 0;
    if (view.type === 'table') Object.assign(V, this.tableVals(db, view, rows, visible, sel));
    if (view.type === 'board') V.board = this.boardVals(db, view, rows, visible);
    if (view.type === 'list') V.list = this.listVals(db, view, rows, visible);
    if (view.type === 'gallery') V.gallery = this.galleryVals(db, view, rows, visible);
    if (view.type === 'calendar') V.cal = this.calendarVals(db, view, rows);
    return V;
  },
  presetFromView: function (db, view) { return {}; },
  tableVals: function (db, view, rows, visible, sel) {
    var self = this, S = this.S;
    var cols = visible.map(function (p) {
      var w = p.w || DEFAULT_W[p.type] || 180;
      var sorted = (view.sorts || []).filter(function (s) { return s.propId === p.id; })[0];
      return { id: p.id, name: p.name, w: w, style: 'width: ' + w + 'px;', ic: iconFlags(PROP_ICON[p.type]), sortMark: sorted ? (sorted.dir === 'desc' ? 'desc' : 'asc') : '', hasSort: !!sorted,
        open: function (e) { self.openPop(e, 'prop', { dbId: db.id, propId: p.id }, 340); },
        resize: function (e) { e.preventDefault(); e.stopPropagation(); S.resize = { kind: 'db', id: db.id, propId: p.id, x: e.clientX, w: w }; self.bump(); } };
    });
    var totalW = cols.reduce(function (a, c) { return a + c.w; }, 0);
    var groups = this.groupsFor(db, view, rows);
    var grouped = !!byId(db.props, view.groupBy);
    var collapsed = S.collapsedGroups;
    // Record the grid as displayed so range selection, keyboard moves and paste line up with it.
    var flat = [], rIndex = {};
    groups.forEach(function (g) { if (!grouped || !collapsed[db.id + '|' + view.id + '|' + g.key]) g.rows.forEach(function (r) { rIndex[r.id] = flat.length; flat.push(r.id); }); });
    this.tblGrid = this.tblGrid || {};
    this.tblGrid[db.id] = { viewId: view.id, rowIds: flat, colIds: visible.map(function (p) { return p.id; }) };
    var R = this.selRange(db);
    cols.forEach(function (co, ci) { self.decorateHeader(co, db, visible[ci], ci, R); });
    return {
      dbId: db.id,
      onKey: function (e) { self.tableKey(e, db); },
      onCopy: function (e) { self.tableCopy(e, db); },
      onCut: function (e) { self.tableCut(e, db); },
      onPaste: function (e) { self.tablePaste(e, db); },
      wrapCls: 'dbt-wrap' + (S.cellDrag && S.cellDrag.moved ? ' selecting' : '') + (S.colDrag && S.colDrag.moved ? ' col-moving' : ''),
      cols: cols, tableStyle: 'min-width: ' + (totalW + 140) + 'px;',
      addProp: function (e) { self.newPropMenu(e, db, null); },
      grouped: grouped,
      groups: groups.map(function (g) {
        var ck = db.id + '|' + view.id + '|' + g.key, open = !collapsed[ck];
        return {
          label: g.label, count: g.rows.length, tagCls: 'tag c-' + (g.color || 'gray'), showHead: grouped, open: open || !grouped,
          chevCls: 'grp-chev' + (open ? ' open' : ''),
          toggle: function () { collapsed[ck] = open; self.bump(); },
          add: function () { var preset = {}; if (grouped && g.prop) { if (g.prop.type === 'multi_select') preset[g.prop.id] = g.value ? [g.value] : []; else if (g.prop.type === 'select' || g.prop.type === 'status' || g.prop.type === 'checkbox') preset[g.prop.id] = g.value; else if (g.prop.type === 'text' || g.prop.type === 'title') preset[g.prop.id] = g.value || ''; } self.newRowAndEdit(db, preset); },
          rows: g.rows.map(function (row) {
            var on = !!sel[row.id];
            return {
              cls: 'dbt-row' + (on ? ' selected' : '') + (S.peek && S.peek.rowId === row.id ? ' peeked' : ''),
              selected: on,
              toggleSel: function (e) { sel[row.id] = e.target.checked; self.bump(); },
              menu: function (e) { self.rowMenu(e, db, row); },
              cells: visible.map(function (p, ci) { var w = p.w || DEFAULT_W[p.type] || 180, c = self.cellVals(db, row, p, 'table', w); self.decorateCell(c, db, row, p, rIndex[row.id], ci, R); return c; })
            };
          }),
          calcs: visible.map(function (p) {
            var fn = (view.calcs || {})[p.id], w = p.w || DEFAULT_W[p.type] || 180, val = self.calcFor(db, p, g.rows, fn);
            return { style: 'width: ' + w + 'px;', label: fn && fn !== 'none' ? CALC_LABEL[fn] : 'Calculate', value: val, cls: 'dbt-calc' + (fn && fn !== 'none' ? ' set' : ''),
              open: function (e) { self.openMenu(e, self.calcOptions(p).map(function (k) { return { label: CALC_LABEL[k], checked: (fn || 'none') === k, run: function () { view.calcs = view.calcs || {}; view.calcs[p.id] = k; self.changed(db); } }; }), 200); } };
          })
        };
      }),
      allSel: rows.length > 0 && rows.every(function (r) { return sel[r.id]; }),
      toggleAll: function (e) { var on = e.target.checked; rows.forEach(function (r) { sel[r.id] = on; }); self.bump(); }
    };
  },
  miniProps: function (db, row, visible, limit) {
    var self = this, out = [];
    visible.forEach(function (p) {
      if (p.type === 'title' || out.length >= (limit || 6)) return;
      var v = self.cellVal(db, row, p), o = null;
      if ((p.type === 'select' || p.type === 'status') && v) o = { hasTags: true, tags: [{ text: v.name, cls: 'tag c-' + v.color }] };
      else if (p.type === 'multi_select' && v.length) o = { hasTags: true, tags: v.map(function (x) { return { text: x.name, cls: 'tag c-' + x.color }; }) };
      else if (p.type === 'relation' && v.length) { var t = self.db(p.config.targetId); o = { hasTags: true, tags: v.map(function (r) { return { text: self.rowTitle(t, r) || 'Untitled', cls: 'tag rel' }; }) }; }
      else if (p.type === 'checkbox') { if (v) o = { showText: true, text: p.name, cls: 'mini-check' }; }
      else { var t2 = self.cellText(db, row, p); if (t2 && !(p.type === 'formula' && typeof v === 'boolean')) o = { showText: true, text: (p.type === 'date' ? prettyDate(v) : t2), cls: p.type === 'date' ? 'mini-date' : '' }; }
      if (o) { o.hasTags = !!o.hasTags; o.showText = !!o.showText; o.tags = o.tags || []; o.text = o.text || ''; o.cls = 'mini ' + (o.cls || ''); o.label = p.name; out.push(o); }
    });
    return out;
  },
  boardVals: function (db, view, rows, visible) {
    var self = this, S = this.S, groups = this.groupsFor(db, view, rows);
    return groups.map(function (g) {
      var key = 'col:' + g.key;
      return {
        label: g.label, count: g.rows.length, tagCls: 'tag c-' + (g.color || 'gray'),
        cls: 'bcol' + (S.dropKey === key ? ' drop' : ''),
        over: function (e) { if (!S.drag || S.drag.kind !== 'card') return; e.preventDefault(); if (S.dropKey !== key) { S.dropKey = key; self.bump(); } },
        leave: function () { },
        drop: function (e) { e.preventDefault(); var d = S.drag; S.drag = null; S.dropKey = null; if (!d || d.kind !== 'card') return self.bump(); var row = byId(db.rows, d.rowId); if (!row) return self.bump(); self.setGroupValue(db, g, row, d.fromKey); },
        add: function () { var preset = {}; if (g.prop) preset[g.prop.id] = g.prop.type === 'multi_select' ? (g.value ? [g.value] : []) : g.value; var r = self.addRow(db, preset); self.openPeek(db, r); self.focusSel('[data-rowtitle]'); },
        cards: g.rows.map(function (row) {
          return {
            title: self.rowTitle(db, row) || 'Untitled', props: self.miniProps(db, row, visible, 5),
            cls: 'bcard' + (S.drag && S.drag.rowId === row.id ? ' dragging' : '') + (S.peek && S.peek.rowId === row.id ? ' peeked' : ''),
            drag: function (e) { S.drag = { kind: 'card', rowId: row.id, fromKey: g.key }; try { e.dataTransfer.setData('text/plain', row.id); e.dataTransfer.effectAllowed = 'move'; } catch (x) { } self.later(function () { self.bump(); }, 0); },
            end: function () { S.drag = null; S.dropKey = null; self.bump(); },
            open: function () { self.openPeek(db, row); }
          };
        })
      };
    });
  },
  setGroupValue: function (db, g, row, fromKey) {
    var p = g.prop; if (!p) return this.bump();
    if (p.type === 'multi_select') {
      var ids = (row.cells[p.id] || []).filter(function (x) { return x !== fromKey; });
      if (g.value && ids.indexOf(g.value) < 0) ids.push(g.value);
      this.setCell(db, row, p, ids);
    } else if (p.type === 'select' || p.type === 'status' || p.type === 'checkbox') this.setCell(db, row, p, g.value);
    else if (!COMPUTED[p.type] && p.type !== 'relation') this.setCell(db, row, p, g.value || '');
    else this.bump();
  },
  listVals: function (db, view, rows, visible) {
    var self = this;
    return { rows: rows.map(function (row) { return { title: self.rowTitle(db, row) || 'Untitled', props: self.miniProps(db, row, visible, 4), open: function () { self.openPeek(db, row); }, menu: function (e) { self.rowMenu(e, db, row); } }; }) };
  },
  galleryVals: function (db, view, rows, visible) {
    var self = this, cover = byId(db.props, view.coverProp) || db.props.filter(function (p) { return (p.type === 'select' || p.type === 'status') && view.hidden.indexOf(p.id) < 0; })[0];
    return { cards: rows.map(function (row) {
      var o = cover ? self.cellVal(db, row, cover) : null;
      var ex = (row.body || []).filter(function (b) { return TEXT_BLOCKS[b.type] && b.text; }).slice(0, 3).map(function (b) { return plainText(b.text); }).join(' ');
      return { title: self.rowTitle(db, row) || 'Untitled', props: self.miniProps(db, row, visible, 4), excerpt: ex, coverCls: 'gcover c-' + (o ? o.color : 'none'), open: function () { self.openPeek(db, row); } };
    }) };
  },
  calendarVals: function (db, view, rows) {
    var self = this, S = this.S, dp = byId(db.props, view.dateProp);
    var t = todayIso(), cur = S.calCursor[view.id] || t.slice(0, 7);
    var y = +cur.slice(0, 4), m = +cur.slice(5, 7);
    var first = FE.dateSerial(y, m, 1), dow = (FE.serialParts(first).dow + 6) % 7, start = first - dow;
    var byDay = {};
    if (dp) rows.forEach(function (r) { var d = dateStart(r.cells[dp.id]), de = dp.type === 'date' ? dateEnd(r.cells[dp.id]) : null; if (d && de) { var s0 = FE.isoToSerial(d), s1 = Math.min(FE.isoToSerial(de), s0 + 92); for (var q = s0; q <= s1; q++) { var qi = FE.serialToIso(q); (byDay[qi] = byDay[qi] || []).push(r); } return; } if (dp.type !== 'date') { var v = self.cellVal(db, r, dp); if (v) { var sp = sydParts(v); d = sp.y + '-' + FE.pad2(sp.m) + '-' + FE.pad2(sp.d); } } if (d) (byDay[d] = byDay[d] || []).push(r); });
    var last = FE.dateSerial(y, m + 1, 0), cells = Math.ceil((dow + FE.serialParts(last).d) / 7) * 7, days = [];
    for (var i = 0; i < cells; i++) {
      (function (s) {
        var iso = FE.serialToIso(s), p = FE.serialParts(s), items = byDay[iso] || [], key = 'day:' + iso;
        days.push({
          num: p.d, iso: iso,
          cls: 'cal-day' + (p.m !== m ? ' other' : '') + (iso === t ? ' today' : '') + (p.dow === 0 || p.dow === 6 ? ' wkend' : '') + (S.dropKey === key ? ' drop' : ''),
          items: items.slice(0, 4).map(function (r) { return { title: self.rowTitle(db, r) || 'Untitled', open: function () { self.openPeek(db, r); }, drag: function (e) { S.drag = { kind: 'cal', rowId: r.id }; try { e.dataTransfer.setData('text/plain', r.id); } catch (x) { } }, cls: 'cal-item' + (S.peek && S.peek.rowId === r.id ? ' peeked' : '') }; }),
          more: items.length > 4, moreText: '+' + (items.length - 4) + ' more',
          add: function () { if (!dp || dp.type !== 'date') return; var preset = {}; preset[dp.id] = iso; var r = self.addRow(db, preset); self.openPeek(db, r); self.focusSel('[data-rowtitle]'); },
          over: function (e) { if (!S.drag || S.drag.kind !== 'cal') return; e.preventDefault(); if (S.dropKey !== key) { S.dropKey = key; self.bump(); } },
          drop: function (e) { e.preventDefault(); var d = S.drag; S.drag = null; S.dropKey = null; if (d && dp && dp.type === 'date') { var r = byId(db.rows, d.rowId); if (r) { var cv = r.cells[dp.id], ce = dateEnd(cv), cs = dateStart(cv); return self.setCell(db, r, dp, ce && cs ? mkDate(iso, addDaysIso(iso, FE.isoToSerial(ce) - FE.isoToSerial(cs))) : iso); } } self.bump(); }
        });
      })(start + i);
    }
    var undated = dp ? rows.filter(function (r) { return !r.cells[dp.id]; }).length : 0;
    return {
      label: FE.MONL[m - 1] + ' ' + y, days: days, dow: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      prev: function () { var d = new Date(Date.UTC(y, m - 2, 1)); S.calCursor[view.id] = d.getUTCFullYear() + '-' + FE.pad2(d.getUTCMonth() + 1); self.bump(); },
      next: function () { var d = new Date(Date.UTC(y, m, 1)); S.calCursor[view.id] = d.getUTCFullYear() + '-' + FE.pad2(d.getUTCMonth() + 1); self.bump(); },
      today: function () { S.calCursor[view.id] = t.slice(0, 7); self.bump(); },
      dateName: dp ? dp.name : '', hasUndated: undated > 0, undatedText: plural(undated, 'row') + ' without ' + (dp ? dp.name : 'a date')
    };
  },
  newPropMenu: function (e, db, afterId) {
    var self = this;
    this.openMenu(e, PROP_TYPES.filter(function (t) { return t[0] !== 'title'; }).map(function (t) {
      return { label: t[1], run: function () { var p = self.addProp(db, t[0], afterId); if (t[0] === 'relation' || t[0] === 'rollup' || t[0] === 'formula' || t[0] === 'lookup' || t[0] === 'select' || t[0] === 'multi_select') self.later(function () { var el = document.querySelector('[data-th="' + p.id + '"]'); self.openPop(el ? { currentTarget: el } : null, 'prop', { dbId: db.id, propId: p.id }, 340); }, 30); } };
    }), 220);
  },

  /* ---------- row document (peek + full page) ---------- */
  rowDocVals: function (db, row, isPeek) {
    var self = this, S = this.S, view = this.dbView(db), rows = this.viewRows(db, view), i = rows.indexOf(row);
    var tp = this.titleProp(db);
    var props = db.props.filter(function (p) { return p.type !== 'title'; }).map(function (p) {
      return { name: p.name, ic: iconFlags(PROP_ICON[p.type]), open: function (e) { self.openPop(e, 'prop', { dbId: db.id, propId: p.id }, 340); }, cell: self.cellVals(db, row, p, 'peek') };
    });
    var words = (row.body || []).reduce(function (a, b) { return a + (TEXT_BLOCKS[b.type] ? (plainText(b.text).match(/\S+/g) || []).length : 0); }, 0);
    return {
      isPeek: isPeek, isFull: !isPeek, docCls: 'rowdoc' + (isPeek ? '' : ' full'),
      title: row.cells[tp.id] || '',
      onTitle: function (e) { row.cells[tp.id] = e.target.value.replace(/\n/g, ' '); self.touchRow(db, row); },
      onTitleKey: function (e) { if (e.key === 'Enter') { e.preventDefault(); self.focusBlockStart({ kind: 'row', modId: db.id, rowId: row.id }); } },
      props: props,
      addProp: function (e) { self.newPropMenu(e, db, null); },
      meta: 'Created ' + fmtDayTime(row.createdAt) + '  -  Edited ' + relTime(row.updatedAt) + (words ? '  -  ' + plural(words, 'word') : ''),
      dbTitle: db.title, tile: 'tile tile-' + db.color,
      close: function () { S.peek = null; S.cellEdit = null; self.bump(); },
      openFull: function () { self.goModule(db.id, null, row.id); },
      backToDb: function () { self.goModule(db.id); },
      toPeek: function () { self.goModule(db.id); self.openPeek(db, row); },
      hasPrev: i > 0, hasNext: i >= 0 && i < rows.length - 1, noPrev: !(i > 0), noNext: !(i >= 0 && i < rows.length - 1),
      prev: function () { if (i > 0) self.openPeek(db, rows[i - 1]); },
      next: function () { if (i < rows.length - 1) self.openPeek(db, rows[i + 1]); },
      position: i >= 0 ? (i + 1) + ' of ' + rows.length : '',
      more: function (e) { self.openMenu(e, [{ label: 'Duplicate', run: function () { var c = self.duplicateRow(db, row); if (isPeek) self.openPeek(db, c); } }, { label: 'Copy page as Markdown', run: function () { self.modal('text', { title: 'Markdown', text: self.blocksToMarkdown(self.rowTitle(db, row), row.body || []), what: 'Markdown' }); } }, 'divider', { label: 'Delete row', danger: true, run: function () { self.deleteRows(db, [row.id]); } }]); },
      ed: this.editorVals({ kind: 'row', modId: db.id, rowId: row.id }),
      backlinks: this.backlinkVals(this.rowTitle(db, row), null)
    };
  },

  /* ---------- popovers ---------- */
  popRefs: function (P) { var db = this.db(P.dbId); return { db: db, row: db && P.rowId ? byId(db.rows, P.rowId) : null, prop: db && P.propId ? byId(db.props, P.propId) : null, view: db ? this.dbView(db) : null }; },
  optPopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, row = R.row, prop = R.prop;
    if (!prop || !row) return {};
    var multi = prop.type === 'multi_select', cur = row.cells[prop.id], q = P.q || '', ql = lc(q).trim();
    var opts = (prop.config.options || []).filter(function (o) { return !ql || lc(o.name).indexOf(ql) >= 0; });
    var exact = (prop.config.options || []).some(function (o) { return lc(o.name) === ql; });
    function pick(o) {
      if (multi) { var a = (cur || []).slice(); var i = a.indexOf(o.id); if (i >= 0) a.splice(i, 1); else a.push(o.id); self.setCell(db, row, prop, a); P.q = ''; }
      else { self.setCell(db, row, prop, cur === o.id ? null : o.id); self.S.pop = null; self.bump(); }
    }
    var sel = multi ? (cur || []).map(function (id) { return byId(prop.config.options, id); }).filter(Boolean) : [];
    return {
      title: prop.name, q: q, estH: 90 + Math.min(opts.length, 8) * 34 + (sel.length ? 40 : 0),
      onQ: function (e) { P.q = e.target.value; self.bump(); },
      onKey: function (e) {
        if (e.key === 'Enter') { e.preventDefault(); if (opts[0] && (exact || !ql)) pick(opts.filter(function (o) { return lc(o.name) === ql; })[0] || opts[0]); else if (ql) create(); }
        if (e.key === 'Backspace' && !q && multi && (cur || []).length) { self.setCell(db, row, prop, cur.slice(0, -1)); }
      },
      selected: sel.map(function (o) { return { text: o.name, cls: 'tag c-' + o.color, remove: function () { pick(o); } }; }), hasSelected: sel.length > 0,
      opts: opts.map(function (o) { var on = multi ? (cur || []).indexOf(o.id) >= 0 : cur === o.id; return { text: o.name, cls: 'tag c-' + o.color, on: on, rowCls: 'opt-row' + (on ? ' on' : ''), pick: function () { pick(o); }, edit: function (e) { self.optionMenu(e, db, prop, o); } }; }),
      canCreate: !!ql && !exact, createLabel: 'Create "' + q.trim() + '"',
      create: create, hint: multi ? 'Select any number of options' : 'Select an option or create one'
    };
    function create() { var o = mkOpt(q.trim(), OPT_COLORS[(prop.config.options || []).length % OPT_COLORS.length]); prop.config.options.push(o); P.q = ''; pick(o); }
  },
  optionMenu: function (e, db, prop, o) {
    var self = this;
    var items = [{ label: 'Rename', run: function () { self.prompt({ title: 'Rename option', value: o.name }, function (v) { if (v.trim()) { o.name = v.trim(); self.changed(db); } }); } }];
    OPT_COLORS.forEach(function (c) { items.push({ label: OPT_COLOR_LABEL[c], swatch: 'c-' + c, checked: o.color === c, run: function () { o.color = c; self.changed(db); } }); });
    items.push('divider');
    items.push({ label: 'Delete option', danger: true, run: function () { prop.config.options = prop.config.options.filter(function (x) { return x !== o; }); db.rows.forEach(function (r) { var v = r.cells[prop.id]; if (Array.isArray(v)) r.cells[prop.id] = v.filter(function (x) { return x !== o.id; }); else if (v === o.id) r.cells[prop.id] = null; }); self.changed(db); } });
    var keep = this.S.pop;
    this.openMenu(e, items, 200);
    this.S.pop = keep;
  },
  datePopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, row = R.row, prop = R.prop;
    if (!prop || !row) return {};
    var raw = row.cells[prop.id], v = dateStart(raw) || '', en = dateEnd(raw) || '', t = todayIso();
    var ranged = !!en || !!P.ranged;
    function set(iso) { self.setCell(db, row, prop, ranged ? mkDate(iso || null, en && iso && en > iso ? en : null) : (iso || null)); }
    function setEnd(iso) { if (!v) return; self.setCell(db, row, prop, mkDate(v, iso || null)); }
    var d = v || t, cur = P.month || d.slice(0, 7), cy = +cur.slice(0, 4), cm = +cur.slice(5, 7);
    var first = FE.dateSerial(cy, cm, 1), dow = (FE.serialParts(first).dow + 6) % 7, days = [];
    for (var i = 0; i < 42; i++) (function (s) {
      var iso = FE.serialToIso(s), p = FE.serialParts(s);
      var on = iso === v || (en && iso === en), inr = en && iso > v && iso < en;
      days.push({ num: p.d, cls: 'dp-day' + (p.m !== cm ? ' other' : '') + (iso === t ? ' today' : '') + (on ? ' on' : '') + (inr ? ' inrange' : ''), pick: function () {
        // With a range on, the first pick after a start sets the end (or a new start if earlier).
        if (ranged && v && P.pickEnd) { if (iso >= v) setEnd(iso); else set(iso); P.pickEnd = false; self.bump(); return; }
        set(iso); if (ranged) { P.pickEnd = true; self.bump(); return; } self.S.pop = null; self.bump();
      } });
    })(first - dow + i);
    return {
      title: prop.name, value: v, endValue: en, ranged: ranged, estH: ranged ? 440 : 410,
      display: v ? self.dateText(raw) + (en ? ' (' + (FE.isoToSerial(en) - FE.isoToSerial(v) + 1) + ' days)' : ' (' + prettyDate(v) + ')') : 'No date',
      onValue: function (e) { set(e.target.value); },
      onEnd: function (e) { setEnd(e.target.value); },
      onRanged: function (e) { P.ranged = e.target.checked; P.pickEnd = false; if (!e.target.checked && v) self.setCell(db, row, prop, v); else self.bump(); },
      monthLabel: FE.MONL[cm - 1] + ' ' + cy, days: days, dow: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
      prevM: function () { var dd = new Date(Date.UTC(cy, cm - 2, 1)); P.month = dd.getUTCFullYear() + '-' + FE.pad2(dd.getUTCMonth() + 1); self.bump(); },
      nextM: function () { var dd = new Date(Date.UTC(cy, cm, 1)); P.month = dd.getUTCFullYear() + '-' + FE.pad2(dd.getUTCMonth() + 1); self.bump(); },
      today: function () { set(t); self.S.pop = null; self.bump(); },
      tomorrow: function () { set(addDaysIso(t, 1)); self.S.pop = null; self.bump(); },
      nextWeek: function () { set(addDaysIso(t, 7)); self.S.pop = null; self.bump(); },
      clear: function () { P.ranged = false; self.setCell(db, row, prop, null); self.S.pop = null; self.bump(); }
    };
  },
  filesPopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, row = R.row, prop = R.prop;
    if (!prop || !row) return {};
    var ids = Array.isArray(row.cells[prop.id]) ? row.cells[prop.id] : [];
    if (this.remote) this.loadAttachments(db.id);
    return {
      title: prop.name, remote: !!this.remote, local: !this.remote, busy: !!P.busy, estH: 130 + Math.min(ids.length, 6) * 34,
      hasFiles: ids.length > 0,
      files: ids.map(function (id) {
        var a = self.attMeta && self.attMeta[id];
        return {
          name: a ? a.filename : 'File', size: a ? self.attSize(a.size) : '', missing: !a && self.attLoaded && self.attLoaded[db.id] === true,
          open: function () { self.openAttachment(id); },
          remove: function () {
            self.setCell(db, row, prop, ids.filter(function (x) { return x !== id; }));
            self.deleteAttachment(id);
          }
        };
      }),
      onPick: function (e) {
        var list = Array.prototype.slice.call(e.target.files || []); e.target.value = '';
        if (!list.length) return;
        P.busy = true; self.bump();
        self.uploadFiles(list, db.id, row.id).then(function (rows) {
          P.busy = false;
          var cur = Array.isArray(row.cells[prop.id]) ? row.cells[prop.id] : [];
          if (rows.length) self.setCell(db, row, prop, cur.concat(rows.map(function (r) { return r.id; })));
          else self.bump();
        });
      }
    };
  },
  relPopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, row = R.row, prop = R.prop;
    if (!prop || !row) return {};
    var t = this.db(prop.config.targetId);
    if (!t) return { noTarget: true, hasTarget: false, setup: function (e) { self.openPop(e, 'prop', { dbId: db.id, propId: prop.id }, 340); }, estH: 120 };
    var cur = row.cells[prop.id] || [], ql = lc(P.q).trim();
    var list = t.rows.filter(function (r) { return r !== row && (!ql || lc(self.rowTitle(t, r)).indexOf(ql) >= 0); }).slice(0, 50);
    return {
      noTarget: false, hasTarget: true, title: prop.name + ' - ' + t.title, q: P.q, estH: 110 + Math.min(list.length, 8) * 34,
      onQ: function (e) { P.q = e.target.value; self.bump(); },
      onKey: function (e) { if (e.key === 'Enter' && ql && !list.length) { e.preventDefault(); create(); } },
      items: list.map(function (r) { var on = cur.indexOf(r.id) >= 0; return { text: self.rowTitle(t, r) || 'Untitled', on: on, rowCls: 'opt-row' + (on ? ' on' : ''), pick: function () { var a = cur.slice(); var i = a.indexOf(r.id); if (i >= 0) a.splice(i, 1); else a.push(r.id); self.setRelation(db, row, prop, a); } }; }),
      canCreate: !!ql, createLabel: 'New row "' + (P.q || '').trim() + '" in ' + t.title, create: create,
      count: plural(cur.length, 'linked row')
    };
    function create() { var tp = self.titleProp(t), pre = {}; pre[tp.id] = P.q.trim(); var nr = self.addRow(t, pre); self.setRelation(db, row, prop, cur.concat([nr.id])); P.q = ''; self.bump(); }
  },
  propPopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, prop = R.prop, view = R.view;
    if (!prop) return {};
    var others = this.mods('database');
    var v = {
      name: prop.name, typeLabel: PROP_LABEL[prop.type], isTitle: prop.type === 'title', notTitle: prop.type !== 'title', estH: 520,
      onName: function (e) { prop.name = e.target.value; self.changed(db); },
      onNameBlur: function () { var n = prop.name.trim() || PROP_LABEL[prop.type]; prop.name = uniqueName(n, db.props.filter(function (x) { return x !== prop; }).map(function (x) { return x.name; })); self.changed(db); },
      type: prop.type, types: PROP_TYPES.filter(function (t) { return t[0] !== 'title'; }).map(function (t) { return { value: t[0], label: t[1] }; }),
      onType: function (e) { self.changePropType(db, prop, e.target.value); },
      isOpts: prop.type === 'select' || prop.type === 'multi_select' || prop.type === 'status',
      isNumber: prop.type === 'number', isRelation: prop.type === 'relation', isRollup: prop.type === 'rollup', isFormula: prop.type === 'formula', isLookup: prop.type === 'lookup',
      sortAsc: function () { view.sorts = [{ id: uid(), propId: prop.id, dir: 'asc' }]; self.S.pop = null; self.changed(db); },
      sortDesc: function () { view.sorts = [{ id: uid(), propId: prop.id, dir: 'desc' }]; self.S.pop = null; self.changed(db); },
      filterBy: function (e) { var k = self.filterKind(prop); view.filters.push({ id: uid(), propId: prop.id, op: self.filterOps(k)[0][0], value: '' }); self.changed(db); self.openPop(e, 'filter', { dbId: db.id }, 520); },
      canGroup: ['select', 'status', 'multi_select', 'checkbox', 'text'].indexOf(prop.type) >= 0 && view.type === 'table',
      groupThis: function () { view.groupBy = prop.id; self.S.pop = null; self.changed(db); },
      hide: function () { if (view.hidden.indexOf(prop.id) < 0) view.hidden.push(prop.id); self.S.pop = null; self.changed(db); },
      insertLeft: function (e) { var i = db.props.indexOf(prop); self.newPropMenu(e, db, i > 0 ? db.props[i - 1].id : null); },
      insertRight: function (e) { self.newPropMenu(e, db, prop.id); },
      moveLeft: function () { var i = db.props.indexOf(prop); if (i > 1) { db.props.splice(i, 1); db.props.splice(i - 1, 0, prop); self.changed(db); } },
      moveRight: function () { var i = db.props.indexOf(prop); if (i < db.props.length - 1) { db.props.splice(i, 1); db.props.splice(i + 1, 0, prop); self.changed(db); } },
      duplicate: function () { var c = clone(prop); c.id = uid(); c.name = uniqueName(prop.name, db.props.map(function (x) { return x.name; })); if (c.type === 'relation') c.config.reversePropId = null; db.props.splice(db.props.indexOf(prop) + 1, 0, c); db.rows.forEach(function (r) { if (r.cells[prop.id] !== undefined) r.cells[c.id] = clone(r.cells[prop.id]); }); self.S.pop = null; self.changed(db); },
      del: function () {
        var rev = prop.type === 'relation' && self.db(prop.config.targetId) && byId(self.db(prop.config.targetId).props, prop.config.reversePropId);
        self.confirm({ title: 'Delete property "' + prop.name + '"?', message: 'Its values in every row are removed.' + (rev ? ' The linked "' + rev.name + '" property in ' + self.db(prop.config.targetId).title + ' is removed too.' : ''), label: 'Delete property', danger: true }, function () { if (rev) self.deleteProp(self.db(prop.config.targetId), rev); self.deleteProp(db, prop); });
      }
    };
    if (v.isOpts) {
      v.options = (prop.config.options || []).map(function (o, i) {
        return { name: o.name, cls: 'tag c-' + o.color, onName: function (e) { o.name = e.target.value; self.changed(db); }, color: function (e) { self.optionMenu(e, db, prop, o); }, up: function () { if (i > 0) { var a = prop.config.options; a.splice(i, 1); a.splice(i - 1, 0, o); self.changed(db); } } };
      });
      v.addOption = function () { prop.config.options.push(mkOpt('Option ' + (prop.config.options.length + 1), OPT_COLORS[prop.config.options.length % OPT_COLORS.length])); self.changed(db); };
    }
    if (v.isNumber) { v.numFmt = prop.config.format || 'number'; v.numFormats = NUM_FORMATS.map(function (f) { return { value: f[0], label: f[1] }; }); v.onNumFmt = function (e) { prop.config.format = e.target.value; self.changed(db); }; v.decimals = prop.config.decimals == null ? '' : String(prop.config.decimals); v.decOpts = [{ value: '', label: 'Default' }, { value: '0', label: '0' }, { value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }]; v.onDecimals = function (e) { var x = e.target.value; if (x === '') delete prop.config.decimals; else prop.config.decimals = +x; self.changed(db); }; }
    if (v.isRelation) {
      v.target = prop.config.targetId || '';
      v.dbs = [{ value: '', label: 'Choose a database...' }].concat(others.map(function (o) { return { value: o.id, label: o.title + (o.id === db.id ? ' (this database)' : '') }; }));
      v.onTarget = function (e) { self.dropReverse(db, prop); var old = self.db(prop.config.targetId), rv = old && byId(old.props, prop.config.reversePropId); if (rv) self.deleteProp(old, rv); prop.config.targetId = e.target.value || null; prop.config.reversePropId = null; db.rows.forEach(function (r) { r.cells[prop.id] = []; }); self.changed(db); };
      var t = this.db(prop.config.targetId), rv = t && byId(t.props, prop.config.reversePropId);
      v.canTwoWay = !!t && t !== db; v.twoWay = !!rv; v.twoWayLabel = rv ? 'Shown in ' + t.title + ' as "' + rv.name + '"' : 'Show on ' + (t ? t.title : 'the other database') + ' too';
      v.onTwoWay = function (e) { if (e.target.checked) self.makeTwoWay(db, prop); else if (rv) { self.deleteProp(t, rv); prop.config.reversePropId = null; self.changed(db); } };
    }
    if (v.isRollup) {
      var rels = db.props.filter(function (p) { return p.type === 'relation'; }), rel = byId(db.props, prop.config.relationPropId), tr = rel && this.db(rel.config.targetId);
      v.relId = prop.config.relationPropId || ''; v.rels = [{ value: '', label: rels.length ? 'Choose a relation...' : 'Add a relation first' }].concat(rels.map(function (p) { return { value: p.id, label: p.name }; }));
      v.onRel = function (e) { prop.config.relationPropId = e.target.value || null; prop.config.targetPropId = null; self.changed(db); };
      v.tpropId = prop.config.targetPropId || ''; v.tprops = [{ value: '', label: tr ? 'Choose a property...' : '-' }].concat(tr ? tr.props.map(function (p) { return { value: p.id, label: p.name }; }) : []);
      v.onTprop = function (e) { prop.config.targetPropId = e.target.value || null; self.changed(db); };
      v.fn = prop.config.fn || 'count'; v.fns = ROLLUP_FNS.map(function (f) { return { value: f[0], label: f[1] }; });
      v.onFn = function (e) { prop.config.fn = e.target.value; self.changed(db); };
    }
    if (v.isFormula) {
      v.expr = prop.config.expr || '';
      v.onExpr = function (e) { prop.config.expr = e.target.value; self.changed(db); };
      v.ffmt = prop.config.format || 'auto'; v.ffmts = FORMULA_FORMATS.map(function (f) { return { value: f[0], label: f[1] }; });
      v.onFfmt = function (e) { prop.config.format = e.target.value; self.changed(db); };
      var perr = v.expr.trim() ? FE.parseError(v.expr.replace(/^\s*=/, '')) : null;
      var sample = db.rows[0] ? this.formulaText(prop, this.formulaVal(db, db.rows[0], prop, 0)) : '';
      v.exprStatus = perr ? 'Error: ' + perr : db.rows[0] ? 'First row: ' + (sample === '' ? '(empty)' : sample) : 'Add a row to preview';
      v.exprCls = 'fx-status' + (perr ? ' bad' : '');
      v.propChips = db.props.filter(function (p) { return p !== prop; }).map(function (p) { return { name: p.name, add: function () { prop.config.expr = (prop.config.expr || '') + 'prop("' + p.name + '")'; self.changed(db); self.focusSel('[data-fxexpr]', 'end'); } }; });
    }
    if (v.isLookup) {
      var c = prop.config, lt = this.db(c.targetId);
      v.srcId = c.sourcePropId || ''; v.srcs = [{ value: '', label: 'Match this property...' }].concat(db.props.filter(function (p) { return p !== prop && p.type !== 'lookup'; }).map(function (p) { return { value: p.id, label: p.name }; }));
      v.onSrc = function (e) { c.sourcePropId = e.target.value || null; self.changed(db); };
      v.ltarget = c.targetId || ''; v.ldbs = [{ value: '', label: 'In database...' }].concat(others.filter(function (o) { return o.id !== db.id; }).map(function (o) { return { value: o.id, label: o.title }; }));
      v.onLtarget = function (e) { c.targetId = e.target.value || null; c.matchPropId = null; c.returnPropId = null; self.changed(db); };
      var lprops = lt ? lt.props.map(function (p) { return { value: p.id, label: p.name }; }) : [];
      v.matchId = c.matchPropId || ''; v.matches = [{ value: '', label: lt ? 'Against column...' : '-' }].concat(lprops);
      v.onMatch = function (e) { c.matchPropId = e.target.value || null; self.changed(db); };
      v.retId = c.returnPropId || ''; v.rets = [{ value: '', label: lt ? 'Return column...' : '-' }].concat(lprops);
      v.onRet = function (e) { c.returnPropId = e.target.value || null; self.changed(db); };
    }
    return v;
  },
  addFilter: function (db, view) {
    var p = db.props[0], k = this.filterKind(p);
    view.filters.push({ id: uid(), propId: p.id, op: this.filterOps(k)[0][0], value: '' });
    this.changed(db);
  },
  filterPopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, view = R.view;
    if (!db) return {};
    return {
      estH: 120 + view.filters.length * 44,
      modeAnd: view.filterMode !== 'or',
      mode: view.filterMode || 'and', modes: [{ value: 'and', label: 'All filters match (and)' }, { value: 'or', label: 'Any filter matches (or)' }],
      onMode: function (e) { view.filterMode = e.target.value; self.changed(db); },
      showMode: view.filters.length > 1,
      rows: view.filters.map(function (f) {
        var p = byId(db.props, f.propId) || db.props[0], kind = self.filterKind(p), ops = self.filterOps(kind);
        var isOpt = kind === 'select' || kind === 'multi', isDate = kind === 'date', need = self.opNeedsValue(f.op);
        return {
          propId: p.id, props: db.props.map(function (x) { return { value: x.id, label: x.name }; }),
          onProp: function (e) { var np = byId(db.props, e.target.value); f.propId = np.id; f.op = self.filterOps(self.filterKind(np))[0][0]; f.value = ''; self.changed(db); },
          op: f.op, ops: ops.map(function (o) { return { value: o[0], label: o[1] }; }),
          onOp: function (e) { f.op = e.target.value; self.changed(db); },
          isText: need && !isOpt && !isDate, isOpt: need && isOpt, isDate: need && isDate,
          value: f.value == null ? '' : f.value,
          opts: [{ value: '', label: 'Choose...' }].concat((p.config.options || []).map(function (o) { return { value: o.id, label: o.name }; })),
          onValue: function (e) { f.value = e.target.value; self.changed(db); },
          remove: function () { view.filters = view.filters.filter(function (x) { return x !== f; }); if (!view.filters.length) self.S.pop = null; self.changed(db); }
        };
      }),
      add: function () { self.addFilter(db, view); },
      clear: function () { view.filters = []; self.S.pop = null; self.changed(db); }
    };
  },
  sortPopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, view = R.view;
    if (!db) return {};
    return {
      estH: 110 + view.sorts.length * 44,
      rows: view.sorts.map(function (s, i) {
        return {
          propId: s.propId, props: db.props.map(function (x) { return { value: x.id, label: x.name }; }),
          onProp: function (e) { s.propId = e.target.value; self.changed(db); },
          dir: s.dir, dirs: [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }],
          onDir: function (e) { s.dir = e.target.value; self.changed(db); },
          remove: function () { view.sorts.splice(i, 1); if (!view.sorts.length) self.S.pop = null; self.changed(db); }
        };
      }),
      add: function () { var used = view.sorts.map(function (s) { return s.propId; }); var p = db.props.filter(function (x) { return used.indexOf(x.id) < 0; })[0] || db.props[0]; view.sorts.push({ id: uid(), propId: p.id, dir: 'asc' }); self.changed(db); },
      clear: function () { view.sorts = []; self.S.pop = null; self.changed(db); }
    };
  },
  groupPopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, view = R.view;
    if (!db) return {};
    var allowed = db.props.filter(function (p) { return ['select', 'status', 'multi_select', 'checkbox'].indexOf(p.type) >= 0 || (view.type === 'table' && (p.type === 'text' || p.type === 'relation')); });
    return {
      estH: 180, isBoard: view.type === 'board',
      groupBy: view.groupBy || '',
      props: (view.type === 'board' ? [] : [{ value: '', label: 'No grouping' }]).concat(allowed.map(function (p) { return { value: p.id, label: p.name + ' (' + PROP_LABEL[p.type] + ')' }; })),
      onGroup: function (e) { view.groupBy = e.target.value || null; self.changed(db); },
      hideEmpty: !!view.hideEmptyGroups,
      onHideEmpty: function (e) { view.hideEmptyGroups = e.target.checked; self.changed(db); }
    };
  },
  propsPopVals: function (P) {
    var self = this, R = this.popRefs(P), db = R.db, view = R.view;
    if (!db) return {};
    return {
      estH: 110 + db.props.length * 34,
      items: db.props.map(function (p, i) {
        var shown = view.hidden.indexOf(p.id) < 0 || p.type === 'title';
        return { name: p.name, ic: iconFlags(PROP_ICON[p.type]), shown: shown, hiddenNow: !shown, locked: p.type === 'title',
          toggle: function () { if (p.type === 'title') return; if (shown) view.hidden.push(p.id); else view.hidden = view.hidden.filter(function (h) { return h !== p.id; }); self.changed(db); },
          up: function () { if (i > 1) { db.props.splice(i, 1); db.props.splice(i - 1, 0, p); self.changed(db); } },
          canUp: i > 1 };
      }),
      showAll: function () { view.hidden = []; self.changed(db); },
      hideAll: function () { view.hidden = db.props.filter(function (p) { return p.type !== 'title'; }).map(function (p) { return p.id; }); self.changed(db); },
      addProp: function (e) { self.newPropMenu(e, db, null); }
    };
  },
  viewPopVals: function (P) {
    var self = this, db = this.db(P.dbId), view = db && byId(db.views, P.viewId);
    if (!view) return {};
    var dates = db.props.filter(function (p) { return p.type === 'date' || p.type === 'created_time' || p.type === 'last_edited_time'; });
    return {
      estH: 330, name: view.name,
      onName: function (e) { view.name = e.target.value; self.changed(db); },
      type: view.type, types: VIEW_TYPES.map(function (t) { return { value: t[0], label: t[1] }; }),
      onType: function (e) { view.type = e.target.value; self.ensureViewNeeds(db, view); self.changed(db); },
      isCalendar: view.type === 'calendar', dateProp: view.dateProp || '',
      dates: dates.map(function (p) { return { value: p.id, label: p.name }; }),
      onDate: function (e) { view.dateProp = e.target.value; self.changed(db); },
      duplicate: function () { var c = clone(view); c.id = uid(); c.name = uniqueName(view.name, db.views.map(function (v) { return v.name; })); db.views.splice(db.views.indexOf(view) + 1, 0, c); db.activeViewId = c.id; self.S.pop = null; self.changed(db); },
      canDelete: db.views.length > 1,
      del: function () { db.views = db.views.filter(function (v) { return v !== view; }); db.activeViewId = db.views[0].id; self.S.pop = null; self.changed(db); },
      left: function () { var i = db.views.indexOf(view); if (i > 0) { db.views.splice(i, 1); db.views.splice(i - 1, 0, view); self.changed(db); } },
      right: function () { var i = db.views.indexOf(view); if (i < db.views.length - 1) { db.views.splice(i, 1); db.views.splice(i + 1, 0, view); self.changed(db); } }
    };
  }
};

function iconFlags(k) { var o = {}; ICON_KEYS.concat(['table', 'board', 'list', 'gallery', 'cal']).forEach(function (x) { o[x] = x === k; }); return o; }
function viewIcon(t) { return t === 'calendar' ? 'cal' : t; }
