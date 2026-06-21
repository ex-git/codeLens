import type Database from "better-sqlite3";
import type { GitScope } from "../git/scope.js";
import { getOrCreateIndex, getActiveIndexId } from "./manager.js";
import { scanFiles, type ScannedFile } from "./scanner.js";
import { indexFile, deleteFileFromIndex } from "./fts.js";
import { setPendingPaths } from "./staleness.js";

/**
 * Top-level indexer (Step 7).
 *
 * Builds the index for the current git scope: scan → per-file transactional
 * insert. Passes the set of known repo-relative paths to the file indexer so
 * import edges can resolve to indexed files (Step 14).
 */

export interface BuildResult {
  indexId: string;
  indexedFiles: number;
  totalChunks: number;
  skipped: number;
}

export function buildIndex(db: Database.Database, scope: GitScope): BuildResult {
  const row = getOrCreateIndex(db, scope);
  const indexId = row.id;
  const files = scanFiles(scope.repoRoot);
  const knownFiles = new Set(files.map((f) => f.path));
  const stored = db
    .prepare("SELECT path FROM files WHERE index_id = ? AND deleted = 0")
    .all(indexId) as { path: string }[];
  for (const row of stored) {
    if (!knownFiles.has(row.path)) deleteFileFromIndex(db, indexId, row.path);
  }
  let indexedFiles = 0;
  let totalChunks = 0;
  let skipped = 0;
  for (const f of files) {
    try {
      const r = indexFile(db, indexId, scope.repoRoot, f, knownFiles);
      indexedFiles++;
      totalChunks += r.chunkCount;
    } catch {
      skipped++;
    }
  }
  setPendingPaths(indexId, []);
  return { indexId, indexedFiles, totalChunks, skipped };
}

/** Convenience: ensure active index id is set after build. */
export function activeIndex(db: Database.Database): string {
  const id = getActiveIndexId();
  if (!id) throw new Error("no active index — call buildIndex or getOrCreateIndex first");
  void db;
  return id;
}

export type { ScannedFile };