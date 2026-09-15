// Keeps a floating layer inside the viewport when its content grows after it opened.

export function keepInView(el) {
  const fit = () => {
    if (!el.isConnected) return ro.disconnect()
    const r = el.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    if (r.right > vw - 8) el.style.left = `${Math.max(8, vw - 8 - r.width)}px`
    if (r.bottom > vh - 8) el.style.top = `${Math.max(8, vh - 8 - r.height)}px`
  }
  const ro = new ResizeObserver(fit)
  ro.observe(el)
  return el
}
