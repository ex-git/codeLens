import type Database from "better-sqlite3";

const indexingStatements = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** Reuse fixed indexing SQL within one database. Do not cache dynamic search SQL. */
export function prepareIndexStatement(db: Database.Database, sql: string): Database.Statement {
  let statements = indexingStatements.get(db);
  if (!statements) {
    statements = new Map();
    indexingStatements.set(db, statements);
  }
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

/**
 * Centralized index-row deletion helpers (Step 24 / DRY refactor 1d).
 *
 * These helpers execute the DELETE statements only; the caller owns the
 * surrounding transaction (per-file reindex and whole-index prune both wrap
 * these in `db.transaction(...)`).
 *
 * `deleteFileRows` has two edge modes because the two call sites have
 * intentionally different edge semantics:
 *   - "out": clear only THIS file's outbound edges (from_path = path). Inbound
 *     edges from other files stay valid while the file still exists.
 *   - "both": clear edges in either direction (from_path = path OR to_path =
 *     path), used when the file is fully removed.
 */

export function deleteFileRows(
  db: Database.Database,
  indexId: string,
  path: string,
  edgeMode: "out" | "both",
): void {
  prepareIndexStatement(db, "DELETE FROM chunks_fts WHERE index_id = ? AND path = ?").run(indexId, path);
  prepareIndexStatement(db, "DELETE FROM chunks WHERE index_id = ? AND path = ?").run(indexId, path);
  prepareIndexStatement(db, "UPDATE edges SET to_id = NULL WHERE index_id = ? AND to_path = ?").run(indexId, path);
  prepareIndexStatement(db, "DELETE FROM symbols WHERE index_id = ? AND path = ?").run(indexId, path);
  if (edgeMode === "out") {
    prepareIndexStatement(db, "DELETE FROM edges WHERE index_id = ? AND from_path = ?").run(indexId, path);
  } else {
    prepareIndexStatement(db, "DELETE FROM edges WHERE index_id = ? AND (from_path = ? OR to_path = ?)").run(indexId, path, path);
  }
  prepareIndexStatement(db, "DELETE FROM files WHERE index_id = ? AND path = ?").run(indexId, path);
}

/**
 * Delete every row belonging to an index, including the index row itself and
 * its write lease. The caller wraps this in a transaction (e.g. pruneIndexes).
 */
export function deleteIndexRows(db: Database.Database, indexId: string): void {
  db.prepare("DELETE FROM chunks_fts WHERE index_id = ?").run(indexId);
  db.prepare("DELETE FROM chunks WHERE index_id = ?").run(indexId);
  db.prepare("DELETE FROM symbols WHERE index_id = ?").run(indexId);
  db.prepare("DELETE FROM edges WHERE index_id = ?").run(indexId);
  db.prepare("DELETE FROM files WHERE index_id = ?").run(indexId);
  db.prepare("DELETE FROM index_locks WHERE index_id = ?").run(indexId);
  db.prepare("DELETE FROM indexes WHERE id = ?").run(indexId);
}