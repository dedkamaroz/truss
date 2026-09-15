// Pointer-based drag gesture shared by column reordering, board cards, calendar items and property lists.

/**
 * Call from a pointerdown handler. Nothing happens until the pointer moves past `threshold`,
 * so plain clicks still work. A floating ghost (clone of `source`) follows the pointer.
 * onMove({ x, y, target }) and onDrop({ x, y, target }) receive the element under the pointer.
 */
export function dragGesture(e, { source, threshold = 4, axis, onStart, onMove, onDrop, onEnd }) {
  if (e.button !== 0) return
  const sx = e.clientX
  const sy = e.clientY
  let started = false
  let ghost = null
  let dx = 0
  let dy = 0
  const at = (ev) => ({ x: ev.clientX, y: ev.clientY, target: document.elementFromPoint(ev.clientX, ev.clientY) })

  const move = (ev) => {
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return
      started = true
      const r = source.getBoundingClientRect()
      dx = sx - r.left
      dy = sy - r.top
      ghost = source.cloneNode(true)
      ghost.classList.add('db-drag-ghost')
      Object.assign(ghost.style, { position: 'fixed', left: '0px', top: '0px', width: `${r.width}px`, height: `${r.height}px`, pointerEvents: 'none', zIndex: 1050, margin: 0 })
      document.body.append(ghost)
      source.classList.add('is-drag-source')
      document.documentElement.classList.add('db-dragging')
      onStart?.()
    }
    const x = axis === 'y' ? sx - dx : ev.clientX - dx
    const y = axis === 'x' ? sy - dy : ev.clientY - dy
    ghost.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    onMove?.(at(ev))
  }
  const cleanup = () => {
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('keydown', key, true)
    ghost?.remove()
    source.classList.remove('is-drag-source')
    document.documentElement.classList.remove('db-dragging')
  }
  const up = (ev) => {
    cleanup()
    if (!started) return
    // Swallow the click that follows a drag.
    window.addEventListener('click', swallow, true)
    setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    onDrop?.(at(ev))
    onEnd?.()
  }
  const swallow = (c) => {
    c.stopPropagation()
    c.preventDefault()
  }
  const key = (ev) => {
    if (ev.key !== 'Escape') return
    ev.stopPropagation()
    cleanup()
    if (started) onEnd?.()
  }
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('keydown', key, true)
}
