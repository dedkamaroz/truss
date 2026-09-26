/* Loaded first. Defines the DCLogic base class the UI logic extends, and TRUSS_REMOTE: the
   connection to the Truss server (null when the page is opened without it). No framework, no build step. */

var TRUSS_RENDER = { schedule: function () {} };

class DCLogic {
  constructor(props) { this.props = props || {}; this.state = {}; }
  setState(s) {
    var next = typeof s === 'function' ? s(this.state) : s;
    this.state = Object.assign({}, this.state, next);
    TRUSS_RENDER.schedule();
  }
  forceUpdate() { TRUSS_RENDER.schedule(); }
  componentDidMount() {}
  componentDidUpdate() {}
  componentWillUnmount() {}
  renderVals() { return {}; }
}

var TRUSS_REMOTE = (function () {
  function meta(name) { var m = document.querySelector('meta[name="' + name + '"]'); return m ? m.content : ''; }
  var token = meta('truss-token');
  // Opened as a plain file, or served by something other than the Truss server: run on browser storage.
  if (!token || token.charAt(0) === '%') return null;
  // The host's CSRF token and hosted flag are injected by the web_server's proxy; locally they are absent.
  var csrf = meta('truss-csrf');
  var hosted = meta('truss-hosted') === '1';
  // Truss is served from "/" locally and from a path prefix behind the proxy. This file lives at
  // <root>/app/boot.js, so "../" is the application root either way; API paths resolve against it.
  var root = new URL('../', document.currentScript ? document.currentScript.src : location.href);
  function resolve(p) { return new URL(String(p).replace(/^\//, ''), root).href; }
  function headers(extra) {
    var h = { 'X-Truss-Token': token };
    if (csrf) h['X-CSRF-Token'] = csrf;
    return Object.assign(h, extra || {});
  }
  function fail(status, code, message, data) { var e = new Error(message); e.status = status; e.code = code; e.data = data; return e; }
  async function parse(res) {
    var type = res.headers.get('content-type') || '';
    // The host answers an expired session with a redirect to its login page, which fetch follows.
    if (res.ok && /text\/html/i.test(type)) throw fail(401, 'session', 'Your session has expired. Reload the page to sign in again.');
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      var err = data && data.error;
      throw fail(res.status, (err && err.code) || 'http_' + res.status, (err && err.message) || res.statusText || 'Request failed', data);
    }
    return data;
  }
  async function request(method, path, body) {
    var init = { method: method, headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    var res;
    try { res = await fetch(resolve(path), init); } catch (e) { throw fail(0, 'network', 'Could not reach the Truss server'); }
    return parse(res);
  }
  return {
    token: token, csrf: csrf, hosted: hosted, root: root.href,
    get: function (p) { return request('GET', p); },
    post: function (p, b) { return request('POST', p, b); },
    del: function (p) { return request('DELETE', p); },
    upload: async function (path, file) {
      var res;
      try {
        res = await fetch(resolve(path), {
          method: 'POST',
          headers: headers({ 'X-Filename': encodeURIComponent(file.name || 'file'), 'Content-Type': file.type || 'application/octet-stream' }),
          body: file
        });
      } catch (e) { throw fail(0, 'network', 'Could not reach the Truss server'); }
      return parse(res);
    },
    // Sends a binary body with PUT (used for thumbnails).
    putBlob: async function (path, blob) {
      var res;
      try { res = await fetch(resolve(path), { method: 'PUT', headers: headers({ 'Content-Type': blob.type || 'application/octet-stream' }), body: blob }); }
      catch (e) { throw fail(0, 'network', 'Could not reach the Truss server'); }
      return parse(res);
    },
    url: function (p) { var u = resolve(p); return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token); }
  };
})();
