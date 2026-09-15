CREATE TABLE modules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('database', 'sheet', 'notebook')),
  title TEXT NOT NULL DEFAULT 'Untitled',
  icon TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX modules_list_idx ON modules (archived_at, sort_order, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules (id) ON DELETE CASCADE,
  page_id TEXT,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'script-output')),
  created_at TEXT NOT NULL
);

CREATE INDEX attachments_owner_idx ON attachments (module_id, page_id);
