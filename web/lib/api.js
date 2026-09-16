// JSON API client. The token comes from <meta name="truss-token"> injected by the server.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// Truss is served from "/" locally and from "/m/truss/" on the web_server, so
// nothing may hardcode the root. api.js lives at <base>/lib/api.js, which makes
// "../" the application root under either mount. Every caller keeps passing
// root-absolute paths ("/api/databases/x"); they are resolved here, which is
// why none of the 69 call sites had to change.
export const BASE = new URL('../', import.meta.url)

const resolve = (p) => new URL(String(p).replace(/^\//, ''), BASE).href

const meta = (name) => globalThis.document?.querySelector(`meta[name="${name}"]`)?.content || ''

const token = meta('truss-token')

// Set by the host's proxy when Truss is served from the web_server. It gates the
// affordances that only make sense on the machine holding the files.
export const hosted = meta('truss-hosted') === '1'

async function parse(res) {
  const text = await res.text()
  let data = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // non-JSON body; keep the text
  }
  if (!res.ok) {
    const err = data && typeof data === 'object' ? data.error : null
    throw new ApiError(res.status, err?.code || 'http_' + res.status, err?.message || res.statusText || 'Request failed')
  }
  return data
}

async function request(method, path, body) {
  const headers = { 'X-Truss-Token': token }
  const init = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let res
  try {
    res = await fetch(resolve(path), init)
  } catch (e) {
    throw new ApiError(0, 'network_error', 'Could not reach the Truss server')
  }
  return parse(res)
}

export const api = {
  token,
  hosted,
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path, body) => request('DELETE', path, body),
  async upload(path, fileOrBlob, filename = fileOrBlob?.name || 'file') {
    const res = await fetch(resolve(path), {
      method: 'POST',
      headers: {
        'X-Truss-Token': token,
        'X-Filename': encodeURIComponent(filename),
        'Content-Type': fileOrBlob?.type || 'application/octet-stream',
      },
      body: fileOrBlob,
    })
    return parse(res)
  },
  url(path) {
    const u = resolve(path)
    return u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
  },
}

export default api

/**
 * Resolves which of the given same-origin URLs exist, without the browser logging
 * "Failed to load resource" console errors for the missing ones: the requests run
 * inside a dedicated worker (this very file). Resolves to a Set of existing URLs,
 * or null if the probe itself could not run (callers then just try everything).
 */
export function probeUrls(urls, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let worker
    const done = (value) => {
      clearTimeout(timer)
      worker?.terminate()
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    try {
      worker = new Worker(import.meta.url, { type: 'module' })
      worker.onmessage = (e) => done(new Set(e.data))
      worker.onerror = () => done(null)
      worker.postMessage(urls)
    } catch {
      done(null)
    }
  })
}

if (!globalThis.document && typeof globalThis.WorkerGlobalScope === 'function' && globalThis instanceof globalThis.WorkerGlobalScope) {
  globalThis.onmessage = async (e) => {
    const found = await Promise.all(
      e.data.map((u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? u : null), () => null)),
    )
    globalThis.postMessage(found.filter(Boolean))
  }
}
