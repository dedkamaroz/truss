import fs from 'node:fs'
import { httpError } from '../http.js'
import { launch, MAX_UPLOAD_BYTES } from '../attachments.js'

export default function register(router, ctx) {
  const { attachments } = ctx

  const load = (id) => {
    const row = attachments.get(id)
    if (!row) throw httpError(404, 'attachment_not_found', 'Attachment not found')
    return row
  }

  router.post('/api/attachments', async ({ req, res, query }) => {
    const raw = req.headers['x-filename']
    if (!raw) throw httpError(400, 'missing_filename', 'X-Filename header is required')
    let filename
    try {
      filename = decodeURIComponent(raw)
    } catch {
      filename = raw
    }
    if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) throw httpError(413, 'payload_too_large', 'Upload exceeds 1 GB')
    const row = await attachments.createFromStream({ moduleId: query.moduleId, pageId: query.pageId, filename, source: 'upload' }, req)
    res.statusCode = 201
    return row
  })

  router.get('/api/attachments', ({ query }) => attachments.list({ moduleId: query.moduleId, pageId: query.pageId }))

  router.get('/api/attachments/:id/content', ({ params, res }) => {
    const row = load(params.id)
    const file = attachments.pathOf(row.id)
    let size
    try {
      size = fs.statSync(file).size
    } catch {
      throw httpError(404, 'file_missing', 'Attachment file is missing on disk')
    }
    res.writeHead(200, {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      // Uploaded HTML/SVG is rendered inert if opened directly.
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox",
      'Cache-Control': 'private, no-cache',
    })
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res)
  })

  router.post('/api/attachments/:id/open', ({ params }) => {
    load(params.id)
    return launch('explorer.exe', [attachments.pathOf(params.id)])
  })

  router.post('/api/attachments/:id/reveal', ({ params }) => {
    load(params.id)
    // Two separate argv entries; Node quotes the path if it contains spaces: /select, "C:\...\file name.png"
    return launch('explorer.exe', ['/select,', attachments.pathOf(params.id)])
  })

  router.delete('/api/attachments/:id', ({ params }) => {
    load(params.id)
    attachments.remove(params.id)
    return { ok: true }
  })
}
