import type Database from "better-sqlite3";
import type { GitScope } from "../git/scope.js";
import { getOrCreateIndex, getActiveIndexId } from "./manager.js";
import { scanFiles, type ScannedFile } from "./scanner.js";
import { indexFile, deleteFileFromIndex } from "./fts.js";
import { extractGDScriptClassNames } from "../graph/edges.js";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

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
  // Build class_name → file map for GDScript cross-file resolution
  const classNameMap = buildGDScriptClassNameMap(files, scope.repoRoot);

  let indexedFiles = 0;
  let totalChunks = 0;
  let skipped = 0;
  for (const f of files) {
    try {
      const r = indexFile(db, indexId, scope.repoRoot, f, knownFiles, classNameMap);
      indexedFiles++;
      totalChunks += r.chunkCount;
    } catch {
      skipped++;
    }
  }
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

/**
 * Build a map of GDScript class_name declarations to file paths.
 * Enables cross-file resolution of `extends ClassName` patterns.
 */
export function buildGDScriptClassNameMap(files: ScannedFile[], repoRoot: string): Map<string, string> {
  const multiMap = new Map<string, string[]>();
  for (const f of files) {
    if (f.language !== "gdscript") continue;
    const abs = posix.join(repoRoot, f.path);
    try {
      const source = readFileSync(abs, "utf-8");
      for (const name of extractGDScriptClassNames(source)) {
        const paths = multiMap.get(name);
        if (paths) {
          paths.push(f.path);
        } else {
          multiMap.set(name, [f.path]);
        }
      }
    } catch {
      // Skip unreadable files
    }
  }
  const map = new Map<string, string>();
  for (const [name, paths] of multiMap) {
    if (paths.length > 1) {
      console.warn(`Duplicate class_name "${name}" in: ${paths.join(", ")}`);
    }
    map.set(name, paths.sort()[0]!); // deterministic: alphabetically first
  }
  return map;
}