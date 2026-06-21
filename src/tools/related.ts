import type Database from "better-sqlite3";
import { getActiveIndexId, getIndex } from "../index/manager.js";
import { getPendingPaths } from "../index/staleness.js";
import { neighbors as graphNeighbors, testsFor, type GraphNeighbor } from "../graph/query.js";

/**
 * cl_related (Step 16): graph expansion returning compact handles for
 * imports/imported_by/tests/callers at 1-2 hops, scoped to the active index.
 */

export interface RelatedHandle {
  handle: string;
  path: string;
  edgeType: string;
  hops: number;
  confidence: number;
  /** True when this file is known stale and should be read from disk directly. */
  stale?: boolean;
}

export interface RelatedResult {
  indexId: string;
  results: RelatedHandle[];
  freshness?: "fresh" | "partial";
  pendingFiles?: number;
}

export function ctxRelated(
  db: Database.Database,
  path: string,
  opts?: { types?: string[]; depth?: number; direction?: "out" | "in" | "both" },
): RelatedResult {
  const indexId = getActiveIndexId();
  if (!indexId || !getIndex(db, indexId)) throw new Error("no active index — call cl_refresh first");
  const ns: GraphNeighbor[] = graphNeighbors(db, indexId, path, opts ?? {});
  const pendingPaths = getPendingPaths(indexId);
  const results: RelatedHandle[] = ns.map((n) => {
    const item: RelatedHandle = {
      handle: `rel:${n.path}`,
      path: n.path,
      edgeType: n.edgeType,
      hops: n.hops,
      confidence: n.confidence,
    };
    if (pendingPaths.has(n.path)) item.stale = true;
    return item;
  });
  const out: RelatedResult = { indexId, results, freshness: pendingPaths.size > 0 ? "partial" : "fresh" };
  if (pendingPaths.size > 0) out.pendingFiles = pendingPaths.size;
  return out;
}

/** cl_related variant: tests for a given source path. */
export function ctxRelatedTests(db: Database.Database, sourcePath: string): RelatedResult {
  const indexId = getActiveIndexId();
  if (!indexId || !getIndex(db, indexId)) throw new Error("no active index — call cl_refresh first");
  const ns = testsFor(db, indexId, sourcePath);
  const pendingPaths = getPendingPaths(indexId);
  const out: RelatedResult = {
    indexId,
    results: ns.map((n) => {
      const item: RelatedHandle = { handle: `rel:${n.path}`, path: n.path, edgeType: n.edgeType, hops: n.hops, confidence: n.confidence };
      if (pendingPaths.has(n.path)) item.stale = true;
      return item;
    }),
    freshness: pendingPaths.size > 0 ? "partial" : "fresh",
  };
  if (pendingPaths.size > 0) out.pendingFiles = pendingPaths.size;
  return out;
}