// Router and HTTP helpers. Zero dependencies.

const MAX_JSON_BYTES = 20 * 1024 * 1024

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code)
    this.status = status
    this.code = code
  }
}

export function httpError(status, code, message) {
  return new HttpError(status, code, message)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeFor(filename) {
  const dot = filename.lastIndexOf('.')
  return (dot >= 0 && MIME[filename.slice(dot).toLowerCase()]) || 'application/octet-stream'
}

export function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  res.end(body)
}

export function sendError(res, err) {
  if (res.headersSent) return res.destroy()
  if (err instanceof HttpError) return sendJson(res, err.status, { error: { code: err.code, message: err.message } })
  console.error('[truss] unexpected error:', err)
  sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error' } })
}

export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BYTES) throw httpError(413, 'payload_too_large', 'JSON body exceeds 20 MB')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'invalid_json', 'Request body is not valid JSON')
  }
}

export function createRouter() {
  const routes = []
  const add = (method) => (pattern, handler) => {
    const keys = []
    const src = pattern
      .split('/')
      .map((seg) => (seg.startsWith(':') ? (keys.push(seg.slice(1)), '([^/]+)') : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')
    routes.push({ method, re: new RegExp(`^${src}/?$`), keys, handler })
  }
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    // Returns { handler, params } or null; { methodNotAllowed: true } when only the method differs.
    match(method, pathname) {
      let pathHit = false
      for (const r of routes) {
        const m = r.re.exec(pathname)
        if (!m) continue
        pathHit = true
        if (r.method !== method) continue
        const params = {}
        r.keys.forEach((k, i) => {
          try { params[k] = decodeURIComponent(m[i + 1]) } catch { params[k] = m[i + 1] }
        })
        return { handler: r.handler, params }
      }
      return pathHit ? { methodNotAllowed: true } : null
    },
  }
}
