/* Renders ui.html against Component.renderVals().
   The template language: {{dotted.path}} holes, <sc-for list as>, <sc-if value>, onX="{{handler}}"
   event bindings, and the build-time-free macros @@NAME(arg)@@ / @@I:icon@@ defined in ui.html.
   Rendering is a keyed virtual-DOM patch: element identity is kept across renders, so focus,
   caret position and scroll survive typing. Styles are applied through the CSSOM (el.style.cssText),
   never as markup attributes, so a style-src 'self' Content-Security-Policy is satisfied. */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SCRIPT_URL = document.currentScript ? document.currentScript.src : location.href;
  var DOT_ICONS = { more: 1, drag: 1 };
  var PICON_KEYS = { text: 'text', hash: 'hash', select: 'select', multi: 'multi', status: 'status', calendar: 'calendar', checkbox: 'checkbox', link: 'link', mail: 'mail', phone: 'phone', relation: 'relation', rollup: 'rollup', formula: 'formula', lookup: 'lookup', clock: 'clock', file: 'file', table: 'table', board: 'board', list: 'list', gallery: 'gallery', cal: 'cal' };

  /* ------------------------------------------------------------ macros */

  function icon(name, cls) {
    var d = TRUSS_ICONS[name];
    if (!d) throw new Error('Unknown icon ' + name);
    cls = (cls || '').trim();
    var c = ('ic ' + cls + (DOT_ICONS[name] && cls.indexOf('dots') < 0 ? ' dots' : '')).trim();
    return '<svg class="' + c + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"></path></svg>';
  }
  function picon(arg) {
    return Object.keys(PICON_KEYS).map(function (k) { return '<sc-if value="{{' + arg + '.ic.' + k + '}}">' + icon(PICON_KEYS[k], 'sm') + '</sc-if>'; }).join('');
  }
  function expandTemplate(text) {
    var macros = {}, re = /<!--@(\w+)-->\n?([\s\S]*?)<!--@END-->/g, m;
    while ((m = re.exec(text))) macros[m[1]] = m[2].trim();
    function expand(s, depth) {
      if (depth > 8) throw new Error('Template macro recursion');
      s = s.replace(/@@([A-Z]+)\(([^)@]+)\)@@/g, function (all, name, arg) {
        if (name === 'PICON') return picon(arg);
        var body = macros[name];
        if (body === undefined) throw new Error('Unknown template macro ' + name);
        body = body.split('{{$}}').join('{{' + arg + '}}').split('{{$.').join('{{' + arg + '.').split('($.').join('(' + arg + '.');
        return expand(body, depth + 1);
      });
      return s.replace(/@@I:(\w+)(?::([\w ]+))?@@/g, function (all, name, cls) { return icon(name, cls); });
    }
    if (!macros.MAIN) throw new Error('ui.html has no MAIN section');
    return expand(macros.MAIN, 0);
  }

  /* ------------------------------------------------------------ parse (our own well-formed markup only) */

  var VOID = { input: 1, br: 1, hr: 1, img: 1, meta: 1, link: 1, area: 1, base: 1, col: 1, embed: 1, source: 1, track: 1, wbr: 1 };
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' };
  function decode(s) {
    return s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m;
    });
  }
  function parse(src) {
    var root = { kids: [] }, stack = [root];
    var re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=\/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g, m;
    while ((m = re.exec(src))) {
      var top = stack[stack.length - 1];
      if (m[5] !== undefined || m[6] !== undefined) { top.kids.push({ text: decode(m[5] !== undefined ? m[5] : m[6]) }); continue; }
      if (m[1]) {
        var name = m[1].toLowerCase();
        for (var i = stack.length - 1; i > 0; i--) if (stack[i].tag.toLowerCase() === name) { stack.length = i; break; }
        continue;
      }
      if (!m[2]) continue;
      var attrs = [], ar = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, a;
      while ((a = ar.exec(m[3] || ''))) attrs.push([a[1], decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '')]);
      var node = { tag: m[2], attrs: attrs, kids: [] };
      top.kids.push(node);
      if (!m[4] && !VOID[m[2].toLowerCase()]) stack.push(node);
    }
    return root.kids;
  }

  /* ------------------------------------------------------------ compile */

  function lookup(scope, path) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (path === 'null') return null;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    var parts = path.split('.'), v = scope;
    for (var i = 0; i < parts.length; i++) { if (v === null || v === undefined) return undefined; v = v[parts[i]]; }
    return v;
  }
  function getter(src) {
    var whole = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/.exec(src);
    if (whole) { var p = whole[1]; return function (s) { return lookup(s, p); }; }
    if (src.indexOf('{{') < 0) return null;
    var bits = src.split(/\{\{\s*([^}]+?)\s*\}\}/g);
    return function (s) {
      var out = '';
      for (var i = 0; i < bits.length; i++) {
        if (i & 1) { var v = lookup(s, bits[i]); out += v === null || v === undefined || typeof v === 'boolean' ? '' : v; }
        else out += bits[i];
      }
      return out;
    };
  }
  function compile(nodes, svg) {
    var out = [];
    nodes.forEach(function (n) {
      if (n.text !== undefined) {
        if (!n.text.trim() && n.text.indexOf(' ') < 0 && n.text.indexOf('\u00A0') < 0) return;
        var g = getter(n.text);
        out.push(g ? { k: 't', f: g } : { k: 't', s: n.text });
        return;
      }
      var tag = n.tag.toLowerCase(), attr = {};
      n.attrs.forEach(function (a) { attr[a[0]] = a[1]; });
      if (tag === 'sc-for') { out.push({ k: 'for', list: getter(attr.list), as: attr.as || 'item', kids: compile(n.kids, svg) }); return; }
      if (tag === 'sc-if') { out.push({ k: 'if', cond: getter(attr.value), kids: compile(n.kids, svg) }); return; }
      var isSvg = svg || tag === 'svg';
      var attrs = n.attrs.filter(function (a) { return a[0].indexOf('hint-') !== 0; }).map(function (a) {
        var g = getter(a[1]);
        return g ? { n: a[0], f: g } : { n: a[0], v: a[1] };
      });
      // "type" first, so onChange can pick its DOM event from the input type.
      attrs.sort(function (x, y) { return (x.n === 'type' ? 0 : 1) - (y.n === 'type' ? 0 : 1); });
      out.push({ k: 'e', tag: isSvg ? n.tag : tag, svg: isSvg, attrs: attrs, kids: compile(n.kids, isSvg) });
    });
    return out;
  }

  /* ------------------------------------------------------------ build virtual nodes */

  function text(v) { return v === null || v === undefined || typeof v === 'boolean' ? '' : String(v); }
  function build(nodes, scope, prefix, out) {
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], key = prefix + '/' + i;
      if (n.k === 't') out.push({ t: 1, key: key, text: n.f ? text(n.f(scope)) : n.s });
      else if (n.k === 'if') { if (n.cond && n.cond(scope)) build(n.kids, scope, key, out); }
      else if (n.k === 'for') {
        var list = n.list ? n.list(scope) : null;
        if (!Array.isArray(list)) continue;
        for (var j = 0; j < list.length; j++) {
          var s2 = Object.create(scope);
          s2[n.as] = list[j];
          s2.$index = j;
          build(n.kids, s2, key + ':' + j, out);
        }
      } else {
        var props = {};
        for (var a = 0; a < n.attrs.length; a++) { var at = n.attrs[a]; props[at.n] = at.f ? at.f(scope) : at.v; }
        var kids = [];
        build(n.kids, scope, '', kids);
        out.push({ key: key, tag: n.tag, svg: n.svg, props: props, kids: kids });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ patch */

  var BOOL_PROPS = { disabled: 'disabled', readOnly: 'readOnly', readonly: 'readOnly', hidden: 'hidden', multiple: 'multiple', required: 'required' };
  var ATTR_ALIAS = { tabIndex: 'tabindex', spellCheck: 'spellcheck', htmlFor: 'for', className: 'class', autoComplete: 'autocomplete', maxLength: 'maxlength' };
  var EVENT_ALIAS = { doubleclick: 'dblclick' };
  function truthy(v) { return v === true || v === 'true' || v === '' || (v && v !== 'false') ? !!v || v === '' : false; }
  function dispatch(e) { var h = this.__h && this.__h[e.type]; if (typeof h === 'function') h(e); }
  function eventType(el, name) {
    var t = name.slice(2).toLowerCase();
    if (t === 'change') {
      var tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
      return tag === 'select' || type === 'checkbox' || type === 'radio' || type === 'file' ? 'change' : 'input';
    }
    return EVENT_ALIAS[t] || t;
  }
  function isEvent(name) { return name.length > 2 && name[0] === 'o' && name[1] === 'n' && name[2] >= 'A' && name[2] <= 'Z'; }
  function setProp(el, name, val, svg) {
    if (isEvent(name)) {
      var type = eventType(el, name);
      if (!el.__h) el.__h = {};
      if (!(type in el.__h)) el.addEventListener(type, dispatch);
      el.__h[type] = val;
      return;
    }
    if (name === 'class') { if (svg) el.setAttribute('class', text(val)); else el.className = text(val); return; }
    if (name === 'style') { el.style.cssText = text(val); return; }
    if (name === 'value' || name === 'checked' || name === 'autoFocus' || name === 'autofocus' || name === 'key' || name === 'ref') return;
    if (BOOL_PROPS[name]) { el[BOOL_PROPS[name]] = val === 'false' ? false : !!(val || val === ''); return; }
    var attr = ATTR_ALIAS[name] || name;
    if (val === null || val === undefined || val === false) el.removeAttribute(attr);
    else el.setAttribute(attr, val === true ? '' : String(val));
  }
  function setLate(el, props) {
    if ('value' in props) {
      var s = props.value === null || props.value === undefined ? '' : String(props.value);
      if (el.value !== s) el.value = s;
    }
    if ('checked' in props) { var c = !!props.checked && props.checked !== 'false'; if (el.checked !== c) el.checked = c; }
  }
  function create(v) {
    if (v.t) return document.createTextNode(v.text);
    var el = v.svg ? document.createElementNS(SVG_NS, v.tag) : document.createElement(v.tag);
    for (var k in v.props) setProp(el, k, v.props[k], v.svg);
    el.__p = v.props;
    patchKids(el, v.kids);
    setLate(el, v.props);
    return el;
  }
  function update(el, v) {
    var old = el.__p || {};
    for (var k in old) if (!(k in v.props)) setProp(el, k, null, v.svg);
    for (var n in v.props) {
      var val = v.props[n];
      if (typeof val === 'function' || old[n] !== val) setProp(el, n, val, v.svg);
    }
    el.__p = v.props;
    patchKids(el, v.kids);
    setLate(el, v.props);
  }
  function patchKids(parent, list) {
    var old = parent.__k || [], map = new Map();
    for (var i = 0; i < old.length; i++) map.set(old[i].key, old[i]);
    var next = [];
    for (var j = 0; j < list.length; j++) {
      var v = list[j], o = map.get(v.key), node;
      if (o && o.tag === (v.t ? '#text' : v.tag)) {
        map.delete(v.key);
        node = o.node;
        if (v.t) { if (node.nodeValue !== v.text) node.nodeValue = v.text; }
        else update(node, v);
      } else node = create(v);
      next.push({ key: v.key, tag: v.t ? '#text' : v.tag, node: node });
    }
    map.forEach(function (o) { if (o.node.parentNode === parent) parent.removeChild(o.node); });
    var cur = parent.firstChild;
    for (var x = 0; x < next.length; x++) {
      var nd = next[x].node;
      if (nd === cur) cur = cur.nextSibling;
      else parent.insertBefore(nd, cur);
    }
    parent.__k = next;
  }

  /* ------------------------------------------------------------ mount */

  var container, template, comp, pending = false, mounted = false, failed = false;
  function render() {
    pending = false;
    if (failed) return;
    try {
      var vals = comp.renderVals();
      patchKids(container, build(template, vals, '', []));
    } catch (err) {
      failed = true;
      console.error('[truss] render failed', err);
      showError(err);
      return;
    }
    if (!mounted) {
      mounted = true;
      container.classList.remove('app-booting');
      container.removeAttribute('aria-busy');
      try { comp.componentDidMount(); } catch (e) { console.error(e); }
    }
  }
  function showError(err) {
    container.textContent = '';
    var box = document.createElement('div');
    box.className = 'boot-error';
    var h = document.createElement('h1'); h.textContent = 'Truss could not start';
    var p = document.createElement('p'); p.textContent = String(err && err.message || err);
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'Reload';
    b.addEventListener('click', function () { location.reload(); });
    box.append(h, p, b);
    container.append(box);
    container.classList.remove('app-booting');
  }
  TRUSS_RENDER.schedule = function () {
    if (pending || !template) return;
    pending = true;
    queueMicrotask(render);
  };
  TRUSS_RENDER.expandTemplate = expandTemplate;
  TRUSS_RENDER.parse = parse;

  async function start() {
    container = document.getElementById('app');
    try {
      var res = await fetch(new URL('ui.html', SCRIPT_URL), { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load the interface (' + res.status + ')');
      template = compile(parse(expandTemplate(await res.text())), false);
      comp = new Component({});
      render();
    } catch (err) {
      console.error('[truss] start failed', err);
      showError(err);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
