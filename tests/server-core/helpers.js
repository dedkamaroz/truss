import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../../server/main.js'

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function tempDir(label = 'core') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `truss-test-${label}-`))
}

// Raw HTTP so tests control the exact path and Host header.
export function raw(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        let json
        try { json = JSON.parse(buf.toString('utf8')) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8'), json })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

export async function boot(dataDir = tempDir()) {
  const s = await startServer({ port: 0, dataDir })
  const call = (method, urlPath, { json, headers = {}, body } = {}) => {
    const h = { 'X-Truss-Token': s.token, ...headers }
    if (json !== undefined) {
      body = JSON.stringify(json)
      h['Content-Type'] = 'application/json'
    }
    return raw(s.port, method, urlPath, { headers: h, body })
  }
  return { s, dataDir, call }
}
