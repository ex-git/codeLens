import type Database from "better-sqlite3";
import { getActiveIndexId, getIndex } from "../index/manager.js";
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
}

export interface RelatedResult {
  indexId: string;
  results: RelatedHandle[];
}

export function ctxRelated(
  db: Database.Database,
  path: string,
  opts?: { types?: string[]; depth?: number; direction?: "out" | "in" | "both" },
): RelatedResult {
  const indexId = getActiveIndexId();
  if (!indexId || !getIndex(db, indexId)) throw new Error("no active index — call cl_refresh first");
  const ns: GraphNeighbor[] = graphNeighbors(db, indexId, path, opts ?? {});
  const results: RelatedHandle[] = ns.map((n) => ({
    handle: `rel:${n.path}`,
    path: n.path,
    edgeType: n.edgeType,
    hops: n.hops,
    confidence: n.confidence,
  }));
  return { indexId, results };
}

/** cl_related variant: tests for a given source path. */
export function ctxRelatedTests(db: Database.Database, sourcePath: string): RelatedResult {
  const indexId = getActiveIndexId();
  if (!indexId || !getIndex(db, indexId)) throw new Error("no active index — call cl_refresh first");
  const ns = testsFor(db, indexId, sourcePath);
  return {
    indexId,
    results: ns.map((n) => ({ handle: `rel:${n.path}`, path: n.path, edgeType: n.edgeType, hops: n.hops, confidence: n.confidence })),
  };
}