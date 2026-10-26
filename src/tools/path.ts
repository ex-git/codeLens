import type Database from "better-sqlite3";
import { requireActiveIndex } from "../index/manager.js";
import { freshnessFromPending, isStalePath } from "../index/staleness.js";
import { bounded, STRUCTURAL_TYPES, walkGraph, type GraphStep } from "../graph/query.js";
import { resolveGraphTarget, type GraphTarget } from "../graph/targets.js";

export interface PathOptions {
  from: string; to: string; direction?: "out" | "in" | "both";
  types?: string[]; depth?: number; maxNodes?: number; maxEdges?: number;
}
export interface PathResult {
  indexId: string; found: boolean;
  status: "found" | "unresolved" | "incompatible-targets" | "not-found-within-limits";
  from?: GraphTarget; to?: GraphTarget; candidates?: { from: GraphTarget[]; to: GraphTarget[] };
  chain: GraphStep[]; confidence?: number; truncated: boolean; visited: number;
  depth: number; stale?: boolean; freshness: "fresh" | "partial"; pendingFiles?: number; note: string;
}
export function ctxPath(db: Database.Database, opts: PathOptions): PathResult {
  const indexId = requireActiveIndex(db);
  const depth = bounded(opts.depth, 6, 12);
  const from = resolveGraphTarget(db, indexId, opts.from);
  const to = resolveGraphTarget(db, indexId, opts.to);
  const result: PathResult = { indexId, found: false, status: "unresolved", chain: [], depth, truncated: false,
    visited: 0, ...freshnessFromPending(indexId), note: "Static indexed relationship path, not a proven runtime execution trace. Confidence is the minimum heuristic edge score." };
  if (from.length !== 1 || to.length !== 1) return { ...result, candidates: { from, to } };
  const a = from[0]!, b = to[0]!;
  result.from = a; result.to = b;
  if (Boolean(a.symbolId) !== Boolean(b.symbolId)) return { ...result, status: "incompatible-targets", note: "Use two file paths or two symbols; mixed-granularity paths are not inferred." };
  if (isStalePath(indexId, a.path) || isStalePath(indexId, b.path)) result.stale = true;
  if ((a.symbolId ?? a.path) === (b.symbolId ?? b.path)) return { ...result, found: true, status: "found", confidence: 1, visited: 1 };
  const walk = walkGraph(db, indexId, a.path, { ...opts, symbolId: a.symbolId, types: opts.types ?? STRUCTURAL_TYPES, depth, direction: opts.direction ?? "out" });
  const match = walk.results.find(n => a.symbolId ? n.symbolId === b.symbolId : n.path === b.path);
  return { ...result, found: Boolean(match), status: match ? "found" : "not-found-within-limits", chain: match?.chain ?? [],
    confidence: match?.confidence, stale: result.stale || match?.stale, visited: walk.visited, truncated: walk.truncated };
}
