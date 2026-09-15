// Windowed rendering for long lists with per-item heights. Elements are pooled by key, so an item
// that stays in the window keeps the same DOM element across renders.

export function createVirtual({ scroller, body, overscan = 240, create, update }) {
  let items = []
  let offsets = new Float64Array(0)
  let heights = new Float64Array(0)
  let total = 0
  const pool = new Map() // key -> element
  const keyIndex = new Map()

  const v = {
    get items() { return items },
    get total() { return total },
    pool,

    setItems(list, heightOf) {
      items = list
      offsets = new Float64Array(list.length)
      heights = new Float64Array(list.length)
      keyIndex.clear()
      let y = 0
      list.forEach((it, i) => {
        offsets[i] = y
        heights[i] = heightOf(it)
        y += heights[i]
        keyIndex.set(it.key, i)
      })
      total = y
      body.style.height = `${total}px`
    },

    bodyTop() {
      return body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
    },

    render() {
      const viewTop = scroller.scrollTop - v.bodyTop()
      const top = viewTop - overscan
      const bottom = viewTop + scroller.clientHeight + overscan
      // Hysteresis: existing elements survive until they are 3x overscan away, so small scrolls
      // (e.g. revealing an overscan row) never replace row elements.
      const keepTop = viewTop - overscan * 3
      const keepBottom = viewTop + scroller.clientHeight + overscan * 3
      let lo = 0
      let hi = items.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (offsets[mid] + heights[mid] <= keepTop) lo = mid + 1
        else hi = mid
      }
      const seen = new Set()
      let prev = null
      for (let i = lo; i < items.length && offsets[i] < keepBottom; i++) {
        const it = items[i]
        let el = pool.get(it.key)
        const inWindow = offsets[i] + heights[i] > top && offsets[i] < bottom
        if (!el && !inWindow) continue
        if (!el) {
          el = create(it)
          el.dataset.key = it.key
          pool.set(it.key, el)
        }
        // Keep DOM order equal to visual order (screen readers, tests); moving keeps element identity.
        const want = prev ? prev.nextSibling : body.firstChild
        if (want !== el) body.insertBefore(el, want)
        prev = el
        const y = `${offsets[i]}px`
        if (el.style.top !== y) el.style.top = y
        update(el, it)
        seen.add(it.key)
      }
      for (const [key, el] of pool) {
        if (!seen.has(key)) {
          el.remove()
          pool.delete(key)
        }
      }
    },

    clear() {
      for (const el of pool.values()) el.remove()
      pool.clear()
    },

    indexOf: (key) => keyIndex.get(key) ?? -1,
    offsetOf: (i) => offsets[i],
    heightOf: (i) => heights[i],

    /** Scrolls the minimum amount so item i is fully visible below `stickyTop` px of header. */
    reveal(i, stickyTop = 0) {
      if (i < 0) return
      const base = v.bodyTop()
      const y = base + offsets[i]
      const viewTop = scroller.scrollTop + stickyTop
      const viewBottom = scroller.scrollTop + scroller.clientHeight
      if (y < viewTop) scroller.scrollTop = y - stickyTop
      else if (y + heights[i] > viewBottom) scroller.scrollTop = y + heights[i] - scroller.clientHeight
    },
  }
  return v
}
