// Scripts: manager page (#/scripts), run history with log viewer, and the "Run script" page action for notebook pages.

const CSS = new URL('./scripts.css', import.meta.url).href
const POLL_MS = 800
const HISTORY_PAGE = 50
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])
const STATUS_LABEL = { queued: 'Queued', running: 'Running', succeeded: 'Succeeded', failed: 'Failed', cancelled: 'Cancelled', timed_out: 'Timed out' }
const MAX_TIMEOUT = 7 * 24 * 3600

const enc = encodeURIComponent
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

export function formatDuration(ms) {
  if (!(ms >= 0)) return ''
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`
  const total = Math.round(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  if (h) return `${h} h${m ? ` ${m} min` : ''}`
  return `${m} min${sec ? ` ${sec} s` : ''}`
}

export function formatTimeout(sec) {
  return formatDuration(sec * 1000)
}

/** Parses the config editor text. Returns { value } or { error }. */
export function parseConfig(text) {
  const src = String(text ?? '').trim()
  if (!src) return { value: {} }
  let value
  try {
    value = JSON.parse(src)
  } catch (err) {
    return { error: `Config is not valid JSON: ${err.message}` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Config must be a JSON object, for example {"key": "value"}' }
  return { value }
}

function runDuration(run, now = Date.now()) {
  if (!run.started_at) return null
  const end = run.finished_at ? Date.parse(run.finished_at) : now
  return end - Date.parse(run.started_at)
}

/** One-line stderr excerpt for toasts. */
function snippet(text, max = 140) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('[truss] Output truncated'))
  const s = lines.join(' ').replace(/\s+/g, ' ')
  return s.length > max ? `${s.slice(0, max - 3)}...` : s
}

let deps = null // { registry, api, ui }

function statusBadge(status) {
  const { h } = deps.ui
  return h('span', { class: 'sc-status', dataset: { status } }, h('span', { class: 'sc-status-dot', 'aria-hidden': 'true' }), STATUS_LABEL[status] || status)
}

function kindBadge(kind) {
  return deps.ui.h('span', { class: 'sc-kind', dataset: { kind } }, kind === 'ps1' ? 'PowerShell' : 'Batch')
}

/* ------------------------------------------------------------------ log viewer */

function logViewer(run) {
  const { h } = deps.ui
  let current = run
  let tab = null
  let picked = false // the user chose a tab; stop switching automatically
  const tabs = {}
  const pre = h('pre', { class: 'sc-log-pre', tabindex: '0', 'aria-label': 'Script output' })
  const tabBar = h('div', { class: 'sc-log-tabs', role: 'tablist' })
  for (const key of ['stdout', 'stderr']) {
    tabs[key] = h('button', { type: 'button', role: 'tab', class: 'sc-log-tab', dataset: { tab: key }, onClick: () => { picked = true; select(key) } },
      h('span', {}, key), h('span', { class: 'sc-log-count' }))
    tabBar.append(tabs[key])
  }
  const el = h('div', { class: 'sc-log' }, tabBar, pre)

  function paint() {
    const text = current[tab] || ''
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24
    if (pre.dataset.empty !== String(!text) || pre.textContent !== (text || `No ${tab} output`)) {
      pre.textContent = text || `No ${tab} output`
      pre.dataset.empty = String(!text)
      if (atBottom) pre.scrollTop = pre.scrollHeight
    }
  }
  function select(key) {
    tab = key
    for (const [k, b] of Object.entries(tabs)) {
      b.setAttribute('aria-selected', String(k === key))
      b.classList.toggle('is-active', k === key)
    }
    pre.dataset.tab = key
    paint()
  }
  function update(next) {
    current = next
    for (const key of ['stdout', 'stderr']) {
      const lines = (next[key] || '').split(/\r?\n/).filter(Boolean).length
      tabs[key].querySelector('.sc-log-count').textContent = lines ? String(lines) : ''
    }
    const failed = next.status === 'failed' || next.status === 'timed_out'
    if (!tab || (!picked && failed && next.stderr && tab !== 'stderr')) select((!next.stdout || failed) && next.stderr ? 'stderr' : 'stdout')
    else paint()
  }
  update(run)
  return { el, update, select }
}

function openLogModal(run, pageLabel) {
  const { h, modal, formatDateTime } = deps.ui
  const viewer = logViewer(run)
  const facts = h('div', { class: 'sc-facts' },
    statusBadge(run.status),
    run.exit_code != null ? h('span', { class: 'sc-fact' }, `Exit code ${run.exit_code}`) : null,
    run.started_at ? h('span', { class: 'sc-fact' }, formatDateTime(run.started_at)) : null,
    run.finished_at ? h('span', { class: 'sc-fact' }, formatDuration(runDuration(run))) : null,
    pageLabel ? h('span', { class: 'sc-fact' }, pageLabel) : null)
  return modal({
    title: `Logs: ${run.script_name || 'Deleted script'}`,
    size: 'lg',
    className: 'sc-modal sc-log-modal',
    body: h('div', { class: 'sc-log-body' }, facts, viewer.el),
    actions: [{ label: 'Close', value: null }],
  })
}

/* ------------------------------------------------------------------ run dialog (page action) */

/** Polls a run until it finishes, even after its dialog is closed, then refreshes the page attachments and toasts. */
function watchRun(run, { moduleId, pageId, onUpdate }) {
  const { api, ui, registry } = deps
  let timer = null
  let stopped = false
  const finish = (r) => {
    stopped = true
    registry.emit('attachments:changed', { moduleId, pageId })
    const name = r.script_name ? `"${r.script_name}"` : 'The script'
    if (r.status === 'succeeded') {
      const n = r.output_attachment_ids.length
      ui.toast(`${name} finished: ${n ? `${plural(n, 'output file')} attached` : 'no output files'}`, { type: 'success' })
    } else if (r.status === 'cancelled') {
      ui.toast(`${name} was cancelled`, { type: 'info' })
    } else {
      const what = r.status === 'timed_out' ? 'timed out' : r.exit_code != null ? `failed with exit code ${r.exit_code}` : 'failed'
      const err = snippet(r.stderr)
      ui.toast(`${name} ${what}${err ? `: ${err}` : ''}`, { type: 'error' })
    }
  }
  const tick = async () => {
    timer = null
    try {
      const r = await api.get(`/api/runs/${enc(run.id)}`)
      onUpdate?.(r)
      if (TERMINAL.has(r.status)) return finish(r)
    } catch (err) {
      if (err.status === 404) return void (stopped = true)
    }
    if (!stopped) timer = setTimeout(tick, POLL_MS)
  }
  if (TERMINAL.has(run.status)) finish(run)
  else timer = setTimeout(tick, POLL_MS)
  return {
    refresh() {
      if (stopped || !timer) return
      clearTimeout(timer)
      tick()
    },
  }
}

async function openRunDialog(ctx) {
  const { api, ui } = deps
  const { h, modal, toast, button, icon } = ui
  ui.loadCss(CSS)
  const moduleId = ctx.module.id
  const pageId = ctx.pageId ?? null
  const attachments = [...(ctx.attachments || [])]
  let scripts
  let pageTitle = null
  try {
    ;[scripts, pageTitle] = await Promise.all([
      api.get('/api/scripts'),
      pageId ? api.get(`/api/notebooks/${enc(moduleId)}/pages/${enc(pageId)}`).then((p) => p.title || 'Untitled', () => null) : null,
    ])
  } catch (err) {
    toast(err.message || 'Could not load scripts', { type: 'error' })
    return
  }

  const host = h('div', { class: 'sc-run' })
  let closeDialog
  const footer = h('div', { class: 'sc-dialog-footer' })

  function renderEmpty() {
    host.replaceChildren(h('div', { class: 'empty-state sc-empty' },
      h('span', { class: 'empty-state-icon' }, icon('script', { size: 22 })),
      h('p', { class: 'empty-state-title' }, 'No scripts registered yet'),
      h('p', { class: 'empty-state-text' }, 'Register a .bat, .cmd or .ps1 script on the Scripts page, then run it against this page.')))
    footer.replaceChildren(
      button('Close', { onClick: () => closeDialog(null) }),
      button('Manage scripts', { variant: 'primary', iconName: 'settings', onClick: () => { closeDialog(null); location.hash = '#/scripts' } }))
    host.append(footer)
  }

  function renderForm() {
    let selected = scripts[0]?.id
    const radios = h('div', { class: 'sc-choice-list', role: 'radiogroup', 'aria-label': 'Script' }, scripts.map((s, i) => {
      const input = h('input', { type: 'radio', name: 'sc-script', value: s.id, checked: i === 0, class: 'sc-choice-input', onChange: () => { selected = s.id } })
      return h('label', { class: 'sc-choice', dataset: { id: s.id } }, input,
        h('span', { class: 'sc-choice-text' },
          h('span', { class: 'sc-choice-name' }, s.name),
          h('span', { class: 'sc-choice-path', title: s.path }, s.path)),
        kindBadge(s.kind))
    }))
    const boxes = attachments.map((a) => h('input', { type: 'checkbox', class: 'sc-check-input', value: a.id, checked: true, onChange: () => syncCount() }))
    const count = h('span', { class: 'sc-section-meta' })
    const toggleAll = h('button', { type: 'button', class: 'sc-link-btn', onClick: () => {
      const all = boxes.every((b) => b.checked)
      for (const b of boxes) b.checked = !all
      syncCount()
    } })
    const syncCount = () => {
      const n = boxes.filter((b) => b.checked).length
      count.textContent = `${n} of ${attachments.length} selected`
      toggleAll.textContent = boxes.every((b) => b.checked) ? 'Select none' : 'Select all'
    }
    const attList = attachments.length
      ? h('div', { class: 'sc-check-list' }, attachments.map((a, i) => h('label', { class: 'sc-check', dataset: { id: a.id } }, boxes[i],
        icon('file', { size: 14 }), h('span', { class: 'sc-check-name', title: a.filename }, a.filename),
        a.source === 'script-output' ? h('span', { class: 'sc-tag' }, 'Output') : null)))
      : h('p', { class: 'sc-muted' }, 'This page has no attachments. The script will run with an empty input list.')
    if (attachments.length) syncCount()
    const error = h('p', { class: 'sc-error', role: 'alert', hidden: true })
    const runBtn = button('Run', { variant: 'primary', iconName: 'play', onClick: async () => {
      runBtn.disabled = true
      error.hidden = true
      try {
        const run = await api.post(`/api/scripts/${enc(selected)}/run`, { moduleId, pageId, attachmentIds: boxes.filter((b) => b.checked).map((b) => b.value) })
        renderRun(run)
      } catch (err) {
        error.textContent = err.message || 'Could not start the run'
        error.hidden = false
        runBtn.disabled = false
      }
    } })
    host.replaceChildren(
      h('section', { class: 'sc-section' }, h('div', { class: 'sc-section-head' }, h('h3', { class: 'sc-section-title' }, 'Script')), radios),
      h('section', { class: 'sc-section' }, h('div', { class: 'sc-section-head' }, h('h3', { class: 'sc-section-title' }, 'Attachments to pass'),
        attachments.length ? count : null, attachments.length > 1 ? toggleAll : null), attList),
      error, footer)
    footer.replaceChildren(button('Close', { onClick: () => closeDialog(null) }), runBtn)
    runBtn.focus()
  }

  function renderRun(run) {
    const script = scripts.find((s) => s.id === run.script_id)
    const badgeHost = h('span', { class: 'sc-live-status', 'aria-live': 'polite' })
    const elapsed = h('span', { class: 'sc-fact sc-elapsed' })
    const exit = h('span', { class: 'sc-fact sc-exit' })
    const viewer = logViewer(run)
    const cancelBtn = button('Cancel', { variant: 'danger-ghost', iconName: 'stop', onClick: async () => {
      cancelBtn.disabled = true
      try {
        const r = await api.post(`/api/runs/${enc(run.id)}/cancel`)
        apply(r)
        poller.refresh()
      } catch (err) {
        if (err.status !== 409) toast(err.message || 'Could not cancel the run', { type: 'error' })
        poller.refresh()
      }
    } })
    const closeBtn = button('Close', { onClick: () => closeDialog(null) })
    const summary = h('div', { class: 'sc-run-head' },
      h('div', { class: 'sc-run-title' }, h('span', { class: 'sc-run-name' }, script?.name || run.script_name || 'Script'), script ? kindBadge(script.kind) : null),
      h('div', { class: 'sc-facts' }, badgeHost, elapsed, exit))
    host.replaceChildren(summary, viewer.el, footer)
    footer.replaceChildren(closeBtn, cancelBtn)
    let lastStatus = null
    let clock = null
    function apply(r) {
      if (r.status !== lastStatus) {
        lastStatus = r.status
        badgeHost.replaceChildren(statusBadge(r.status))
        host.dataset.status = r.status
      }
      viewer.update(r)
      exit.textContent = r.exit_code != null ? `Exit code ${r.exit_code}` : ''
      exit.hidden = r.exit_code == null
      const tickClock = () => {
        const d = runDuration(r)
        elapsed.textContent = d == null ? 'Waiting for a free slot' : formatDuration(d)
      }
      tickClock()
      clearInterval(clock)
      if (TERMINAL.has(r.status)) {
        const hadFocus = document.activeElement === cancelBtn || !host.contains(document.activeElement)
        cancelBtn.hidden = true
        closeBtn.className = 'btn btn-primary'
        if (hadFocus && host.isConnected) closeBtn.focus({ preventScroll: true })
      } else if (r.started_at) {
        clock = setInterval(tickClock, 250)
      }
    }
    apply(run)
    if (!cancelBtn.hidden) cancelBtn.focus({ preventScroll: true })
    const poller = watchRun(run, { moduleId, pageId, onUpdate: (r) => host.isConnected && apply(r) })
    const stopClock = () => clearInterval(clock)
    host.addEventListener('sc:closed', stopClock, { once: true })
  }

  const done = modal({
    title: 'Run script',
    description: `Runs against ${pageTitle ? `"${pageTitle}"` : 'this page'} and attaches any output files back to it.`,
    size: 'md',
    className: 'sc-modal sc-run-modal',
    actions: [],
    body: (close) => {
      closeDialog = close
      return host
    },
  })
  if (scripts.length) renderForm()
  else renderEmpty()
  await done
  host.dispatchEvent(new Event('sc:closed'))
}

/* ------------------------------------------------------------------ manager page */

function mountManager(el, { api, ui }) {
  const { h, button, toast, confirmDialog, modal, formatDateTime, icon } = ui
  ui.loadCss(CSS)
  let destroyed = false
  let scripts = []
  let runs = []
  let shown = HISTORY_PAGE
  let historyTimer = null
  const pageTitles = new Map() // moduleId -> Promise<Map pageId -> title>
  let moduleTitles = null

  /* ---- add */
  const pathInput = h('input', { class: 'input sc-path-input', type: 'text', placeholder: 'C:\\Scripts\\process.ps1', 'aria-label': 'Script path', spellcheck: 'false', autocomplete: 'off' })
  const addError = h('p', { class: 'sc-error', role: 'alert', id: 'sc-add-error', hidden: true })
  const showAddError = (msg) => {
    addError.textContent = msg
    addError.hidden = !msg
    if (msg) pathInput.setAttribute('aria-invalid', 'true')
    else pathInput.removeAttribute('aria-invalid')
    pathInput.setAttribute('aria-describedby', msg ? 'sc-add-error' : '')
  }
  pathInput.addEventListener('input', () => showAddError(''))
  const browseBtn = button('Browse', { iconName: 'folder', onClick: async () => {
    browseBtn.disabled = true
    try {
      const { path } = await api.post('/api/scripts/browse')
      if (path) {
        pathInput.value = path
        showAddError('')
        pathInput.focus()
      }
    } catch (err) {
      showAddError(err.message || 'Could not open the file dialog')
    } finally {
      browseBtn.disabled = false
    }
  } })
  const addBtn = button('Add script', { variant: 'primary', iconName: 'plus', type: 'submit' })
  const addForm = h('form', { class: 'sc-add', novalidate: true, onSubmit: async (e) => {
    e.preventDefault()
    const p = pathInput.value.trim()
    if (!p) return showAddError('Enter the full path to a .bat, .cmd or .ps1 file')
    addBtn.disabled = true
    try {
      const s = await api.post('/api/scripts', { path: p })
      scripts.push(s)
      scripts.sort((a, b) => a.name.localeCompare(b.name, 'en-AU', { sensitivity: 'base' }))
      pathInput.value = ''
      showAddError('')
      renderScripts()
      toast(`Added "${s.name}"`, { type: 'success' })
    } catch (err) {
      showAddError(err.message || 'Could not add the script')
      pathInput.focus()
    } finally {
      addBtn.disabled = false
    }
  } },
  h('label', { class: 'field-label', for: 'sc-path' }, 'Add a script'),
  h('div', { class: 'sc-add-row' }, pathInput, browseBtn, addBtn),
  addError,
  h('p', { class: 'sc-hint' }, 'Absolute path to a .bat, .cmd or .ps1 file. Scripts receive the chosen attachments through TRUSS_INPUTS_FILE and write results to TRUSS_OUTPUT_DIR.'))
  pathInput.id = 'sc-path'

  /* ---- list */
  const listHost = h('div', { class: 'sc-list', 'aria-busy': 'true' }, h('div', { class: 'list-skeleton' }, [1, 2].map(() => h('span'))))
  const scriptCount = h('span', { class: 'section-count' })

  function scriptRow(s) {
    const edit = button('', { variant: 'ghost', size: 'sm', iconName: 'edit', title: `Edit ${s.name}`, onClick: () => openEditor(s) })
    const del = button('', { variant: 'ghost', size: 'sm', iconName: 'trash', title: `Delete ${s.name}`, class: 'btn btn-ghost btn-sm btn-icon sc-danger-icon', onClick: () => removeScript(s) })
    return h('div', { class: 'sc-row', dataset: { id: s.id, kind: s.kind } },
      h('span', { class: 'sc-row-icon', dataset: { kind: s.kind } }, icon(s.kind === 'ps1' ? 'terminal' : 'script', { size: 16 })),
      h('div', { class: 'sc-row-text' },
        h('div', { class: 'sc-row-title' }, h('span', { class: 'sc-row-name' }, s.name), kindBadge(s.kind)),
        h('span', { class: 'sc-row-path', title: s.path }, s.path)),
      h('span', { class: 'sc-row-timeout', title: `Timeout: ${s.timeout_sec} seconds` }, icon('clock', { size: 13 }), h('span', {}, formatTimeout(s.timeout_sec))),
      h('div', { class: 'sc-row-actions' }, edit, del))
  }

  function renderScripts() {
    listHost.removeAttribute('aria-busy')
    scriptCount.textContent = scripts.length ? plural(scripts.length, 'script') : ''
    if (!scripts.length) {
      listHost.replaceChildren(h('div', { class: 'empty-state' },
        h('span', { class: 'empty-state-icon' }, icon('script', { size: 22 })),
        h('p', { class: 'empty-state-title' }, 'No scripts yet'),
        h('p', { class: 'empty-state-text' }, 'Add a script above, then run it from any notebook page with "Run script".')))
      return
    }
    listHost.replaceChildren(...scripts.map(scriptRow))
  }

  function openEditor(s) {
    const name = h('input', { class: 'input', type: 'text', value: s.name, id: 'sc-edit-name' })
    const timeout = h('input', { class: 'input', type: 'number', min: '1', max: String(MAX_TIMEOUT), step: '1', value: String(s.timeout_sec), id: 'sc-edit-timeout' })
    const config = h('textarea', { class: 'input sc-config', id: 'sc-edit-config', spellcheck: 'false', rows: '8' })
    config.value = JSON.stringify(s.config ?? {}, null, 2)
    const error = h('p', { class: 'sc-error', role: 'alert', hidden: true })
    const setError = (msg, field) => {
      error.textContent = msg || ''
      error.hidden = !msg
      for (const f of [name, timeout, config]) f.removeAttribute('aria-invalid')
      field?.setAttribute('aria-invalid', 'true')
      field?.focus()
    }
    let closeFn
    const save = button('Save', { variant: 'primary', type: 'submit' })
    const form = h('form', { class: 'sc-form', novalidate: true, onSubmit: async (e) => {
      e.preventDefault()
      const n = name.value.trim()
      if (!n) return setError('Name cannot be empty', name)
      const t = Number(timeout.value)
      if (!Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT) return setError(`Timeout must be a whole number of seconds from 1 to ${MAX_TIMEOUT}`, timeout)
      const cfg = parseConfig(config.value)
      if (cfg.error) return setError(cfg.error, config)
      setError('')
      save.disabled = true
      try {
        const saved = await api.patch(`/api/scripts/${enc(s.id)}`, { name: n, timeout_sec: t, config: cfg.value })
        scripts = scripts.map((x) => (x.id === saved.id ? saved : x))
        renderScripts()
        closeFn(true)
        toast(`Saved "${saved.name}"`, { type: 'success' })
      } catch (err) {
        setError(err.message || 'Could not save the script')
        save.disabled = false
      }
    } },
    h('div', { class: 'form-field' }, h('label', { class: 'field-label', for: 'sc-edit-name' }, 'Name'), name),
    h('div', { class: 'form-field' }, h('label', { class: 'field-label', for: 'sc-edit-timeout' }, 'Timeout (seconds)'), timeout,
      h('span', { class: 'sc-hint' }, 'The run is stopped and marked timed out after this long.')),
    h('div', { class: 'form-field' }, h('label', { class: 'field-label', for: 'sc-edit-config' }, 'Config (JSON)'), config,
      h('span', { class: 'sc-hint' }, 'Passed to the script as TRUSS_CONFIG.')),
    h('div', { class: 'sc-path-fact' }, kindBadge(s.kind), h('span', { class: 'sc-row-path', title: s.path }, s.path)),
    error,
    h('div', { class: 'sc-dialog-footer' }, button('Cancel', { onClick: () => closeFn(null) }), save))
    modal({ title: 'Edit script', size: 'md', className: 'sc-modal', actions: [], body: (close) => { closeFn = close; return form }, onOpen: () => name.select() })
  }

  async function removeScript(s) {
    const ok = await confirmDialog({ title: `Delete "${s.name}"?`, message: 'The script is removed from Truss. The file on disk and its past runs are kept.', confirmLabel: 'Delete', danger: true })
    if (!ok) return
    try {
      await api.del(`/api/scripts/${enc(s.id)}`)
      scripts = scripts.filter((x) => x.id !== s.id)
      renderScripts()
      toast(`Deleted "${s.name}"`, { type: 'success' })
    } catch (err) {
      toast(err.message || 'Could not delete the script', { type: 'error' })
    }
  }

  /* ---- history */
  const historyHost = h('div', { class: 'sc-history' })
  const runCount = h('span', { class: 'section-count' })

  async function titlesFor(moduleId) {
    if (!pageTitles.has(moduleId)) {
      pageTitles.set(moduleId, api.get(`/api/notebooks/${enc(moduleId)}/pages`)
        .then((pages) => new Map(pages.map((p) => [p.id, p.title || 'Untitled'])), () => new Map()))
    }
    return pageTitles.get(moduleId)
  }

  async function pageLabel(run) {
    const mod = moduleTitles?.get(run.module_id)
    if (!mod) return { module: 'Deleted module', page: null } // skip a lookup that can only 404
    const pages = run.page_id ? await titlesFor(run.module_id) : null
    const page = run.page_id ? pages.get(run.page_id) : null
    return { module: mod || 'Deleted module', page }
  }

  const runHref = (r) => `#/m/${enc(r.module_id)}${r.page_id ? `/p/${enc(r.page_id)}` : ''}`

  function runRow(r) {
    const link = h('a', { class: 'sc-page-link', href: runHref(r) }, icon('page', { size: 14 }), h('span', { class: 'sc-page-link-text' }, 'Page'))
    pageLabel(r).then(({ module, page }) => {
      link.lastChild.textContent = page ? page : module
      link.title = page ? `${module} / ${page}` : module
      link.dataset.label = link.title
    })
    const d = runDuration(r)
    return h('tr', { class: 'sc-run-row', dataset: { id: r.id, status: r.status } },
      h('td', { class: 'sc-td-script' }, h('span', { class: 'sc-td-name' }, r.script_name || h('span', { class: 'sc-muted' }, 'Deleted script'))),
      h('td', { class: 'sc-td-page' }, link),
      h('td', { class: 'sc-td-status' }, statusBadge(r.status)),
      h('td', { class: 'sc-td-started' }, h('time', { datetime: r.started_at || r.created_at }, formatDateTime(r.started_at || r.created_at))),
      h('td', { class: 'sc-td-duration' }, d == null ? h('span', { class: 'sc-muted' }, '-') : TERMINAL.has(r.status) ? formatDuration(d) : h('span', { class: 'sc-muted' }, 'Running')),
      h('td', { class: 'sc-td-actions' }, button('Logs', { variant: 'ghost', size: 'sm', iconName: 'terminal', title: 'View logs', onClick: async () => {
        const full = await api.get(`/api/runs/${enc(r.id)}`).catch(() => r)
        const label = link.dataset.label
        openLogModal(full, label)
      } })))
  }

  function renderHistory() {
    runCount.textContent = runs.length ? plural(runs.length, 'run') : ''
    if (!runs.length) {
      historyHost.replaceChildren(h('div', { class: 'empty-state' },
        h('span', { class: 'empty-state-icon' }, icon('clock', { size: 22 })),
        h('p', { class: 'empty-state-title' }, 'No runs yet'),
        h('p', { class: 'empty-state-text' }, 'Runs started from notebook pages appear here with their status and logs.')))
      return
    }
    // ponytail: paged (50 rows per "Show more") instead of virtualised; the API caps history at 500 runs.
    const visible = runs.slice(0, shown)
    const table = h('table', { class: 'sc-table' },
      h('thead', {}, h('tr', {}, ['Script', 'Page', 'Status', 'Started', 'Duration', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, visible.map(runRow)))
    const more = runs.length > shown
      ? h('div', { class: 'sc-more' }, button(`Show more (${runs.length - shown} older)`, { variant: 'ghost', size: 'sm', onClick: () => { shown += HISTORY_PAGE; renderHistory() } }))
      : null
    historyHost.replaceChildren(h('div', { class: 'sc-table-wrap' }, table), ...(more ? [more] : []))
  }

  async function loadHistory() {
    clearTimeout(historyTimer)
    try {
      const [list, mods, archived] = await Promise.all([api.get('/api/runs'), ...(moduleTitles ? [] : [api.get('/api/modules'), api.get('/api/modules?archived=1')])])
      if (destroyed) return
      if (mods) moduleTitles = new Map([...mods, ...archived].map((m) => [m.id, m.title]))
      const key = (l) => l.map((r) => `${r.id}:${r.status}`).join('|')
      const changed = key(list) !== key(runs)
      runs = list
      if (changed || !historyHost.firstChild) renderHistory()
      if (runs.some((r) => !TERMINAL.has(r.status))) historyTimer = setTimeout(loadHistory, 2000)
    } catch (err) {
      if (destroyed) return
      historyHost.replaceChildren(h('p', { class: 'sc-error' }, err.message || 'Could not load run history'))
    }
  }

  const page = h('div', { class: 'page sc-page' },
    h('header', { class: 'page-intro' },
      h('h1', { class: 'page-intro-title' }, 'Scripts'),
      h('p', { class: 'page-intro-text' }, 'Register local scripts and run them against notebook page attachments. Output files are attached back to the page.')),
    h('section', { class: 'sc-card' }, addForm),
    h('section', { class: 'sc-block' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Registered scripts'), scriptCount),
      listHost),
    h('section', { class: 'sc-block' },
      h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Run history'),
        h('div', { class: 'sc-head-actions' }, runCount, button('', { variant: 'ghost', size: 'sm', iconName: 'restore', title: 'Refresh history', onClick: loadHistory }))),
      historyHost))
  el.append(page)

  api.get('/api/scripts').then((list) => {
    if (destroyed) return
    scripts = list
    renderScripts()
  }, (err) => {
    if (!destroyed) listHost.replaceChildren(h('p', { class: 'sc-error' }, err.message || 'Could not load scripts'))
  })
  loadHistory()

  return {
    unmount() {
      destroyed = true
      clearTimeout(historyTimer)
    },
  }
}

/* ------------------------------------------------------------------ init */

export default {
  init({ registry, api, ui }) {
    deps = { registry, api, ui }
    ui.loadCss(CSS) // small and idempotent; loading at boot avoids a flash of unstyled dialog or page
    registry.registerRoute('#/scripts', { title: 'Scripts', mount: (el, rctx) => mountManager(el, { ...rctx, api, ui }) })
    registry.registerSidebarItem({ id: 'scripts', label: 'Scripts', icon: 'script', href: '#/scripts' })
    registry.registerPageAction({
      id: 'run-script',
      label: 'Run script',
      icon: 'play',
      // Needs a real saved notebook (with an id) to attach outputs to; database and sheet modules never qualify.
      isAvailable: (ctx) => ctx?.module?.type === 'notebook' && typeof ctx.module.id === 'string' && !!ctx.module.id,
      run: (ctx) => openRunDialog(ctx),
    })
  },
}
