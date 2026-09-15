CREATE TABLE nb_pages (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules (id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES nb_pages (id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  icon TEXT,
  sort_order REAL NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '[]',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX nb_pages_tree_idx ON nb_pages (module_id, parent_id, sort_order);
