-- The workspace UI stores each module as one versioned JSON document. The legacy tables
-- (db_*, worksheets, cells, nb_pages) are left in place and untouched: they are converted
-- into modules.doc the first time the workspace is read, and remain as a fallback.
ALTER TABLE modules ADD COLUMN doc TEXT;
ALTER TABLE modules ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- One row per accepted change, so clients can catch up after a dropped event stream.
CREATE TABLE workspace_log (
  rev INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  client TEXT,
  at TEXT NOT NULL
);
