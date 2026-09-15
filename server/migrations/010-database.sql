CREATE TABLE db_properties (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  sort_order REAL NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 200
);

CREATE INDEX db_properties_module_idx ON db_properties (module_id, sort_order);

CREATE TABLE db_rows (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules (id) ON DELETE CASCADE,
  sort_order REAL NOT NULL DEFAULT 0,
  "values" TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX db_rows_module_idx ON db_rows (module_id, sort_order);

CREATE TABLE db_views (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('table', 'board', 'list', 'gallery', 'calendar')),
  sort_order REAL NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX db_views_module_idx ON db_views (module_id, sort_order);
