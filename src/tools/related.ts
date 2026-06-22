import type Database from "better-sqlite3";
import { requireActiveIndex } from "../index/manager.js";
import { freshnessFromPending, markStale } from "../index/staleness.js";
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
  const indexId = requireActiveIndex(db);
  const ns: GraphNeighbor[] = graphNeighbors(db, indexId, path, opts ?? {});
  const results: RelatedHandle[] = ns.map((n) => {
    const item: RelatedHandle = {
      handle: `rel:${n.path}`,
      path: n.path,
      edgeType: n.edgeType,
      hops: n.hops,
      confidence: n.confidence,
    };
    markStale(item, indexId, n.path);
    return item;
  });
  const out: RelatedResult = { indexId, results, ...freshnessFromPending(indexId) };
  return out;
}

/** cl_related variant: tests for a given source path. */
export function ctxRelatedTests(db: Database.Database, sourcePath: string): RelatedResult {
  const indexId = requireActiveIndex(db);
  const ns = testsFor(db, indexId, sourcePath);
  const out: RelatedResult = {
    indexId,
    results: ns.map((n) => {
      const item: RelatedHandle = { handle: `rel:${n.path}`, path: n.path, edgeType: n.edgeType, hops: n.hops, confidence: n.confidence };
      markStale(item, indexId, n.path);
      return item;
    }),
    ...freshnessFromPending(indexId),
  };
  return out;
}