import type Database from "better-sqlite3";
import { getActiveIndexId, getIndex } from "../index/manager.js";
import { getPendingPaths } from "../index/staleness.js";

/**
 * cl_map: outline / repo-map.
 *
 * Returns per-file symbol signatures (the "repo map" pattern) for cheap
 * orientation, read directly from the indexed `symbols` table — no re-parse.
 * Scoped to the active index; bounded by a file cap so large dirs stay compact.
 */

export interface MapSymbol {
  name: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface MapFile {
  path: string;
  symbols: MapSymbol[];
  /** True when this file is known stale and should be read from disk directly. */
  stale?: boolean;
}

export interface MapResult {
  indexId: string;
  files: MapFile[];
  fileCount: number;
  truncated: boolean;
  freshness?: "fresh" | "partial";
  pendingFiles?: number;
}

const DEFAULT_FILE_LIMIT = 50;
const MAX_FILE_LIMIT = 200;

interface SymRow {
  path: string;
  name: string;
  kind: string;
  signature: string | null;
  start_line: number;
  end_line: number;
  exported: number;
}

/**
 * Outline symbols under `path` (a file or directory prefix), grouped by file.
 * Defaults to exported symbols only; pass `all: true` for everything.
 */
export function ctxMap(
  db: Database.Database,
  opts?: { path?: string; limit?: number; all?: boolean },
): MapResult {
  const indexId = getActiveIndexId();
  if (!indexId || !getIndex(db, indexId)) throw new Error("no active index — call cl_refresh first");

  const fileLimit = Math.min(Math.max(1, opts?.limit ?? DEFAULT_FILE_LIMIT), MAX_FILE_LIMIT);
  const prefix = (opts?.path ?? "").replace(/^\.?\//, "").replace(/\/$/, "");
  const exportedClause = opts?.all ? "" : " AND exported = 1";

  // Match a single file exactly OR any file under the directory prefix.
  const where = prefix
    ? ` AND (path = ? OR path LIKE ?)`
    : "";
  const params: unknown[] = prefix ? [indexId, prefix, prefix + "/%"] : [indexId];

  const rows = db
    .prepare(
      `SELECT path, name, kind, signature, start_line, end_line, exported
       FROM symbols
       WHERE index_id = ?${where}${exportedClause}
       ORDER BY path ASC, start_line ASC`,
    )
    .all(...params) as SymRow[];

  const byFile = new Map<string, MapSymbol[]>();
  for (const r of rows) {
    let arr = byFile.get(r.path);
    if (!arr) {
      if (byFile.size >= fileLimit) continue; // cap distinct files
      arr = [];
      byFile.set(r.path, arr);
    }
    arr.push({
      name: r.name,
      kind: r.kind,
      signature: r.signature,
      startLine: r.start_line,
      endLine: r.end_line,
      exported: !!r.exported,
    });
  }

  // Were there more files than the cap allowed?
  const distinctPaths = new Set(rows.map((r) => r.path));
  const truncated = distinctPaths.size > byFile.size;

  const pendingPaths = getPendingPaths(indexId);
  const files: MapFile[] = [...byFile.entries()].map(([path, symbols]) => {
    const item: MapFile = { path, symbols };
    if (pendingPaths.has(path)) item.stale = true;
    return item;
  });
  const out: MapResult = { indexId, files, fileCount: files.length, truncated, freshness: pendingPaths.size > 0 ? "partial" : "fresh" };
  if (pendingPaths.size > 0) out.pendingFiles = pendingPaths.size;
  return out;
}
