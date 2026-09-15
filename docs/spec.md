# Truss - Spec and Integration Contract

Truss is a local, single-user, Notion-like app: Databases, Excel-style Workbooks, and Notebooks, plus a local script runner. This document is the frozen contract every gauntlet piece builds against. If a piece needs to deviate from it, it reports that as an anomaly instead of silently changing it.

## 1. Stack and constraints

- Runtime: Node.js 22 (installed: v22.21). **Zero runtime npm dependencies.** Only Node built-ins (`node:http`, `node:sqlite`, `node:fs`, `node:child_process`, `node:crypto`, ...).
- Dev-only dependency: `@playwright/test` (already installed at repo root, Chromium downloaded). No other packages may be added by any piece.
- Frontend: vanilla ES modules served as static files, no build step, no frameworks, no CDN or network fetches (fully offline).
- Storage: SQLite via `node:sqlite` (`DatabaseSync`), WAL mode, `PRAGMA foreign_keys = ON`.
- Platform: Windows 10. Launch opens the app in an Edge (fallback Chrome, fallback default browser) `--app=` window.
- Locale (user-facing): dates `DD/MM/YYYY`, times with AEST/AEDT, currency AUD (`$`), Australian English spelling. Never the em dash character in UI text; use `-`.
- Performance targets are stated per piece; general rule: virtualise any list/grid that can exceed ~200 visible items; never re-render a whole grid on a single cell edit.

## 2. Repository layout and ownership

```
truss.cmd                          launcher                          [server-core]
server/main.js                     startServer(), CLI entry           [server-core]
server/http.js                     router + helpers                   [server-core]
server/db.js                       sqlite open + migration runner     [server-core]
server/attachments.js              ctx.attachments implementation     [server-core]
server/routes/modules.js           module CRUD/archive + templates    [server-core]
server/routes/attachments.js       attachment endpoints               [server-core]
server/routes/database.js          database endpoints + templates     [database]  (then [database-relations-io] may modify)
server/routes/sheets.js            workbook endpoints + templates     [sheets]
server/routes/notebooks.js         notebook endpoints + templates     [notebooks]
server/routes/scripts.js           script registry + runs             [scripts-server]
server/runner.js                   process spawning / run queue       [scripts-server]
server/migrations/001-core.sql                                        [server-core]
server/migrations/010-database.sql                                    [database]
server/migrations/020-sheets.sql                                      [sheets]
server/migrations/030-notebooks.sql                                   [notebooks]
server/migrations/040-relations.sql  (only if needed)                 [database-relations-io]
server/migrations/050-scripts.sql                                     [scripts-server]
web/index.html                     (baseline stub exists)             [ui-shell]
web/app.js                         shell bootstrap, router, sidebar   [ui-shell]
web/lib/api.js, ui.js, icons.js, registry.js, sanitize.js             [ui-shell]
web/styles/*.css                                                      [ui-shell]
web/lib/formula/**                 formula engine                     [formula-engine]
web/lib/csv.js                     RFC 4180 CSV parse/stringify       [database-relations-io]
web/modules/database/**                                               [database]  (then [database-relations-io] may modify)
web/modules/sheet/**                                                  [sheets]
web/modules/notebook/**                                               [notebooks]
web/modules/scripts/**                                                [scripts-ui]
tests/<piece-id>/**                                                   [that piece]
```

Baseline-owned (no piece may modify): `package.json`, `package-lock.json`, `playwright.config.js`, `.gitignore`, `docs/spec.md`. Files a piece creates must live inside its owned paths.

## 3. Testing conventions

- Unit/API tests: `node --test "tests/<piece-id>/**/*.test.js"`. All tests: `npm test`.
- API tests start their own server in-process: `const s = await startServer({ port: 0, dataDir: <fresh temp dir> })` then use `s.url` and `s.token`, `await s.close()` at the end.
- E2E: Playwright files named `*.e2e.js` in `tests/<piece-id>/`. Run with `$env:TRUSS_E2E_PORT=<piece port>; npx playwright test tests/<piece-id>`. The config starts `node server/main.js` on that port with a fresh temp data dir.
- Each piece uses ONLY its assigned E2E port so parallel pieces never collide:
  server-core 4811, ui-shell 4812, scripts-server 4813, database 4814, sheets 4815, notebooks 4816, database-relations-io 4817, scripts-ui 4818, judge 4819.
- E2E tests must create their own data (via UI or API) and not depend on test order.
- UI verification includes screenshots: save to `test-results/<piece-id>/` (gitignored) and actually look at them.

## 4. Server contract [server-core]

### 4.1 Process
- `server/main.js` exports `async function startServer({ port = 4717, dataDir, host = '127.0.0.1' })` returning `{ url, port, token, close() }`.
- Run as main (`node server/main.js [--open]`): reads `PORT` (default 4717) and `TRUSS_DATA_DIR` (default `<repo>/data`), prints the URL, `--open` launches the app window.
- `truss.cmd` runs `node "%~dp0server\main.js" --open`.
- Binds **127.0.0.1 only**. Rejects requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (DNS-rebinding guard) with 403.
- A random token (`crypto.randomBytes(24).toString('hex')`) is generated per start. `GET /` serves `web/index.html` with the literal placeholder `%TRUSS_TOKEN%` replaced by the token.
- All `/api/*` routes except `GET /api/health` require header `X-Truss-Token: <token>` or, for GET only, query `?token=<token>` (used by `<img src>`). Missing/wrong: 401.
- Static files: anything under `web/` by path, correct MIME types (html, js, css, svg, png, json, woff2), path traversal impossible (resolve and verify prefix), 404 otherwise. HTML responses carry `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'`.
- `dataDir` layout: `truss.db`, `attachments/<attachmentId>/<filename>`, `runs/<runId>/...`.

### 4.2 Router and route autoloading
- `server/http.js` exports `createRouter()` with `get/post/put/patch/delete(pattern, handler)`; patterns like `/api/modules/:id`.
- Handler signature: `async ({ req, res, params, query, body, ctx }) => result`. `body` is parsed JSON when `Content-Type: application/json` (max 20 MB), otherwise `undefined` (handler may stream `req` itself). A returned non-undefined value is sent as JSON 200 (201 is fine for creates if the handler sets `res.statusCode` first). If the handler writes `res` itself it returns `undefined`.
- Errors: `throw httpError(status, code, message)` (exported) produces `{ "error": { "code", "message" } }`. Unexpected errors produce 500 with code `internal` (message logged server-side, not leaked).
- On start, the server imports every `server/routes/*.js` (sorted by filename) and calls its default export `register(router, ctx)`.
- `ctx` = `{ db, dataDir, attachments, registerTemplate(type, key, { name, description, apply(db, moduleId, module) }) }`.
- `server/db.js`: opens `truss.db`, creates `schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT)`, applies every `server/migrations/*.sql` not yet applied, in filename order, each in a transaction.

### 4.3 Core schema (001-core.sql)
```sql
modules(id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('database','sheet','notebook')),
        title TEXT NOT NULL DEFAULT 'Untitled', icon TEXT, sort_order REAL NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}', archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
attachments(id TEXT PRIMARY KEY, module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
            page_id TEXT, filename TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'upload' CHECK(source IN ('upload','script-output')), created_at TEXT NOT NULL)
```
IDs are `crypto.randomUUID()`. Timestamps are ISO 8601 UTC strings. `page_id` means "sub-item id" (a notebook page id or a database row id); it has no FK. Type-specific tables reference `modules(id) ON DELETE CASCADE`.

### 4.4 Core endpoints
| Method | Path | Behaviour |
|---|---|---|
| GET | `/api/health` | `{ ok: true }` (no token) |
| GET | `/api/templates` | `[{ type, key, name, description }]`; every type always has a `blank` template |
| GET | `/api/modules?archived=0\|1` | list (default non-archived), ordered by `sort_order, created_at`; `data` included |
| POST | `/api/modules` | `{ type, template?='blank', title?, icon? }` -> creates, runs template `apply` in the same transaction, returns module |
| GET | `/api/modules/:id` | module or 404 |
| PATCH | `/api/modules/:id` | any of `{ title, icon, sort_order, data }` (data is replaced whole) |
| POST | `/api/modules/:id/archive` / `/restore` | set / clear `archived_at` |
| DELETE | `/api/modules/:id` | hard delete (cascade) and remove its attachment files from disk |
| POST | `/api/attachments?moduleId=&pageId=` | raw request body = file bytes, header `X-Filename` (URI-encoded); streams to disk; max 1 GB; returns attachment |
| GET | `/api/attachments?moduleId=&pageId=` | list |
| GET | `/api/attachments/:id/content` | file bytes with MIME, `Content-Disposition: inline` |
| POST | `/api/attachments/:id/open` | opens with default Windows app (`explorer.exe <path>`, detached) |
| POST | `/api/attachments/:id/reveal` | `explorer.exe /select,<path>` |
| DELETE | `/api/attachments/:id` | row + file |

Filenames are sanitised (strip path separators, reserved Windows characters and names) before being written.

### 4.5 `ctx.attachments` (server-side API for other pieces)
`create({ moduleId, pageId, filename, source, buffer | srcPath })`, `list({ moduleId, pageId })`, `get(id)`, `pathOf(id)`, `remove(id)`, `removeFor({ moduleId, pageId })`. All return/accept the same attachment row shape as the HTTP API.

## 5. Frontend shell contract [ui-shell]

### 5.1 Libraries
- `web/lib/api.js`: `api.get/post/put/patch/del(path, body?)` (JSON, token header from `<meta name="truss-token">`, throws `ApiError { status, code, message }`), `api.upload(path, fileOrBlob, filename)`, `api.url(path)` (appends `token` query for `<img src>`), `api.token`.
- `web/lib/ui.js`: `h(tag, attrs, ...children)` DOM builder; `modal({ title, body, actions }) -> Promise`; `confirmDialog({ title, message, confirmLabel, danger }) -> Promise<boolean>`; `promptDialog({ title, label, value }) -> Promise<string|null>`; `toast(message, { type: 'info'|'success'|'error' })`; `menu(anchorEl, items)` where items are `{ label, icon?, onClick, danger?, disabled? }` or `'divider'`; `loadCss(href)` (idempotent); `debounce(fn, ms)`; `formatDate(iso)` -> `DD/MM/YYYY`; `formatDateTime(iso)` -> `DD/MM/YYYY h:mm am AEST`. Never use `alert/confirm/prompt`.
- `web/lib/icons.js`: `icon(name, { size })` returns an inline SVG element; covers at least: database, sheet, notebook, page, plus, trash, archive, restore, search, more, chevron-right, chevron-down, close, file, image, upload, download, play, settings, sun, moon, filter, sort, drag.
- `web/lib/sanitize.js`: `sanitizeHtml(html)` allowlist (`b, strong, i, em, u, s, code, a[href http/https/mailto only], br, span[data-*]`), everything else stripped to text. All user rich text is sanitised before insertion into the DOM.
- `web/lib/registry.js`: `registerRoute(prefix, { title, mount })` (e.g. `#/scripts`); `registerSidebarItem({ id, label, icon, href })`; `registerPageAction({ id, label, icon, isAvailable(ctx), run(ctx) })` and `getPageActions(ctx)` where `ctx = { module, pageId, attachments }`; event bus `on(event, fn)`, `off(event, fn)`, `emit(event, payload)`. Standard events: `attachments:changed { moduleId, pageId }`, `modules:changed`.

### 5.2 Module loading and mounting
- On boot, `web/app.js` dynamically imports, each wrapped in try/catch so a missing/broken one never breaks the shell: `/modules/database/index.js`, `/modules/sheet/index.js`, `/modules/notebook/index.js`, `/modules/scripts/index.js`.
- Each default-exports an object. If it has `type` it is a content type: `{ type, label, icon, mount(el, mctx) }`. Any export may have `init({ registry, api, ui })`, called once at boot.
- `mount(el, mctx)` with `mctx = { module, route: { moduleId, sub: string[] }, api, ui, registry, navigate(hash) }` returns `{ unmount(), onRoute?(route), onModuleChange?(module) }`. A type whose module file is missing renders a friendly "not available" placeholder.
- Hash routes: `#/` home (recent modules, create buttons), `#/m/<moduleId>[/<sub>...]` (e.g. `#/m/<id>/p/<pageId>`), `#/archive`, plus registry routes.
- Module CSS lives in the module folder and is loaded via `ui.loadCss`.

### 5.3 Shell features
Sidebar (modules grouped by type, icons, active state, inline rename, context menu: rename, change icon (emoji picker), archive, delete with confirm), "New" button opening a template picker (cards from `/api/templates`), header with editable module title + icon and breadcrumb, archive view (restore, delete permanently), quick switcher `Ctrl+K`, light/dark theme toggle persisted in `localStorage`, toasts, collapsible sidebar, keyboard accessible (focus rings, Esc closes modals/menus). Visual direction: calm, Notion-like, generous whitespace, system font stack (`"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`), CSS custom-property design tokens in `web/styles/tokens.css` that module CSS must reuse.

## 6. Formula engine contract [formula-engine]

Pure ES module(s) under `web/lib/formula/`, entry `web/lib/formula/index.js`, no DOM, importable from Node and the browser.

- Values: `number`, `string`, `boolean`, `null` (empty), errors as `{ error: '#DIV/0!' | '#REF!' | '#NAME?' | '#VALUE!' | '#N/A' | '#NUM!' | '#CYCLE!' }`. `isError(v)`.
- Coordinates are 0-based `row`, `col`. Helpers: `toA1(row, col)`, `fromA1('B3') -> { row, col }`, `colToLetters`, `lettersToCol`.
- Syntax: numbers, strings `"..."`, booleans, `+ - * / ^ & % = <> < <= > >=`, unary +/-, parentheses, function calls, `A1`, `$A$1`, `A1:B9`, `A:A`, `1:1`, `Sheet2!A1`, `'My Sheet'!A1:B2`, external `[Workbook Name]Sheet1!A1`. Raw cell input not starting with `=` is a literal (number/boolean/date-like strings parsed as in Excel: `14/05/2026` -> date serial, DD/MM/YYYY).
- `createWorkbookEngine({ resolveExternal?(workbookName, sheetName, row, col) })` returns an engine with: `addSheet(name)`, `renameSheet(old, new)` (rewrites references in formulas), `removeSheet(name)` (references become `#REF!`), `setCell(sheet, row, col, raw)` -> array of `{ sheet, row, col }` whose values changed, `getValue(sheet, row, col)`, `getRaw(...)`, `getDisplay(sheet, row, col, format?)`, `insertRows/deleteRows/insertCols/deleteCols(sheet, index, count)` (rewrites references like Excel, deleted referenced cells become `#REF!`) -> changed cells, `invalidateExternal(workbookName)`.
- Recalculation is incremental via a dependency graph; cycles yield `#CYCLE!` without hanging. `TODAY/NOW/RAND` are volatile.
- `evaluateExpression(src, { functions?, resolveRef? })` evaluates a standalone formula (used by database formula properties with injected functions like `prop("Name")`).
- `registerFunction(name, impl, { minArgs, maxArgs, description, signature })` and `listFunctions()` (for autocomplete). `web/lib/formula/custom.js` is where the user's future custom formula list goes; it imports `registerFunction` and currently contains one documented example.
- Dates: Excel 1900 serial system (including the 1900 leap-year quirk for compatibility).
- Built-ins (minimum): SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, COUNTBLANK, PRODUCT, MEDIAN, STDEV, ROUND, ROUNDUP, ROUNDDOWN, INT, ABS, SQRT, POWER, MOD, CEILING, FLOOR, IF, IFS, IFERROR, IFNA, AND, OR, NOT, XOR, SWITCH, SUMIF, SUMIFS, COUNTIF, COUNTIFS, AVERAGEIF, AVERAGEIFS, VLOOKUP, HLOOKUP, XLOOKUP, INDEX, MATCH, CHOOSE, CONCAT, CONCATENATE, TEXTJOIN, LEFT, RIGHT, MID, LEN, UPPER, LOWER, PROPER, TRIM, SUBSTITUTE, REPLACE, FIND, SEARCH, TEXT, VALUE, REPT, EXACT, TODAY, NOW, DATE, YEAR, MONTH, DAY, HOUR, MINUTE, WEEKDAY, EDATE, EOMONTH, DATEDIF, NETWORKDAYS, DAYS, ISBLANK, ISNUMBER, ISTEXT, ISERROR, ISNA, ISLOGICAL, NA, PMT, FV, PV, NPV, RAND, RANDBETWEEN.
- Display formats: `general`, `number` (decimals, thousands separator), `currency` (AUD `$`), `percent`, `date` (DD/MM/YYYY), `datetime`, `text`.

## 7. Content types (summary; each piece's full clauses are in its gauntlet prompt)

- **Database** [database]: properties (title, text, number, select, multi_select, status, date, checkbox, url, email, phone, files, created_time, last_edited_time), rows, views (table, board, list, gallery, calendar) each with own sorts/filters/grouping/hidden properties; row peek panel. Templates: blank, task tracker, contacts.
- **Relations, rollups, formula properties, CSV/JSON import/export** [database-relations-io].
- **Workbook** [sheets]: multiple worksheets, virtualised grid, formula bar, cross-sheet and cross-workbook references via the engine. Templates: blank, monthly budget.
- **Notebook** [notebooks]: `module.data.style` is `'text'` or `'table'`; nested pages with archive/restore/delete; text pages use a block editor, table pages use a full-page table editor; both support attachments and render page actions from the registry. Templates: text notebook, table notebook.
- **Scripts** [scripts-server, scripts-ui]: registered local `.bat`/`.cmd`/`.ps1` scripts run against notebook page attachments; outputs attach back to the page.

## 8. Script runner contract [scripts-server]

- Schema: `scripts(id, name, path, kind CHECK IN ('bat','ps1'), config TEXT '{}', timeout_sec INTEGER DEFAULT 1800, created_at, updated_at)`; `script_runs(id, script_id REFERENCES scripts ON DELETE SET NULL, module_id, page_id, status CHECK IN ('queued','running','succeeded','failed','cancelled','timed_out'), exit_code, stdout, stderr, input_attachment_ids TEXT '[]', output_attachment_ids TEXT '[]', created_at, started_at, finished_at)`.
- Registration validates: absolute path, file exists, extension `.bat`/`.cmd`/`.ps1`, and for batch files the path contains none of `" % ^ & | < > !`.
- Endpoints: `GET/POST /api/scripts`, `PATCH/DELETE /api/scripts/:id`, `POST /api/scripts/browse` (opens a native Windows file dialog via PowerShell, returns `{ path | null }`), `POST /api/scripts/:id/run { moduleId, pageId, attachmentIds }`, `GET /api/runs?moduleId=&pageId=`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`.
- Execution: no user-controlled data on the command line. Batch: `cmd.exe /d /s /c "<path>"` with `windowsVerbatimArguments`. PowerShell: `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>` with `shell: false`. cwd = script directory. Inputs via env: `TRUSS_RUN_ID`, `TRUSS_INPUTS_FILE` (JSON array of `{ id, filename, path }`), `TRUSS_INPUT_DIR` (copies of inputs), `TRUSS_OUTPUT_DIR` (empty dir), `TRUSS_CONFIG` (script config JSON). stdout/stderr captured, each capped at 1 MB.
- At most 2 concurrent runs; others queue. Timeout and cancel kill the whole process tree (`taskkill /T /F /PID`). On server start, runs left `queued`/`running` are marked `failed` with stderr note.
- On exit, every file in `TRUSS_OUTPUT_DIR` (recursive, flattened names) becomes an attachment on the same module/page with `source: 'script-output'`; ids recorded on the run.
