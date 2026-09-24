// Loads the browser UI scripts (web/app/*.js) into a Node vm context so their logic can be tested
// without a browser. The DOM is stubbed: only what the logic touches at load and render time.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'app')
const ORDER = ['boot', 'icons', 'engine', 'helpers', 'core', 'db', 'sheet', 'nb', 'sync']

export function loadApp({ meta = {} } = {}) {
  const store = {}
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  }
  const document = {
    currentScript: null,
    readyState: 'complete',
    visibilityState: 'visible',
    querySelector: (sel) => {
      const m = /meta\[name="([^"]+)"\]/.exec(sel)
      return m && meta[m[1]] !== undefined ? { content: meta[m[1]] } : null
    },
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
    body: {},
  }
  const window = {
    localStorage, innerWidth: 1440, innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener: () => {}, removeEventListener: () => {}, open: () => null,
  }
  const ctx = vm.createContext({
    window, document, localStorage, console, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask, Promise, Map, Set, JSON, Math, Date, Intl, location: { href: 'http://127.0.0.1/', reload() {} },
    navigator: { platform: 'Win32', clipboard: null }, requestAnimationFrame: (f) => setTimeout(f, 0),
    fetch: () => Promise.reject(new Error('no network in tests')),
  })
  const src = ORDER.map((f) => fs.readFileSync(path.join(APP, f + '.js'), 'utf8')).join('\n;\n')
  vm.runInContext(src + '\n;globalThis.__T = { Component: Component, merge3: merge3, FE: FE, TRUSS_REMOTE: TRUSS_REMOTE, dateStart: dateStart, dateEnd: dateEnd, mkDate: mkDate, mkBlock: mkBlock, normModule: normModule };', ctx, { filename: 'web-app.js' })
  return { ...ctx.__T, ctx, store }
}

export const fakeEvent = (extra = {}) => ({
  currentTarget: { getBoundingClientRect: () => ({ left: 100, right: 200, top: 100, bottom: 120, width: 100, height: 20 }), contains: () => false },
  target: { value: '', checked: false, files: [], selectionStart: 0, selectionEnd: 0, blur() {} },
  stopPropagation() {}, preventDefault() {}, button: 0, clientX: 0, clientY: 0, key: '',
  ...extra,
})
