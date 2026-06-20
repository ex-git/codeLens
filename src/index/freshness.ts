import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReal } from "../util/paths.js";
import { contentHash } from "../util/hash.js";
import type { ScannedFile } from "./scanner.js";
import { CHUNKER_VERSION } from "./fts.js";

/**
 * Freshness checker (Design Decision: freshness).
 *
 * Compares the scanned working tree against the indexed file rows. Uses fast
 * signals (size + mtime) first; only hashes changed/new files. Classifies each
 * path as unchanged | changed | new | deleted.
 */

export interface StoredFile {
  id: string;
  path: string;
  size: number;
  mtime_ms: number;
  content_hash: string | null;
}

export interface FreshnessDiff {
  unchanged: ScannedFile[];      // size+mtime match → skip hashing
  changed: ScannedFile[];        // size or mtime differ → needs reindex
  newFiles: ScannedFile[];       // not in index
  deleted: { path: string; id: string }[]; // in index, not on disk
}

/** Load indexed file rows for an index, keyed by POSIX path. */
function loadStored(db: Database.Database, indexId: string): Map<string, StoredFile> {
  const rows = db
    .prepare("SELECT id, path, size, mtime_ms, content_hash FROM files WHERE index_id = ? AND deleted = 0")
    .all(indexId) as StoredFile[];
  return new Map(rows.map((r) => [r.path, r]));
}

/** Paths with at least one chunk produced by an older or unknown chunker. */
function loadStaleChunkPaths(db: Database.Database, indexId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT path FROM chunks
       WHERE index_id = ? AND (chunker_version IS NULL OR chunker_version < ?)`,
    )
    .all(indexId, CHUNKER_VERSION) as { path: string }[];
  return new Set(rows.map((r) => r.path));
}

/**
 * Diff scanned files vs stored rows. Fast path: skip hashing when size AND
 * mtime match. Changed/new files are flagged for reindex (hashing happens
 * inside indexFile in Step 10).
 */
export function diffFiles(db: Database.Database, indexId: string, scanned: ScannedFile[], repoRoot: string): FreshnessDiff {
  const stored = loadStored(db, indexId);
  const staleChunkPaths = loadStaleChunkPaths(db, indexId);
  const scannedByPath = new Map(scanned.map((f) => [f.path, f]));
  const unchanged: ScannedFile[] = [];
  const changed: ScannedFile[] = [];
  const newFiles: ScannedFile[] = [];
  const deleted: { path: string; id: string }[] = [];

  for (const f of scanned) {
    const s = stored.get(f.path);
    if (!s) {
      newFiles.push(f);
    } else if (staleChunkPaths.has(f.path)) {
      changed.push(f);
    } else if (s.size === f.size && s.mtime_ms === f.mtimeMs) {
      unchanged.push(f);
    } else {
      changed.push(f);
    }
  }
  for (const [path, s] of stored) {
    if (!scannedByPath.has(path)) deleted.push({ path, id: s.id });
  }
  void repoRoot;
  return { unchanged, changed, newFiles, deleted };
}

/**
 * Strong check: recompute content hash and compare to stored. Used when mtime
 * is ambiguous (e.g. after a checkout that resets mtime). Returns true if the
 * file's content actually differs from what's indexed.
 */
export function contentChanged(repoRoot: string, file: ScannedFile, storedHash: string | null): boolean {
  if (!storedHash) return true;
  try {
    const root = resolveReal(repoRoot);
    const text = readFileSync(join(root, file.path), "utf-8");
    return contentHash(text) !== storedHash;
  } catch {
    return true; // unreadable → treat as changed (will be re-skipped by indexer)
  }
}