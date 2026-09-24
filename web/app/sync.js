/* ================= server sync (hosted and local Truss server) =================
   Each module is saved as one document with a version. Saves carry the version they were based on;
   when someone else saved in between, the server refuses and returns their copy, which is merged with
   ours item by item (rows, pages, blocks, cells, properties...) before retrying. Other people's saves
   arrive as Server-Sent Events and are merged the same way, so nobody's work is overwritten silently. */

var CLIENT_ID = uid() + uid();

function isPlainObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function sameJson(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b); }
function isIdList(a) { return Array.isArray(a) && a.every(function (x) { return isPlainObj(x) && typeof x.id === 'string'; }); }

/* Three-way merge of JSON values: base (last common version), local (ours) and server (theirs).
   Objects merge key by key, arrays of {id} merge item by item, and anything both sides changed
   differently keeps our value. */
function merge3(b, l, s) {
  if (sameJson(l, b)) return s;
  if (sameJson(s, b)) return l;
  if (isPlainObj(l) && isPlainObj(s)) {
    var bo = isPlainObj(b) ? b : {}, out = {};
    Object.keys(Object.assign({}, l, s)).forEach(function (k) {
      var inL = Object.prototype.hasOwnProperty.call(l, k), inS = Object.prototype.hasOwnProperty.call(s, k), inB = Object.prototype.hasOwnProperty.call(bo, k);
      if (inL && inS) out[k] = merge3(bo[k], l[k], s[k]);
      else if (inL) { if (!(inB && sameJson(l[k], bo[k]))) out[k] = l[k]; }
      else if (!(inB && sameJson(s[k], bo[k]))) out[k] = s[k];
    });
    return out;
  }
  if (isIdList(l) && isIdList(s) && (b === undefined || b === null || isIdList(b))) return mergeById(b || [], l, s);
  return l;
}
function mergeById(b, l, s) {
  var bm = new Map(b.map(function (x) { return [x.id, x]; })), lm = new Map(l.map(function (x) { return [x.id, x]; })), sm = new Map(s.map(function (x) { return [x.id, x]; }));
  var out = [];
  s.forEach(function (x) {
    if (lm.has(x.id)) out.push(merge3(bm.get(x.id), lm.get(x.id), x));
    else if (!(bm.has(x.id) && sameJson(bm.get(x.id), x))) out.push(x); // we deleted it, unless they changed it since
  });
  l.forEach(function (x, i) {
    if (sm.has(x.id)) return;
    if (bm.has(x.id) && sameJson(bm.get(x.id), x)) return; // they deleted it and we had not changed it
    var at = 0;
    for (var j = i - 1; j >= 0; j--) { var k = idxById(out, l[j].id); if (k >= 0) { at = k + 1; break; } }
    out.splice(at, 0, x);
  });
  // A reorder made only by us wins; otherwise the server's order stands.
  var bIds = b.map(function (x) { return x.id; }).join('|'), sIds = s.map(function (x) { return x.id; }).join('|'), lIds = l.map(function (x) { return x.id; }).join('|');
  if (sIds === bIds && lIds !== bIds) {
    var rank = new Map(l.map(function (x, i) { return [x.id, i]; }));
    out = out.map(function (x, i) { return { x: x, r: rank.has(x.id) ? rank.get(x.id) : i - 0.5 }; }).sort(function (p, q) { return p.r - q.r; }).map(function (p) { return p.x; });
  }
  return out;
}

var SyncMix = {
  loadRecent: function () { try { return JSON.parse(window.localStorage.getItem('truss.recent.v2') || '[]'); } catch (e) { return []; } },
  saveRecent: function () { try { window.localStorage.setItem('truss.recent.v2', JSON.stringify(this.ws.recent || [])); } catch (e) { /* per-browser convenience only */ } },
  setSync: function (state) { if (this.S.sync !== state) { this.S.sync = state; this.bump(); } },

  syncBoot: async function () {
    var self = this, S = this.S;
    S.loading = true; S.loadError = null; this.bump();
    var w;
    try { w = await this.remote.get('/api/v2/workspace'); }
    catch (e) { S.loading = false; S.loadError = e.message || 'Could not load the workspace'; this.bump(); return; }
    this.base = {}; this.ver = {};
    this.ws.modules = w.modules.map(function (x) { normModule(x.module); self.base[x.module.id] = JSON.stringify(x.module); self.ver[x.module.id] = x.version; return x.module; });
    this.rev = w.rev || 0;
    S.loading = false; S.sync = 'saved';
    if (S.route.name === 'm' && !this.mod(S.route.id)) S.route = { name: 'home' };
    this.calc = new Map();
    this.bump();
    if (w.migration && w.migration.length) this.modal('text', { title: 'Imported from the previous Truss', text: 'Your existing databases, workbooks and notebooks were converted. A few things could not be carried over exactly:\n\n- ' + w.migration.join('\n- ') + '\n\nThe original tables are untouched on the server.', what: 'Notes' });
    this.openEvents();
    this._pollT = setInterval(function () { self.pollChanges(); }, 30000);
    window.addEventListener('beforeunload', function (e) { if (self.hasPending()) { self.syncNow(); e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') self.syncNow(); else self.pollChanges(); });
  },

  pendingWork: function () {
    var self = this, puts = [], present = {};
    this.ws.modules.forEach(function (m) {
      present[m.id] = 1;
      var j = JSON.stringify(m);
      if (j !== self.base[m.id]) puts.push({ id: m.id, json: j, base: self.ver[m.id] || 0 });
    });
    var deletes = Object.keys(this.base).filter(function (id) { return !present[id]; }).map(function (id) { return { id: id, baseVersion: self.ver[id] || 0 }; });
    return { puts: puts, deletes: deletes };
  },
  hasPending: function () {
    if (!this.remote || !this.base) return false;
    var w = this.pendingWork();
    return w.puts.length > 0 || w.deletes.length > 0;
  },
  scheduleSync: function () {
    var self = this;
    if (!this.base) return;
    clearTimeout(this._syncT);
    this._syncT = setTimeout(function () { self.syncNow(); }, 500);
    if (this.S.sync === 'saved') this.setSync('pending');
  },
  syncNow: async function () {
    var self = this;
    if (!this.remote || !this.base || this.S.sync === 'auth') return;
    clearTimeout(this._syncT);
    if (this.syncing) { this.syncAgain = true; return; }
    var work = this.pendingWork();
    if (!work.puts.length && !work.deletes.length) { this.setSync('saved'); return; }
    this.syncing = true;
    this.setSync('saving');
    var body = '{"client":' + JSON.stringify(CLIENT_ID) + ',"puts":[' + work.puts.map(function (p) { return '{"module":' + p.json + ',"baseVersion":' + p.base + '}'; }).join(',') + '],"deletes":' + JSON.stringify(work.deletes) + '}';
    try {
      var r = await this.remote.post('/api/v2/sync', body);
      work.puts.forEach(function (p) { self.base[p.id] = p.json; self.ver[p.id] = r.versions[p.id]; });
      work.deletes.forEach(function (d) { delete self.base[d.id]; delete self.ver[d.id]; });
      this.rev = Math.max(this.rev || 0, r.rev || 0);
      this._retry = 0;
      this.S.sync = 'saved';
    } catch (e) {
      if (e.status === 409 && e.data && e.data.conflicts) { this.resolveConflicts(e.data.conflicts); this.syncAgain = true; }
      else if (e.status === 401 || e.status === 403) this.S.sync = 'auth';
      else {
        this.S.sync = 'offline';
        this._retry = Math.min(30000, (this._retry || 1000) * 2);
        setTimeout(function () { self.syncNow(); }, this._retry);
      }
    } finally {
      this.syncing = false;
      if (this.syncAgain) { this.syncAgain = false; this.scheduleSync(); }
      else if (this.S.sync === 'saved' && this.hasPending()) this.scheduleSync();
      this.bump();
    }
  },
  replaceModule: function (i, m) { this.ws.modules[i] = m; },
  dropModule: function (i) {
    var m = this.ws.modules[i];
    this.ws.modules.splice(i, 1);
    if (this.S.route.id === m.id) { this.S.route = { name: 'home' }; this.S.peek = null; }
    this.toast('"' + (m.title || 'Untitled') + '" was deleted by someone else', 'info');
  },
  resolveConflicts: function (conflicts) {
    var self = this;
    conflicts.forEach(function (c) {
      var i = idxById(self.ws.modules, c.id), local = i >= 0 ? self.ws.modules[i] : null, baseJ = self.base[c.id];
      if (c.module) normModule(c.module);
      if (!c.module) {
        var changed = local && baseJ !== JSON.stringify(local);
        if (local && !changed && baseJ) self.dropModule(i);
        delete self.base[c.id];
        if (local && (changed || !baseJ)) self.ver[c.id] = 0; else delete self.ver[c.id];
        return;
      }
      if (!local) { self.ws.modules.push(c.module); self.toast('"' + c.module.title + '" was changed by someone else, so it was kept', 'info'); }
      else self.replaceModule(i, merge3(baseJ ? JSON.parse(baseJ) : null, local, c.module));
      self.base[c.id] = JSON.stringify(c.module);
      self.ver[c.id] = c.version;
    });
    this.calc = new Map();
  },

  openEvents: function () {
    var self = this;
    if (typeof EventSource === 'undefined') return;
    try {
      this.es = new EventSource(this.remote.url('/api/v2/events?since=' + (this.rev || 0)));
      this.es.onmessage = function (ev) { try { self.onRemoteChange(JSON.parse(ev.data)); } catch (e) { /* ignore a malformed event */ } };
    } catch (e) { this.es = null; }
  },
  pollChanges: async function () {
    if (!this.remote || !this.base || this.S.sync === 'auth') return;
    try {
      var r = await this.remote.get('/api/v2/changes?since=' + (this.rev || 0));
      var self = this;
      r.changes.forEach(function (c) { self.onRemoteChange(c); });
      this.rev = Math.max(this.rev || 0, r.rev || 0);
      if (this.S.sync === 'offline') this.syncNow();
    } catch (e) {
      if (e.status === 401 || e.status === 403) this.setSync('auth');
    }
  },
  onRemoteChange: function (c) {
    if (c.rev > (this.rev || 0)) this.rev = c.rev;
    if (c.client === CLIENT_ID) return;
    if (!c.deleted && (this.ver[c.id] || 0) >= c.version) return;
    if (c.deleted && !(c.id in this.ver) && !this.mod(c.id)) return;
    var self = this;
    this._fetchQ = this._fetchQ || {};
    clearTimeout(this._fetchQ[c.id]);
    this._fetchQ[c.id] = setTimeout(function () { self.fetchRemote(c.id); }, 120);
  },
  fetchRemote: async function (id) {
    var self = this, r = null;
    if (this.syncing) { this._fetchQ[id] = setTimeout(function () { self.fetchRemote(id); }, 300); return; }
    try { r = await this.remote.get('/api/v2/modules/' + encodeURIComponent(id)); }
    catch (e) { if (e.status !== 404) return; r = null; }
    if (this.syncing) { this._fetchQ[id] = setTimeout(function () { self.fetchRemote(id); }, 300); return; }
    var i = idxById(this.ws.modules, id), local = i >= 0 ? this.ws.modules[i] : null, baseJ = this.base[id];
    var pending = !!local && baseJ !== JSON.stringify(local);
    if (r) normModule(r.module);
    if (!r) {
      if (local && !pending) this.dropModule(i);
      delete this.base[id];
      if (local && pending) this.ver[id] = 0; else delete this.ver[id];
    } else {
      if (r.version <= (this.ver[id] || 0)) return;
      if (!local) {
        this.ws.modules.push(r.module);
        if (baseJ) this.toast('"' + r.module.title + '" was changed by someone else, so it was kept', 'info');
      } else if (!pending) this.replaceModule(i, r.module);
      else this.replaceModule(i, merge3(JSON.parse(baseJ), local, r.module));
      this.base[id] = JSON.stringify(r.module);
      this.ver[id] = r.version;
    }
    this.calc = new Map();
    this.bump();
    if (pending) this.scheduleSync();
  },

  /* ---------- attachments ---------- */
  attKey: function (modId, ownerId) { return modId + '|' + (ownerId || ''); },
  loadAttachments: function (modId) {
    var self = this;
    if (!this.remote) return;
    this.attLoaded = this.attLoaded || {};
    if (this.attLoaded[modId]) return;
    this.attLoaded[modId] = 'loading';
    this.remote.get('/api/attachments?moduleId=' + encodeURIComponent(modId)).then(function (rows) {
      self.attMeta = self.attMeta || {};
      rows.forEach(function (a) { self.attMeta[a.id] = a; });
      self.attLoaded[modId] = true;
      self.bump();
    }, function () { self.attLoaded[modId] = false; });
  },
  attList: function (modId, ownerId) {
    this.loadAttachments(modId);
    var meta = this.attMeta || {};
    return Object.keys(meta).map(function (k) { return meta[k]; }).filter(function (a) { return a.module_id === modId && (a.page_id || '') === (ownerId || ''); });
  },
  attUrl: function (id) { return this.remote ? this.remote.url('/api/attachments/' + encodeURIComponent(id) + '/content') : ''; },
  openAttachment: function (id) { if (this.remote) window.open(this.attUrl(id), '_blank', 'noopener'); },
  // Attachments reference their module on the server, so a module created moments ago is saved first.
  ensureSaved: async function (modId) {
    for (var i = 0; i < 20 && !(this.ver && this.ver[modId]); i++) {
      await this.syncNow();
      if (this.ver && this.ver[modId]) break;
      await new Promise(function (r) { setTimeout(r, 250); });
    }
    return !!(this.ver && this.ver[modId]);
  },
  uploadFiles: async function (files, modId, ownerId) {
    var self = this, out = [];
    if (!this.remote) { this.toast('Files need the Truss server', 'info'); return out; }
    files = Array.prototype.slice.call(files || []);
    if (!files.length) return out;
    if (!(await this.ensureSaved(modId))) { this.toast('Could not save before uploading - check the connection', 'error'); return out; }
    for (var i = 0; i < files.length; i++) {
      try {
        var row = await this.remote.upload('/api/attachments?moduleId=' + encodeURIComponent(modId) + (ownerId ? '&pageId=' + encodeURIComponent(ownerId) : ''), files[i]);
        this.attMeta = this.attMeta || {};
        this.attMeta[row.id] = row;
        out.push(row);
      } catch (e) {
        this.toast('Upload failed: ' + (e.message || 'error'), 'error');
      }
    }
    if (out.length) this.toast(plural(out.length, 'file') + ' uploaded', 'success');
    self.bump();
    return out;
  },
  deleteAttachment: async function (id) {
    if (!this.remote) return;
    try { await this.remote.del('/api/attachments/' + encodeURIComponent(id)); delete this.attMeta[id]; this.bump(); }
    catch (e) { this.toast('Could not delete the file: ' + e.message, 'error'); }
  },
  attName: function (id) { var a = this.attMeta && this.attMeta[id]; return a ? a.filename : 'File'; },
  attSize: function (n) { if (!n && n !== 0) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; },
  isImage: function (id) { var a = this.attMeta && this.attMeta[id]; return !!(a && /^image\/(png|jpe?g|gif|webp|bmp)/.test(a.mime || '')); }
};

Object.assign(Component.prototype, SyncMix);
