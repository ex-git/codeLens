-- saved_contexts schema (separate DB file — survives core-index rebuild, Step 21)

CREATE TABLE IF NOT EXISTS saved_contexts (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL,        -- hash of repo root (scoping)
  name            TEXT NOT NULL,
  notes           TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  UNIQUE (repo_id, name)
);

CREATE TABLE IF NOT EXISTS saved_context_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id   TEXT NOT NULL,
  handle       TEXT,
  path          TEXT,
  symbol_id     TEXT,
  chunk_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_context ON saved_context_items(context_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_items ON saved_context_items(context_id, COALESCE(chunk_id, handle), path);
