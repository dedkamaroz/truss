// Block editor for text pages. Content is an array of { id, type, html, props }.
// One contenteditable per block; typing only touches that block's model entry (no re-render of others).

import { h, popover, promptDialog, emojiPicker, menu, toast } from '../../lib/ui.js'
import { icon } from '../../lib/icons.js'
import { sanitizeHtml, safeHref } from '../../lib/sanitize.js'
import { bid, escapeHtml, caretOffset, selectionEndOffset, rangeAt, setCaret, createHistory, historyKey, formatSize } from './util.js'
import { createTableEditor, newTable, normaliseTable } from './table.js'

const glyph = (text, cls = '') => h('span', { class: `nb-glyph ${cls}`.trim() }, text)

export const BLOCK_TYPES = [
  { type: 'paragraph', label: 'Text', desc: 'Start writing with plain text', keys: 'paragraph plain text', tile: () => glyph('Aa') },
  { type: 'heading1', label: 'Heading 1', desc: 'Big section heading', keys: 'h1 title heading1 #', tile: () => glyph('H1') },
  { type: 'heading2', label: 'Heading 2', desc: 'Medium section heading', keys: 'h2 subtitle heading2 ##', tile: () => glyph('H2') },
  { type: 'heading3', label: 'Heading 3', desc: 'Small section heading', keys: 'h3 heading3 ###', tile: () => glyph('H3') },
  { type: 'bulleted', label: 'Bulleted list', desc: 'A simple bulleted list', keys: 'bullet unordered ul list -', tile: () => icon('list', { size: 18 }) },
  { type: 'numbered', label: 'Numbered list', desc: 'A list with numbering', keys: 'number ordered ol list 1.', tile: () => glyph('1.') },
  { type: 'todo', label: 'To-do list', desc: 'Track tasks with a checkbox', keys: 'todo task checkbox check []', tile: () => icon('check', { size: 18 }) },
  { type: 'quote', label: 'Quote', desc: 'Capture a quote', keys: 'quote blockquote citation >', tile: () => glyph('“', 'nb-glyph-quote') },
  { type: 'callout', label: 'Callout', desc: 'Make writing stand out', keys: 'callout note info highlight', tile: () => icon('info', { size: 18 }) },
  { type: 'code', label: 'Code', desc: 'Capture a code snippet', keys: 'code snippet pre ```', tile: () => icon('script', { size: 18 }) },
  { type: 'divider', label: 'Divider', desc: 'Visually divide blocks', keys: 'divider hr rule line separator', tile: () => h('span', { class: 'nb-glyph nb-glyph-divider' }) },
  { type: 'toggle', label: 'Toggle', desc: 'Hide content inside a toggle', keys: 'toggle collapse details expand', tile: () => icon('chevron-right', { size: 18 }) },
  { type: 'table', label: 'Table', desc: 'A simple table of text', keys: 'table grid rows columns', tile: () => icon('table', { size: 18 }) },
  { type: 'image', label: 'Image', desc: 'Upload an image', keys: 'image picture photo upload', tile: () => icon('image', { size: 18 }) },
  { type: 'file', label: 'File', desc: 'Upload and attach a file', keys: 'file attachment upload document', tile: () => icon('paperclip', { size: 18 }) },
]
const TYPE_BY_ID = new Map(BLOCK_TYPES.map((t) => [t.type, t]))
const TEXT_TYPES = new Set(['paragraph', 'heading1', 'heading2', 'heading3', 'bulleted', 'numbered', 'todo', 'quote', 'callout', 'code', 'toggle'])
const CONTINUING = new Set(['bulleted', 'numbered', 'todo'])
const PLACEHOLDER = {
  paragraph: "Type '/' for commands", heading1: 'Heading 1', heading2: 'Heading 2', heading3: 'Heading 3',
  bulleted: 'List', numbered: 'List', todo: 'To-do', quote: 'Quote', callout: 'Callout', toggle: 'Toggle', code: '',
}
const MARKDOWN = { '#': 'heading1', '##': 'heading2', '###': 'heading3', '-': 'bulleted', '*': 'bulleted', '1.': 'numbered', '[]': 'todo', '[ ]': 'todo', '>': 'quote' }

const htmlToText = (html) => {
  const d = document.createElement('div')
  d.innerHTML = sanitizeHtml(html)
  return d.textContent
}

function defaultProps(type, props = {}) {
  if (type === 'todo') return { checked: !!props.checked }
  if (type === 'callout') return { icon: props.icon || '💡' }
  if (type === 'toggle') return { open: props.open ?? true, body: props.body || '' }
  if (type === 'table') return normaliseTable(props.columns ? props : newTable(3, 3))
  if (type === 'image' || type === 'file') return { ...props }
  return {}
}

export function normaliseBlocks(list) {
  const out = (Array.isArray(list) ? list : []).filter((b) => b && TYPE_BY_ID.has(b.type)).map((b) => ({
    id: typeof b.id === 'string' && b.id ? b.id : bid(),
    type: b.type,
    html: typeof b.html === 'string' ? b.html : '',
    props: defaultProps(b.type, b.props && typeof b.props === 'object' ? b.props : {}),
  }))
  if (!out.length) out.push({ id: bid(), type: 'paragraph', html: '', props: {} })
  return out
}

function fill(ed, html) {
  if (!/[<&]/.test(html)) ed.textContent = html
  else ed.innerHTML = sanitizeHtml(html)
}

// Paste/drop HTML: keep line structure from block elements, then allowlist.
function cleanPastedHtml(html) {
  return sanitizeHtml(String(html).replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '$&<br>')).replace(/(<br>\s*)+$/, '')
}

/**
 * createBlockEditor({ blocks, onChange, upload(file) -> attachment, attachmentUrl(id), openAttachment(id) })
 * -> { el, blocks, insertAttachment(att), focusStart(), destroy() }
 */
export function createBlockEditor({ blocks: input, onChange = () => {}, upload, attachmentUrl, openAttachment }) {
  let blocks = normaliseBlocks(input)
  const nodes = new Map() // id -> block element
  const tables = new Map() // id -> table editor
  let lastFocusedId = null
  let suppressRecord = false
  let dragId = null
  let slash = null

  const list = h('div', { class: 'nb-blocks' })
  const indicator = h('div', { class: 'nb-drop-line', hidden: true })
  const tail = h('div', { class: 'nb-editor-tail', title: 'Click to add a block' })
  const fileInput = h('input', { type: 'file', class: 'nb-hidden-input', tabindex: '-1', 'aria-hidden': 'true' })
  const root = h('div', { class: 'nb-editor' }, list, indicator, tail, fileInput)

  const history = createHistory({
    capture: () => ({ json: JSON.stringify(blocks), focus: focusInfo() }),
    restore: (snap) => applySnapshot(snap),
  })

  const changed = () => onChange(blocks)
  const byId = (id) => blocks.find((b) => b.id === id)
  const indexOf = (b) => blocks.indexOf(b)
  const editableOf = (b, field = 'html') => nodes.get(b.id)?.querySelector(`.nb-text[data-field="${field}"]`)

  function readEditable(ed, b) {
    if (ed.innerHTML === '<br>') ed.innerHTML = ''
    const raw = ed.innerHTML
    const value = b.type === 'code' ? escapeHtml(ed.textContent) : (/[<&]/.test(raw) ? sanitizeHtml(raw) : raw)
    if (ed.dataset.field === 'body') b.props.body = value
    else b.html = value
  }

  /* ------------------------------------------------------------ rendering */

  function editable(b, field = 'html', extra = {}) {
    const ed = h('div', {
      class: `nb-text nb-${b.type}-text`,
      contenteditable: b.type === 'code' ? 'plaintext-only' : 'true',
      spellcheck: b.type === 'code' ? 'false' : null,
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': field === 'body' ? 'Toggle content' : TYPE_BY_ID.get(b.type).label,
      dataset: { field, placeholder: field === 'body' ? 'Empty toggle. Type here' : PLACEHOLDER[b.type] || '' },
      ...extra,
    })
    fill(ed, field === 'body' ? b.props.body || '' : b.html)
    if (b.type === 'code') ensureCodeTail(ed)
    return ed
  }

  function renderBlock(b) {
    const handle = h('button', { type: 'button', class: 'nb-handle', draggable: 'true', title: 'Drag to move, click for options', 'aria-label': 'Block options' }, icon('drag', { size: 16 }))
    const add = h('button', { type: 'button', class: 'nb-add', title: 'Add a block below', 'aria-label': 'Add a block below' }, icon('plus', { size: 16 }))
    const body = h('div', { class: 'nb-body' })
    const el = h('div', { class: 'nb-block', dataset: { id: b.id, type: b.type } }, h('div', { class: 'nb-gutter' }, add, handle), body)
    switch (b.type) {
      case 'todo': {
        const box = h('input', { type: 'checkbox', class: 'nb-check', checked: !!b.props.checked, 'aria-label': 'Done' })
        el.classList.toggle('is-checked', !!b.props.checked)
        body.append(h('span', { class: 'nb-check-wrap' }, box), editable(b))
        break
      }
      case 'callout':
        body.append(h('button', { type: 'button', class: 'nb-callout-icon', title: 'Change icon', 'aria-label': 'Change callout icon' }, b.props.icon || '💡'), editable(b))
        break
      case 'toggle': {
        el.classList.toggle('is-open', !!b.props.open)
        const btn = h('button', { type: 'button', class: 'nb-toggle-btn', 'aria-expanded': String(!!b.props.open), 'aria-label': 'Expand or collapse' }, icon('chevron-right', { size: 16, strokeWidth: 2 }))
        body.append(h('div', { class: 'nb-toggle-head' }, btn, editable(b)), h('div', { class: 'nb-toggle-body' }, editable(b, 'body')))
        break
      }
      case 'divider':
        body.append(h('div', { class: 'nb-divider', tabindex: '0', role: 'separator', 'aria-label': 'Divider' }, h('hr')))
        break
      case 'table': {
        const t = createTableEditor({
          data: b.props,
          record: (key) => history.record(key ? `tbl:${b.id}:${key}` : null),
          onChange: () => {
            b.props = t.data
            changed()
          },
        })
        tables.set(b.id, t)
        body.append(t.el)
        break
      }
      case 'image': {
        const img = h('img', { src: b.props.attachmentId ? attachmentUrl(b.props.attachmentId) : '', alt: b.props.name || 'Image', draggable: 'false' })
        const fig = h('figure', { class: 'nb-image', tabindex: '0' }, img)
        img.addEventListener('error', () => {
          fig.classList.add('is-broken')
          fig.replaceChildren(icon('image', { size: 18 }), h('span', {}, 'Image unavailable'))
        })
        body.append(fig)
        break
      }
      case 'file':
        body.append(h('div', { class: 'nb-file', tabindex: '0', role: 'button', title: 'Open file', dataset: { attachmentId: b.props.attachmentId || '' } },
          h('span', { class: 'nb-file-icon' }, icon('paperclip', { size: 16 })),
          h('span', { class: 'nb-file-name' }, b.props.name || 'File'),
          h('span', { class: 'nb-file-size' }, formatSize(b.props.size))))
        break
      default:
        body.append(editable(b))
    }
    nodes.set(b.id, el)
    return el
  }

  function renderAll() {
    nodes.clear()
    tables.clear()
    const frag = document.createDocumentFragment()
    for (const b of blocks) frag.appendChild(renderBlock(b))
    list.replaceChildren(frag)
  }

  function replaceEl(b) {
    const old = nodes.get(b.id)
    tables.delete(b.id)
    const el = renderBlock(b)
    old?.replaceWith(el)
    return el
  }

  /* ------------------------------------------------------------ focus */

  function focusInfo() {
    const a = document.activeElement
    if (!a || !root.contains(a)) return null
    const blockEl = a.closest('.nb-block')
    if (!blockEl) return null
    if (a.classList.contains('nb-text')) return { id: blockEl.dataset.id, field: a.dataset.field, offset: caretOffset(a) }
    if (a.classList.contains('nb-cell')) return { id: blockEl.dataset.id, cell: [Number(a.dataset.r), Number(a.dataset.c)], offset: caretOffset(a) }
    return { id: blockEl.dataset.id }
  }

  function restoreFocus(info) {
    if (!info) return
    const b = byId(info.id)
    if (!b) return
    if (info.cell) return tables.get(b.id)?.focusCell(info.cell[0], info.cell[1])
    focusBlock(b, info.offset ?? Infinity, info.field)
  }

  function focusBlock(b, offset = Infinity, field = 'html') {
    const el = nodes.get(b.id)
    if (!el) return
    const ed = editableOf(b, field) || editableOf(b)
    if (ed) {
      setCaret(ed, offset)
      scrollIntoViewIfNeeded(el)
      return
    }
    if (b.type === 'table') {
      const t = tables.get(b.id)
      return offset === 0 ? t?.focusCell(0, 0, 'start') : t?.focusCell(t.data.rows.length - 1, 0)
    }
    el.querySelector('[tabindex="0"]')?.focus()
  }

  function scrollIntoViewIfNeeded(el) {
    const r = el.getBoundingClientRect()
    if (r.top < 60 || r.bottom > innerHeight - 20) el.scrollIntoView({ block: 'nearest' })
  }

  /* ------------------------------------------------------------ block operations */

  const makeBlock = (type, html = '', props = {}) => ({ id: bid(), type, html, props: defaultProps(type, props) })

  function insertAfter(ref, nb) {
    const i = ref ? indexOf(ref) : blocks.length - 1
    blocks.splice(i + 1, 0, nb)
    const el = renderBlock(nb)
    if (ref && nodes.get(ref.id)) nodes.get(ref.id).after(el)
    else list.appendChild(el)
    return nb
  }

  function insertBefore(ref, nb) {
    blocks.splice(indexOf(ref), 0, nb)
    nodes.get(ref.id).before(renderBlock(nb))
    return nb
  }

  function removeBlock(b) {
    const i = indexOf(b)
    if (i < 0) return
    blocks.splice(i, 1)
    nodes.get(b.id)?.remove()
    nodes.delete(b.id)
    tables.delete(b.id)
    if (!blocks.length) insertAfter(null, makeBlock('paragraph'))
  }

  function turnInto(b, type, caret = Infinity) {
    if (b.type === type) return focusBlock(b, caret)
    const textual = TEXT_TYPES.has(type)
    if (type === 'code') b.html = escapeHtml(htmlToText(b.html))
    else if (!textual) b.html = ''
    b.type = type
    b.props = defaultProps(type, b.props)
    replaceEl(b)
    focusBlock(b, caret)
    changed()
  }

  function duplicate(b) {
    history.record(null)
    const copy = JSON.parse(JSON.stringify(b))
    copy.id = bid()
    insertAfter(b, copy)
    changed()
  }

  function deleteBlock(b) {
    history.record(null)
    const i = indexOf(b)
    removeBlock(b)
    const target = blocks[Math.max(0, i - 1)]
    if (target) focusBlock(target)
    changed()
  }

  function blockMenu(anchor, b) {
    menu(anchor, [
      { label: 'Delete', icon: 'trash', danger: true, onClick: () => deleteBlock(b) },
      { label: 'Duplicate', icon: 'copy', onClick: () => duplicate(b) },
      'divider',
      { header: 'Turn into' },
      ...BLOCK_TYPES.filter((t) => TEXT_TYPES.has(t.type)).map((t) => ({
        label: t.label,
        disabled: t.type === b.type || !TEXT_TYPES.has(b.type),
        onClick: () => {
          history.record(null)
          turnInto(b, t.type)
        },
      })),
    ])
  }

  function applySnapshot(snap) {
    const next = JSON.parse(snap.json)
    const prev = new Map(blocks.map((b) => [b.id, JSON.stringify(b)]))
    const keep = new Set(next.filter((nb) => prev.get(nb.id) === JSON.stringify(nb)).map((nb) => nb.id))
    for (const [id, el] of nodes) {
      if (!keep.has(id)) {
        el.remove()
        nodes.delete(id)
        tables.delete(id)
      }
    }
    blocks = next
    blocks.forEach((b, i) => {
      const el = nodes.get(b.id) || renderBlock(b)
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null)
    })
    restoreFocus(snap.focus)
    changed()
  }

  /* ------------------------------------------------------------ keyboard */

  function caretLines(ed) {
    const sel = getSelection()
    const off = caretOffset(ed)
    const fallback = { first: off <= 0, last: selectionEndOffset(ed) >= ed.textContent.length }
    if (!sel.rangeCount) return fallback
    const r = sel.getRangeAt(0).cloneRange()
    r.collapse(true)
    const rect = r.getClientRects()[0]
    if (!rect) return fallback
    const box = ed.getBoundingClientRect()
    const lh = parseFloat(getComputedStyle(ed).lineHeight) || 22
    return { first: rect.top - box.top < lh * 0.8, last: box.bottom - rect.bottom < lh * 0.8 }
  }

  function insertTextAtCaret(ed, text) {
    const sel = getSelection()
    const r = sel.getRangeAt(0)
    r.deleteContents()
    const node = document.createTextNode(text)
    r.insertNode(node)
    r.setStartAfter(node)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }

  function ensureCodeTail(ed) {
    // A trailing <br> lets a final newline render as an empty line in pre-wrap text.
    if (ed.lastChild?.nodeName !== 'BR') ed.appendChild(document.createElement('br'))
  }

  function handleEnter(b, ed) {
    if (ed.dataset.field === 'body') {
      suppressRecord = true
      document.execCommand('insertLineBreak')
      suppressRecord = false
      return
    }
    history.record(null)
    if (b.type === 'code') {
      insertTextAtCaret(ed, '\n')
      ensureCodeTail(ed)
      readEditable(ed, b)
      changed()
      return
    }
    const text = ed.textContent
    if (!text.trim() && b.type !== 'paragraph' && !ed.querySelector('br + br')) {
      turnInto(b, 'paragraph', 0)
      return
    }
    const nextType = CONTINUING.has(b.type) ? b.type : 'paragraph'
    if (text && caretOffset(ed) === 0 && getSelection().isCollapsed) {
      insertBefore(b, makeBlock(CONTINUING.has(b.type) ? b.type : 'paragraph'))
      changed()
      return
    }
    const r = getSelection().getRangeAt(0)
    if (!r.collapsed) r.deleteContents()
    const tailRange = document.createRange()
    tailRange.setStart(r.startContainer, r.startOffset)
    tailRange.setEnd(ed, ed.childNodes.length)
    const tmp = document.createElement('div')
    tmp.append(tailRange.extractContents())
    const tailHtml = tmp.textContent ? sanitizeHtml(tmp.innerHTML) : ''
    if (!ed.textContent) ed.innerHTML = ''
    readEditable(ed, b)
    const nb = insertAfter(b, makeBlock(nextType, tailHtml))
    focusBlock(nb, 0)
    changed()
  }

  function mergeIntoPrevious(b, ed) {
    const i = indexOf(b)
    const prev = blocks[i - 1]
    if (!prev) {
      if (b.type === 'paragraph') return false
      history.record(null)
      turnInto(b, 'paragraph', 0)
      return true
    }
    history.record(null)
    if (!TEXT_TYPES.has(prev.type)) {
      removeBlock(prev)
      focusBlock(b, 0)
      changed()
      return true
    }
    const prevEd = editableOf(prev)
    const at = prevEd.textContent.length
    readEditable(ed, b)
    prev.html = prev.type === 'code' ? escapeHtml(htmlToText(prev.html) + htmlToText(b.html)) : prev.html + b.html
    fill(prevEd, prev.html)
    removeBlock(b)
    focusBlock(prev, at)
    changed()
    return true
  }

  function mergeNext(b, ed) {
    const next = blocks[indexOf(b) + 1]
    if (!next) return false
    history.record(null)
    if (!TEXT_TYPES.has(next.type)) {
      removeBlock(next)
      changed()
      return true
    }
    const at = ed.textContent.length
    readEditable(ed, b)
    b.html = b.type === 'code' ? escapeHtml(htmlToText(b.html) + htmlToText(next.html)) : b.html + next.html
    fill(ed, b.html)
    removeBlock(next)
    setCaret(ed, at)
    changed()
    return true
  }

  function neighbour(b, dir) {
    return blocks[indexOf(b) + dir]
  }

  function onKeydown(e) {
    if (e.isComposing) return
    const hk = historyKey(e)
    if (hk) {
      e.preventDefault()
      closeSlash()
      history[hk]()
      return
    }
    const ed = e.target.closest?.('.nb-text')
    const blockEl = e.target.closest?.('.nb-block')
    if (!blockEl) return
    const b = byId(blockEl.dataset.id)
    if (!b) return

    if (!ed) {
      // Focused non-text block (divider, image, file)
      if (!e.target.matches('[tabindex="0"]')) return
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        deleteBlock(b)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (e.target.classList.contains('nb-file')) return openAttachment?.(b.props.attachmentId)
        history.record(null)
        focusBlock(insertAfter(b, makeBlock('paragraph')), 0)
        changed()
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const n = neighbour(b, e.key === 'ArrowUp' ? -1 : 1)
        if (n) {
          e.preventDefault()
          focusBlock(n, e.key === 'ArrowUp' ? Infinity : 0)
        }
      }
      return
    }

    if (slash) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveSlash(e.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (slash.items.length) {
          e.preventDefault()
          chooseSlash(slash.items[slash.active])
          return
        }
        closeSlash()
      }
    }

    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && !e.altKey && b.type !== 'code') {
      const fmt = !e.shiftKey && { b: 'bold', i: 'italic', u: 'underline', e: 'code', k: 'link' }[key]
      const strike = e.shiftKey && (key === 's' || key === 'x')
      if (fmt || strike) {
        e.preventDefault()
        // Keep the shell's document-level Ctrl+K (quick switcher) from also firing.
        e.stopPropagation()
        format(strike ? 'strike' : fmt)
        return
      }
    }

    const collapsed = getSelection().isCollapsed
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault()
      closeSlash()
      handleEnter(b, ed)
    } else if (e.key === 'Enter' && e.shiftKey && b.type === 'code') {
      e.preventDefault()
      handleEnter(b, ed)
    } else if (e.key === 'Tab' && b.type === 'code') {
      e.preventDefault()
      history.record(null)
      insertTextAtCaret(ed, '  ')
      readEditable(ed, b)
      changed()
    } else if (e.key === 'Backspace' && collapsed && ed.dataset.field === 'html' && caretOffset(ed) === 0 && !mod) {
      if (mergeIntoPrevious(b, ed)) e.preventDefault()
    } else if (e.key === 'Delete' && collapsed && ed.dataset.field === 'html' && caretOffset(ed) >= ed.textContent.length && !mod) {
      if (mergeNext(b, ed)) e.preventDefault()
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !slash) {
      const up = e.key === 'ArrowUp'
      const lines = caretLines(ed)
      if (up ? !lines.first : !lines.last) return
      if (ed.dataset.field === 'body' && up) {
        e.preventDefault()
        return focusBlock(b, Infinity, 'html')
      }
      if (!up && ed.dataset.field === 'html' && b.type === 'toggle' && b.props.open) {
        e.preventDefault()
        return focusBlock(b, 0, 'body')
      }
      const n = neighbour(b, up ? -1 : 1)
      if (!n) return
      e.preventDefault()
      if (!up && n.type === 'toggle') return focusBlock(n, 0)
      focusBlock(n, up ? Infinity : 0, up && n.type === 'toggle' && n.props.open ? 'body' : 'html')
    } else if (e.key === 'ArrowLeft' && collapsed && !e.shiftKey && caretOffset(ed) === 0 && ed.dataset.field === 'html') {
      const n = neighbour(b, -1)
      if (n && TEXT_TYPES.has(n.type)) {
        e.preventDefault()
        focusBlock(n, Infinity)
      }
    } else if (e.key === 'ArrowRight' && collapsed && !e.shiftKey && selectionEndOffset(ed) >= ed.textContent.length && ed.dataset.field === 'html') {
      const n = neighbour(b, 1)
      if (n && TEXT_TYPES.has(n.type)) {
        e.preventDefault()
        focusBlock(n, 0)
      }
    }
  }

  /* ------------------------------------------------------------ input, markdown, slash */

  function onBeforeInput(e) {
    const ed = e.target.closest?.('.nb-text')
    if (!ed || suppressRecord) return
    const blockEl = ed.closest('.nb-block')
    history.record(`type:${blockEl.dataset.id}:${ed.dataset.field}`)
  }

  function onInput(e) {
    const ed = e.target.closest?.('.nb-text')
    if (!ed) return
    const b = byId(ed.closest('.nb-block').dataset.id)
    if (!b) return
    readEditable(ed, b)
    if (b.type === 'code') ensureCodeTail(ed)
    if (e.inputType === 'insertText' && ed.dataset.field === 'html') {
      const off = caretOffset(ed)
      const before = ed.textContent.slice(0, off).replace(/ /g, ' ')
      if (b.type === 'paragraph' && e.data === ' ' && MARKDOWN[before.slice(0, -1)] && before.endsWith(' ')) {
        history.record(null)
        rangeAt(ed, 0, off).deleteContents()
        readEditable(ed, b)
        closeSlash()
        turnInto(b, MARKDOWN[before.slice(0, -1)], 0)
        return
      }
      if (b.type === 'paragraph' && e.data === '`' && before === '```') {
        history.record(null)
        rangeAt(ed, 0, off).deleteContents()
        readEditable(ed, b)
        closeSlash()
        turnInto(b, 'code', 0)
        return
      }
      if (e.data === '/' && b.type !== 'code' && !slash && (off === 1 || /\s/.test(before[off - 2] || ''))) {
        openSlash(b, ed, off - 1)
        changed()
        return
      }
    }
    if (slash) updateSlash()
    changed()
  }

  function caretRect() {
    const sel = getSelection()
    if (!sel.rangeCount) return null
    const r = sel.getRangeAt(0).cloneRange()
    r.collapse(true)
    const rect = r.getClientRects()[0]
    if (rect) return rect
    const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement
    return node?.getBoundingClientRect() || null
  }

  function openSlash(b, ed, start) {
    const rect = caretRect() || ed.getBoundingClientRect()
    const listEl = h('div', { class: 'nb-slash-list', role: 'listbox', 'aria-label': 'Block types' })
    const content = h('div', { class: 'nb-slash' }, h('div', { class: 'nb-slash-header' }, 'Basic blocks'), listEl)
    slash = { b, ed, start, items: [], active: 0, listEl, header: content.firstChild, rect }
    updateSlash() // fill before opening so the popover is positioned with its real height
    const anchor = { getBoundingClientRect: () => new DOMRect(rect.left, rect.top, rect.width, rect.height) }
    const pop = popover(anchor, content, {
      className: 'nb-slash-pop',
      onClose: () => {
        if (slash?.pop === pop) slash = null
      },
    })
    slash.pop = pop
  }

  function placeSlash() {
    const el = slash?.pop?.el
    if (!el) return
    const r = slash.rect
    const hgt = el.offsetHeight
    const top = r.bottom + 4 + hgt > innerHeight - 8 ? Math.max(8, r.top - hgt - 4) : r.bottom + 4
    el.style.top = `${Math.round(top)}px`
  }

  function closeSlash() {
    if (!slash) return
    const s = slash
    slash = null
    s.pop?.close()
  }

  function updateSlash() {
    const s = slash
    if (!s) return
    const text = s.ed.textContent
    const off = caretOffset(s.ed)
    if (!s.ed.isConnected || off <= s.start || text[s.start] !== '/') return closeSlash()
    const query = text.slice(s.start + 1, off).replace(/ /g, ' ').toLowerCase()
    if (/\s\s/.test(query) || query.length > 24) return closeSlash()
    const q = query.trim()
    s.items = BLOCK_TYPES.filter((t) => !q || t.label.toLowerCase().includes(q) || t.keys.includes(q))
    s.active = 0
    s.header.textContent = q ? (s.items.length ? 'Results' : 'No results') : 'Basic blocks'
    s.listEl.replaceChildren(...s.items.map((t, i) => h('div', {
      class: `nb-slash-item${i === 0 ? ' is-active' : ''}`,
      role: 'option',
      'aria-selected': String(i === 0),
      dataset: { type: t.type },
      onMousedown: (ev) => ev.preventDefault(),
      onClick: () => chooseSlash(t),
      onMousemove: () => {
        if (s.active !== i) setActive(i)
      },
    }, h('span', { class: 'nb-slash-tile' }, t.tile()), h('span', { class: 'nb-slash-text' }, h('span', { class: 'nb-slash-label' }, t.label), h('span', { class: 'nb-slash-desc' }, t.desc)))))
    placeSlash()
  }

  function setActive(i) {
    const s = slash
    const items = s.listEl.children
    items[s.active]?.classList.remove('is-active')
    items[s.active]?.setAttribute('aria-selected', 'false')
    s.active = i
    items[i]?.classList.add('is-active')
    items[i]?.setAttribute('aria-selected', 'true')
    items[i]?.scrollIntoView({ block: 'nearest' })
  }

  function moveSlash(dir) {
    const n = slash.items.length
    if (n) setActive((slash.active + dir + n) % n)
  }

  function chooseSlash(t) {
    const { b, ed, start } = slash
    const end = Math.max(caretOffset(ed), start + 1)
    closeSlash()
    history.record(null)
    rangeAt(ed, start, end).deleteContents()
    if (!ed.textContent) ed.innerHTML = ''
    readEditable(ed, b)
    applyType(b, ed, t.type, start)
  }

  async function applyType(b, ed, type, caret) {
    const empty = !ed.textContent.trim()
    const replaceable = empty && ed.dataset.field === 'html' && b.type === 'paragraph'
    if (TEXT_TYPES.has(type)) {
      if (replaceable || (b.type === 'paragraph' && ed.dataset.field === 'html')) return turnInto(b, type, caret)
      const nb = insertAfter(b, makeBlock(type))
      focusBlock(nb, 0)
      return changed()
    }
    if (type === 'image' || type === 'file') {
      const file = await pickFile(type === 'image' ? 'image/*' : '')
      if (!file) return changed()
      let att
      try {
        att = await upload(file)
      } catch (err) {
        toast(err?.message || 'Upload failed', { type: 'error' })
        return changed()
      }
      return insertAttachmentBlock(att, replaceable ? b : null, b, type)
    }
    const nb = makeBlock(type)
    if (replaceable) {
      b.type = type
      b.props = nb.props
      b.html = ''
      replaceEl(b)
    } else insertAfter(b, nb)
    const placed = replaceable ? b : nb
    if (type === 'table') tables.get(placed.id)?.focusCell(-1, 0)
    else {
      const next = neighbour(placed, 1)
      focusBlock(next && next.type === 'paragraph' && !next.html ? next : insertAfter(placed, makeBlock('paragraph')), 0)
    }
    changed()
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      fileInput.value = ''
      fileInput.accept = accept
      const done = () => {
        fileInput.removeEventListener('change', done)
        fileInput.removeEventListener('cancel', done)
        resolve(fileInput.files?.[0] || null)
      }
      fileInput.addEventListener('change', done)
      fileInput.addEventListener('cancel', done)
      fileInput.click()
    })
  }

  function insertAttachmentBlock(att, replace, after, forced) {
    const type = forced || (/^image\//.test(att.mime || '') ? 'image' : 'file')
    const props = { attachmentId: att.id, name: att.filename, size: att.size, mime: att.mime }
    let placed
    if (replace) {
      replace.type = type
      replace.html = ''
      replace.props = props
      replaceEl(replace)
      placed = replace
    } else {
      placed = insertAfter(after || null, makeBlock(type, '', props))
    }
    const next = neighbour(placed, 1)
    if (!next) insertAfter(placed, makeBlock('paragraph'))
    changed()
    return placed
  }

  /* ------------------------------------------------------------ paste and drop */

  function insertClean(ed, b, dt) {
    history.record(null)
    suppressRecord = true
    try {
      if (b.type === 'code') {
        insertTextAtCaret(ed, dt.getData('text/plain') || '')
        ensureCodeTail(ed)
      } else {
        const html = dt.getData('text/html')
        const text = dt.getData('text/plain')
        const clean = html ? cleanPastedHtml(html) : escapeHtml(text).replace(/\r?\n/g, '<br>')
        if (clean) document.execCommand('insertHTML', false, clean)
      }
    } finally {
      suppressRecord = false
    }
    readEditable(ed, b)
    changed()
  }

  function onPaste(e) {
    const ed = e.target.closest?.('.nb-text')
    if (!ed || !e.clipboardData) return
    const b = byId(ed.closest('.nb-block').dataset.id)
    if (!b) return
    if (e.clipboardData.files?.length) return // files go to attachments (handled by the page)
    e.preventDefault()
    insertClean(ed, b, e.clipboardData)
  }

  /* ------------------------------------------------------------ formatting toolbar */

  const selbar = h('div', { class: 'nb-selbar', role: 'toolbar', 'aria-label': 'Text formatting', hidden: true, onMousedown: (e) => e.preventDefault() })
  const FORMATS = [
    ['bold', 'Bold (Ctrl+B)', h('b', {}, 'B')],
    ['italic', 'Italic (Ctrl+I)', h('i', {}, 'I')],
    ['underline', 'Underline (Ctrl+U)', h('u', {}, 'U')],
    ['strike', 'Strikethrough (Ctrl+Shift+S)', h('s', {}, 'S')],
    ['code', 'Inline code (Ctrl+E)', icon('script', { size: 15 })],
    ['link', 'Link (Ctrl+K)', icon('link', { size: 15 })],
  ]
  const fmtButtons = new Map()
  for (const [cmd, title, content] of FORMATS) {
    const btn = h('button', { type: 'button', class: 'nb-selbar-btn', title, 'aria-label': title.replace(/ \(.*\)$/, ''), dataset: { format: cmd }, onClick: () => format(cmd) }, content)
    fmtButtons.set(cmd, btn)
    selbar.append(btn)
    if (cmd === 'strike') selbar.append(h('span', { class: 'nb-selbar-sep' }))
  }
  document.body.appendChild(selbar)

  function activeEditable() {
    const sel = getSelection()
    if (!sel.rangeCount) return null
    const r = sel.getRangeAt(0)
    const node = r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement
    const ed = node?.closest('.nb-text')
    return ed && root.contains(ed) ? ed : null
  }

  function ancestorTag(ed, node, tag) {
    for (let x = node?.nodeType === 1 ? node : node?.parentElement; x && x !== ed; x = x.parentElement) if (x.localName === tag) return x
    return null
  }

  let selRaf = 0
  function onSelectionChange() {
    cancelAnimationFrame(selRaf)
    selRaf = requestAnimationFrame(updateSelbar)
  }

  function updateSelbar() {
    const sel = getSelection()
    const ed = !sel.isCollapsed && activeEditable()
    const b = ed && byId(ed.closest('.nb-block')?.dataset.id)
    if (!ed || !b || b.type === 'code' || !sel.toString().trim() || !ed.contains(document.activeElement)) {
      selbar.hidden = true
      return
    }
    const r = sel.getRangeAt(0)
    const rect = r.getBoundingClientRect()
    selbar.hidden = false
    const w = selbar.offsetWidth
    const hgt = selbar.offsetHeight
    const left = Math.min(Math.max(8, rect.left + rect.width / 2 - w / 2), document.documentElement.clientWidth - w - 8)
    const top = rect.top - hgt - 8 < 8 ? rect.bottom + 8 : rect.top - hgt - 8
    selbar.style.left = `${Math.round(left)}px`
    selbar.style.top = `${Math.round(top)}px`
    const state = {
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      strike: !!ancestorTag(ed, r.startContainer, 's'),
      code: !!ancestorTag(ed, r.startContainer, 'code'),
      link: !!ancestorTag(ed, r.startContainer, 'a'),
    }
    for (const [cmd, btn] of fmtButtons) {
      btn.classList.toggle('is-active', !!state[cmd])
      btn.setAttribute('aria-pressed', String(!!state[cmd]))
    }
  }

  function toggleWrap(ed, tag) {
    const sel = getSelection()
    const r = sel.getRangeAt(0)
    const a = ancestorTag(ed, r.startContainer, tag)
    const z = ancestorTag(ed, r.endContainer, tag)
    const nr = document.createRange()
    if (a && a === z) {
      const first = a.firstChild
      const last = a.lastChild
      while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a)
      a.remove()
      if (first) {
        nr.setStartBefore(first)
        nr.setEndAfter(last)
      }
    } else {
      const frag = r.extractContents()
      frag.querySelectorAll(tag).forEach((x) => x.replaceWith(...x.childNodes))
      const w = document.createElement(tag)
      w.append(frag)
      r.insertNode(w)
      nr.selectNodeContents(w)
    }
    sel.removeAllRanges()
    sel.addRange(nr)
  }

  async function format(cmd) {
    const ed = activeEditable()
    if (!ed) return
    const b = byId(ed.closest('.nb-block').dataset.id)
    if (!b || b.type === 'code') return
    const sel = getSelection()
    if (cmd === 'link') {
      const r = sel.getRangeAt(0).cloneRange()
      if (r.collapsed) return
      const existing = ancestorTag(ed, r.startContainer, 'a')
      const url = await promptDialog({ title: existing ? 'Edit link' : 'Add link', label: 'Link address (leave empty to remove)', value: existing?.getAttribute('href') || 'https://', confirmLabel: 'Apply' })
      ed.focus({ preventScroll: true })
      sel.removeAllRanges()
      sel.addRange(r)
      if (url === null) return
      history.record(null)
      suppressRecord = true
      const value = url.trim()
      if (!value) document.execCommand('unlink')
      else {
        const href = safeHref(value) || safeHref(`https://${value}`)
        if (href) {
          document.execCommand('createLink', false, href)
          for (const a of ed.querySelectorAll('a')) {
            a.setAttribute('rel', 'noopener noreferrer')
            a.setAttribute('target', '_blank')
          }
        } else toast('Links must start with http, https or mailto', { type: 'error' })
      }
      suppressRecord = false
    } else {
      // A collapsed caret only sets the typing style (bold/italic/underline) for what is typed next.
      if (sel.isCollapsed && !['bold', 'italic', 'underline'].includes(cmd)) return
      history.record(null)
      suppressRecord = true
      if (cmd === 'strike') toggleWrap(ed, 's')
      else if (cmd === 'code') toggleWrap(ed, 'code')
      else document.execCommand(cmd)
      suppressRecord = false
    }
    readEditable(ed, b)
    changed()
    updateSelbar()
  }

  /* ------------------------------------------------------------ mouse: gutter, checkboxes, toggles, links */

  function onClick(e) {
    const blockEl = e.target.closest('.nb-block')
    const b = blockEl && byId(blockEl.dataset.id)
    if (!b) return
    if (e.target.closest('.nb-handle')) return blockMenu(e.target.closest('.nb-handle'), b)
    if (e.target.closest('.nb-add')) {
      history.record(null)
      const nb = TEXT_TYPES.has(b.type) && b.type === 'paragraph' && !b.html ? b : insertAfter(b, makeBlock('paragraph'))
      const ed = editableOf(nb)
      ed.textContent = '/'
      readEditable(ed, nb)
      setCaret(ed, 1)
      openSlash(nb, ed, 0)
      return changed()
    }
    if (e.target.closest('.nb-toggle-btn')) {
      b.props.open = !b.props.open
      blockEl.classList.toggle('is-open', b.props.open)
      e.target.closest('.nb-toggle-btn').setAttribute('aria-expanded', String(b.props.open))
      return changed()
    }
    if (e.target.closest('.nb-callout-icon')) {
      const btn = e.target.closest('.nb-callout-icon')
      emojiPicker(btn, { allowRemove: false }).then((emoji) => {
        if (!emoji) return
        history.record(null)
        b.props.icon = emoji
        btn.textContent = emoji
        changed()
      })
      return
    }
    if (e.target.closest('.nb-file')) return openAttachment?.(b.props.attachmentId)
    const link = e.target.closest('.nb-text a[href]')
    if (link && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      window.open(link.href, '_blank', 'noopener,noreferrer')
    }
  }

  function onChangeEvent(e) {
    if (!e.target.matches('.nb-check')) return
    const blockEl = e.target.closest('.nb-block')
    const b = byId(blockEl.dataset.id)
    if (!b) return
    const checked = e.target.checked
    history.record(null)
    b.props.checked = checked
    blockEl.classList.toggle('is-checked', checked)
    changed()
  }

  /* ------------------------------------------------------------ drag to reorder */

  function onDragStart(e) {
    const handle = e.target.closest?.('.nb-handle')
    if (!handle) return
    const blockEl = handle.closest('.nb-block')
    dragId = blockEl.dataset.id
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-truss-block', dragId)
    e.dataTransfer.setDragImage(blockEl, 20, 16)
    blockEl.classList.add('is-dragging')
  }

  function dropSpot(e) {
    let target = e.target.closest?.('.nb-block')
    while (target && target.parentElement !== list) target = target.parentElement.closest('.nb-block')
    if (!target) {
      const last = list.lastElementChild
      if (!last) return null
      target = e.clientY < list.getBoundingClientRect().top ? list.firstElementChild : last
    }
    const rect = target.getBoundingClientRect()
    return { target, after: e.clientY > rect.top + rect.height / 2 }
  }

  function onDragOver(e) {
    if (!dragId) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const spot = dropSpot(e)
    if (!spot) return
    const rect = spot.target.getBoundingClientRect()
    const base = root.getBoundingClientRect()
    indicator.hidden = false
    indicator.style.top = `${Math.round((spot.after ? rect.bottom : rect.top) - base.top - 1)}px`
  }

  function onDrop(e) {
    if (dragId) {
      e.preventDefault()
      const spot = dropSpot(e)
      const b = byId(dragId)
      endDrag()
      if (!spot || !b) return
      const targetB = byId(spot.target.dataset.id)
      if (!targetB || targetB === b) return
      history.record(null)
      blocks.splice(indexOf(b), 1)
      blocks.splice(indexOf(targetB) + (spot.after ? 1 : 0), 0, b)
      const el = nodes.get(b.id)
      if (spot.after) spot.target.after(el)
      else spot.target.before(el)
      changed()
      return
    }
    // External text/HTML dropped into a block: insert sanitised at the drop point.
    const ed = e.target.closest?.('.nb-text')
    const dt = e.dataTransfer
    if (!ed || !dt || dt.types.includes('Files') || !(dt.types.includes('text/html') || dt.types.includes('text/plain'))) return
    e.preventDefault()
    const b = byId(ed.closest('.nb-block').dataset.id)
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    ed.focus({ preventScroll: true })
    if (pos && ed.contains(pos.startContainer)) {
      getSelection().removeAllRanges()
      getSelection().addRange(pos)
    } else setCaret(ed)
    insertClean(ed, b, dt)
  }

  function endDrag() {
    if (dragId) nodes.get(dragId)?.classList.remove('is-dragging')
    dragId = null
    indicator.hidden = true
  }

  /* ------------------------------------------------------------ wiring */

  tail.addEventListener('click', () => {
    const last = blocks[blocks.length - 1]
    if (last && last.type === 'paragraph' && !last.html) return focusBlock(last, 0)
    history.record(null)
    focusBlock(insertAfter(last, makeBlock('paragraph')), 0)
    changed()
  })
  root.addEventListener('keydown', onKeydown)
  root.addEventListener('beforeinput', onBeforeInput)
  root.addEventListener('input', onInput)
  root.addEventListener('paste', onPaste)
  root.addEventListener('click', onClick)
  root.addEventListener('change', onChangeEvent)
  root.addEventListener('dragstart', onDragStart)
  root.addEventListener('dragover', onDragOver)
  root.addEventListener('drop', onDrop)
  root.addEventListener('dragend', endDrag)
  root.addEventListener('focusin', (e) => {
    const blockEl = e.target.closest('.nb-block')
    if (blockEl) lastFocusedId = blockEl.dataset.id
  })
  root.addEventListener('focusout', () => setTimeout(() => {
    updateSelbar()
    if (slash && document.activeElement !== slash.ed) closeSlash()
  }))
  document.addEventListener('selectionchange', onSelectionChange)
  document.execCommand('styleWithCSS', false, false)
  renderAll()

  return {
    el: root,
    get blocks() {
      return blocks
    },
    history,
    focusStart() {
      focusBlock(blocks[0], 0)
    },
    insertAttachment(att) {
      history.record(null)
      const after = (lastFocusedId && byId(lastFocusedId)) || blocks[blocks.length - 1]
      const replace = after && after.type === 'paragraph' && !after.html ? after : null
      const placed = insertAttachmentBlock(att, replace, after)
      nodes.get(placed.id)?.scrollIntoView({ block: 'center' })
      return placed
    },
    destroy() {
      closeSlash()
      document.removeEventListener('selectionchange', onSelectionChange)
      cancelAnimationFrame(selRaf)
      selbar.remove()
    },
  }
}
