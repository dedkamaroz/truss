// Small helpers shared by the notebook editors: ids, caret offsets, undo history, formatting.

export const bid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16)).slice(0, 8)

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** Text offset of the caret (selection start) inside el, or -1 when the selection is elsewhere. */
export function caretOffset(el) {
  const sel = getSelection()
  if (!sel.rangeCount) return -1
  const r = sel.getRangeAt(0)
  if (!el.contains(r.startContainer)) return -1
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(r.startContainer, r.startOffset)
  return pre.toString().length
}

export function selectionEndOffset(el) {
  const sel = getSelection()
  if (!sel.rangeCount) return -1
  const r = sel.getRangeAt(0)
  if (!el.contains(r.endContainer)) return -1
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(r.endContainer, r.endOffset)
  return pre.toString().length
}

function pointAt(el, offset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let left = offset
  let last = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (left <= n.data.length) return [n, left]
    left -= n.data.length
    last = n
  }
  return last ? [last, last.data.length] : [el, el.childNodes.length]
}

/** Range covering text offsets [start, end) inside el. */
export function rangeAt(el, start, end = start) {
  const r = document.createRange()
  r.setStart(...pointAt(el, start))
  r.setEnd(...pointAt(el, end))
  return r
}

export function setCaret(el, offset = Infinity) {
  el.focus({ preventScroll: true })
  const len = el.textContent.length
  const r = rangeAt(el, Math.max(0, Math.min(offset, len)))
  const sel = getSelection()
  sel.removeAllRanges()
  sel.addRange(r)
}

/** Undo history of opaque snapshots. record(key) is called before a change; equal keys within 1.2 s coalesce. */
export function createHistory({ capture, restore, limit = 200 }) {
  let undo = []
  let redo = []
  let lastKey = null
  let lastAt = 0
  return {
    record(key = null) {
      const now = Date.now()
      if (key && key === lastKey && now - lastAt < 1200) {
        lastAt = now
        return
      }
      undo.push(capture())
      if (undo.length > limit) undo.shift()
      redo = []
      lastKey = key
      lastAt = now
    },
    undo() {
      if (!undo.length) return false
      redo.push(capture())
      restore(undo.pop())
      lastKey = null
      return true
    },
    redo() {
      if (!redo.length) return false
      undo.push(capture())
      restore(redo.pop())
      lastKey = null
      return true
    },
    clear() {
      undo = []
      redo = []
      lastKey = null
    },
  }
}

/** True for Ctrl/Cmd+Z style shortcuts: returns 'undo' | 'redo' | null. */
export function historyKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'z') return e.shiftKey ? 'redo' : 'undo'
  if (k === 'y') return 'redo'
  return null
}
