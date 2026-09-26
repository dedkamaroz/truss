/* ================= file previews =================
   TRUSS_PDF renders PDF pages with the vendored PDF.js (web/vendor/pdfjs), loaded on first use.
   Pages come back as data: URLs, which the host CSP allows for images (blob: it does not).
   ViewerMix adds thumbnails for image and PDF attachments and a viewer: a 16:9 frame (9:16 for
   portrait files) of up to 1280 x 720, with previous/next file, previous/next page for PDFs, and zoom. */

var TRUSS_PDF = (function () {
  var here = document.currentScript ? document.currentScript.src : (typeof location !== 'undefined' ? location.href : '');
  var base = '';
  try { base = new URL('../vendor/pdfjs/', here).href; } catch (e) { base = 'vendor/pdfjs/'; }
  var lib = null, docs = new Map(), pages = new Map(), KEEP = 80;
  function load() {
    if (!lib) {
      lib = import(base + 'pdf.min.mjs').then(function (m) { m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs'; return m; });
      lib.catch(function () { lib = null; });
    }
    return lib;
  }
  function open(url) {
    if (!docs.has(url)) {
      var p = load().then(function (m) {
        return fetch(url, { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) throw new Error('Could not load the file (' + r.status + ')');
          return r.arrayBuffer();
        }).then(function (buf) {
          return m.getDocument({ data: new Uint8Array(buf), standardFontDataUrl: base + 'standard_fonts/', cMapUrl: base + 'cmaps/', cMapPacked: true, useWasm: false, isEvalSupported: false, enableXfa: false }).promise;
        });
      });
      p.catch(function () { docs.delete(url); });
      docs.set(url, p);
      if (docs.size > 12) { var first = docs.keys().next().value; docs.get(first).then(function (d) { d.destroy(); }, function () {}); docs.delete(first); }
    }
    return docs.get(url);
  }
  // Renders page n to fit within maxW x maxH device pixels. Resolves { src, w, h, pages } (w, h in PDF points).
  function render(url, n, maxW, maxH, type) {
    var key = url + '|' + n + '|' + maxW + 'x' + maxH + '|' + (type || 'png');
    if (pages.has(key)) return pages.get(key);
    var p = open(url).then(function (doc) {
      return doc.getPage(clamp(n, 1, doc.numPages)).then(function (page) {
        var vp1 = page.getViewport({ scale: 1 }), scale = Math.min(maxW / vp1.width, maxH / vp1.height), vp = page.getViewport({ scale: scale });
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(vp.width)); canvas.height = Math.max(1, Math.floor(vp.height));
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        return page.render({ canvas: canvas, canvasContext: ctx, viewport: vp }).promise.then(function () {
          var src = type === 'jpeg' ? canvas.toDataURL('image/jpeg', 0.85) : canvas.toDataURL('image/png');
          canvas.width = canvas.height = 0;
          return { src: src, w: vp1.width, h: vp1.height, pages: doc.numPages };
        });
      });
    });
    p.catch(function () { pages.delete(key); });
    pages.set(key, p);
    if (pages.size > KEEP) pages.delete(pages.keys().next().value);
    return p;
  }
  function info(url) { return open(url).then(function (doc) { return doc.getPage(1).then(function (pg) { var v = pg.getViewport({ scale: 1 }); return { pages: doc.numPages, w: v.width, h: v.height }; }); }); }
  return { base: base, render: render, info: info, thumb: function (url) { return render(url, 1, 160, 160, 'jpeg'); } };
})();

var THUMB_PX = 192, THUMB_CONCURRENCY = 2;
function dataUrlToBlob(u) {
  var i = u.indexOf(','), bin = atob(u.slice(i + 1)), n = bin.length, a = new Uint8Array(n);
  for (var j = 0; j < n; j++) a[j] = bin.charCodeAt(j);
  return new Blob([a], { type: (/^data:([^;,]+)/.exec(u) || [0, 'application/octet-stream'])[1] });
}

var VIEW_MAX_W = 1280, VIEW_MAX_H = 720, VIEW_HEAD = 48;

var ViewerMix = {
  isPdf: function (id) { var a = this.attMeta && this.attMeta[id]; return !!(a && (/^application\/pdf/i.test(a.mime || '') || /\.pdf$/i.test(a.filename || ''))); },
  canPreview: function (id) { return this.isImage(id) || this.isPdf(id); },
  // Thumbnail source for an attachment: the image itself, or page 1 of a PDF once rendered ('' until then).
  // Thumbnails are small JPEGs stored on the server. Drawing the full-size originals into 32px boxes was
  // what made tables with a Files column slow: every visible photo was downloaded in full (megabytes each)
  // and decoded at full resolution, again and again as rows were repainted. A thumbnail is made once, by
  // whichever browser first shows the file (or uploads it), and every later view loads a few kilobytes.
  thumbSrc: function (id) {
    if (!this.remote || !this.canPreview(id)) return '';
    this.thumbs = this.thumbs || {};
    var t = this.thumbs[id], a = this.attMeta && this.attMeta[id];
    if (t && t.src) return t.src;
    if (a && a.has_thumb) return this.remote.url('/api/attachments/' + encodeURIComponent(id) + '/thumb');
    if (!t) { this.thumbs[id] = { state: 'queued', src: '' }; this.queueThumb(id, null); }
    return '';
  },
  // At most two thumbnails are made at a time, so a table full of new files stays responsive.
  queueThumb: function (id, blob) {
    var self = this;
    this.thumbQ = this.thumbQ || [];
    this.thumbQ.push({ id: id, blob: blob });
    this.thumbRunning = this.thumbRunning || 0;
    function next() {
      if (self.thumbRunning >= THUMB_CONCURRENCY || !self.thumbQ.length) return;
      var job = self.thumbQ.shift(), t = self.thumbs[job.id] || (self.thumbs[job.id] = { state: 'queued', src: '' });
      self.thumbRunning++;
      t.state = 'making';
      self.makeThumb(job.id, job.blob).then(function (dataUrl) {
        t.state = 'ok'; t.src = dataUrl;
        var a = self.attMeta && self.attMeta[job.id];
        return self.remote.putBlob('/api/attachments/' + encodeURIComponent(job.id) + '/thumb', dataUrlToBlob(dataUrl)).then(function () { if (a) a.has_thumb = 1; }, function () { /* shown locally; another view will store it */ });
      }).catch(function () { t.state = 'err'; }).then(function () {
        self.thumbRunning--;
        self.bumpSoon();
        next();
      });
      next();
    }
    next();
  },
  // Renders a JPEG data URL no larger than THUMB_PX on its longer side: from the given Blob (a file
  // just uploaded), else from the stored file (images decode off the main thread; PDFs use page 1).
  makeThumb: function (id, blob) {
    var self = this;
    if (this.isPdf(id)) return TRUSS_PDF.render(this.attUrl(id), 1, THUMB_PX, THUMB_PX, 'jpeg').then(function (r) { return r.src; });
    var src = blob ? Promise.resolve(blob) : fetch(this.attUrl(id), { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw new Error('fetch ' + r.status); return r.blob(); });
    return src.then(function (b) { return createImageBitmap(b); }).then(function (bmp) {
      var k = Math.min(1, THUMB_PX / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
      var c = document.createElement('canvas'); c.width = w; c.height = h;
      var ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      var out = c.toDataURL('image/jpeg', 0.82);
      c.width = c.height = 0;
      return out;
    });
  },
  // Re-renders at most every 150 ms while thumbnails arrive, rather than once per thumbnail.
  bumpSoon: function () {
    var self = this;
    if (this._bumpSoonT) return;
    this._bumpSoonT = setTimeout(function () { self._bumpSoonT = null; self.bump(); }, 150);
  },
  // Values for the thumbnails of a files cell; files that cannot be previewed stay as name tags.
  fileThumbs: function (ids, where) {
    var self = this, thumbs = [], tags = [], max = where === 'peek' ? 8 : 4;
    ids.forEach(function (id) {
      if (self.canPreview(id) && thumbs.length < max) {
        var src = self.thumbSrc(id), pdf = self.isPdf(id);
        thumbs.push({ src: src, hasSrc: !!src, noSrc: !src, label: pdf ? 'PDF' : 'IMG', name: self.attName(id), cls: 'thumb' + (pdf ? ' pdf' : '') + (where === 'peek' ? ' big' : ''),
          open: function (e) { if (e) { e.stopPropagation(); e.preventDefault(); } self.openViewer(ids, id); } });
      } else tags.push({ text: self.attName(id), cls: 'tag file' });
    });
    var more = ids.filter(function (id) { return self.canPreview(id); }).length - thumbs.length;
    if (more > 0) tags.unshift({ text: '+' + more, cls: 'tag file' });
    return { thumbs: thumbs, tags: tags };
  },

  openViewer: function (ids, id) {
    var list = ids.filter(Boolean);
    if (!list.length) return;
    this.S.viewer = { ids: list, i: Math.max(0, list.indexOf(id)), page: 1, pages: 0, zoom: 1, dims: {}, pdf: {} };
    this.S.menu = null; this.S.pop = null;
    this.bump();
  },
  closeViewer: function () { this.S.viewer = null; this.bump(); },
  viewerGo: function (d) { var V = this.S.viewer; if (!V || V.ids.length < 2) return; V.i = (V.i + d + V.ids.length) % V.ids.length; V.page = 1; V.zoom = 1; this.bump(); },
  viewerPage: function (d) { var V = this.S.viewer; if (!V) return; var n = V.pdf[V.ids[V.i]] ? V.pdf[V.ids[V.i]].pages : 1; var p = clamp(V.page + d, 1, n || 1); if (p !== V.page) { V.page = p; this.bump(); } },
  // Zooms about the centre of what is in view.
  viewerZoom: function (z) {
    var V = this.S.viewer; if (!V) return;
    var old = V.zoom, nz = clamp(Math.round(z * 100) / 100, 0.25, 8); if (nz === old) return;
    var el = typeof document !== 'undefined' && document.querySelector ? document.querySelector('.vw-body') : null;
    var cx = el ? (el.scrollLeft + el.clientWidth / 2) / Math.max(1, el.scrollWidth) : 0.5, cy = el ? (el.scrollTop + el.clientHeight / 2) / Math.max(1, el.scrollHeight) : 0.5;
    V.zoom = nz;
    this.bump();
    this.later(function () { var b = document.querySelector('.vw-body'); if (!b) return; b.scrollLeft = cx * b.scrollWidth - b.clientWidth / 2; b.scrollTop = cy * b.scrollHeight - b.clientHeight / 2; }, 0);
  },
  viewerKey: function (e) {
    var V = this.S.viewer, k = e.key; if (!V) return false;
    var zoomed = V.zoom > 1;
    if (k === 'Escape') { e.preventDefault(); this.closeViewer(); }
    else if (k === 'ArrowRight' && !zoomed) { e.preventDefault(); this.viewerGo(1); }
    else if (k === 'ArrowLeft' && !zoomed) { e.preventDefault(); this.viewerGo(-1); }
    else if (k === 'PageDown' || (k === 'ArrowDown' && !zoomed)) { e.preventDefault(); this.viewerPage(1); }
    else if (k === 'PageUp' || (k === 'ArrowUp' && !zoomed)) { e.preventDefault(); this.viewerPage(-1); }
    else if (k === '+' || k === '=') { e.preventDefault(); this.viewerZoom(V.zoom * 1.25); }
    else if (k === '-' || k === '_') { e.preventDefault(); this.viewerZoom(V.zoom / 1.25); }
    else if (k === '0') { e.preventDefault(); this.viewerZoom(1); }
    else return false;
    return true;
  },
  // Frame: 16:9 up to 1280 x 720, or 9:16 for portrait files, shrunk to fit the window.
  viewerFrame: function (portrait) {
    var W = (typeof window !== 'undefined' && window.innerWidth) || 1440, H = (typeof window !== 'undefined' && window.innerHeight) || 900;
    var fw, fh, availW = W - 120, availH = H - 40 - VIEW_HEAD - 8;
    if (portrait) { fh = Math.min(VIEW_MAX_W, availH); fw = Math.round(fh * 9 / 16); if (fw > availW) { fw = availW; fh = Math.round(fw * 16 / 9); } }
    else { fw = Math.min(VIEW_MAX_W, availW); fh = Math.round(fw * 9 / 16); if (fh > availH) { fh = availH; fw = Math.round(fh * 16 / 9); } }
    return { w: fw, h: fh };
  },
  viewerVals: function () {
    var self = this, V = this.S.viewer;
    if (!V) return { open: false };
    var id = V.ids[V.i], a = this.attMeta && this.attMeta[id], isImg = this.isImage(id), isPdf = this.isPdf(id);
    var d = V.dims[id], portrait = !!(d && d.h > d.w * 1.05), fr = this.viewerFrame(portrait);
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var fit = d ? Math.min(fr.w / d.w, fr.h / d.h) : 1, dw = d ? Math.round(d.w * fit * V.zoom) : 0, dh = d ? Math.round(d.h * fit * V.zoom) : 0;
    var src = '', loading = false, error = '';
    if (isImg) src = this.attUrl(id);
    else if (isPdf) {
      var P = V.pdf[id] || (V.pdf[id] = { pages: 0, src: '', key: '', err: '' });
      if (P.err) error = P.err;
      if (!P.pages && !P.infoing && !P.err) {
        P.infoing = true;
        TRUSS_PDF.info(this.attUrl(id)).then(function (inf) { P.pages = inf.pages; V.dims[id] = { w: inf.w, h: inf.h }; self.bump(); }, function (err) { P.err = (err && err.message) || 'This PDF could not be opened'; self.bump(); });
      }
      if (d) {
        // Render at the displayed size (device pixels), in steps so zooming does not re-render every frame.
        var step = 256, tw = Math.min(4096, Math.ceil(dw * dpr / step) * step), th = Math.min(4096, Math.ceil(dh * dpr / step) * step), key = V.page + '|' + tw + 'x' + th;
        if (P.key !== key && P.want !== key) {
          P.want = key;
          TRUSS_PDF.render(this.attUrl(id), V.page, tw, th).then(function (r) {
            if (P.want !== key) return;
            P.src = r.src; P.key = key; P.shownPage = V.page; V.dims[id] = { w: r.w, h: r.h }; P.pages = r.pages; self.bump();
          }, function (err) { P.err = (err && err.message) || 'This page could not be rendered'; self.bump(); });
        }
        src = P.src && P.shownPage === V.page ? P.src : '';
        loading = !src && !P.err;
      } else loading = !P.err;
    }
    var n = V.ids.length, pages = isPdf && V.pdf[id] ? V.pdf[id].pages : 0;
    return {
      open: true, name: a ? a.filename : 'File', size: a ? this.attSize(a.size) : '',
      counter: n > 1 ? 'File ' + (V.i + 1) + ' of ' + n : '', many: n > 1,
      isPdf: isPdf, hasPages: pages > 1, pageLabel: 'Page ' + V.page + ' of ' + (pages || 1),
      prevPageOff: V.page <= 1, nextPageOff: !pages || V.page >= pages,
      zoomLabel: Math.round(V.zoom * 100) + '%',
      frameStyle: 'width: ' + fr.w + 'px;',
      // The toolbar sits above the frame and keeps room for its controls when a portrait frame is narrow.
      barStyle: 'width: ' + Math.max(fr.w, Math.min(640, ((typeof window !== 'undefined' && window.innerWidth) || 1440) - 32)) + 'px;',
      bodyStyle: 'width: ' + fr.w + 'px; height: ' + fr.h + 'px;',
      bodyCls: 'vw-body' + (V.zoom > 1 ? ' zoomed' : ''),
      hasSrc: !!src, src: src, imgStyle: d ? 'width: ' + dw + 'px; height: ' + dh + 'px;' : 'max-width: 100%; max-height: 100%;',
      loading: loading, hasError: !!error, error: error,
      noPreview: !isImg && !isPdf,
      onImgLoad: function (e) { var el = e.target; if (isImg && el.naturalWidth && (!V.dims[id] || V.dims[id].w !== el.naturalWidth)) { V.dims[id] = { w: el.naturalWidth, h: el.naturalHeight }; self.bump(); } },
      close: function () { self.closeViewer(); },
      backdrop: function (e) { if (e.target === e.currentTarget) self.closeViewer(); },
      prev: function () { self.viewerGo(-1); }, next: function () { self.viewerGo(1); },
      prevPage: function () { self.viewerPage(-1); }, nextPage: function () { self.viewerPage(1); },
      zoomIn: function () { self.viewerZoom(V.zoom * 1.25); }, zoomOut: function () { self.viewerZoom(V.zoom / 1.25); }, zoomFit: function () { self.viewerZoom(1); },
      openTab: function () { self.openAttachment(id); },
      onWheel: function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        self.viewerZoom(V.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      },
      // Drag to pan when zoomed in.
      panDown: function (e) {
        if (V.zoom <= 1 || e.button !== 0) return;
        var el = e.currentTarget; V.pan = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
        try { el.setPointerCapture(e.pointerId); } catch (x) { /* capture unsupported */ }
        e.preventDefault();
      },
      panMove: function (e) { var p = V.pan; if (!p) return; var el = e.currentTarget; el.scrollLeft = p.sl - (e.clientX - p.x); el.scrollTop = p.st - (e.clientY - p.y); },
      panUp: function () { V.pan = null; }
    };
  }
};

Object.assign(Component.prototype, ViewerMix);
