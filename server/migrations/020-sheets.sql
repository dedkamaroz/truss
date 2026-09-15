CREATE TABLE worksheets (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL REFERENCES modules (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order REAL NOT NULL DEFAULT 0,
  col_widths TEXT NOT NULL DEFAULT '{}',
  row_heights TEXT NOT NULL DEFAULT '{}',
  frozen_rows INTEGER NOT NULL DEFAULT 0,
  frozen_cols INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX worksheets_module_idx ON worksheets (module_id, sort_order);

CREATE TABLE cells (
  sheet_id TEXT NOT NULL REFERENCES worksheets (id) ON DELETE CASCADE,
  row INTEGER NOT NULL,
  col INTEGER NOT NULL,
  raw TEXT,
  format TEXT,
  PRIMARY KEY (sheet_id, row, col)
) WITHOUT ROWID;
