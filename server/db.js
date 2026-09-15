import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const MODULE_TYPES = ['database', 'sheet', 'notebook']

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'truss.db'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT)')
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name))
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const name of files) {
    if (applied.has(name)) continue
    transaction(db, () => {
      db.exec(fs.readFileSync(path.join(dir, name), 'utf8'))
      db.prepare('INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString())
    })
  }
}

let savepointSeq = 0

// Runs synchronous fn inside a transaction (a savepoint when already inside one); rolls back on throw.
export function transaction(db, fn) {
  const nested = db.isTransaction
  const sp = `sp_${++savepointSeq}`
  db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE')
  try {
    const result = fn()
    if (result && typeof result.then === 'function') throw new Error('transaction callback must be synchronous')
    db.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
    return result
  } catch (err) {
    db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK')
    throw err
  }
}
