CREATE TABLE scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bat', 'ps1')),
  config TEXT NOT NULL DEFAULT '{}',
  timeout_sec INTEGER NOT NULL DEFAULT 1800,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE script_runs (
  id TEXT PRIMARY KEY,
  script_id TEXT REFERENCES scripts (id) ON DELETE SET NULL,
  module_id TEXT,
  page_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  input_attachment_ids TEXT NOT NULL DEFAULT '[]',
  output_attachment_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX script_runs_owner_idx ON script_runs (module_id, page_id, created_at);
CREATE INDEX script_runs_status_idx ON script_runs (status);
CREATE INDEX script_runs_script_idx ON script_runs (script_id);
