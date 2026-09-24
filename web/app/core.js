/* ================= component ================= */
class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { v: 0 };
    this._v = 0;
    this.calc = new Map();
    this.calcStack = new Set();
    this.S = {
      route: { name: 'home' }, theme: 'light', sbCollapsed: false, expanded: {}, collapsedGroups: {},
      menu: null, pop: null, modal: null, toasts: [], peek: null, cellEdit: null,
      dbSearch: {}, dbSel: {}, calCursor: {}, drag: null, dropKey: null, resize: null,
      sheetUI: {}, activeBlock: null, slash: null, blockDrop: null, storage: 'unknown'
    };
    // Served by the Truss server: the workspace lives there. Opened on its own: browser storage.
    this.remote = typeof TRUSS_REMOTE !== 'undefined' ? TRUSS_REMOTE : null;
    if (this.remote) {
      this.ws = { version: 1, modules: [], recent: this.loadRecent() };
      this.S.loading = true;
      this.S.storage = 'server';
      this.S.sync = 'saved';
    } else this.ws = this.load() || seedWorkspace();
    this.loadUi();
    if (!this.ws.recent) this.ws.recent = [];
  }

  componentDidMount() { this._mounted = true; if (this.remote) this.syncBoot(); }
  componentWillUnmount() { this._mounted = false; clearTimeout(this._saveT); }

  /* ---------- persistence ---------- */
  load() {
    try {
      var s = window.localStorage.getItem(STORE_KEY);
      this.S.storage = 'ok';
      if (s) { var ws = JSON.parse(s); if (ws && Array.isArray(ws.modules)) { ws.modules = ws.modules.filter(function (m) { return m && typeof m.id === 'string'; }).map(normModule); return ws; } }
    } catch (e) { this.S.storage = 'off'; }
    return null;
  }
  save() {
    var self = this;
    if (this.remote) { this.scheduleSync(); return; }
    clearTimeout(this._saveT);
    this._saveT = setTimeout(function () {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(self.ws)); if (self.S.storage !== 'ok') { self.S.storage = 'ok'; self.bump(); } }
      catch (e) { if (self.S.storage !== 'off') { self.S.storage = 'off'; self.bump(); } }
    }, 350);
  }
  loadUi() {
    try {
      var u = JSON.parse(window.localStorage.getItem(UI_KEY) || 'null');
      if (u) { this.S.theme = u.theme === 'dark' ? 'dark' : 'light'; this.S.sbCollapsed = !!u.sbCollapsed; this.S.expanded = u.expanded || {}; if (u.route) this.S.route = u.route; }
      else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) this.S.theme = 'dark';
    } catch (e) { /* storage unavailable: defaults */ }
    if (!this.remote && this.S.route.name === 'm' && !this.mod(this.S.route.id)) this.S.route = { name: 'home' };
  }
  saveUi() {
    try { window.localStorage.setItem(UI_KEY, JSON.stringify({ theme: this.S.theme, sbCollapsed: this.S.sbCollapsed, expanded: this.S.expanded, route: this.S.route })); } catch (e) { /* ignore */ }
  }

  /* ---------- state plumbing ---------- */
  bump() { this._v++; this.setState({ v: this._v }); }
  changed(mod) {
    if (mod) mod.updatedAt = nowIso();
    this.calc = new Map();
    this.save();
    this.bump();
  }
  later(fn, ms) { var self = this; setTimeout(function () { try { fn.call(self); } catch (e) { /* element gone */ } }, ms || 0); }
  focusSel(sel, caret) {
    this.later(function () {
      var el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      if (caret !== undefined && el.setSelectionRange && typeof el.value === 'string') {
        var p = caret === 'end' ? el.value.length : caret === 'all' ? null : caret;
        if (p === null) el.select(); else el.setSelectionRange(p, p);
      }
    }, 0);
  }

  /* ---------- modules ---------- */
  mod(id) { return byId(this.ws.modules, id); }
  mods(type) {
    return this.ws.modules.filter(function (m) { return !m.archivedAt && (!type || m.type === type); })
      .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0) || (a.createdAt < b.createdAt ? -1 : 1); });
  }
  uniqueTitle(title, except) { return uniqueName(title, this.ws.modules.filter(function (m) { return m !== except; }).map(function (m) { return m.title; })); }
  addModule(m) {
    m.title = this.uniqueTitle(m.title);
    m.sortOrder = this.ws.modules.reduce(function (a, x) { return Math.max(a, x.sortOrder || 0); }, 0) + 1;
    this.ws.modules.push(m);
    this.changed(m);
    return m;
  }
  createModule(type, key, title) {
    var m = this.addModule(createFromTemplate(type, key, title));
    this.goModule(m.id, m.type === 'notebook' && m.pages[0] ? m.pages[0].id : null);
    this.toast(TYPE_LABEL[m.type] + ' created', 'success');
    if (m.type === 'notebook') this.later(function () { this.focusSel('[data-pagetitle]', 'all'); }, 30);
    return m;
  }
  renameModule(m, title, oldTitle) {
    var before = oldTitle !== undefined ? oldTitle : m.title;
    title = String(title || '').trim() || 'Untitled';
    m.title = this.uniqueTitle(title, m);
    if (m.type === 'sheet' && before && lc(before) !== lc(m.title)) this.onWorkbookRenamed(before, m.title);
    this.changed(m);
  }
  duplicateModule(m) {
    var c = clone(m);
    var map = {};
    c.id = uid(); c.title = m.title + ' copy'; c.favorite = false; c.createdAt = c.updatedAt = nowIso();
    if (c.type === 'database') {
      c.props.forEach(function (p) { var n = uid(); map[p.id] = n; p.id = n; if (p.type === 'relation') p.config.reversePropId = null; });
      c.rows.forEach(function (r) { var cells = {}; Object.keys(r.cells).forEach(function (k) { cells[map[k] || k] = r.cells[k]; }); r.cells = cells; var n = uid(); map[r.id] = n; r.id = n; });
      c.props.forEach(function (p) { if (p.type === 'rollup') { p.config.relationPropId = map[p.config.relationPropId] || p.config.relationPropId; } if (p.type === 'lookup') p.config.sourcePropId = map[p.config.sourcePropId] || p.config.sourcePropId; if (p.type === 'relation' && p.config.targetId === m.id) { p.config.targetId = c.id; c.rows.forEach(function (r) { r.cells[p.id] = (r.cells[p.id] || []).map(function (x) { return map[x] || x; }); }); } });
      c.views.forEach(function (v) { v.id = uid(); v.groupBy = map[v.groupBy] || v.groupBy; v.dateProp = map[v.dateProp] || v.dateProp; v.hidden = v.hidden.map(function (h) { return map[h] || h; }); v.filters.forEach(function (f) { f.propId = map[f.propId] || f.propId; }); v.sorts.forEach(function (s) { s.propId = map[s.propId] || s.propId; }); var calcs = {}; Object.keys(v.calcs || {}).forEach(function (k) { calcs[map[k] || k] = v.calcs[k]; }); v.calcs = calcs; });
      c.activeViewId = c.views[0].id;
    } else if (c.type === 'notebook') {
      c.pages.forEach(function (p) { var n = uid(); map[p.id] = n; p.id = n; });
      c.pages.forEach(function (p) { p.parentId = p.parentId ? map[p.parentId] || null : null; (p.blocks || []).forEach(function (b) { b.id = uid(); if (b.type === 'pagelink' && map[b.ref]) b.ref = map[b.ref]; }); });
    } else {
      c.sheets.forEach(function (s) { s.id = uid(); }); c.activeSheetId = c.sheets[0].id;
    }
    this.addModule(c);
    this.toast('Duplicated as "' + c.title + '"', 'success');
    return c;
  }
  archiveModule(m) {
    m.archivedAt = nowIso();
    if (this.S.route.id === m.id) this.S.route = { name: 'home' };
    this.S.peek = null;
    this.changed(m);
    this.toast('"' + m.title + '" moved to the archive', 'info', { label: 'Undo', run: function () { m.archivedAt = null; this.changed(m); } });
  }
  restoreModule(m) { m.archivedAt = null; this.changed(m); this.toast('"' + m.title + '" restored', 'success'); }
  deleteModule(m) {
    var self = this;
    this.ws.modules = this.ws.modules.filter(function (x) { return x !== m; });
    if (m.type === 'database') this.unlinkDatabase(m);
    this.ws.recent = (this.ws.recent || []).filter(function (r) { return r.id !== m.id; });
    if (this.S.route.id === m.id) this.S.route = { name: 'home' };
    this.S.peek = null;
    this.ws.modules.forEach(function (x) { if (x.type === 'notebook') x.pages.forEach(function (p) { (p.blocks || []).forEach(function (b) { if ((b.type === 'db' || b.type === 'sheet') && b.ref === m.id) b.ref = null; }); }); });
    self.changed(null);
  }

  /* ---------- navigation ---------- */
  go(route) {
    var S = this.S;
    S.route = route; S.menu = null; S.pop = null; S.modal = null; S.peek = null; S.cellEdit = null; S.activeBlock = null; S.slash = null;
    this.remember(route);
    this.saveUi();
    this.bump();
    this.later(function () { var el = document.querySelector('[data-scroll="main"]'); if (el) el.scrollTop = 0; });
  }
  goModule(id, pageId, rowId) {
    var m = this.mod(id); if (!m) return;
    if (pageId === '__none') { this.go({ name: 'm', id: id, pageId: null, rowId: null, overview: true }); return; }
    if (m.type === 'notebook' && !pageId && !rowId) {
      var first = m.lastPageId && byId(m.pages, m.lastPageId);
      if (!first || first.archivedAt) first = m.pages.filter(function (p) { return !p.archivedAt && !p.parentId; })[0];
      pageId = first ? first.id : null;
    }
    if (m.type === 'notebook' && pageId) { m.lastPageId = pageId; this.expandTo(m, pageId); }
    this.go({ name: 'm', id: id, pageId: pageId || null, rowId: rowId || null });
  }
  remember(route) {
    if (route.name !== 'm') return;
    var key = route.id + '|' + (route.pageId || route.rowId || '');
    var rec = (this.ws.recent || []).filter(function (r) { return r.key !== key; });
    rec.unshift({ key: key, id: route.id, pageId: route.pageId || null, rowId: route.rowId || null, at: nowIso() });
    this.ws.recent = rec.slice(0, 12);
    if (this.remote) this.saveRecent(); else this.save();
  }
  expandTo(m, pageId) { var p = byId(m.pages, pageId); this.S.expanded[m.id] = true; while (p && p.parentId) { this.S.expanded[p.parentId] = true; p = byId(m.pages, p.parentId); } }

  /* ---------- menus, popovers, modals, toasts ---------- */
  anchorOf(e) {
    if (e && e.type === 'contextmenu') return { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY };
    var t = e && (e.currentTarget || e.target);
    if (t && t.getBoundingClientRect) return t.getBoundingClientRect();
    return { left: 200, right: 200, top: 120, bottom: 120 };
  }
  openMenu(e, items, w) {
    if (e) { if (e.preventDefault && e.type === 'contextmenu') e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); }
    var r = this.anchorOf(e);
    this.S.menu = { x: r.left, y: r.bottom + 4, top: r.top, items: items.filter(Boolean), w: w || 236 };
    this.S.pop = null;
    this.bump();
  }
  openPop(e, kind, data, w) {
    if (e && e.stopPropagation) e.stopPropagation();
    var r = this.anchorOf(e);
    this.S.pop = Object.assign({ kind: kind, x: r.left, y: r.bottom + 4, top: r.top, w: w || 300 }, data || {});
    this.S.menu = null;
    this.bump();
  }
  closeFloating() { this.S.menu = null; this.S.pop = null; this.bump(); }
  modal(kind, data) { this.S.modal = Object.assign({ kind: kind }, data || {}); this.S.menu = null; this.S.pop = null; this.bump(); }
  closeModal() { this.S.modal = null; this.bump(); }
  confirm(o, onOk) { this.modal('confirm', { title: o.title, message: o.message || '', label: o.label || 'Confirm', danger: !!o.danger, ok: onOk }); }
  prompt(o, onOk) { this.modal('prompt', { title: o.title, label: o.label || 'Name', value: o.value || '', okLabel: o.okLabel || 'Save', ok: onOk }); this.focusSel('[data-prompt]', 'all'); }
  toast(text, type, action) {
    var self = this, t = { id: uid(), text: text, type: type || 'info', action: action || null };
    this.S.toasts = this.S.toasts.concat([t]).slice(-4);
    this.bump();
    setTimeout(function () { self.S.toasts = self.S.toasts.filter(function (x) { return x.id !== t.id; }); self.bump(); }, action ? 6000 : 3200);
  }
  place(x, y, w, h, top) {
    var W = (typeof window !== 'undefined' && window.innerWidth) || 1440, H = (typeof window !== 'undefined' && window.innerHeight) || 900;
    x = clamp(x, 8, Math.max(8, W - w - 8));
    if (y + h > H - 8) { var above = (top || y) - h - 8; y = above > 8 ? above : Math.max(8, H - h - 8); }
    return 'left: ' + Math.round(x) + 'px; top: ' + Math.round(y) + 'px; width: ' + w + 'px;';
  }

  /* ---------- root events ---------- */
  onRootKey(e) {
    var k = e.key, mod = e.ctrlKey || e.metaKey, S = this.S;
    if (mod && (k === 'k' || k === 'K')) { e.preventDefault(); this.openSwitcher(); return; }
    if (mod && k === '\\') { e.preventDefault(); this.toggleSidebar(); return; }
    if (k === 'Escape') {
      if (S.menu || S.pop) { this.closeFloating(); return; }
      if (S.modal) { this.closeModal(); return; }
      if (S.peek) { S.peek = null; S.cellEdit = null; this.bump(); return; }
    }
  }
  onRootPointerMove(e) {
    var R = this.S.resize; if (!R) return;
    var w = clamp(R.w + (e.clientX - R.x), 60, 640);
    if (R.kind === 'db') { var db = this.mod(R.id), p = db && byId(db.props, R.propId); if (p) { p.w = w; this.bump(); } }
    else { var wb = this.mod(R.id), sh = wb && byId(wb.sheets, R.sheetId); if (sh) { sh.colW[R.col] = w; this.bump(); } }
  }
  onRootPointerUp() {
    if (this.S.resize) { var m = this.mod(this.S.resize.id); this.S.resize = null; this.changed(m); }
    if (this.S.sheetSelecting) { this.S.sheetSelecting = false; }
  }
  toggleSidebar() { this.S.sbCollapsed = !this.S.sbCollapsed; this.saveUi(); this.bump(); }
  toggleTheme() { this.S.theme = this.S.theme === 'dark' ? 'light' : 'dark'; this.saveUi(); this.bump(); }

  /* ---------- colour / module menus ---------- */
  colorMenu(e, m) {
    var self = this;
    var items = TILES.map(function (t) { return { label: TILE_LABEL[t], swatch: 'tile-' + t, checked: m.color === t, run: function () { m.color = t; self.changed(m); } }; });
    items.push('divider', { label: m.icon ? 'Change icon...' : 'Add an icon...', keep: true, run: function () { self.openMenu(e, iconMenuItems(m.icon || null, function (ic) { m.icon = ic; self.changed(m); }), 200); } });
    this.openMenu(e, items, 200);
  }
  moduleMenu(e, m) {
    var self = this;
    var items = [
      { label: 'Open', run: function () { self.goModule(m.id); } },
      { label: 'Rename', run: function () { self.prompt({ title: 'Rename ' + TYPE_LABEL[m.type].toLowerCase(), value: m.title }, function (v) { self.renameModule(m, v); }); } },
      { label: 'Change colour', hint: TILE_LABEL[m.color] || '', run: function () { self.colorMenu(e, m); }, keep: true },
      { label: m.favorite ? 'Remove from favourites' : 'Add to favourites', run: function () { m.favorite = !m.favorite; self.changed(null); } },
      { label: 'Duplicate', run: function () { self.duplicateModule(m); } }
    ];
    if (m.type === 'notebook') items.push({ label: 'New page', run: function () { self.addPage(m, null); } });
    if (m.type === 'database') items.push({ label: 'Export CSV', run: function () { self.openCsvExport(m); } });
    items.push('divider');
    items.push({ label: 'Move to archive', run: function () { self.archiveModule(m); } });
    items.push({ label: 'Delete permanently', danger: true, run: function () { self.confirm({ title: 'Delete "' + m.title + '"?', message: 'This removes the ' + TYPE_LABEL[m.type].toLowerCase() + ' and everything in it. This cannot be undone.', label: 'Delete', danger: true }, function () { self.deleteModule(m); self.toast('Deleted', 'info'); }); } });
    this.openMenu(e, items);
  }

  /* ---------- quick switcher ---------- */
  openSwitcher() { this.modal('switcher', { q: '', idx: 0 }); this.focusSel('[data-switcher]'); }
  switcherResults(q) {
    var self = this, out = [], ql = lc(q).trim();
    function score(t) { t = lc(t); if (!ql) return 1; if (t === ql) return 100; if (t.indexOf(ql) === 0) return 60; var i = t.indexOf(ql); if (i >= 0) return 40 - Math.min(i, 30) / 3; var words = ql.split(/\s+/); return words.every(function (w) { return t.indexOf(w) >= 0; }) ? 15 : 0; }
    this.mods().forEach(function (m) {
      var s = score(m.title); if (s) out.push({ title: m.title, sub: TYPE_LABEL[m.type], type: m.type, tile: m.color, s: s + 5, run: function () { self.goModule(m.id); } });
      if (m.type === 'notebook') m.pages.forEach(function (p) { if (p.archivedAt) return; var sp = score(p.title || 'Untitled'); var sb = 0; if (!sp && ql.length > 2) { sb = (p.blocks || []).some(function (b) { return lc(b.text).indexOf(ql) >= 0; }) ? 8 : 0; } if (sp || sb) out.push({ title: p.title || 'Untitled', sub: m.title + (sb && !sp ? ' - matches page text' : ''), type: 'page', tile: m.color, s: (sp || sb) + 2, run: function () { self.goModule(m.id, p.id); } }); });
      if (m.type === 'database' && ql) { var tp = self.titleProp(m); m.rows.forEach(function (r) { var st = score(r.cells[tp.id] || ''); if (st) out.push({ title: r.cells[tp.id] || 'Untitled', sub: m.title + ' row', type: 'row', tile: m.color, s: st, run: function () { self.goModule(m.id); self.openPeek(m, r); } }); }); }
    });
    if (!ql) {
      var rec = (this.ws.recent || []).map(function (r) { return r.key; });
      out.sort(function (a, b) { return b.s - a.s; });
      out = out.filter(function (o) { return o.type !== 'row'; }).slice(0, 8);
      rec; // recency already reflected by module order
    } else out.sort(function (a, b) { return b.s - a.s; });
    out = out.slice(0, 10);
    var cmds = [
      { title: 'New database', sub: 'Command', type: 'cmd', run: function () { self.createModule('database', 'blank'); } },
      { title: 'New workbook', sub: 'Command', type: 'cmd', run: function () { self.createModule('sheet', 'blank'); } },
      { title: 'New notebook', sub: 'Command', type: 'cmd', run: function () { self.createModule('notebook', 'text'); } },
      { title: self.S.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', sub: 'Command', type: 'cmd', run: function () { self.S.modal = null; self.toggleTheme(); } },
      { title: 'Open archive', sub: 'Command', type: 'cmd', run: function () { self.go({ name: 'archive' }); } },
      { title: 'Browse templates', sub: 'Command', type: 'cmd', run: function () { self.modal('templates', {}); } }
    ].filter(function (c) { return !ql || score(c.title); });
    return out.concat(cmds.slice(0, ql ? 3 : 6));
  }
  switcherKey(e, results) {
    var M = this.S.modal;
    if (e.key === 'ArrowDown') { e.preventDefault(); M.idx = Math.min(results.length - 1, M.idx + 1); this.bump(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); M.idx = Math.max(0, M.idx - 1); this.bump(); }
    else if (e.key === 'Enter') { e.preventDefault(); var r = results[M.idx]; if (r) { this.S.modal = null; r.run(); } }
  }

  /* ---------- workspace export / import ---------- */
  resetDemo() { var recent = this.ws.recent; this.ws = seedWorkspace(); if (this.remote) this.ws.recent = recent; this.S.route = { name: 'home' }; this.S.modal = null; this.S.peek = null; this.changed(null); this.toast('Demo workspace restored', 'success'); }
  clearAll() { this.ws = { version: 1, modules: [], recent: this.remote ? this.ws.recent : [] }; this.S.route = { name: 'home' }; this.S.modal = null; this.S.peek = null; this.changed(null); this.toast('Workspace cleared', 'info'); }
  importWorkspace(text) {
    try {
      var ws = JSON.parse(text);
      if (!ws || !Array.isArray(ws.modules)) throw new Error('No modules array');
      ws.modules.forEach(function (m) { if (!m.id || !m.type) throw new Error('Module without id or type'); });
      if (this.remote) ws.recent = this.ws.recent;
      this.ws = ws; if (!ws.recent) ws.recent = [];
      this.S.route = { name: 'home' }; this.S.modal = null;
      this.changed(null); this.toast('Workspace imported', 'success');
    } catch (e) { this.toast('Import failed: ' + e.message, 'error'); }
  }
  copyText(text, what) {
    var self = this;
    try {
      navigator.clipboard.writeText(text).then(function () { self.toast((what || 'Text') + ' copied', 'success'); }, function () { self.toast('Select the text and press Ctrl+C', 'info'); });
    } catch (e) { this.toast('Select the text and press Ctrl+C', 'info'); }
  }

  /* ================= render ================= */
  renderVals() {
    var S = this.S, self = this, r = S.route, m = r.name === 'm' ? this.mod(r.id) : null;
    if (S.loading || S.loadError) return this.loadingVals();
    if (r.name === 'm' && (!m || m.archivedAt)) { S.route = r = { name: 'home' }; m = null; }
    var isDb = !!(m && m.type === 'database'), isSheet = !!(m && m.type === 'sheet'), isNb = !!(m && m.type === 'notebook');
    var rowPage = isDb && r.rowId ? byId(m.rows, r.rowId) : null;
    var V = {
      rootCls: 'app ' + (S.theme === 'dark' ? 'dark' : 'light') + (S.sbCollapsed ? ' sb-off' : '') + (S.resize ? ' is-resizing' : ''),
      onRootKey: function (e) { self.onRootKey(e); },
      onRootMove: function (e) { self.onRootPointerMove(e); },
      onRootUp: function (e) { self.onRootPointerUp(e); },
      sb: this.sidebarVals(),
      top: this.topVals(m, rowPage),
      isHome: r.name === 'home', isArchive: r.name === 'archive',
      isDb: isDb && !rowPage, isRowPage: !!rowPage, isSheet: isSheet, isNb: isNb,
      mainCls: 'main' + (isSheet ? ' main-sheet' : '') + (isDb && !rowPage ? ' main-db' : ''),
      home: r.name === 'home' ? this.homeVals() : {},
      archive: r.name === 'archive' ? this.archiveVals() : {},
      db: isDb && !rowPage ? this.dbVals(m) : {},
      rowpage: rowPage ? this.rowDocVals(m, rowPage, false) : {},
      sh: isSheet ? this.sheetVals(m) : {},
      nb: isNb ? this.nbVals(m, r.pageId) : {},
      hasPeek: !!S.peek && isDb && !rowPage,
      peek: {},
      menu: this.menuVals(),
      pop: this.popVals(),
      modal: this.modalVals(),
      toasts: S.toasts.map(function (t) { return { text: t.text, cls: 'toast toast-' + t.type, hasAction: !!t.action, actionLabel: t.action ? t.action.label : '', act: function () { S.toasts = S.toasts.filter(function (x) { return x !== t; }); if (t.action) t.action.run.call(self); self.bump(); }, close: function () { S.toasts = S.toasts.filter(function (x) { return x !== t; }); self.bump(); } }; }),
      hasToasts: S.toasts.length > 0,
      isLoading: false, hasLoadError: false, loadError: '', retryLoad: null
    };
    if (V.hasPeek) {
      var pr = byId(m.rows, S.peek.rowId);
      if (pr) V.peek = this.rowDocVals(m, pr, true); else { S.peek = null; V.hasPeek = false; }
    }
    return V;
  }

  loadingVals() {
    var self = this, S = this.S;
    return {
      rootCls: 'app ' + (S.theme === 'dark' ? 'dark' : 'light') + ' app-loading', onRootKey: function () { }, onRootMove: function () { }, onRootUp: function () { },
      sb: { groups: [], favs: [], hasFavs: false, isLight: S.theme !== 'dark', isDark: S.theme === 'dark', themeLabel: '', archivedCount: '' }, top: { crumbs: [{ label: 'Truss', cls: 'crumb last', go: function () { } }] },
      isHome: false, isArchive: false, isDb: false, isRowPage: false, isSheet: false, isNb: false, hasPeek: false, mainCls: 'main',
      menu: { open: false }, pop: { open: false }, modal: { open: false }, toasts: [], hasToasts: false,
      isLoading: !!S.loading, hasLoadError: !!S.loadError, loadError: S.loadError || '',
      retryLoad: function () { self.syncBoot(); }
    };
  }

  /* ---------- sidebar ---------- */
  sidebarVals() {
    var self = this, S = this.S, r = S.route;
    function tile(m) { return 'tile tile-' + (m.color || 'slate'); }
    function flags(t) { return { isDb: t === 'database', isSheet: t === 'sheet', isNb: t === 'notebook' }; }
    function item(m) {
      var active = r.name === 'm' && r.id === m.id;
      var o = Object.assign(flags(m.type), {
        id: m.id, title: m.title || 'Untitled', tile: tile(m),
        cls: 'sb-item' + (active && !(m.type === 'notebook' && r.pageId) ? ' on' : ''),
        go: function () { self.goModule(m.id); },
        menu: function (e) { self.moduleMenu(e, m); },
        hasTree: m.type === 'notebook', expanded: !!S.expanded[m.id],
        chevCls: 'sb-chev' + (S.expanded[m.id] ? ' open' : ''),
        toggle: function (e) { e.stopPropagation(); S.expanded[m.id] = !S.expanded[m.id]; self.saveUi(); self.bump(); },
        addPage: function (e) { e.stopPropagation(); self.addPage(m, null); },
        pages: []
      });
      if (m.type === 'notebook' && S.expanded[m.id]) o.pages = self.pageTree(m, r.name === 'm' && r.id === m.id ? r.pageId : null);
      o.hasPages = o.pages.length > 0; o.noPages = o.expanded && !o.hasPages;
      return o;
    }
    var groups = [['database', 'Databases'], ['sheet', 'Workbooks'], ['notebook', 'Notebooks']].map(function (g) {
      var items = self.mods(g[0]).map(item);
      var collapsed = !!S.collapsedGroups[g[0]];
      return { label: g[1], items: collapsed ? [] : items, count: items.length, empty: !collapsed && items.length === 0, headCls: 'sb-group-head' + (collapsed ? ' closed' : ''), toggle: function () { S.collapsedGroups[g[0]] = !collapsed; self.bump(); }, add: function (e) { e.stopPropagation(); self.createModule(g[0], g[0] === 'notebook' ? 'text' : 'blank'); } };
    });
    var favs = [];
    this.mods().forEach(function (m) {
      if (m.favorite) favs.push(Object.assign(flags(m.type), { title: m.title, tile: tile(m), isPage: false, cls: 'sb-item' + (r.id === m.id && !r.pageId ? ' on' : ''), go: function () { self.goModule(m.id); } }));
      if (m.type === 'notebook') m.pages.forEach(function (p) { if (p.favorite && !p.archivedAt) favs.push({ title: p.title || 'Untitled', tile: tile(m), isPage: true, isDb: false, isSheet: false, isNb: false, cls: 'sb-item' + (r.pageId === p.id ? ' on' : ''), go: function () { self.goModule(m.id, p.id); } }); });
    });
    return {
      groups: groups, favs: favs, hasFavs: favs.length > 0,
      homeCls: 'sb-link' + (r.name === 'home' ? ' on' : ''), archiveCls: 'sb-link' + (r.name === 'archive' ? ' on' : ''),
      goHome: function () { self.go({ name: 'home' }); },
      goArchive: function () { self.go({ name: 'archive' }); },
      search: function () { self.openSwitcher(); },
      newMenu: function (e) { self.openMenu(e, [{ label: 'New database', run: function () { self.createModule('database', 'blank'); } }, { label: 'New workbook', run: function () { self.createModule('sheet', 'blank'); } }, { label: 'New notebook', run: function () { self.createModule('notebook', 'text'); } }, 'divider', { label: 'From a template...', run: function () { self.modal('templates', {}); } }]); },
      templates: function () { self.modal('templates', {}); },
      settings: function () { self.modal('settings', { importText: '' }); },
      toggleTheme: function () { self.toggleTheme(); },
      isDark: S.theme === 'dark', isLight: S.theme !== 'dark',
      themeLabel: S.theme === 'dark' ? 'Light theme' : 'Dark theme',
      collapse: function () { self.toggleSidebar(); },
      archivedCount: this.ws.modules.filter(function (m) { return m.archivedAt; }).length + this.ws.modules.reduce(function (a, m) { return a + (m.type === 'notebook' ? m.pages.filter(function (p) { return p.archivedAt; }).length : 0); }, 0),
      storageOff: S.storage === 'off'
    };
  }

  /* ---------- top bar ---------- */
  topVals(m, rowPage) {
    var self = this, r = this.S.route, crumbs = [];
    var o = { showFav: false, favOn: false, favCls: 'icon-btn', toggleFav: null, more: null, hasMore: false, edited: '', openSidebar: function () { self.toggleSidebar(); }, sbOff: this.S.sbCollapsed };
    if (r.name === 'home') crumbs.push({ label: 'Home' });
    else if (r.name === 'archive') crumbs.push({ label: 'Archive' });
    else if (m) {
      crumbs.push({ label: m.title || 'Untitled', go: function () { self.goModule(m.id, m.type === 'notebook' ? '__none' : null); }, tile: 'tile tile-' + m.color, isDb: m.type === 'database', isSheet: m.type === 'sheet', isNb: m.type === 'notebook' });
      var target = m, edited = m.updatedAt;
      if (m.type === 'notebook' && r.pageId && r.pageId !== '__none') {
        var chain = [], p = byId(m.pages, r.pageId);
        while (p) { chain.unshift(p); p = p.parentId ? byId(m.pages, p.parentId) : null; }
        chain.forEach(function (pg) { crumbs.push({ label: pg.title || 'Untitled', go: function () { self.goModule(m.id, pg.id); } }); });
        target = byId(m.pages, r.pageId); edited = target && target.updatedAt;
      }
      if (rowPage) { crumbs.push({ label: this.rowTitle(m, rowPage) || 'Untitled' }); edited = rowPage.updatedAt; }
      if (target && !rowPage) {
        o.showFav = true; o.favOn = !!target.favorite; o.favCls = 'icon-btn fav' + (target.favorite ? ' on' : '');
        o.toggleFav = function () { target.favorite = !target.favorite; self.changed(null); self.toast(target.favorite ? 'Added to favourites' : 'Removed from favourites', 'info'); };
      }
      o.hasMore = true;
      o.more = function (e) { if (target !== m && m.type === 'notebook') self.pageMenu(e, m, target); else self.moduleMenu(e, m); };
      o.edited = edited ? 'Edited ' + relTime(edited) : '';
    }
    crumbs.forEach(function (c, i) { c.isLast = i === crumbs.length - 1; c.notLast = !c.isLast; c.cls = 'crumb' + (c.isLast ? ' last' : ''); c.hasTile = !!c.tile; if (!c.go) c.go = function () {}; });
    o.crumbs = crumbs;
    o.search = function () { self.openSwitcher(); };
    o.hasSync = !!this.remote;
    var st = this.S.sync || 'saved';
    o.syncLabel = { saved: 'Saved', pending: 'Saving...', saving: 'Saving...', offline: 'Offline - retrying', auth: 'Session expired - reload' }[st] || '';
    o.syncCls = 'sync sync-' + st;
    o.syncClick = function () { if (st === 'auth') location.reload(); else if (st === 'offline') self.syncNow(); };
    return o;
  }

  /* ---------- home ---------- */
  homeVals() {
    var self = this, now = sydParts(), h = now.h;
    var greet = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    var dayName = FE.DOW[FE.serialParts(FE.dateSerial(now.y, now.m, now.d)).dow];
    function card(m, p, when, label) {
      return { title: p ? (p.title || 'Untitled') : (m.title || 'Untitled'), sub: p ? m.title : TYPE_LABEL[m.type], when: when, tile: 'tile tile-' + m.color, isDb: m.type === 'database' && !p, isSheet: m.type === 'sheet', isNb: m.type === 'notebook' && !p, isPage: !!p, go: function () { self.goModule(m.id, p ? p.id : null); }, label: label || '' };
    }
    var seen = {}, recent = [];
    (this.ws.recent || []).forEach(function (rc) {
      var m = self.mod(rc.id); if (!m || m.archivedAt) return;
      var p = rc.pageId && m.type === 'notebook' ? byId(m.pages, rc.pageId) : null;
      if (rc.pageId && (!p || p.archivedAt)) return;
      var key = m.id + (p ? p.id : ''); if (seen[key]) return; seen[key] = 1;
      recent.push(card(m, p, 'Visited ' + relTime(rc.at)));
    });
    var edited = this.mods().slice().sort(function (a, b) { return a.updatedAt < b.updatedAt ? 1 : -1; }).slice(0, 6).map(function (m) { return card(m, null, 'Edited ' + relTime(m.updatedAt)); });
    var due = [];
    this.mods('database').forEach(function (db) {
      var dp = db.props.filter(function (p) { return p.type === 'date'; })[0]; if (!dp) return;
      var sp = db.props.filter(function (p) { return p.type === 'status'; })[0];
      db.rows.forEach(function (row) {
        var d = dateEnd(row.cells[dp.id]) || dateStart(row.cells[dp.id]); if (!d) return;
        var st = sp ? byId(sp.config.options, row.cells[sp.id]) : null;
        if (st && /done|complete|shipped/i.test(st.name)) return;
        var diff = FE.isoToSerial(d) - FE.isoToSerial(todayIso());
        if (diff > 7) return;
        due.push({ title: self.rowTitle(db, row) || 'Untitled', db: db.title, when: prettyDate(d), cls: 'due' + (diff < 0 ? ' late' : diff === 0 ? ' today' : ''), sort: diff, go: function () { self.goModule(db.id); self.openPeek(db, row); } });
      });
    });
    due.sort(function (a, b) { return a.sort - b.sort; });
    return {
      greeting: greet, dateLine: dayName + ', ' + fmtDay(todayIso()),
      recent: recent.slice(0, 6), hasRecent: recent.length > 0,
      edited: edited, hasEdited: edited.length > 0,
      due: due.slice(0, 8), hasDue: due.length > 0, noDue: due.length === 0,
      newDb: function () { self.createModule('database', 'blank'); },
      newSheet: function () { self.createModule('sheet', 'blank'); },
      newNb: function () { self.createModule('notebook', 'text'); },
      templates: TEMPLATES.map(function (t) { return { name: t.name, desc: t.desc, type: TYPE_LABEL[t.type], isDb: t.type === 'database', isSheet: t.type === 'sheet', isNb: t.type === 'notebook', use: function () { self.createModule(t.type, t.key); } }; }),
      isEmpty: this.mods().length === 0,
      reset: function () { self.resetDemo(); }
    };
  }

  /* ---------- archive ---------- */
  archiveVals() {
    var self = this;
    var mods = this.ws.modules.filter(function (m) { return m.archivedAt; }).map(function (m) {
      return { title: m.title || 'Untitled', sub: TYPE_LABEL[m.type] + ' - archived ' + relTime(m.archivedAt), tile: 'tile tile-' + m.color, isDb: m.type === 'database', isSheet: m.type === 'sheet', isNb: m.type === 'notebook', isPage: false,
        restore: function () { self.restoreModule(m); },
        del: function () { self.confirm({ title: 'Delete "' + m.title + '" permanently?', message: 'This cannot be undone.', label: 'Delete', danger: true }, function () { self.deleteModule(m); }); } };
    });
    var pages = [];
    this.ws.modules.forEach(function (m) {
      if (m.type !== 'notebook' || m.archivedAt) return;
      m.pages.forEach(function (p) {
        if (!p.archivedAt) return;
        var parent = p.parentId && byId(m.pages, p.parentId);
        if (parent && parent.archivedAt) return;
        pages.push({ title: p.title || 'Untitled', sub: 'Page in ' + m.title + ' - archived ' + relTime(p.archivedAt), tile: 'tile tile-' + m.color, isPage: true, isDb: false, isSheet: false, isNb: false,
          restore: function () { self.restorePage(m, p); },
          del: function () { self.confirm({ title: 'Delete "' + (p.title || 'Untitled') + '" permanently?', message: 'Its sub-pages are deleted too. This cannot be undone.', label: 'Delete', danger: true }, function () { self.deletePage(m, p); }); } });
      });
    });
    var items = mods.concat(pages);
    return {
      items: items, hasItems: items.length > 0, isEmpty: items.length === 0,
      emptyAll: function () {
        self.confirm({ title: 'Empty the archive?', message: plural(items.length, 'item') + ' will be deleted permanently.', label: 'Empty archive', danger: true }, function () {
          self.ws.modules.filter(function (m) { return m.archivedAt; }).forEach(function (m) { self.deleteModule(m); });
          self.ws.modules.forEach(function (m) { if (m.type === 'notebook') m.pages.filter(function (p) { return p.archivedAt; }).forEach(function (p) { if (byId(m.pages, p.id)) self.deletePage(m, p, true); }); });
          self.changed(null); self.toast('Archive emptied', 'info');
        });
      }
    };
  }

  /* ---------- floating layers ---------- */
  menuVals() {
    var M = this.S.menu, self = this;
    if (!M) return { open: false };
    var h = M.items.reduce(function (a, it) { return a + (it === 'divider' ? 9 : 34); }, 12);
    return {
      open: true,
      style: this.place(M.x, M.y, M.w, h, M.top),
      close: function () { self.closeFloating(); },
      items: M.items.map(function (it) {
        if (it === 'divider') return { isDivider: true, isItem: false };
        return {
          isDivider: false, isItem: true, label: it.label, hint: it.hint || '', hasHint: !!it.hint,
          cls: 'menu-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : ''),
          checked: !!it.checked, hasSwatch: !!it.swatch, swatch: 'swatch ' + (it.swatch || ''),
          disabled: !!it.disabled,
          run: function (e) { if (it.disabled) return; if (!it.keep) self.S.menu = null; it.run.call(self, e); self.bump(); }
        };
      })
    };
  }
  popVals() {
    var P = this.S.pop, self = this;
    if (!P) return { open: false };
    var v = { open: true, close: function () { self.closeFloating(); } };
    var inner = {};
    try { inner = this.popInner(P) || {}; } catch (e) { inner = {}; }
    var h = inner.estH || 320;
    v.style = this.place(P.x, P.y, P.w, h, P.top);
    ['opt', 'date', 'files', 'rel', 'prop', 'filter', 'sort', 'group', 'props', 'view', 'hint'].forEach(function (k) { v['is_' + k] = P.kind === k; });
    v.d = inner;
    return v;
  }
  popInner(P) {
    switch (P.kind) {
      case 'opt': return this.optPopVals(P);
      case 'date': return this.datePopVals(P);
      case 'files': return this.filesPopVals(P);
      case 'rel': return this.relPopVals(P);
      case 'prop': return this.propPopVals(P);
      case 'filter': return this.filterPopVals(P);
      case 'sort': return this.sortPopVals(P);
      case 'group': return this.groupPopVals(P);
      case 'props': return this.propsPopVals(P);
      case 'view': return this.viewPopVals(P);
    }
    return {};
  }
  modalVals() {
    var M = this.S.modal, self = this;
    if (!M) return { open: false };
    var v = { open: true, close: function () { self.closeModal(); }, stop: function (e) { e.stopPropagation(); } };
    ['confirm', 'prompt', 'templates', 'switcher', 'settings', 'csvExport', 'csvImport', 'text', 'picker', 'sheetEmbed', 'functions'].forEach(function (k) { v['is_' + k] = M.kind === k; });
    v.cls = 'modal modal-' + M.kind;
    if (M.kind === 'confirm') {
      v.title = M.title; v.message = M.message; v.label = M.label; v.okCls = 'btn ' + (M.danger ? 'btn-danger' : 'btn-primary');
      v.ok = function () { self.S.modal = null; M.ok.call(self); self.bump(); };
    } else if (M.kind === 'prompt') {
      v.title = M.title; v.label = M.label; v.value = M.value; v.okLabel = M.okLabel;
      v.onValue = function (e) { M.value = e.target.value; self.bump(); };
      v.ok = function () { self.S.modal = null; M.ok.call(self, M.value); self.bump(); };
      v.onKey = function (e) { if (e.key === 'Enter') { e.preventDefault(); v.ok(); } };
    } else if (M.kind === 'templates') {
      v.groups = [['database', 'Databases'], ['sheet', 'Workbooks'], ['notebook', 'Notebooks']].map(function (g) {
        return { label: g[1], items: TEMPLATES.filter(function (t) { return t.type === g[0]; }).map(function (t) { return { name: t.name, desc: t.desc, isDb: t.type === 'database', isSheet: t.type === 'sheet', isNb: t.type === 'notebook', use: function () { self.S.modal = null; self.createModule(t.type, t.key); } }; }) };
      });
    } else if (M.kind === 'switcher') {
      var res = this.switcherResults(M.q);
      if (M.idx >= res.length) M.idx = Math.max(0, res.length - 1);
      v.q = M.q;
      v.onQ = function (e) { M.q = e.target.value; M.idx = 0; self.bump(); };
      v.onKey = function (e) { self.switcherKey(e, res); };
      v.results = res.map(function (x, i) { return { title: x.title, sub: x.sub, cls: 'sw-item' + (i === M.idx ? ' on' : ''), tile: 'tile tile-' + (x.tile || 'slate'), isDb: x.type === 'database', isSheet: x.type === 'sheet', isNb: x.type === 'notebook', isPage: x.type === 'page', isRow: x.type === 'row', isCmd: x.type === 'cmd', notCmdRow: x.type !== 'row' && x.type !== 'cmd', hover: function () { if (M.idx !== i) { M.idx = i; self.bump(); } }, run: function () { self.S.modal = null; x.run(); self.bump(); } }; });
      v.noResults = res.length === 0;
    } else if (M.kind === 'settings') {
      v.storageLine = this.S.storage === 'server' ? 'Saved on the Truss server as you work. Everyone with access sees the same workspace, and changes from others appear live.' : this.S.storage === 'off' ? 'Browser storage is not available here, so changes last until this page is reloaded. Use Export to keep a copy.' : 'Changes are saved automatically in this browser.';
      v.storageCls = 'note' + (this.S.storage === 'off' ? ' warn' : '');
      v.exportWs = function () { self.modal('text', { title: 'Workspace JSON', text: JSON.stringify(self.ws, null, 1), what: 'Workspace JSON' }); };
      v.importText = M.importText;
      v.onImport = function (e) { M.importText = e.target.value; self.bump(); };
      v.doImport = function () { self.confirm({ title: 'Replace this workspace?', message: 'Everything here is replaced by the imported JSON.', label: 'Replace', danger: true }, function () { self.importWorkspace(M.importText); }); };
      v.reset = function () { self.confirm({ title: 'Restore the demo workspace?', message: 'Your current content is replaced by the demo databases, workbooks and notebooks.', label: 'Restore demo', danger: true }, function () { self.resetDemo(); }); };
      v.clear = function () { self.confirm({ title: 'Start from an empty workspace?', message: 'Everything is deleted. Export first if you want a copy.', label: 'Clear everything', danger: true }, function () { self.clearAll(); }); };
      v.themeLight = function () { self.S.theme = 'light'; self.saveUi(); self.bump(); };
      v.themeDark = function () { self.S.theme = 'dark'; self.saveUi(); self.bump(); };
      v.lightCls = 'seg' + (this.S.theme !== 'dark' ? ' on' : ''); v.darkCls = 'seg' + (this.S.theme === 'dark' ? ' on' : '');
      v.counts = plural(this.mods('database').length, 'database') + ', ' + plural(this.mods('sheet').length, 'workbook') + ', ' + plural(this.mods('notebook').length, 'notebook');
    } else if (M.kind === 'text') {
      v.title = M.title; v.text = M.text; v.copy = function () { self.copyText(M.text, M.what); };
      v.selectAll = function (e) { e.target.select(); };
    } else if (M.kind === 'csvExport' || M.kind === 'csvImport') {
      Object.assign(v, this.csvModalVals(M));
    } else if (M.kind === 'picker') {
      var q = lc(M.q);
      v.title = M.title; v.q = M.q;
      v.onQ = function (e) { M.q = e.target.value; self.bump(); };
      v.items = M.items.filter(function (it) { return !q || lc(it.label + ' ' + (it.sub || '')).indexOf(q) >= 0; }).slice(0, 40).map(function (it) { return { label: it.label, sub: it.sub || '', tile: 'tile tile-' + (it.tile || 'slate'), isDb: it.type === 'database', isSheet: it.type === 'sheet', isPage: it.type === 'page', pick: function () { self.S.modal = null; it.pick.call(self); self.bump(); } }; });
      v.empty = v.items.length === 0;
    } else if (M.kind === 'sheetEmbed') {
      Object.assign(v, this.sheetEmbedModalVals(M));
    } else if (M.kind === 'functions') {
      var fq = lc(M.q);
      v.q = M.q; v.onQ = function (e) { M.q = e.target.value; self.bump(); };
      v.fns = FE.listFunctions().filter(function (f) { return !fq || lc(f.name + ' ' + f.desc).indexOf(fq) >= 0; }).map(function (f) { return { name: f.name, sig: f.sig, desc: f.desc, use: function () { self.S.modal = null; self.insertFunction(f.name); } }; });
      v.count = FE.listFunctions().length;
    }
    return v;
  }
}
