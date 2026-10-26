import type Database from "better-sqlite3";
import { requireActiveIndex } from "../index/manager.js";
import { freshnessFromPending, markStale } from "../index/staleness.js";
import { walkGraph, testsFor, type GraphNeighbor } from "../graph/query.js";

/**
 * cl_related (Step 16): graph expansion returning compact handles for
 * imports/imported_by/tests/callers at 1-2 hops, scoped to the active index.
 */

export interface RelatedHandle extends GraphNeighbor {
  handle: string;
}

export interface RelatedResult {
  indexId: string;
  results: RelatedHandle[];
  freshness?: "fresh" | "partial";
  pendingFiles?: number;
  truncated?: boolean;
}

export function ctxRelated(
  db: Database.Database,
  path: string,
  opts?: { types?: string[]; depth?: number; direction?: "out" | "in" | "both" },
): RelatedResult {
  const indexId = requireActiveIndex(db);
  const walk = walkGraph(db, indexId, path, { ...opts, depth: Math.min(3, Math.max(1, opts?.depth ?? 2)) });
  const ns = walk.results;
  const results: RelatedHandle[] = ns.map((n) => {
    const item: RelatedHandle = {
      ...n,
      handle: `rel:${n.path}`,
    };
    markStale(item, indexId, n.path);
    return item;
  });
  const out: RelatedResult = { indexId, results, truncated: walk.truncated, ...freshnessFromPending(indexId) };
  return out;
}

/** cl_related variant: tests for a given source path. */
export function ctxRelatedTests(db: Database.Database, sourcePath: string): RelatedResult {
  const indexId = requireActiveIndex(db);
  const ns = testsFor(db, indexId, sourcePath);
  const out: RelatedResult = {
    indexId,
    results: ns.map((n) => {
      const item: RelatedHandle = { ...n, handle: `rel:${n.path}` };
      markStale(item, indexId, n.path);
      return item;
    }),
    ...freshnessFromPending(indexId),
  };
  return out;
}