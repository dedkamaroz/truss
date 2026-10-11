// Hidden databases: a small admin/non-admin split without a permission system.
//
// TRUSS_HIDDEN_TITLES lists module titles (comma-separated) that only admins
// may open. The hosted proxy decides who is an admin and says so with the
// X-Truss-Admin header; the sidecar is bound to 127.0.0.1 behind a per-process
// token, so nothing else can speak for it. A non-hosted (local desktop) run has
// no proxy and therefore no header - its single user is always an admin.
//
// Hidden modules are NOT removed from responses wholesale: the web client keeps
// their documents in memory because relation, lookup, rollup and list columns
// in visible databases are computed from them. Hiding removes them from the
// sidebar, the switcher, the pickers and the routes - not from the data other
// databases reference.

const TITLES = () =>
  (process.env.TRUSS_HIDDEN_TITLES || '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)

export function hiddenTitle(title) {
  if (typeof title !== 'string') return false
  const t = title.trim().toLowerCase()
  return TITLES().includes(t)
}

export function isAdmin(req, hosted) {
  return !hosted || req.headers['x-truss-admin'] === '1'
}
