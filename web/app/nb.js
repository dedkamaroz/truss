/* ================= notebooks + block editor ================= */
var LIST_TYPES = { ul: 1, ol: 1, todo: 1 };

var NbMix = {
  nbPage: function (nb, id) { return byId(nb.pages, id); },
  isPageLive: function (nb, p) { while (p) { if (p.archivedAt) return false; p = p.parentId ? byId(nb.pages, p.parentId) : null; } return true; },
  childrenOf: function (nb, id) { return nb.pages.filter(function (p) { return (p.parentId || null) === (id || null) && !p.archivedAt; }); },
  descendants: function (nb, id) { var out = [], self = this; nb.pages.forEach(function (p) { if (p.parentId === id) { out.push(p); out = out.concat(self.descendants(nb, p.id)); } }); return out; },
  pageTree: function (nb, activeId) {
    var self = this, S = this.S, out = [];
    function walk(parentId, depth) {
      self.childrenOf(nb, parentId).forEach(function (p) {
        var kids = self.childrenOf(nb, p.id), open = !!S.expanded[p.id];
        out.push({
          id: p.id, title: p.title || 'Untitled', icon: p.icon || '', hasIcon: !!p.icon, isTable: !!p.table && !p.icon, isText: !p.table && !p.icon,
          cls: 'sb-page' + (p.id === activeId ? ' on' : ''), style: 'padding-left: ' + (22 + depth * 14) + 'px;',
          hasKids: kids.length > 0, noKids: kids.length === 0, chevCls: 'sb-chev' + (open ? ' open' : ''),
          toggle: function (e) { e.stopPropagation(); S.expanded[p.id] = !open; self.saveUi(); self.bump(); },
          go: function () { self.goModule(nb.id, p.id); },
          add: function (e) { e.stopPropagation(); self.addPage(nb, p.id); },
          menu: function (e) { self.pageMenu(e, nb, p); }
        });
        if (open) walk(p.id, depth + 1);
      });
    }
    walk(null, 0);
    return out;
  },
  addPage: function (nb, parentId, title, noNav) {
    var p = mkPage(title || '', parentId || null);
    if (nb.style === 'table') { p.blocks = []; p.table = mkTable(['Name', 'Notes', 'Owner'], [['', '', ''], ['', '', ''], ['', '', '']]); }
    nb.pages.push(p);
    if (parentId) this.S.expanded[parentId] = true;
    this.S.expanded[nb.id] = true;
    this.changed(nb);
    if (!noNav) { this.goModule(nb.id, p.id); this.focusSel('[data-pagetitle]', 'end'); }
    return p;
  },
  archivePage: function (nb, p) {
    var self = this;
    p.archivedAt = nowIso();
    var r = this.S.route;
    if (r.id === nb.id && r.pageId && (r.pageId === p.id || this.descendants(nb, p.id).some(function (d) { return d.id === r.pageId; }))) {
      var parent = p.parentId && byId(nb.pages, p.parentId);
      if (parent) this.goModule(nb.id, parent.id); else this.goModule(nb.id, '__none');
    }
    this.changed(nb);
    this.toast('"' + (p.title || 'Untitled') + '" moved to the archive', 'info', { label: 'Undo', run: function () { p.archivedAt = null; self.changed(nb); } });
  },
  restorePage: function (nb, p) { p.archivedAt = null; if (p.parentId && !byId(nb.pages, p.parentId)) p.parentId = null; this.changed(nb); this.toast('Page restored', 'success'); },
  deletePage: function (nb, p, quiet) {
    var ids = [p.id].concat(this.descendants(nb, p.id).map(function (d) { return d.id; }));
    nb.pages = nb.pages.filter(function (x) { return ids.indexOf(x.id) < 0; });
    this.ws.modules.forEach(function (m) { if (m.type === 'notebook') m.pages.forEach(function (pg) { (pg.blocks || []).forEach(function (b) { if (b.type === 'pagelink' && ids.indexOf(b.ref) >= 0) b.ref = null; }); }); });
    if (!quiet) this.changed(nb);
  },
  duplicatePage: function (nb, p) {
    var c = clone(p); c.id = uid(); c.title = (p.title || 'Untitled') + ' copy'; c.favorite = false; c.createdAt = c.updatedAt = nowIso();
    (c.blocks || []).forEach(function (b) { b.id = uid(); });
    nb.pages.splice(nb.pages.indexOf(p) + 1, 0, c);
    this.changed(nb);
    this.goModule(nb.id, c.id);
  },
  pageMenu: function (e, nb, p) {
    var self = this;
    this.openMenu(e, [
      { label: 'Open', run: function () { self.goModule(nb.id, p.id); } },
      { label: 'Add sub-page', run: function () { self.addPage(nb, p.id); } },
      { label: p.favorite ? 'Remove from favourites' : 'Add to favourites', run: function () { p.favorite = !p.favorite; self.changed(null); } },
      { label: 'Duplicate', run: function () { self.duplicatePage(nb, p); } },
      { label: 'Move to...', run: function () { self.movePagePicker(nb, p); } },
      { label: 'Copy as Markdown', run: function () { self.modal('text', { title: 'Markdown', text: self.pageMarkdown(p), what: 'Markdown' }); } },
      'divider',
      { label: 'Move to archive', run: function () { self.archivePage(nb, p); } }
    ]);
  },
  movePagePicker: function (nb, p) {
    var self = this, bad = {}; bad[p.id] = 1; this.descendants(nb, p.id).forEach(function (d) { bad[d.id] = 1; });
    var items = [{ label: 'Top level of ' + nb.title, sub: 'No parent', type: 'page', pick: function () { p.parentId = null; self.changed(nb); self.toast('Moved to the top level', 'success'); } }];
    nb.pages.forEach(function (x) { if (bad[x.id] || x.archivedAt) return; items.push({ label: x.title || 'Untitled', sub: 'Inside this page', type: 'page', pick: function () { p.parentId = x.id; self.S.expanded[x.id] = true; self.changed(nb); self.toast('Moved into "' + (x.title || 'Untitled') + '"', 'success'); } }); });
    this.modal('picker', { title: 'Move "' + (p.title || 'Untitled') + '" to', q: '', items: items });
    this.focusSel('[data-pickq]');
  },
  renameLinks: function (oldT, newT) {
    if (!oldT || lc(oldT) === lc(newT)) return;
    var re = new RegExp('\\[\\[' + oldT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\]', 'gi'), n = 0;
    function fix(b) { if (b.text && re.test(b.text)) { re.lastIndex = 0; b.text = b.text.replace(re, '[[' + newT + ']]'); n++; } re.lastIndex = 0; }
    this.ws.modules.forEach(function (m) {
      if (m.type === 'notebook') m.pages.forEach(function (p) { (p.blocks || []).forEach(fix); });
      if (m.type === 'database') m.rows.forEach(function (r) { (r.body || []).forEach(fix); });
    });
    if (n) this.toast('Updated ' + plural(n, 'link') + ' to the new title', 'info');
  },

  /* ---------- link resolution / backlinks ---------- */
  resolveLink: function (title) {
    var t = lc(title).trim(), hit = null, self = this;
    this.mods('notebook').some(function (m) { var p = m.pages.filter(function (x) { return !x.archivedAt && lc(x.title).trim() === t; })[0]; if (p) { hit = { go: function () { self.goModule(m.id, p.id); } }; return true; } return false; });
    if (hit) return hit;
    this.mods('database').some(function (db) { var tp = self.titleProp(db); var r = db.rows.filter(function (x) { return lc(x.cells[tp.id]).trim() === t; })[0]; if (r) { hit = { go: function () { self.goModule(db.id); self.openPeek(db, r); } }; return true; } return false; });
    if (hit) return hit;
    var m = this.mods().filter(function (x) { return lc(x.title) === t; })[0];
    if (m) return { go: function () { self.goModule(m.id); } };
    return null;
  },
  backlinkVals: function (title, pageId) {
    var self = this, out = [], t = lc(title).trim();
    if (!t && !pageId) return { items: [], has: false, count: '' };
    function hits(blocks) { return (blocks || []).some(function (b) { return (t && b.text && lc(b.text).indexOf('[[' + t + ']]') >= 0) || (pageId && b.type === 'pagelink' && b.ref === pageId); }); }
    this.mods('notebook').forEach(function (m) { m.pages.forEach(function (p) { if (p.id === pageId || p.archivedAt) return; if (hits(p.blocks)) out.push({ title: p.title || 'Untitled', sub: m.title, go: function () { self.goModule(m.id, p.id); } }); }); });
    this.mods('database').forEach(function (db) { db.rows.forEach(function (r) { if (hits(r.body)) out.push({ title: self.rowTitle(db, r) || 'Untitled', sub: db.title, go: function () { self.goModule(db.id); self.openPeek(db, r); } }); }); });
    return { items: out, has: out.length > 0, count: plural(out.length, 'backlink') };
  },

  /* ---------- block containers ---------- */
  ctResolve: function (ct) {
    var m = this.mod(ct.modId); if (!m) return null;
    if (ct.kind === 'page') { var p = byId(m.pages, ct.pageId); return p ? { mod: m, obj: p, blocks: p.blocks || (p.blocks = []) } : null; }
    var r = byId(m.rows, ct.rowId); if (!r) return null;
    if (!r.body) r.body = [];
    return { mod: m, obj: r, blocks: r.body };
  },
  ctTouch: function (ct) { var R = this.ctResolve(ct); if (!R) return; R.obj.updatedAt = nowIso(); this.changed(R.mod); },
  focusBlock: function (id, caret) { this.S.activeBlock = id; this.bump(); this.focusSel('[data-bin="' + id + '"]', caret === undefined ? 'end' : caret); },
  focusBlockStart: function (ct) {
    var R = this.ctResolve(ct); if (!R) return;
    var b = R.blocks.filter(function (x) { return TEXT_BLOCKS[x.type]; })[0];
    if (!b) { b = mkBlock('p', ''); R.blocks.unshift(b); this.ctTouch(ct); }
    this.focusBlock(b.id, 0);
  },
  insertAfter: function (ct, b, type, text, extra) {
    var R = this.ctResolve(ct), nb = mkBlock(type, text, extra);
    var i = b ? R.blocks.indexOf(b) : R.blocks.length - 1;
    R.blocks.splice(i + 1, 0, nb);
    return nb;
  },
  removeBlock: function (ct, b) { var R = this.ctResolve(ct); var i = R.blocks.indexOf(b); if (i >= 0) R.blocks.splice(i, 1); return i; },
  addBlockEnd: function (ct) {
    var R = this.ctResolve(ct); if (!R) return;
    var last = R.blocks[R.blocks.length - 1];
    if (last && last.type === 'p' && !last.text) return this.focusBlock(last.id, 0);
    var b = mkBlock('p', ''); R.blocks.push(b); this.ctTouch(ct); this.focusBlock(b.id, 0);
  },
  setBlockText: function (ct, b, text, el) {
    var S = this.S;
    if (b.type === 'p' || b.type === 'ul' || b.type === 'ol' || b.type === 'todo') {
      var m;
      if (b.type === 'p' && (m = /^(#{1,3}) /.exec(text))) { b.type = 'h' + m[1].length; text = text.slice(m[0].length); }
      else if (b.type === 'p' && /^[-*] /.test(text)) { b.type = 'ul'; text = text.slice(2); }
      else if (b.type === 'p' && /^1[.)] /.test(text)) { b.type = 'ol'; text = text.slice(3); }
      else if ((b.type === 'p' || b.type === 'ul') && (m = /^\[( |x)?\] /i.exec(text))) { b.type = 'todo'; b.checked = !!(m[1] && m[1].toLowerCase() === 'x'); text = text.slice(m[0].length); }
      else if (b.type === 'p' && /^> /.test(text)) { b.type = 'toggle'; b.open = true; text = text.slice(2); }
      else if (b.type === 'p' && /^" /.test(text)) { b.type = 'quote'; text = text.slice(2); }
      else if (b.type === 'p' && /^!> /.test(text)) { b.type = 'callout'; text = text.slice(3); }
      else if (b.type === 'p' && /^```$/.test(text)) { b.type = 'code'; text = ''; }
      else if (b.type === 'p' && text === '---') { b.type = 'divider'; b.text = ''; var nb = this.insertAfter(ct, b, 'p', ''); S.slash = null; this.ctTouch(ct); return this.focusBlock(nb.id, 0); }
    }
    b.text = text;
    if (b.type !== 'code') {
      var caret = el && typeof el.selectionStart === 'number' ? el.selectionStart : text.length;
      var head = text.slice(0, caret), sm = /(^|\s)\/([A-Za-z0-9-]*)$/.exec(head), lm = /\[\[([^\]\n]*)$/.exec(head);
      if (sm) S.slash = { bid: b.id, q: sm[2], idx: (S.slash && S.slash.bid === b.id && S.slash.q === sm[2]) ? S.slash.idx : 0, mode: 'slash', start: caret - sm[2].length - 1, end: caret };
      else if (lm) S.slash = { bid: b.id, q: lm[1], idx: (S.slash && S.slash.bid === b.id && S.slash.mode === 'link' && S.slash.q === lm[1]) ? S.slash.idx : 0, mode: 'link', start: caret - lm[1].length - 2, end: caret };
      else if (S.slash && S.slash.bid === b.id) S.slash = null;
    }
    this.ctTouch(ct);
  },
  slashItems: function (ct, sl) {
    var self = this, q = lc(sl.q);
    if (sl.mode === 'link') {
      var out = [];
      this.mods('notebook').forEach(function (m) { m.pages.forEach(function (p) { if (!p.archivedAt && p.title && (!q || lc(p.title).indexOf(q) >= 0)) out.push({ label: p.title, glyph: 'Pg', hint: m.title, key: 'link', title: p.title }); }); });
      this.mods('database').forEach(function (db) { var tp = self.titleProp(db); db.rows.forEach(function (r) { var t = r.cells[tp.id]; if (t && q && lc(t).indexOf(q) >= 0) out.push({ label: t, glyph: 'Db', hint: db.title + ' row', key: 'link', title: t }); }); });
      out = out.slice(0, 8);
      if (sl.q.trim() && !out.some(function (o) { return lc(o.title) === q; }) && ct.kind === 'page') out.push({ label: 'New page "' + sl.q.trim() + '"', glyph: '+', hint: 'Create it in this notebook', key: 'linknew', title: sl.q.trim() });
      return out;
    }
    return BLOCK_TYPES.filter(function (t) { return (!t.nbOnly || ct.kind === 'page') && (!q || lc(t.label).indexOf(q) >= 0 || t.kw.indexOf(q) >= 0); }).slice(0, 12);
  },
  applySlash: function (ct, b, item) {
    var self = this, S = this.S, sl = S.slash; if (!sl) return;
    S.slash = null;
    var before = b.text.slice(0, sl.start), after = b.text.slice(sl.end);
    if (sl.mode === 'link') {
      if (item.key === 'linknew') { var R = this.ctResolve(ct); if (R && R.mod.type === 'notebook') this.addPage(R.mod, R.obj.id, item.title, true); }
      b.text = before + '[[' + item.title + ']]' + after;
      this.ctTouch(ct);
      return this.focusBlock(b.id, (before + '[[' + item.title + ']]').length);
    }
    var rest = (before + after).trim() === '' ? '' : before.replace(/\s+$/, '') + (after && before ? ' ' : '') + after.replace(/^\s+/, '');
    var empty = rest === '', key = item.key, target = b;
    b.text = rest;
    if (TEXT_BLOCKS[key]) {
      if (empty) { b.type = key; if (key === 'toggle') { b.open = true; b.body = b.body || ''; } if (key === 'todo') b.checked = false; this.ctTouch(ct); return this.focusBlock(b.id, 0); }
      var nb = this.insertAfter(ct, b, key, ''); this.ctTouch(ct); return this.focusBlock(nb.id, 0);
    }
    function place(type, extra) {
      if (empty) { target.type = type; target.text = ''; Object.assign(target, extra || {}); }
      else target = self.insertAfter(ct, b, type, '', extra);
      var np = self.insertAfter(ct, target, 'p', '');
      self.ctTouch(ct);
      self.focusBlock(np.id, 0);
      return target;
    }
    if (item.server && !this.remote) { this.ctTouch(ct); return this.toast('Images and files need the Truss server', 'info'); }
    if (key === 'divider') return place('divider');
    if (key === 'table') return place('table', { table: mkTable(['Column 1', 'Column 2', 'Column 3'], [['', '', ''], ['', '', '']]) });
    if (key === 'image' || key === 'file') return place(key, { att: null, name: '' });
    if (key === 'toc') return place('toc');
    if (key === 'subpage') {
      var R2 = this.ctResolve(ct);
      var child = this.addPage(R2.mod, R2.obj.id, '', true);
      place('pagelink', { ref: child.id });
      this.goModule(R2.mod.id, child.id); this.focusSel('[data-pagetitle]');
      return;
    }
    if (key === 'pagelink') return this.pickPageFor(function (pageId) { place('pagelink', { ref: pageId }); });
    if (key === 'db') return this.pickDbFor(function (id) { place('db', { ref: id }); });
    if (key === 'sheet') {
      var wbs = this.mods('sheet'); if (!wbs.length) return this.toast('Create a workbook first', 'info');
      this.modal('sheetEmbed', { wbId: wbs[0].id, sheetId: wbs[0].sheets[0].id, range: 'A1:D6', onSave: function (cfg) { place('sheet', cfg); } });
      return;
    }
    this.ctTouch(ct);
  },
  pickPageFor: function (cb) {
    var self = this, items = [];
    this.mods('notebook').forEach(function (m) { m.pages.forEach(function (p) { if (!p.archivedAt) items.push({ label: p.title || 'Untitled', sub: m.title, tile: m.color, type: 'page', pick: function () { cb.call(self, p.id); } }); }); });
    this.modal('picker', { title: 'Link to a page', q: '', items: items }); this.focusSel('[data-pickq]');
  },
  pickDbFor: function (cb) {
    var self = this, items = this.mods('database').map(function (d) { return { label: d.title, sub: plural(d.rows.length, 'row'), tile: d.color, type: 'database', pick: function () { cb.call(self, d.id); } }; });
    if (!items.length) return this.toast('Create a database first', 'info');
    this.modal('picker', { title: 'Choose a database', q: '', items: items }); this.focusSel('[data-pickq]');
  },
  turnInto: function (ct, b, type) {
    b.type = type;
    if (type === 'todo') b.checked = !!b.checked;
    if (type === 'toggle') { b.open = true; b.body = b.body || ''; }
    this.ctTouch(ct);
  },
  blockMenu: function (e, ct, b) {
    var self = this, R = this.ctResolve(ct), i = R.blocks.indexOf(b);
    var items = [];
    if (TEXT_BLOCKS[b.type]) items.push({ label: 'Turn into...', keep: true, run: function (ev) { self.openMenu(e, TURN_INTO.map(function (t) { return { label: BLOCK_LABEL[t], checked: b.type === t, run: function () { self.turnInto(ct, b, t); } }; }), 200); } });
    if (b.type === 'callout') items.push({ label: 'Callout colour...', keep: true, run: function () { self.openMenu(e, ['gray', 'blue', 'green', 'yellow', 'red', 'purple'].map(function (c) { return { label: OPT_COLOR_LABEL[c], swatch: 'c-' + c, checked: (b.color || 'gray') === c, run: function () { b.color = c; self.ctTouch(ct); } }; }), 180); } });
    if (b.type === 'callout') items.push({ label: 'Callout icon...', keep: true, run: function () { self.openMenu(e, iconMenuItems(b.icon || null, function (ic) { if (ic) b.icon = ic; else delete b.icon; self.ctTouch(ct); }), 200); } });
    if ((b.type === 'image' || b.type === 'file') && b.att) {
      items.push({ label: 'Open', run: function () { self.openAttachment(b.att); } });
      items.push({ label: 'Replace...', run: function () { b.att = null; self.ctTouch(ct); } });
    }
    if (b.type === 'db') items.push({ label: 'Change database', run: function () { self.pickDbFor(function (id) { b.ref = id; self.ctTouch(ct); }); } });
    if (b.type === 'sheet') items.push({ label: 'Change range', run: function () { self.editSheetEmbed(ct, b); } });
    if (b.type === 'pagelink') items.push({ label: 'Change page', run: function () { self.pickPageFor(function (id) { b.ref = id; self.ctTouch(ct); }); } });
    items.push({ label: 'Duplicate', hint: 'Ctrl+D', run: function () { var c = clone(b); c.id = uid(); R.blocks.splice(i + 1, 0, c); self.ctTouch(ct); } });
    items.push({ label: 'Move up', hint: 'Ctrl+Shift+Up', disabled: i === 0, run: function () { R.blocks.splice(i, 1); R.blocks.splice(i - 1, 0, b); self.ctTouch(ct); } });
    items.push({ label: 'Move down', hint: 'Ctrl+Shift+Down', disabled: i === R.blocks.length - 1, run: function () { R.blocks.splice(i, 1); R.blocks.splice(i + 1, 0, b); self.ctTouch(ct); } });
    items.push('divider');
    items.push({ label: 'Delete', danger: true, run: function () { self.removeBlock(ct, b); if (!R.blocks.length) R.blocks.push(mkBlock('p', '')); self.ctTouch(ct); } });
    this.openMenu(e, items, 230);
  },
  editSheetEmbed: function (ct, b) { var self = this; this.modal('sheetEmbed', { wbId: b.ref, sheetId: b.sheetId, range: b.range || 'A1:D6', onSave: function (cfg) { Object.assign(b, cfg); self.ctTouch(ct); } }); },
  wrapSel: function (ct, b, el, mark) {
    var s = el.selectionStart, e2 = el.selectionEnd, t = b.text;
    if (s === e2) return;
    b.text = t.slice(0, s) + mark + t.slice(s, e2) + mark + t.slice(e2);
    this.ctTouch(ct);
    this.later(function () { var n = document.querySelector('[data-bin="' + b.id + '"]'); if (n) n.setSelectionRange(s + mark.length, e2 + mark.length); }, 0);
  },
  blockKey: function (e, ct, b) {
    var self = this, S = this.S, R = this.ctResolve(ct); if (!R) return;
    var el = e.target, pos = el.selectionStart, end = el.selectionEnd, text = b.text || '', blocks = R.blocks, i = blocks.indexOf(b), k = e.key, mod = e.ctrlKey || e.metaKey;
    if (S.slash && S.slash.bid === b.id) {
      var items = this.slashItems(ct, S.slash);
      if (k === 'ArrowDown') { e.preventDefault(); S.slash.idx = items.length ? (S.slash.idx + 1) % items.length : 0; return this.bump(); }
      if (k === 'ArrowUp') { e.preventDefault(); S.slash.idx = items.length ? (S.slash.idx - 1 + items.length) % items.length : 0; return this.bump(); }
      if ((k === 'Enter' || k === 'Tab') && items.length) { e.preventDefault(); return this.applySlash(ct, b, items[clamp(S.slash.idx, 0, items.length - 1)]); }
      if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); S.slash = null; return this.bump(); }
    }
    function prevText() { for (var j = i - 1; j >= 0; j--) if (TEXT_BLOCKS[blocks[j].type]) return blocks[j]; return null; }
    function nextText() { for (var j = i + 1; j < blocks.length; j++) if (TEXT_BLOCKS[blocks[j].type]) return blocks[j]; return null; }
    if (mod && e.shiftKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault(); var ni = k === 'ArrowUp' ? i - 1 : i + 1; if (ni < 0 || ni >= blocks.length) return;
      blocks.splice(i, 1); blocks.splice(ni, 0, b); this.ctTouch(ct); return this.focusBlock(b.id, pos);
    }
    if (mod && !e.shiftKey) {
      var lk = k.toLowerCase();
      if (lk === 'b') { e.preventDefault(); return this.wrapSel(ct, b, el, '**'); }
      if (lk === 'i') { e.preventDefault(); return this.wrapSel(ct, b, el, '*'); }
      if (lk === 'e') { e.preventDefault(); return this.wrapSel(ct, b, el, '`'); }
      if (lk === 'd') { e.preventDefault(); var c = clone(b); c.id = uid(); blocks.splice(i + 1, 0, c); this.ctTouch(ct); return this.focusBlock(c.id, 'end'); }
      if (k === 'Enter' && b.type === 'todo') { e.preventDefault(); b.checked = !b.checked; return this.ctTouch(ct); }
    }
    if (k === 'Enter' && !e.shiftKey && !mod) {
      if (b.type === 'code') return;
      e.preventDefault();
      if ((LIST_TYPES[b.type] || b.type === 'toggle' || b.type === 'quote' || b.type === 'callout') && text === '') { if (b.indent) b.indent--; else b.type = 'p'; return this.ctTouch(ct); }
      if (pos === 0 && text !== '') { var nb0 = mkBlock('p', ''); blocks.splice(i, 0, nb0); this.ctTouch(ct); return this.focusBlock(b.id, 0); }
      var before = text.slice(0, pos), after = text.slice(end);
      b.text = before;
      var nt = LIST_TYPES[b.type] ? b.type : 'p';
      var nb = this.insertAfter(ct, b, nt, after, b.indent && (LIST_TYPES[b.type] || b.type === 'p') ? { indent: b.indent } : {});
      if (nt === 'todo') nb.checked = false;
      this.ctTouch(ct);
      return this.focusBlock(nb.id, 0);
    }
    if (k === 'Backspace' && pos === 0 && end === 0) {
      if (b.type !== 'p' && b.type !== 'code' && TEXT_BLOCKS[b.type]) { e.preventDefault(); b.type = 'p'; return this.ctTouch(ct); }
      if (b.indent) { e.preventDefault(); b.indent--; return this.ctTouch(ct); }
      if (i === 0) return;
      var prev = blocks[i - 1];
      e.preventDefault();
      if (!TEXT_BLOCKS[prev.type]) { blocks.splice(i - 1, 1); this.ctTouch(ct); return this.focusBlock(b.id, 0); }
      if (prev.type === 'code' && text !== '') return;
      var at = (prev.text || '').length;
      prev.text = (prev.text || '') + text;
      blocks.splice(i, 1);
      this.ctTouch(ct);
      return this.focusBlock(prev.id, at);
    }
    if (k === 'Delete' && pos === text.length && end === pos) {
      var nx = blocks[i + 1]; if (!nx) return;
      e.preventDefault();
      if (!TEXT_BLOCKS[nx.type]) { blocks.splice(i + 1, 1); return this.ctTouch(ct); }
      b.text = text + (nx.text || ''); blocks.splice(i + 1, 1); this.ctTouch(ct); return this.focusBlock(b.id, pos);
    }
    if (k === 'Tab') {
      if (b.type === 'code') { e.preventDefault(); b.text = text.slice(0, pos) + '  ' + text.slice(end); this.ctTouch(ct); return this.focusBlock(b.id, pos + 2); }
      e.preventDefault(); b.indent = clamp((b.indent || 0) + (e.shiftKey ? -1 : 1), 0, 4); return this.ctTouch(ct);
    }
    if (k === 'ArrowUp' && pos === 0 && end === 0) { var p = prevText(); if (p) { e.preventDefault(); return this.focusBlock(p.id, 'end'); } }
    if (k === 'ArrowDown' && pos === text.length) { var n = nextText(); if (n) { e.preventDefault(); return this.focusBlock(n.id, 0); } }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); S.activeBlock = null; S.slash = null; el.blur(); return this.bump(); }
  },

  /* ---------- editor render ---------- */
  editorVals: function (ct) {
    var self = this, S = this.S, R = this.ctResolve(ct);
    if (!R) return { blocks: [] };
    var blocks = R.blocks, nums = [], headings = [];
    blocks.forEach(function (b) { if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') headings.push(b); });
    var out = blocks.map(function (b, i) {
      var ind = b.indent || 0;
      nums.length = ind + 1;
      var num = 0;
      if (b.type === 'ol') { nums[ind] = (nums[ind] || 0) + 1; num = nums[ind]; } else nums[ind] = 0;
      var active = S.activeBlock === b.id, isText = !!TEXT_BLOCKS[b.type];
      var drop = S.blockDrop && S.blockDrop.id === b.id ? ' drop-' + S.blockDrop.pos : '';
      var v = {
        id: b.id, type: b.type,
        cls: 'blk blk-' + b.type + ' ind-' + ind + (b.type === 'todo' && b.checked ? ' done' : '') + (b.type === 'callout' ? ' c-' + (b.color || 'gray') : '') + drop + (active ? ' active' : ''),
        tcls: 't-' + b.type,
        isText: isText, active: active && isText, notActive: !active && isText,
        text: b.text || '', rows: Math.max(1, (b.text || '').split('\n').length),
        placeholder: b.type === 'p' ? (active ? "Type '/' for commands, [[ to link a page" : '') : b.type === 'h1' ? 'Heading 1' : b.type === 'h2' ? 'Heading 2' : b.type === 'h3' ? 'Heading 3' : b.type === 'todo' ? 'To-do' : b.type === 'code' ? 'Code' : b.type === 'toggle' ? 'Toggle' : b.type === 'quote' ? 'Quote' : b.type === 'callout' ? 'Callout' : 'List item',
        isTodo: b.type === 'todo', checked: !!b.checked, isUl: b.type === 'ul', isOl: b.type === 'ol', num: num + '.',
        isToggle: b.type === 'toggle', open: !!b.open, tgCls: 'blk-tg' + (b.open ? ' open' : ''), isCallout: b.type === 'callout',
        isDivider: b.type === 'divider', isPageLink: b.type === 'pagelink', isDbEmbed: b.type === 'db', isSheetEmbed: b.type === 'sheet', isToc: b.type === 'toc',
        isTableBlk: b.type === 'table', isImage: b.type === 'image', isFile: b.type === 'file',
        hasCalloutIcon: b.type === 'callout' && !!b.icon, noCalloutIcon: b.type === 'callout' && !b.icon, calloutIcon: b.icon || '',
        body: b.body || '', showBody: b.type === 'toggle' && !!b.open,
        onBody: function (e) { b.body = e.target.value; self.ctTouch(ct); },
        toggleCheck: function () { b.checked = !b.checked; self.ctTouch(ct); },
        toggleOpen: function () { b.open = !b.open; self.ctTouch(ct); },
        onChange: function (e) { self.setBlockText(ct, b, e.target.value, e.target); },
        onKey: function (e) { self.blockKey(e, ct, b); },
        onFocus: function () { if (S.activeBlock !== b.id) { S.activeBlock = b.id; self.bump(); } },
        onBlur: function () { if (S.activeBlock === b.id) { S.activeBlock = null; if (S.slash && S.slash.bid === b.id) S.slash = null; self.bump(); } },
        activate: function (e) { if (e.button !== 0) return; e.preventDefault(); self.focusBlock(b.id, 'end'); },
        handle: function (e) { self.blockMenu(e, ct, b); },
        add: function () { var nb = self.insertAfter(ct, b, 'p', ''); self.ctTouch(ct); self.focusBlock(nb.id, 0); },
        dragStart: function (e) { S.drag = { kind: 'block', id: b.id, ct: ct }; try { e.dataTransfer.setData('text/plain', b.text || b.type); e.dataTransfer.effectAllowed = 'move'; } catch (x) { } },
        dragEnd: function () { S.drag = null; S.blockDrop = null; self.bump(); },
        dragOver: function (e) {
          if (!S.drag || S.drag.kind !== 'block') return;
          e.preventDefault();
          var r = e.currentTarget.getBoundingClientRect(), pos = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
          if (!S.blockDrop || S.blockDrop.id !== b.id || S.blockDrop.pos !== pos) { S.blockDrop = { id: b.id, pos: pos }; self.bump(); }
        },
        drop: function (e) {
          e.preventDefault();
          var d = S.drag, bd = S.blockDrop; S.drag = null; S.blockDrop = null;
          if (!d || d.kind !== 'block' || d.id === b.id) return self.bump();
          var src = self.ctResolve(d.ct), moving = src && byId(src.blocks, d.id);
          if (!moving) return self.bump();
          src.blocks.splice(src.blocks.indexOf(moving), 1);
          var ti = blocks.indexOf(b); blocks.splice(bd && bd.pos === 'after' ? ti + 1 : ti, 0, moving);
          if (src.obj !== R.obj) self.ctTouch(d.ct);
          self.ctTouch(ct);
        },
        segs: [], showPh: false, slashOpen: false, slashItems: [], slashEmpty: false
      };
      if (isText && !active) {
        if (b.type === 'code') v.segs = [{ text: b.text || '', cls: '', isText: true, isLink: false, isUrl: false }];
        else v.segs = inlineSegments(b.text).map(function (s) {
          if (s.link) { var hit = self.resolveLink(s.link); return { text: s.link, isLink: true, isText: false, isUrl: false, cls: 'ilink' + (hit ? '' : ' missing'), go: function (e) { e.preventDefault(); e.stopPropagation(); if (hit) hit.go(); else if (ct.kind === 'page') { var R2 = self.ctResolve(ct); self.addPage(R2.mod, R2.obj.id, s.link); } else self.toast('No page called "' + s.link + '"', 'info'); } }; }
          if (s.url) return { text: s.text, href: s.url, isUrl: true, isLink: false, isText: false, stop: function (e) { e.stopPropagation(); } };
          return { text: s.text, cls: s.cls, isText: true, isLink: false, isUrl: false };
        });
        v.showPh = !b.text && b.type !== 'p';
      }
      if (S.slash && S.slash.bid === b.id && active) {
        var items = self.slashItems(ct, S.slash), idx = clamp(S.slash.idx, 0, Math.max(0, items.length - 1));
        v.slashOpen = true; v.slashEmpty = items.length === 0; v.slashTitle = S.slash.mode === 'link' ? 'Link to' : 'Blocks';
        v.slashItems = items.map(function (it, j) { return { label: it.label, glyph: it.glyph, hint: it.hint, cls: 'slash-item' + (j === idx ? ' on' : ''), pick: function (e) { e.preventDefault(); self.applySlash(ct, b, it); }, hover: function () { if (S.slash && S.slash.idx !== j) { S.slash.idx = j; self.bump(); } } }; });
      }
      if (b.type === 'pagelink') {
        var found = null;
        self.ws.modules.some(function (m) { if (m.type !== 'notebook') return false; var p = byId(m.pages, b.ref); if (p) { found = { m: m, p: p }; return true; } return false; });
        v.pl = found && !found.p.archivedAt ? { title: found.p.title || 'Untitled', sub: found.m.title, ok: true, missing: false, go: function () { self.goModule(found.m.id, found.p.id); } } : { title: 'Page not found', sub: 'It may have been deleted or archived', ok: false, missing: true, go: function () { } };
      }
      if (b.type === 'table') { if (!b.table || !Array.isArray(b.table.cols)) b.table = mkTable(['Column 1', 'Column 2'], [['', '']]); v.tg = self.gridVals(b.table, function () { self.ctTouch(ct); }, b.id); }
      if (b.type === 'image' || b.type === 'file') v.media = self.mediaVals(ct, b);
      if (b.type === 'db') v.dbe = self.dbEmbedVals(b);
      if (b.type === 'sheet') { v.she = self.rangeEmbed(b.ref, b.sheetId, b.range); v.editRange = function () { self.editSheetEmbed(ct, b); }; }
      if (b.type === 'toc') {
        v.toc = headings.map(function (h) { return { text: plainText(h.text) || 'Untitled heading', cls: 'toc-item toc-' + h.type, go: function () { self.later(function () { var el = document.querySelector('[data-blk="' + h.id + '"]'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); } }; });
        v.tocEmpty = v.toc.length === 0;
      }
      return v;
    });
    var owner = ct.kind === 'page' ? ct.pageId : ct.rowId;
    return {
      blocks: out, addEnd: function () { self.addBlockEnd(ct); }, count: blocks.length,
      edCls: 'editor' + (S.fileOver === owner ? ' file-over' : ''),
      fileOver: function (e) {
        if (S.drag || !e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
        e.preventDefault(); if (S.fileOver !== owner) { S.fileOver = owner; self.bump(); }
      },
      fileLeave: function (e) { if (S.fileOver === owner && !e.currentTarget.contains(e.relatedTarget)) { S.fileOver = null; self.bump(); } },
      fileDrop: function (e) {
        if (S.drag || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault(); S.fileOver = null;
        self.dropFilesInto(ct, Array.prototype.slice.call(e.dataTransfer.files));
      }
    };
  },
  // Files dropped on a page or row document become image or file blocks at the end.
  dropFilesInto: function (ct, files) {
    var self = this;
    if (!this.remote) { this.toast('Images and files need the Truss server', 'info'); return this.bump(); }
    this.bump();
    this.uploadFiles(files, ct.modId, ct.kind === 'page' ? ct.pageId : ct.rowId).then(function (rows) {
      var R = self.ctResolve(ct); if (!R || !rows.length) return;
      var last = R.blocks[R.blocks.length - 1];
      if (last && last.type === 'p' && !last.text) R.blocks.pop();
      rows.forEach(function (a) { R.blocks.push(mkBlock(/^image\//.test(a.mime || '') ? 'image' : 'file', '', { att: a.id, name: a.filename, size: a.size })); });
      R.blocks.push(mkBlock('p', ''));
      self.ctTouch(ct);
    });
  },
  mediaVals: function (ct, b) {
    var self = this, isImg = b.type === 'image', key = 'media:' + b.id;
    if (this.remote) this.loadAttachments(ct.modId);
    var a = b.att && this.attMeta ? this.attMeta[b.att] : null;
    var gone = b.att && !a && this.attLoaded && this.attLoaded[ct.modId] === true;
    return {
      has: !!b.att && !gone, none: !b.att || gone, gone: !!gone, remote: !!this.remote, local: !this.remote,
      busy: !!(this.S.uploading && this.S.uploading[key]),
      url: b.att ? this.attUrl(b.att) : '', name: (a && a.filename) || b.name || (isImg ? 'Image' : 'File'), size: this.attSize(a ? a.size : b.size),
      accept: isImg ? 'image/*' : '', pickLabel: isImg ? 'Upload an image' : 'Upload a file',
      emptyText: gone ? 'This file is no longer on the server.' : isImg ? 'No image yet' : 'No file yet',
      // Opens the viewer on this file, able to step through every image and PDF on the page.
      open: function () {
        if (!b.att) return;
        if (!self.canPreview(b.att)) return self.openAttachment(b.att);
        var R = self.ctResolve(ct), ids = (R ? R.blocks : [b]).filter(function (x) { return (x.type === 'image' || x.type === 'file') && x.att && self.canPreview(x.att); }).map(function (x) { return x.att; });
        self.openViewer(ids, b.att);
      },
      onPick: function (e) {
        var f = e.target.files && e.target.files[0]; e.target.value = '';
        if (!f) return;
        self.S.uploading = self.S.uploading || {}; self.S.uploading[key] = true; self.bump();
        self.uploadFiles([f], ct.modId, ct.kind === 'page' ? ct.pageId : ct.rowId).then(function (rows) {
          delete self.S.uploading[key];
          if (rows[0]) { b.att = rows[0].id; b.name = rows[0].filename; b.size = rows[0].size; self.ctTouch(ct); } else self.bump();
        });
      }
    };
  },
  // Files attached to a page (or database row) - including ones uploaded by the previous Truss.
  attachVals: function (modId, ownerId, blocks) {
    var self = this;
    if (!this.remote) return { has: false, list: [], remote: false };
    var used = {}; (blocks || []).forEach(function (b) { if (b.att) used[b.att] = 1; });
    var list = this.attList(modId, ownerId).filter(function (a) { return !used[a.id]; });
    return {
      remote: true, has: list.length > 0, count: plural(list.length, 'attachment'),
      list: list.map(function (a) { return { name: a.filename, size: self.attSize(a.size), open: function () { if (self.canPreview(a.id)) self.openViewer(list.filter(function (x) { return self.canPreview(x.id); }).map(function (x) { return x.id; }), a.id); else self.openAttachment(a.id); }, remove: function () { self.confirm({ title: 'Delete "' + a.filename + '"?', message: 'The file is removed from the server. This cannot be undone.', label: 'Delete', danger: true }, function () { self.deleteAttachment(a.id); }); } }; }),
      onPick: function (e) { var fs = Array.prototype.slice.call(e.target.files || []); e.target.value = ''; if (fs.length) self.uploadFiles(fs, modId, ownerId); }
    };
  },
  dbEmbedVals: function (b) {
    var self = this, db = this.db(b.ref);
    if (!db) return { ok: false, missing: true };
    var view = this.dbView(db), rows = this.viewRows(db, view), visible = db.props.filter(function (p) { return view.hidden.indexOf(p.id) < 0; }).slice(0, 5);
    return {
      ok: true, missing: false, title: db.title, viewName: view.name, tile: 'tile tile-' + db.color, count: plural(rows.length, 'row'),
      go: function () { self.goModule(db.id); },
      cols: visible.map(function (p) { return { name: p.name }; }),
      rows: rows.slice(0, 8).map(function (r) { return { open: function () { self.goModule(db.id); self.openPeek(db, r); }, cells: visible.map(function (p) { var c = self.cellVals(db, r, p, 'embed'); c.click = function () { }; return c; }) }; }),
      more: rows.length > 8, moreText: 'Open ' + db.title + ' to see all ' + rows.length + ' rows',
      add: function () { var r = self.addRow(db, {}); self.goModule(db.id); self.openPeek(db, r); self.focusSel('[data-rowtitle]'); }
    };
  },

  /* ---------- notebook page ---------- */
  nbVals: function (nb, pageId) {
    var self = this, S = this.S, page = pageId ? byId(nb.pages, pageId) : null;
    if (page && !this.isPageLive(nb, page)) page = null;
    var V = { title: nb.title, tile: 'tile tile-' + nb.color, isTableNb: nb.style === 'table', addPage: function () { self.addPage(nb, null); } };
    if (!page) {
      V.isOverview = true; V.isPage = false;
      V.titleDraft = S.titleDraft && S.titleDraft.id === nb.id ? S.titleDraft.text : nb.title;
      V.onTitle = function (e) { S.titleDraft = { id: nb.id, text: e.target.value }; self.bump(); };
      V.onTitleBlur = function () { if (S.titleDraft && S.titleDraft.id === nb.id) { var t = S.titleDraft.text; S.titleDraft = null; self.renameModule(nb, t); } };
      V.pickColor = function (e) { self.colorMenu(e, nb); }; V.icon = nb.icon || ''; V.hasIcon = !!nb.icon; V.noIcon = !nb.icon;
      V.styleLabel = nb.style === 'table' ? 'Table notebook - every page is a full-page table' : 'Text notebook - pages use the block editor';
      V.pages = this.childrenOf(nb, null).map(function (p) {
        var kids = self.childrenOf(nb, p.id).length, words = (p.blocks || []).reduce(function (a, b) { return a + (plainText(b.text).match(/\S+/g) || []).length; }, 0);
        var ex = (p.blocks || []).filter(function (b) { return TEXT_BLOCKS[b.type] && b.text; }).slice(0, 2).map(function (b) { return plainText(b.text); }).join(' ');
        if (p.table) ex = plural(p.table.rows.length, 'row') + ' x ' + plural(p.table.cols.length, 'column');
        return { title: p.title || 'Untitled', excerpt: ex, meta: 'Edited ' + relTime(p.updatedAt) + (kids ? '  -  ' + plural(kids, 'sub-page') : '') + (words ? '  -  ' + plural(words, 'word') : ''), go: function () { self.goModule(nb.id, p.id); }, isTable: !!p.table, isText: !p.table };
      });
      V.hasPages = V.pages.length > 0; V.noPages = !V.hasPages;
      return V;
    }
    nb.lastPageId = page.id;
    V.isOverview = false; V.isPage = true;
    var ct = { kind: 'page', modId: nb.id, pageId: page.id };
    var words = (page.blocks || []).reduce(function (a, b) { return a + (TEXT_BLOCKS[b.type] ? (plainText(b.text).match(/\S+/g) || []).length : 0); }, 0);
    var kids = this.childrenOf(nb, page.id);
    V.page = {
      title: page.title, isText: !page.table, isTable: !!page.table,
      icon: page.icon || '', hasIcon: !!page.icon, noIcon: !page.icon,
      iconMenu: function (e) { self.openMenu(e, iconMenuItems(page.icon || null, function (ic) { page.icon = ic; page.updatedAt = nowIso(); self.changed(nb); }), 200); },
      att: this.attachVals(nb.id, page.id, page.blocks),
      onTitle: function (e) { if (S.titleBefore === undefined || S.titleBefore.id !== page.id) S.titleBefore = { id: page.id, text: page.title }; page.title = e.target.value.replace(/\n/g, ' '); page.updatedAt = nowIso(); self.changed(nb); },
      onTitleBlur: function () { if (S.titleBefore && S.titleBefore.id === page.id) { var old = S.titleBefore.text; S.titleBefore = undefined; if (old && old !== page.title) self.renameLinks(old, page.title || 'Untitled'); } },
      onTitleKey: function (e) { if (e.key === 'Enter') { e.preventDefault(); if (page.table) return; self.focusBlockStart(ct); } else if (e.key === 'ArrowDown') { if (!page.table) { e.preventDefault(); self.focusBlockStart(ct); } } },
      meta: 'Edited ' + relTime(page.updatedAt) + (words ? '  -  ' + plural(words, 'word') + '  -  ' + Math.max(1, Math.round(words / 230)) + ' min read' : ''),
      ed: page.table ? { blocks: [] } : this.editorVals(ct),
      tbl: page.table ? this.tablePageVals(nb, page) : {},
      kids: kids.map(function (k) { return { title: k.title || 'Untitled', go: function () { self.goModule(nb.id, k.id); }, isTable: !!k.table, isText: !k.table }; }),
      hasKids: kids.length > 0,
      addSub: function () { self.addPage(nb, page.id); },
      backlinks: this.backlinkVals(page.title, page.id),
      outline: page.table ? [] : (page.blocks || []).filter(function (b) { return b.type === 'h1' || b.type === 'h2' || b.type === 'h3'; }).map(function (h) { return { text: plainText(h.text) || 'Untitled heading', cls: 'ol-item ol-' + h.type, go: function () { var el = document.querySelector('[data-blk="' + h.id + '"]'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }; })
    };
    V.page.hasOutline = V.page.outline.length >= 2;
    return V;
  },
  tablePageVals: function (nb, page) {
    var self = this, t = page.table;
    function touch() { page.updatedAt = nowIso(); self.changed(nb); }
    return Object.assign(this.gridVals(t, touch, 'pg'), {
      count: plural(t.rows.length, 'row'),
      toDb: function () { self.tableToDatabase(nb, page); },
      toSheet: function () { self.tableToWorkbook(nb, page); },
      exportCsv: function () { self.modal('text', { title: 'CSV', text: csvStringify([t.cols.map(function (c) { return c.name; })].concat(t.rows.map(function (r) { return t.cols.map(function (c) { return r.cells[c.id] || ''; }); }))), what: 'CSV' }); }
    });
  },
  // A simple text table: full-page tables in table notebooks and table blocks share it. tag keeps focus targets unique.
  gridVals: function (t, touch, tag) {
    var self = this;
    function sel(r, c) { return '[data-tcell="' + tag + ':' + r + ',' + c + '"]'; }
    return {
      cols: t.cols.map(function (c, ci) {
        return { name: c.name, onName: function (e) { c.name = e.target.value; touch(); }, style: 'width: ' + (c.w || 200) + 'px;',
          menu: function (e) { self.openMenu(e, [
            { label: 'Insert column left', run: function () { var n = { id: uid(), name: 'Column' }; t.cols.splice(ci, 0, n); touch(); } },
            { label: 'Insert column right', run: function () { var n = { id: uid(), name: 'Column' }; t.cols.splice(ci + 1, 0, n); touch(); } },
            { label: 'Width: narrow', run: function () { c.w = 120; touch(); } }, { label: 'Width: normal', run: function () { delete c.w; touch(); } }, { label: 'Width: wide', run: function () { c.w = 340; touch(); } },
            { label: 'Sort A to Z', run: function () { t.rows.sort(function (a, b) { return FE.cmp(FE.literal(a.cells[c.id] || '').v, FE.literal(b.cells[c.id] || '').v); }); touch(); } },
            { label: 'Sort Z to A', run: function () { t.rows.sort(function (a, b) { return -FE.cmp(FE.literal(a.cells[c.id] || '').v, FE.literal(b.cells[c.id] || '').v); }); touch(); } },
            'divider',
            { label: 'Delete column', danger: true, disabled: t.cols.length === 1, run: function () { t.cols.splice(ci, 1); t.rows.forEach(function (r) { delete r.cells[c.id]; }); touch(); } }
          ], 200); } };
      }),
      rows: t.rows.map(function (r, ri) {
        return {
          num: ri + 1,
          menu: function (e) { self.openMenu(e, [
            { label: 'Insert row above', run: function () { t.rows.splice(ri, 0, { id: uid(), cells: {} }); touch(); } },
            { label: 'Insert row below', run: function () { t.rows.splice(ri + 1, 0, { id: uid(), cells: {} }); touch(); } },
            { label: 'Duplicate row', run: function () { var c = clone(r); c.id = uid(); t.rows.splice(ri + 1, 0, c); touch(); } },
            'divider',
            { label: 'Delete row', danger: true, run: function () { t.rows.splice(ri, 1); touch(); } }
          ], 200); },
          cells: t.cols.map(function (c, ci) {
            return { value: r.cells[c.id] || '', key: tag + ':' + ri + ',' + ci, style: 'width: ' + (c.w || 200) + 'px;',
              onChange: function (e) { r.cells[c.id] = e.target.value; touch(); },
              onKey: function (e) {
                if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.shiftKey)) { e.preventDefault(); if (ri === t.rows.length - 1 && e.key === 'Enter') { t.rows.push({ id: uid(), cells: {} }); touch(); } self.focusSel(sel(ri + 1, ci), 'end'); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); self.focusSel(sel(ri - 1, ci), 'end'); }
              } };
          })
        };
      }),
      addRow: function () { t.rows.push({ id: uid(), cells: {} }); touch(); self.focusSel(sel(t.rows.length - 1, 0)); },
      addCol: function () { t.cols.push({ id: uid(), name: 'Column ' + (t.cols.length + 1) }); touch(); }
    };
  },
  tableToDatabase: function (nb, page) {
    var t = page.table, db = newDatabase(page.title || 'Imported table', 'blank');
    var props = t.cols.map(function (c, i) { if (i === 0) { db.props[0].name = c.name || 'Name'; return db.props[0]; } var p = mkProp('text', uniqueName(c.name || 'Column', db.props.map(function (x) { return x.name; }))); db.props.push(p); return p; });
    t.rows.forEach(function (r) { if (!t.cols.some(function (c) { return (r.cells[c.id] || '').trim(); })) return; var cells = {}; t.cols.forEach(function (c, i) { cells[props[i].id] = r.cells[c.id] || ''; }); db.rows.push(mkRow(cells)); });
    this.addModule(db);
    this.goModule(db.id);
    this.toast('Created database "' + db.title + '" from the table', 'success');
  },
  tableToWorkbook: function (nb, page) {
    var t = page.table, wb = newWorkbook(page.title || 'Imported table', 'blank'), s = wb.sheets[0];
    t.cols.forEach(function (c, ci) { s.cells['0,' + ci] = c.name; s.fmt['0,' + ci] = { b: true }; });
    t.rows.forEach(function (r, ri) { t.cols.forEach(function (c, ci) { var v = r.cells[c.id]; if (v) s.cells[(ri + 1) + ',' + ci] = v; }); });
    this.addModule(wb);
    this.goModule(wb.id);
    this.toast('Created workbook "' + wb.title + '" from the table', 'success');
  },

  /* ---------- markdown ---------- */
  blocksToMarkdown: function (title, blocks) {
    var self = this, out = ['# ' + (title || 'Untitled'), ''], n = 0;
    (blocks || []).forEach(function (b) {
      var pad = new Array((b.indent || 0) + 1).join('  '), t = b.text || '';
      if (b.type !== 'ol') n = 0;
      switch (b.type) {
        case 'h1': out.push('## ' + t, ''); break;
        case 'h2': out.push('### ' + t, ''); break;
        case 'h3': out.push('#### ' + t, ''); break;
        case 'ul': out.push(pad + '- ' + t); break;
        case 'ol': n++; out.push(pad + n + '. ' + t); break;
        case 'todo': out.push(pad + '- [' + (b.checked ? 'x' : ' ') + '] ' + t); break;
        case 'quote': out.push('> ' + t, ''); break;
        case 'callout': out.push('> ' + (b.icon ? b.icon + ' ' : '**Note:** ') + t, ''); break;
        case 'toggle': out.push('<details><summary>' + t + '</summary>', '', b.body || '', '</details>', ''); break;
        case 'code': out.push('```', t, '```', ''); break;
        case 'divider': out.push('---', ''); break;
        case 'pagelink': { var nm = ''; self.ws.modules.forEach(function (m) { if (m.type === 'notebook') { var p = byId(m.pages, b.ref); if (p) nm = p.title; } }); out.push('[[' + (nm || 'Missing page') + ']]', ''); break; }
        case 'db': { var d = self.db(b.ref); out.push('_Linked database: ' + (d ? d.title : 'missing') + '_', ''); break; }
        case 'sheet': { var e = self.rangeEmbed(b.ref, b.sheetId, b.range); if (e.ok) { out.push('_' + e.title + '_', ''); e.rows.forEach(function (r, i) { out.push('| ' + r.cells.map(function (c) { return c.text.replace(/\|/g, '\\|'); }).join(' | ') + ' |'); if (i === 0) out.push('|' + r.cells.map(function () { return ' --- '; }).join('|') + '|'); }); out.push(''); } break; }
        case 'toc': break;
        case 'table': { var tb = b.table; if (tb && tb.cols) { out.push('| ' + tb.cols.map(function (c) { return (c.name || '').replace(/\|/g, '\\|'); }).join(' | ') + ' |', '|' + tb.cols.map(function () { return ' --- '; }).join('|') + '|'); tb.rows.forEach(function (r) { out.push('| ' + tb.cols.map(function (c) { return (r.cells[c.id] || '').replace(/\|/g, '\\|').replace(/\n/g, ' '); }).join(' | ') + ' |'); }); out.push(''); } break; }
        case 'image': out.push('![' + (b.name || 'Image') + '](' + (b.att ? 'attachment:' + b.att : '') + ')', ''); break;
        case 'file': out.push('[' + (b.name || 'File') + '](' + (b.att ? 'attachment:' + b.att : '') + ')', ''); break;
        default: out.push(t, '');
      }
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  },
  pageMarkdown: function (p) {
    if (p.table) { var t = p.table; return '# ' + (p.title || 'Untitled') + '\n\n| ' + t.cols.map(function (c) { return c.name; }).join(' | ') + ' |\n|' + t.cols.map(function () { return ' --- '; }).join('|') + '|\n' + t.rows.map(function (r) { return '| ' + t.cols.map(function (c) { return (r.cells[c.id] || '').replace(/\|/g, '\\|'); }).join(' | ') + ' |'; }).join('\n') + '\n'; }
    return this.blocksToMarkdown(p.title, p.blocks);
  }
};

Object.assign(Component.prototype, DbMix, SheetMix, NbMix);
