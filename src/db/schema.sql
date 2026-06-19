-- Context Expert — schema v1
-- All tables scoped by index_id (branch/worktree/head namespace).
-- Managed by src/db/migrations.ts; do not edit in place — add migrations.

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Index namespace: repo + worktree + branch + head
CREATE TABLE IF NOT EXISTS indexes (
  id           TEXT PRIMARY KEY,
  repo_root     TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  branch_name   TEXT NOT NULL,
  head_sha      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  expires_at    INTEGER,          -- NULL = active, never expire
  pinned        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'active'  -- active|stale|deleted
);

CREATE INDEX IF NOT EXISTS idx_indexes_branch ON indexes(branch_name);

-- File records within an index
CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  index_id      TEXT NOT NULL,
  path          TEXT NOT NULL,       -- POSIX repo-relative
  language      TEXT,
  size          INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  content_hash  TEXT,                 -- xxhash of content
  git_blob_sha  TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  last_indexed_at INTEGER NOT NULL,
  FOREIGN KEY (index_id) REFERENCES indexes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_files_index_path ON files(index_id, path);

-- Symbols (functions/classes/methods/types/exports/imports)
CREATE TABLE IF NOT EXISTS symbols (
  id          TEXT PRIMARY KEY,
  index_id    TEXT NOT NULL,
  file_id     TEXT NOT NULL,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- function|class|method|type|interface|constant|import|export
  signature   TEXT,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  exported    INTEGER NOT NULL DEFAULT 0,
  doc         TEXT,
  FOREIGN KEY (index_id) REFERENCES indexes(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_symbols_index_name ON symbols(index_id, name);
CREATE INDEX IF NOT EXISTS idx_symbols_index_file ON symbols(index_id, file_id);

-- Chunks (text slices for FTS + embedding)
CREATE TABLE IF NOT EXISTS chunks (
  id            TEXT PRIMARY KEY,
  index_id      TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  symbol_id     TEXT,
  path          TEXT NOT NULL,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  content       TEXT NOT NULL,
  content_hash  TEXT,
  content_type  TEXT NOT NULL DEFAULT 'prose', -- prose|code
  FOREIGN KEY (index_id) REFERENCES indexes(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chunks_index_file ON chunks(index_id, file_id);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol ON chunks(symbol_id);

-- FTS5 virtual table over chunk content (content-less external content via rowid map)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  path,
  index_id UNINDEXED,
  chunk_id UNINDEXED,
  tokenize = 'porter'
);

-- Graph edges
CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  index_id    TEXT NOT NULL,
  from_id     TEXT,
  to_id       TEXT,
  from_path   TEXT,
  to_path     TEXT,
  type        TEXT NOT NULL,          -- imports|imported_by|defines|exports|references|calls|tests|belongs_to
  confidence  REAL NOT NULL DEFAULT 1.0,
  FOREIGN KEY (index_id) REFERENCES indexes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_edges_index_from ON edges(index_id, from_id);
CREATE INDEX IF NOT EXISTS idx_edges_index_to ON edges(index_id, to_id);
CREATE INDEX IF NOT EXISTS idx_edges_index_type ON edges(index_id, type);


-- Advisory write locks (cross-process, leased)
CREATE TABLE IF NOT EXISTS index_locks (
  index_id    TEXT NOT NULL,
  owner       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (index_id)
);