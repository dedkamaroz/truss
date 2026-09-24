/* ================= helpers ================= */
var OPT_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
var OPT_COLOR_LABEL = { gray: 'Grey', brown: 'Brown', orange: 'Orange', yellow: 'Yellow', green: 'Green', blue: 'Blue', purple: 'Purple', pink: 'Pink', red: 'Red' };
var TILES = ['slate', 'clay', 'teal', 'blue', 'violet', 'rose', 'amber', 'green'];
var TILE_LABEL = { slate: 'Slate', clay: 'Clay', teal: 'Teal', blue: 'Blue', violet: 'Violet', rose: 'Rose', amber: 'Amber', green: 'Green' };
var TYPE_LABEL = { database: 'Database', sheet: 'Workbook', notebook: 'Notebook' };
var STORE_KEY = 'truss.workspace.v1';
var UI_KEY = 'truss.ui.v1';

var PROP_TYPES = [
  ['title', 'Title'], ['text', 'Text'], ['number', 'Number'], ['select', 'Select'], ['multi_select', 'Multi-select'], ['status', 'Status'],
  ['date', 'Date'], ['checkbox', 'Checkbox'], ['url', 'URL'], ['email', 'Email'], ['phone', 'Phone'], ['files', 'Files'],
  ['relation', 'Relation'], ['rollup', 'Rollup'], ['formula', 'Formula'], ['lookup', 'Lookup'],
  ['created_time', 'Created time'], ['last_edited_time', 'Last edited time']
];
var PROP_LABEL = {}; PROP_TYPES.forEach(function (p) { PROP_LABEL[p[0]] = p[1]; });
var PROP_ICON = { title: 'text', text: 'text', number: 'hash', select: 'select', multi_select: 'multi', status: 'status', date: 'calendar', checkbox: 'checkbox', url: 'link', email: 'mail', phone: 'phone', files: 'file', relation: 'relation', rollup: 'rollup', formula: 'formula', lookup: 'lookup', created_time: 'clock', last_edited_time: 'clock' };
var ICON_KEYS = ['text', 'hash', 'select', 'multi', 'status', 'calendar', 'checkbox', 'link', 'mail', 'phone', 'file', 'relation', 'rollup', 'formula', 'lookup', 'clock'];
var COMPUTED = { rollup: 1, formula: 1, lookup: 1, created_time: 1, last_edited_time: 1 };
var VIEW_TYPES = [['table', 'Table'], ['board', 'Board'], ['list', 'List'], ['gallery', 'Gallery'], ['calendar', 'Calendar']];
var VIEW_LABEL = { table: 'Table', board: 'Board', list: 'List', gallery: 'Gallery', calendar: 'Calendar' };

var BLOCK_TYPES = [
  { key: 'p', label: 'Text', glyph: 'Aa', hint: 'Plain paragraph', kw: 'text paragraph plain' },
  { key: 'h1', label: 'Heading 1', glyph: 'H1', hint: 'Big section heading', kw: 'heading title h1 #' },
  { key: 'h2', label: 'Heading 2', glyph: 'H2', hint: 'Medium heading', kw: 'heading subtitle h2 ##' },
  { key: 'h3', label: 'Heading 3', glyph: 'H3', hint: 'Small heading', kw: 'heading h3 ###' },
  { key: 'ul', label: 'Bulleted list', glyph: '*', hint: 'Simple list', kw: 'bullet list unordered ul -' },
  { key: 'ol', label: 'Numbered list', glyph: '1.', hint: 'Ordered list', kw: 'numbered list ordered ol 1.' },
  { key: 'todo', label: 'To-do', glyph: '[ ]', hint: 'Checklist item', kw: 'todo task check checkbox []' },
  { key: 'toggle', label: 'Toggle', glyph: '>', hint: 'Collapsible section', kw: 'toggle collapse details' },
  { key: 'quote', label: 'Quote', glyph: '"', hint: 'Pull quote', kw: 'quote citation >' },
  { key: 'callout', label: 'Callout', glyph: 'i', hint: 'Highlighted note', kw: 'callout note info tip warning' },
  { key: 'code', label: 'Code', glyph: '</>', hint: 'Monospaced snippet', kw: 'code snippet pre ```' },
  { key: 'divider', label: 'Divider', glyph: '--', hint: 'Horizontal rule', kw: 'divider line rule hr ---' },
  { key: 'table', label: 'Table', glyph: 'Tb', hint: 'A simple table of text', kw: 'table grid rows columns' },
  { key: 'image', label: 'Image', glyph: 'Img', hint: 'Upload an image', kw: 'image picture photo upload', server: true },
  { key: 'file', label: 'File', glyph: 'File', hint: 'Upload and attach a file', kw: 'file attachment upload document pdf', server: true },
  { key: 'subpage', label: 'Sub-page', glyph: 'Pg', hint: 'Nested page in this notebook', kw: 'page subpage child new', nbOnly: true },
  { key: 'pagelink', label: 'Link to page', glyph: '->', hint: 'Reference another page', kw: 'link page mention reference' },
  { key: 'db', label: 'Linked database', glyph: 'Db', hint: 'Live view of a database', kw: 'database table linked view embed' },
  { key: 'sheet', label: 'Workbook range', glyph: 'fx', hint: 'Live cells from a workbook', kw: 'sheet workbook range spreadsheet excel embed' },
  { key: 'toc', label: 'Table of contents', glyph: 'TOC', hint: 'Headings on this page', kw: 'toc contents outline headings' }
];
var BLOCK_LABEL = {}; BLOCK_TYPES.forEach(function (b) { BLOCK_LABEL[b.key] = b.label; });
var TEXT_BLOCKS = { p: 1, h1: 1, h2: 1, h3: 1, ul: 1, ol: 1, todo: 1, toggle: 1, quote: 1, callout: 1, code: 1 };
var TURN_INTO = ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'toggle', 'quote', 'callout', 'code'];

// Emoji offered for page, module and callout icons (code points, so the source stays ASCII).
var ICON_CHOICES = [[0x1F4C4, 'Page'], [0x1F4DD, 'Memo'], [0x1F4CA, 'Chart'], [0x1F4C8, 'Trend'], [0x1F4C5, 'Calendar'], [0x1F4CC, 'Pin'], [0x1F4A1, 'Idea'], [0x2705, 'Done'], [0x26A0, 'Warning'], [0x2B50, 'Star'], [0x1F525, 'Hot'], [0x1F680, 'Launch'], [0x1F3AF, 'Target'], [0x1F4BC, 'Work'], [0x1F4B0, 'Money'], [0x1F9FE, 'Receipt'], [0x1F50D, 'Search'], [0x1F512, 'Locked'], [0x1F6E1, 'Shield'], [0x1F4E6, 'Package'], [0x1F3E0, 'Home'], [0x1F465, 'People'], [0x1F4DA, 'Books'], [0x2699, 'Settings']];
function iconMenuItems(cur, set) {
  var items = ICON_CHOICES.map(function (c) { var ch = String.fromCodePoint(c[0]); return { label: ch + '  ' + c[1], checked: cur === ch, run: function () { set(ch); } }; });
  if (cur) items.unshift({ label: 'Remove icon', run: function () { set(null); } }, 'divider');
  return items;
}
function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3); }
function nowIso() { return new Date().toISOString(); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lc(s) { return String(s == null ? '' : s).toLowerCase(); }
function byId(list, id) { for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i]; return null; }
function idxById(list, id) { for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return i; return -1; }
function uniqueName(name, taken) { var t = {}; taken.forEach(function (x) { t[lc(x)] = 1; }); if (!t[lc(name)]) return name; for (var i = 2; ; i++) if (!t[lc(name + ' ' + i)]) return name + ' ' + i; }
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

var SYD_PARTS_FMT = null;
function sydParts(iso) {
  var d = iso ? new Date(iso) : new Date();
  try {
    if (!SYD_PARTS_FMT) SYD_PARTS_FMT = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
    var o = {}; SYD_PARTS_FMT.formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    var tz = o.timeZoneName || ''; tz = /\+11/.test(tz) || /AEDT/.test(tz) ? 'AEDT' : 'AEST';
    return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, mi: +o.minute, tz: tz };
  } catch (e) { return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), tz: 'AEST' }; }
}
function fmtDay(iso) { if (!iso) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) { var a = iso.split('-'); return a[2] + '/' + a[1] + '/' + a[0]; } var p = sydParts(iso); return FE.pad2(p.d) + '/' + FE.pad2(p.m) + '/' + p.y; }
function fmtDayTime(iso) { if (!iso) return ''; var p = sydParts(iso); var h = p.h % 12 || 12; return FE.pad2(p.d) + '/' + FE.pad2(p.m) + '/' + p.y + ' ' + h + ':' + FE.pad2(p.mi) + ' ' + (p.h < 12 ? 'am' : 'pm') + ' ' + p.tz; }
function todayIso() { var p = sydParts(); return p.y + '-' + FE.pad2(p.m) + '-' + FE.pad2(p.d); }
function addDaysIso(iso, n) { return FE.serialToIso(FE.isoToSerial(iso) + n); }
// A date cell holds "YYYY-MM-DD" or, for a range, { start, end }.
function dateStart(v) { return v && typeof v === 'object' ? v.start || null : v || null; }
function dateEnd(v) { return v && typeof v === 'object' ? v.end || null : null; }
function mkDate(start, end) { if (!start) return null; return end && end > start ? { start: start, end: end } : start; }
function relTime(iso) {
  if (!iso) return '';
  var s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 172800) return 'yesterday';
  if (s < 86400 * 7) return Math.round(s / 86400) + ' days ago';
  return fmtDay(iso);
}
function prettyDate(iso) {
  if (!iso) return '';
  var t = todayIso();
  if (iso === t) return 'Today';
  if (iso === addDaysIso(t, 1)) return 'Tomorrow';
  if (iso === addDaysIso(t, -1)) return 'Yesterday';
  var p = iso.split('-'); var mo = FE.MON[+p[1] - 1];
  return (+p[2]) + ' ' + mo + ' ' + p[0];
}

/* CSV (RFC 4180) */
function csvParse(text) {
  text = String(text || '').replace(/^\uFEFF/, '');
  var rows = [], row = [], f = '', i = 0, q = false, n = text.length;
  while (i < n) {
    var ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i += 2; continue; } q = false; i++; continue; }
      f += ch; i++; continue;
    }
    if (ch === '"' && f === '') { q = true; i++; continue; }
    if (ch === ',') { row.push(f); f = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; if (ch === '\r' && text[i + 1] === '\n') i++; i++; continue; }
    f += ch; i++;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
}
function csvField(v) { var s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function csvStringify(rows) { return rows.map(function (r) { return r.map(csvField).join(','); }).join('\r\n'); }

/* inline markup -> segments */
function inlineSegments(text) {
  var out = [], re = /(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(`([^`]+)`)|(\[\[([^\]]+)\]\])|(https?:\/\/[^\s)]+)|(\*([^*\s][^*]*)\*)/g, last = 0, m;
  text = String(text || '');
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), cls: '' });
    if (m[1]) out.push({ text: m[2], cls: 'fx-b' });
    else if (m[3]) out.push({ text: m[4], cls: 'fx-s' });
    else if (m[5]) out.push({ text: m[6], cls: 'fx-code' });
    else if (m[7]) out.push({ text: m[8], link: m[8] });
    else if (m[9]) out.push({ text: m[9], url: m[9] });
    else if (m[10]) out.push({ text: m[11], cls: 'fx-i' });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last), cls: '' });
  return out;
}
function plainText(text) { return inlineSegments(text).map(function (s) { return s.text; }).join(''); }

/* ================= module factories ================= */
function mkModule(type, title, color) {
  var t = nowIso();
  return { id: uid(), type: type, title: title || 'Untitled', color: color || TILES[Math.floor(Math.random() * TILES.length)], favorite: false, archivedAt: null, createdAt: t, updatedAt: t };
}
// Fills in anything a module document from the server is missing, so a hand-made or partly converted
// document cannot break rendering. Generated ids derive from the module id, so every client fills
// the same gaps the same way.
function normModule(m) {
  if (!m || typeof m !== 'object') return m;
  function arr(o, k) { if (!Array.isArray(o[k])) o[k] = []; return o[k]; }
  function obj(o, k) { if (!o[k] || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {}; return o[k]; }
  if (typeof m.title !== 'string') m.title = String(m.title || '');
  if (!m.color) m.color = 'slate';
  if (!m.createdAt) m.createdAt = m.updatedAt || nowIso();
  if (!m.updatedAt) m.updatedAt = m.createdAt;
  if (m.type === 'database') {
    var props = arr(m, 'props'), rows = arr(m, 'rows'), views = arr(m, 'views');
    props.forEach(function (p) { obj(p, 'config'); });
    if (!props.some(function (p) { return p.type === 'title'; })) props.unshift({ id: m.id + '-title', type: 'title', name: 'Name', config: {} });
    rows.forEach(function (r) { obj(r, 'cells'); arr(r, 'body'); if (!r.createdAt) r.createdAt = m.createdAt; if (!r.updatedAt) r.updatedAt = r.createdAt; });
    if (!views.length) views.push({ id: m.id + '-table', type: 'table', name: 'Table' });
    views.forEach(function (v) { arr(v, 'filters'); arr(v, 'sorts'); arr(v, 'hidden'); obj(v, 'calcs'); if (!v.filterMode) v.filterMode = 'and'; if (v.groupBy === undefined) v.groupBy = null; if (v.dateProp === undefined) v.dateProp = null; });
    if (!byId(views, m.activeViewId)) m.activeViewId = views[0].id;
  } else if (m.type === 'sheet') {
    var sheets = arr(m, 'sheets');
    if (!sheets.length) sheets.push({ id: m.id + '-s1', name: 'Sheet1' });
    sheets.forEach(function (sh) { obj(sh, 'cells'); obj(sh, 'fmt'); obj(sh, 'colW'); if (!(sh.rowsN > 0)) sh.rowsN = 60; if (!(sh.colsN > 0)) sh.colsN = 14; if (!sh.name) sh.name = 'Sheet'; });
    if (!byId(sheets, m.activeSheetId)) m.activeSheetId = sheets[0].id;
  } else if (m.type === 'notebook') {
    var pages = arr(m, 'pages');
    if (m.style !== 'table') m.style = 'text';
    pages.forEach(function (pg) {
      if (typeof pg.title !== 'string') pg.title = '';
      if (pg.parentId === undefined) pg.parentId = null;
      if (!pg.createdAt) pg.createdAt = m.createdAt; if (!pg.updatedAt) pg.updatedAt = pg.createdAt;
      if (pg.table && (!Array.isArray(pg.table.cols) || !Array.isArray(pg.table.rows))) pg.table = null;
      if (!pg.table) { var bl = arr(pg, 'blocks'); if (!bl.length) bl.push({ id: pg.id + '-b0', type: 'p', text: '' }); }
      else if (!Array.isArray(pg.blocks)) pg.blocks = [];
    });
  }
  return m;
}
function mkOpt(name, color) { return { id: uid(), name: name, color: color || OPT_COLORS[Math.floor(Math.random() * OPT_COLORS.length)] }; }
function mkProp(type, name, config) { return { id: uid(), type: type, name: name, config: config || {} }; }
function mkView(type, name, extra) { return Object.assign({ id: uid(), type: type, name: name || VIEW_LABEL[type], filters: [], filterMode: 'and', sorts: [], groupBy: null, hideEmptyGroups: false, hidden: [], calcs: {}, dateProp: null }, extra || {}); }
function mkRow(cells, body) { var t = nowIso(); return { id: uid(), cells: cells || {}, body: body || [], createdAt: t, updatedAt: t }; }
function mkBlock(type, text, extra) { return Object.assign({ id: uid(), type: type || 'p', text: text || '' }, extra || {}); }
function mkPage(title, parentId, blocks) { var t = nowIso(); return { id: uid(), parentId: parentId || null, title: title || '', blocks: blocks || [mkBlock('p', '')], table: null, favorite: false, archivedAt: null, createdAt: t, updatedAt: t }; }
function mkTable(cols, rows) {
  var cs = cols.map(function (c) { return { id: uid(), name: c }; });
  var rs = rows.map(function (r) { var cells = {}; cs.forEach(function (c, i) { cells[c.id] = r[i] == null ? '' : String(r[i]); }); return { id: uid(), cells: cells }; });
  return { cols: cs, rows: rs };
}
function mkSheet(name, rowsN, colsN) { return { id: uid(), name: name, cells: {}, fmt: {}, rowsN: rowsN || 60, colsN: colsN || 14, colW: {} }; }

function newDatabase(title, templateKey) {
  var m = mkModule('database', title);
  m.description = '';
  var title_ = mkProp('title', 'Name');
  m.props = [title_]; m.rows = []; m.views = [mkView('table', 'Table')];
  if (templateKey === 'tasks') {
    var st = mkProp('status', 'Status', { options: [mkOpt('Not started', 'gray'), mkOpt('In progress', 'blue'), mkOpt('Done', 'green')] });
    var pr = mkProp('select', 'Priority', { options: [mkOpt('High', 'red'), mkOpt('Medium', 'yellow'), mkOpt('Low', 'gray')] });
    var who = mkProp('text', 'Assignee'), due = mkProp('date', 'Due'), est = mkProp('number', 'Estimate (h)', { format: 'number' });
    var done = mkProp('checkbox', 'Blocked');
    m.props = [title_, st, pr, who, due, est, done];
    m.views = [mkView('table', 'All tasks'), mkView('board', 'By status', { groupBy: st.id }), mkView('calendar', 'Calendar', { dateProp: due.id })];
    m.description = 'Track work by status, priority and due date.';
  } else if (templateKey === 'contacts') {
    var co = mkProp('text', 'Company'), role = mkProp('text', 'Role'), em = mkProp('email', 'Email'), ph = mkProp('phone', 'Phone');
    var tg = mkProp('multi_select', 'Tags', { options: [mkOpt('Client', 'blue'), mkOpt('Vendor', 'orange'), mkOpt('Partner', 'green')] });
    var lc_ = mkProp('date', 'Last contacted'), site = mkProp('url', 'Website');
    m.props = [title_, co, role, em, ph, tg, lc_, site];
    m.views = [mkView('table', 'All contacts'), mkView('gallery', 'Cards')];
    m.description = 'People and organisations you work with.';
  }
  m.activeViewId = m.views[0].id;
  return m;
}
function newWorkbook(title, templateKey) {
  var m = mkModule('sheet', title);
  var s = mkSheet('Sheet1');
  m.sheets = [s]; m.activeSheetId = s.id;
  if (templateKey === 'budget') {
    var inc = mkSheet('Income'), exp = mkSheet('Expenses'), sum = mkSheet('Summary');
    fillSheet(inc, [['Source', 'Amount'], ['Salary', ''], ['Other income', ''], ['Total', '=SUM(B2:B3)']]);
    fillSheet(exp, [['Category', 'Budget', 'Actual', 'Difference'], ['Housing', '', '', '=B2-C2'], ['Groceries', '', '', '=B3-C3'], ['Transport', '', '', '=B4-C4'], ['Utilities', '', '', '=B5-C5'], ['Savings', '', '', '=B6-C6'], ['Total', '=SUM(B2:B6)', '=SUM(C2:C6)', '=SUM(D2:D6)']]);
    fillSheet(sum, [['Item', 'Amount'], ['Income', '=Income!B4'], ['Planned spend', '=Expenses!B7'], ['Actual spend', '=Expenses!C7'], ['Left over', '=B2-B4'], ['Savings rate', '=IFERROR(B5/B2,0)']]);
    fmtRange(inc, 1, 1, 3, 1, { f: 'currency' }); fmtRange(exp, 1, 1, 6, 3, { f: 'currency' }); fmtRange(sum, 1, 1, 4, 1, { f: 'currency' }); fmtRange(sum, 5, 1, 5, 1, { f: 'percent' });
    [inc, exp, sum].forEach(function (sh) { fmtRange(sh, 0, 0, 0, 5, { b: true }); });
    fmtRange(inc, 3, 0, 3, 1, { b: true }); fmtRange(exp, 6, 0, 6, 3, { b: true }); fmtRange(sum, 4, 0, 4, 1, { b: true });
    exp.colW = { 0: 150 }; inc.colW = { 0: 150 }; sum.colW = { 0: 150 };
    m.sheets = [sum, inc, exp]; m.activeSheetId = sum.id;
  }
  return m;
}
function fillSheet(s, grid) { grid.forEach(function (row, r) { row.forEach(function (v, c) { if (v !== '' && v != null) s.cells[r + ',' + c] = String(v); }); }); }
function fmtRange(s, r1, c1, r2, c2, f) { for (var r = r1; r <= r2; r++) for (var c = c1; c <= c2; c++) { var k = r + ',' + c; s.fmt[k] = Object.assign({}, s.fmt[k] || {}, f); } }
function newNotebook(title, style) {
  var m = mkModule('notebook', title);
  m.style = style || 'text';
  if (m.style === 'table') {
    var p = mkPage('Untitled table'); p.blocks = []; p.table = mkTable(['Name', 'Notes', 'Owner'], [['', '', ''], ['', '', ''], ['', '', '']]);
    m.pages = [p];
  } else {
    m.pages = [mkPage('Untitled', null, [mkBlock('p', '')])];
  }
  return m;
}

var TEMPLATES = [
  { type: 'database', key: 'blank', name: 'Blank database', desc: 'A title column and a table view. Add properties as you go.' },
  { type: 'database', key: 'tasks', name: 'Task tracker', desc: 'Status, priority, assignee, due dates. Board and calendar views.' },
  { type: 'database', key: 'contacts', name: 'Contacts', desc: 'Company, role, email, phone and tags, with a card gallery.' },
  { type: 'sheet', key: 'blank', name: 'Blank workbook', desc: 'One empty worksheet with formulas ready to go.' },
  { type: 'sheet', key: 'budget', name: 'Monthly budget', desc: 'Income, expenses and a summary sheet linked by cross-sheet formulas.' },
  { type: 'notebook', key: 'text', name: 'Text notebook', desc: 'Nested pages with a block editor, slash commands and backlinks.' },
  { type: 'notebook', key: 'table', name: 'Table notebook', desc: 'Pages that are full-page tables. Convert any of them to a database.' }
];
function createFromTemplate(type, key, title) {
  if (type === 'database') return newDatabase(title || (key === 'tasks' ? 'Tasks' : key === 'contacts' ? 'Contacts' : 'Untitled database'), key);
  if (type === 'sheet') return newWorkbook(title || (key === 'budget' ? 'Monthly budget' : 'Untitled workbook'), key);
  return newNotebook(title || (key === 'table' ? 'Untitled table notebook' : 'Untitled notebook'), key === 'table' ? 'table' : 'text');
}

/* ================= demo workspace (content from the Truss docs) ================= */
function seedWorkspace() {
  var ws = { version: 1, modules: [], recent: [] };
  function daysFrom(n) { return addDaysIso(todayIso(), n); }

  // Projects
  var projects = newDatabase('Projects', 'blank');
  projects.color = 'violet';
  projects.description = 'Streams of work on Truss.';
  var pTitle = projects.props[0];
  var pStatus = mkProp('status', 'Status', { options: [mkOpt('Planned', 'gray'), mkOpt('Active', 'blue'), mkOpt('Shipped', 'green')] });
  var pTarget = mkProp('date', 'Target');
  projects.props.push(pStatus, pTarget);

  // Tasks
  var tasks = newDatabase('Tasks', 'tasks');
  tasks.color = 'teal';
  tasks.description = 'Open follow-ups from the gauntlet punchlist and the hosted-module plan.';
  var tp = tasks.props, tTitle = tp[0], tStatus = tp[1], tPri = tp[2], tWho = tp[3], tDue = tp[4], tEst = tp[5], tBlocked = tp[6];
  var tIsDone = mkProp('formula', 'Is done', { expr: 'prop("Status") = "Done"', format: 'auto' });
  var tDays = mkProp('formula', 'Days left', { expr: 'IF(prop("Due") = "", "", IF(prop("Status") = "Done", "", DAYS(prop("Due"), TODAY())))', format: 'auto' });
  var tProj = mkProp('relation', 'Project', { targetId: projects.id, reversePropId: null });
  var pTasks = mkProp('relation', 'Tasks', { targetId: tasks.id, reversePropId: tProj.id });
  tProj.config.reversePropId = pTasks.id;
  var pProgress = mkProp('rollup', 'Progress', { relationPropId: pTasks.id, targetPropId: tIsDone.id, fn: 'percent_checked' });
  var pHours = mkProp('rollup', 'Hours', { relationPropId: pTasks.id, targetPropId: tEst.id, fn: 'sum' });
  var tCreated = mkProp('created_time', 'Created');
  tasks.props = [tTitle, tStatus, tPri, tProj, tDue, tDays, tEst, tWho, tBlocked, tIsDone, tCreated];
  projects.props.push(pTasks, pProgress, pHours);
  tasks.views[0].hidden = [tIsDone.id, tCreated.id, tBlocked.id];
  tasks.views[1].hidden = [tIsDone.id, tCreated.id, tEst.id, tWho.id, tBlocked.id, tDays.id];
  tasks.views[0].calcs = {}; tasks.views[0].calcs[tEst.id] = 'sum'; tasks.views[0].calcs[tTitle.id] = 'count_all';
  tasks.views.push(mkView('list', 'Open', { filters: [{ id: uid(), propId: tStatus.id, op: 'is_not', value: optByName(tStatus, 'Done').id }], sorts: [{ id: uid(), propId: tDue.id, dir: 'asc' }], hidden: [tIsDone.id, tCreated.id, tDays.id, tEst.id, tWho.id] }));

  var P = {};
  [['Truss v1 gauntlet', 'Shipped', -9], ['Hosted Truss', 'Active', 14], ['Lookup and List columns', 'Active', 21], ['Live sync', 'Planned', 45]].forEach(function (x) {
    var c = {}; c[pTitle.id] = x[0]; c[pStatus.id] = optByName(pStatus, x[1]).id; c[pTarget.id] = daysFrom(x[2]); c[pTasks.id] = [];
    var r = mkRow(c); projects.rows.push(r); P[x[0]] = r;
  });
  var T = [
    ['Serve frontend from any path prefix', 'Done', 'High', 'Hosted Truss', -3, 3, 'Ded'],
    ['Hosted mode drops local-shell surfaces', 'Done', 'High', 'Hosted Truss', -2, 2, 'Ded'],
    ['csrf_protect reads header token for JSON bodies', 'In progress', 'High', 'Hosted Truss', 2, 2, 'Ded'],
    ['Truss proxy module (streaming, CSRF meta)', 'In progress', 'High', 'Hosted Truss', 4, 4, 'Ded'],
    ['Vendor script excludes data/ and scripts', 'Not started', 'Medium', 'Hosted Truss', 6, 2, 'Ded'],
    ['Deploy: Node stage, sidecar loop, upload cap', 'Not started', 'Medium', 'Hosted Truss', 9, 3, 'Ded'],
    ['Lookup column: config, #N/A, reset on delete', 'Not started', 'Medium', 'Lookup and List columns', 12, 5, ''],
    ['List column: sync rows from source database', 'Not started', 'Low', 'Lookup and List columns', 18, 8, ''],
    ['Supply custom formula list (custom.js)', 'Not started', 'Low', 'Truss v1 gauntlet', 5, 1, 'Ded'],
    ['Built-in viewers for images and documents', 'Not started', 'Low', 'Truss v1 gauntlet', 30, 6, ''],
    ['Emit modules:changed after API-created notebook', 'Done', 'Medium', 'Truss v1 gauntlet', -12, 1, ''],
    ['Server-Sent Events through the proxy', 'Not started', 'Medium', 'Live sync', 40, 8, '']
  ];
  T.forEach(function (x, i) {
    var c = {}; c[tTitle.id] = x[0]; c[tStatus.id] = optByName(tStatus, x[1]).id; c[tPri.id] = optByName(tPri, x[2]).id;
    c[tDue.id] = daysFrom(x[4]); c[tEst.id] = x[5]; c[tWho.id] = x[6]; c[tBlocked.id] = i === 7; c[tProj.id] = [P[x[3]].id];
    var r = mkRow(c);
    if (i === 3) r.body = [mkBlock('p', 'One catch-all route gated by require_module("truss"). Responses **stream** so SSE can flush later; HTML is the one buffered case so the CSRF and hosted meta tags can be injected.'), mkBlock('todo', 'Strip /m/truss prefix, keep query', { checked: true }), mkBlock('todo', '307 /m/truss to /m/truss/'), mkBlock('todo', 'Byte-identical JSON responses'), mkBlock('p', 'Background: [[Hosted module design]]')];
    tasks.rows.push(r); P[x[3]].cells[pTasks.id].push(r.id);
  });

  // Workbook: gauntlet stats (from the punchlist)
  var wb = newWorkbook('Gauntlet stats', 'blank');
  wb.color = 'amber';
  var s1 = wb.sheets[0]; s1.name = 'Pieces';
  fillSheet(s1, [
    ['Piece', 'Wave', 'Attempts', 'Node tests', 'Playwright tests', 'Status'],
    ['server-core', 1, 1, 28, 0, 'passed'], ['formula-engine', 1, 1, 69, 0, 'passed'], ['ui-shell', 2, 2, 0, 19, 'passed'],
    ['scripts-server', 2, 1, 18, 2, 'passed'], ['database', 3, 1, 16, 14, 'passed'], ['sheets', 3, 1, 22, 24, 'passed'],
    ['notebooks', 3, 2, 7, 17, 'passed'], ['database-relations-io', 4, 1, 15, 30, 'passed'], ['scripts-ui', 4, 1, 0, 7, 'passed'],
    ['Total', '', '=SUM(C2:C10)', '=SUM(D2:D10)', '=SUM(E2:E10)', '=COUNTIF(F2:F10,"passed")&" of "&COUNTA(A2:A10)']
  ]);
  fmtRange(s1, 0, 0, 0, 5, { b: true }); fmtRange(s1, 10, 0, 10, 5, { b: true });
  s1.colW = { 0: 170, 5: 120 };
  var s2 = mkSheet('Summary');
  fillSheet(s2, [
    ['Metric', 'Value'],
    ['Pieces', '=COUNTA(Pieces!A2:A10)'],
    ['First-attempt pass rate', '=COUNTIF(Pieces!C2:C10,1)/B2'],
    ['Total tests', '=Pieces!D11+Pieces!E11'],
    ['Average attempts', '=AVERAGE(Pieces!C2:C10)'],
    ['Most Playwright tests', '=INDEX(Pieces!A2:A10,MATCH(MAX(Pieces!E2:E10),Pieces!E2:E10,0))'],
    ['Spawn ceiling', 118],
    ['Worst-case spawns', 59],
    ['Headroom', '=B7-B8'],
    ['Report date', '=TODAY()']
  ]);
  fmtRange(s2, 0, 0, 0, 1, { b: true }); fmtRange(s2, 2, 1, 2, 1, { f: 'percent' }); fmtRange(s2, 4, 1, 4, 1, { f: 'number', dp: 2 });
  s2.colW = { 0: 200, 1: 170 };
  wb.sheets = [s1, s2]; wb.activeSheetId = s1.id;

  var budget = newWorkbook('Monthly budget', 'budget');
  budget.color = 'green';

  // Notebook: Truss docs
  var nb = newNotebook('Truss docs', 'text');
  nb.color = 'clay';
  var pSpec = mkPage('Spec overview', null, [
    mkBlock('callout', 'Truss is a local, single-user, Notion-like app: Databases, Excel-style Workbooks and Notebooks. This page is a summary of the frozen contract.'),
    mkBlock('h2', 'Stack and constraints'),
    mkBlock('ul', 'Node.js 22 with **zero runtime npm dependencies** (node:http, node:sqlite, node:fs ...)'),
    mkBlock('ul', 'Frontend: vanilla ES modules, no build step, no CDN, fully offline'),
    mkBlock('ul', 'SQLite via node:sqlite, WAL mode, foreign keys on'),
    mkBlock('ul', 'Locale: DD/MM/YYYY, AEST/AEDT times, AUD currency, Australian English'),
    mkBlock('h2', 'Content types'),
    mkBlock('ol', '**Database**: properties, rows, table/board/list/gallery/calendar views, row peek'),
    mkBlock('ol', '**Workbook**: multiple worksheets, formula bar, cross-sheet and cross-workbook references'),
    mkBlock('ol', '**Notebook**: text or table style, nested pages, block editor, attachments'),
    mkBlock('h2', 'Open work'),
    mkBlock('db', '', { ref: tasks.id }),
    mkBlock('h2', 'Gauntlet results'),
    mkBlock('sheet', '', { ref: wb.id, sheetId: s1.id, range: 'A1:F11' }),
    mkBlock('p', 'Formula engine notes live in [[Formula engine]]. Hosting is covered in [[Hosted module design]].')
  ]);
  var pFormula = mkPage('Formula engine', pSpec.id, [
    mkBlock('p', 'Pure ES module, no DOM, importable from Node and the browser. Values are number, string, boolean, empty or an error such as `#DIV/0!` or `#CYCLE!`.'),
    mkBlock('h3', 'Syntax'),
    mkBlock('code', '=SUM(A1:A9) * 1.1\n=Sheet2!B3 & " units"\n=\'My Sheet\'!A1:B2\n=[Monthly budget]Summary!B5'),
    mkBlock('toggle', 'Dates', { open: false, body: 'Excel 1900 serial system, including the 1900 leap-year quirk. TODAY and NOW are volatile and use Australia/Sydney.' }),
    mkBlock('todo', 'Recalculation is incremental through a dependency graph', { checked: true }),
    mkBlock('todo', 'Cycles yield #CYCLE! without hanging', { checked: true }),
    mkBlock('todo', 'Custom formula list supplied by the user')
  ]);
  var pHosted = mkPage('Hosted module design', null, [
    mkBlock('p', 'Make Truss reachable online for several people, behind the web_server login (username + password + TOTP + per-user module grants), without changing a pixel of the interface.'),
    mkBlock('toc', ''),
    mkBlock('h2', 'Decisions'),
    mkBlock('ul', 'Runtime: Node sidecar in the host container, behind a FastAPI proxy module'),
    mkBlock('ul', 'Workspace: one shared truss.db everyone edits (last write wins)'),
    mkBlock('ul', 'Scripts: not shipped in the hosted build; local Windows Truss keeps them'),
    mkBlock('h2', 'CSRF'),
    mkBlock('p', 'Form bodies are validated exactly as today; any other body reads the token from an `X-CSRF-Token` header and compares it to the cookie with `hmac.compare_digest`.'),
    mkBlock('h2', 'Accepted risks'),
    mkBlock('quote', 'Last write wins on the shared workspace. Truss has no locking and no live sync today, and this design adds none.'),
    mkBlock('h2', 'Deferred'),
    mkBlock('p', 'Local Truss against hosted data, and live sync. See the tasks in [[Spec overview]].')
  ]);
  var pDeferred = mkPage('Resource sizing', pHosted.id, [
    mkBlock('p', 'shared-cpu-1x / 1GB / 512MB swap, unchanged. The host baselines at about 81MB and the sidecar adds roughly 40-60MB idle.'),
    mkBlock('callout', 'Signal for upgrading: health-check flapping in fly logs, or Truss feeling slow while a statement generates.')
  ]);
  nb.pages = [pSpec, pFormula, pHosted, pDeferred];

  // Table notebook
  var tn = newNotebook('Test log', 'table');
  tn.color = 'blue';
  var tpage = tn.pages[0]; tpage.title = 'Open follow-ups';
  tpage.table = mkTable(['Item', 'Area', 'Notes'], [
    ['Backspace-merge of split bold leaves adjacent tags', 'notebooks', 'Minor'],
    ['Slash filter "to" matches Divider/Image', 'notebooks', 'Minor'],
    ['Import preview selects use default arrow', 'database-relations-io', 'Matches filter menus'],
    ['Number input arrows are browser default', 'scripts-ui', 'Minor'],
    ['Formula TODAY/NOW timezone', 'formula-engine', 'Accepted by the user']
  ]);

  ws.modules = [nb, tasks, projects, wb, budget, tn];
  tasks.favorite = true; nb.favorite = true;
  ws.modules.forEach(function (m, i) { m.sortOrder = i; });
  return ws;
}
function optByName(prop, name) { var o = (prop.config.options || []).filter(function (x) { return lc(x.name) === lc(name); })[0]; return o || null; }
