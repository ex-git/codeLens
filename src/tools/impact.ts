import type Database from "better-sqlite3";
import { requireActiveIndex } from "../index/manager.js";
import { freshnessFromPending, isStalePath, markStale } from "../index/staleness.js";
import { walkGraph, testsFor, documentsFor, type GraphNeighbor } from "../graph/query.js";
import { resolveExactSymbols, type IndexedSymbol } from "../graph/targets.js";

export interface ImpactTarget {
  path: string;
  symbolId?: string;
  symbol?: string;
  kind?: string;
  signature?: string | null;
  lines?: string;
  stale?: boolean;
}

export interface ImpactCandidate extends ImpactTarget {
  id: string;
}

export interface ImpactHandle extends GraphNeighbor {
  handle: string;
  /** Where this impact edge came from: graph traversal or a conservative path heuristic. */
  provenance?: "graph" | "path-heuristic";
  confidenceLabel?: "high" | "medium" | "low";
}

export interface ImpactSummary {
  callers: number;
  callees: number;
  affectedFiles: number;
  affectedTests: number;
}

export interface ImpactResult {
  indexId: string;
  target?: ImpactTarget;
  candidates?: ImpactCandidate[];
  callers: ImpactHandle[];
  callees: ImpactHandle[];
  affectedFiles: ImpactHandle[];
  affectedTests: ImpactHandle[];
  documents?: ImpactHandle[];
  depth: number;
  summary?: ImpactSummary;
  confidenceNote: string;
  resolution?: "symbol" | "file";
  fileFallback?: { callers: ImpactHandle[]; callees: ImpactHandle[] };
  truncated?: boolean;
  freshness?: "fresh" | "partial";
  pendingFiles?: number;
  omitted?: Record<string, number>;
}

const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 3;

function clampDepth(depth?: number): number {
  return Math.min(Math.max(1, depth ?? DEFAULT_DEPTH), MAX_DEPTH);
}

function confidenceLabel(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

function staleAware(indexId: string, n: GraphNeighbor, provenance: ImpactHandle["provenance"] = "graph"): ImpactHandle {
  const item: ImpactHandle = {
    ...n,
    handle: `rel:${n.path}`,
    provenance,
    confidenceLabel: confidenceLabel(n.confidence),
  };
  markStale(item, indexId, n.path);
  return item;
}

export function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function uniq(handles: ImpactHandle[]): ImpactHandle[] {
  const byKey = new Map<string, ImpactHandle>();
  for (const h of handles) {
    const key = `${h.path}\0${h.edgeType}`;
    const existing = byKey.get(key);
    if (!existing || h.hops < existing.hops || (h.hops === existing.hops && h.confidence > existing.confidence)) {
      byKey.set(key, h);
    }
  }
  return [...byKey.values()].sort((a, b) => a.hops - b.hops || b.confidence - a.confidence || a.edgeType.localeCompare(b.edgeType) || a.path.localeCompare(b.path));
}

function resolveSymbol(db: Database.Database, indexId: string, symbol: string, path?: string): IndexedSymbol[] {
  const exact = resolveExactSymbols(db, indexId, symbol, path || undefined, 20);
  if (exact.length > 0) return exact;
  const pathClause = path ? " AND path = ?" : "";
  const likeParams: unknown[] = path ? [indexId, `%${symbol}%`, path] : [indexId, `%${symbol}%`];
  return db.prepare(
    `SELECT id, path, name, scope, kind, signature, start_line, end_line
     FROM symbols WHERE index_id = ? AND name LIKE ?${pathClause}
     ORDER BY path ASC, start_line ASC LIMIT 20`,
  ).all(...likeParams) as IndexedSymbol[];
}

function candidateFrom(row: IndexedSymbol, stale: boolean): ImpactCandidate {
  const c: ImpactCandidate = {
    id: row.id,
    symbolId: row.id,
    path: row.path,
    symbol: row.name,
    kind: row.kind,
    signature: row.signature,
    lines: `${row.start_line}-${row.end_line}`,
  };
  if (stale) c.stale = true;
  return c;
}

function targetFrom(row: IndexedSymbol | undefined, path: string, stale: boolean): ImpactTarget {
  if (!row) {
    const target: ImpactTarget = { path };
    if (stale) target.stale = true;
    return target;
  }
  const target: ImpactTarget = {
    path: row.path,
    symbolId: row.id,
    symbol: row.name,
    kind: row.kind,
    signature: row.signature,
    lines: `${row.start_line}-${row.end_line}`,
  };
  if (stale) target.stale = true;
  return target;
}

export function ctxImpact(
  db: Database.Database,
  opts: { symbol?: string; path?: string; depth?: number; includeTests?: boolean },
): ImpactResult {
  const indexId = requireActiveIndex(db);
  if (!opts.symbol && !opts.path) throw new Error("cl_impact requires symbol or path");

  const depth = clampDepth(opts.depth);
  const includeTests = opts.includeTests ?? true;
  let targetPath = opts.path?.replace(/^\.?\//, "");
  let targetSymbol: IndexedSymbol | undefined;

  if (opts.symbol) {
    const matches = resolveSymbol(db, indexId, opts.symbol, targetPath);
    if (matches.length > 1) {
      const candidates = matches.map((m) => candidateFrom(m, isStalePath(indexId, m.path)));
      const out: ImpactResult = {
        indexId,
        candidates,
        callers: [],
        callees: [],
        affectedFiles: [],
        affectedTests: [],
        depth,
        confidenceNote: "Multiple symbols matched; inspect candidate paths and line ranges before trusting impact results.",
        ...freshnessFromPending(indexId),
      };
      return out;
    }
    targetSymbol = matches[0];
    if (!targetSymbol) {
      const out: ImpactResult = {
        indexId,
        candidates: [],
        callers: [],
        callees: [],
        affectedFiles: [],
        affectedTests: [],
        depth,
        confidenceNote: "No indexed symbol matched; try cl_search or pass a repo-relative path.",
        ...freshnessFromPending(indexId),
      };
      return out;
    }
    targetPath = targetSymbol.path;
  }
  if (!targetPath) throw new Error("cl_impact could not resolve a target path");

  return impactForTarget(db, indexId, targetPath, targetSymbol, { depth, includeTests });
}

export interface ImpactLimits {
  depth: number; includeTests?: boolean;
  maxNodes?: number; maxEdges?: number; maxTestPaths?: number; limit?: number;
}

/** Internal exact-ID entry point. Batch consumers need no fuzzy name resolution. */
export function impactForTarget(db: Database.Database, indexId: string, targetPath: string, targetSymbol: IndexedSymbol | undefined, opts: ImpactLimits): ImpactResult {
  const { depth, includeTests = true } = opts;
  const bounds = { maxNodes: opts.maxNodes, maxEdges: opts.maxEdges };
  let truncated = false;
  const omitted: Record<string, number> = {};
  const cap = <T>(items: T[], name: string, limit = opts.limit): T[] => {
    if (limit === undefined || items.length <= limit) return items;
    omitted[name] = items.length - limit; truncated = true; return items.slice(0, limit);
  };
  const findTests = (path: string) => {
    if (opts.maxEdges === undefined) return testsFor(db, indexId, path);
    const walk = walkGraph(db, indexId, path, { ...bounds, types: ["tests"], depth: 1, direction: "in" });
    truncated ||= walk.truncated;
    return walk.results;
  };
  const fileIncoming = walkGraph(db, indexId, targetPath, { ...bounds, types: ["calls", "references", "imports", "imported_by"], depth, direction: "in" });
  const fileOutgoing = walkGraph(db, indexId, targetPath, { ...bounds, types: ["calls", "references", "imports"], depth, direction: "out" });
  const fileCallers = uniq(fileIncoming.results.map(n => staleAware(indexId, n)));
  const fileCallees = uniq(fileOutgoing.results.map(n => staleAware(indexId, n)));
  const incoming = targetSymbol ? walkGraph(db, indexId, targetPath, { ...bounds, symbolId: targetSymbol.id, types: ["calls", "inherits"], depth, direction: "in" }) : fileIncoming;
  const outgoing = targetSymbol ? walkGraph(db, indexId, targetPath, { ...bounds, symbolId: targetSymbol.id, types: ["calls", "inherits"], depth, direction: "out" }) : fileOutgoing;
  const callers = incoming.results.map(n => staleAware(indexId, n));
  const callees = outgoing.results.filter(n => !targetSymbol || n.symbolId).map(n => staleAware(indexId, n));
  const affectedFiles = uniq(callers);
  const affectedTests = includeTests
    ? uniq([
        ...findTests(targetPath).map((n) => staleAware(indexId, n)),
        ...cap(affectedFiles, "testPaths", opts.maxTestPaths).flatMap((f) => findTests(f.path).map((n) => staleAware(indexId, {
          ...n, hops: f.hops + n.hops, confidence: Math.min(f.confidence, n.confidence),
          chain: [...(f.chain ?? []), ...(n.chain ?? [])], stale: f.stale || n.stale,
        }))),
        ...affectedFiles.filter((f) => isTestPath(f.path)).map((f) => ({ ...f, edgeType: "tests", confidence: Math.min(f.confidence, 0.6), confidenceLabel: "medium" as const, provenance: "path-heuristic" as const })),
        ...callers.filter((f) => isTestPath(f.path)).map((f) => ({ ...f, edgeType: "tests", confidence: Math.min(f.confidence, 0.6), confidenceLabel: "medium" as const, provenance: "path-heuristic" as const })),
      ])
    : [];

  const docLinks = documentsFor(db, indexId, targetPath, targetSymbol?.id, opts.limit);
  const documents = docLinks.results.map(n => staleAware(indexId, n));
  const out: ImpactResult = {
    indexId,
    documents: cap(documents, "documents"),
    target: targetFrom(targetSymbol, targetPath, isStalePath(indexId, targetPath)),
    callers: cap(callers, "callers"),
    callees: cap(callees, "callees"),
    affectedFiles: cap(affectedFiles, "affectedFiles"),
    affectedTests: cap(affectedTests, "affectedTests"),
    depth,
    summary: {
      callers: callers.length,
      callees: callees.length,
      affectedFiles: affectedFiles.length,
      affectedTests: affectedTests.length,
    },
    resolution: targetSymbol ? "symbol" : "file",
    fileFallback: targetSymbol ? { callers: cap(fileCallers, "fileCallers"), callees: cap(fileCallees, "fileCallees") } : undefined,
    truncated: truncated || incoming.truncated || outgoing.truncated || fileIncoming.truncated || fileOutgoing.truncated || docLinks.truncated,
    ...(opts.limit === undefined ? {} : { omitted }),
    confidenceNote: "Impact is derived from static indexed edges, not runtime traces. Symbol requests follow resolved calls/inheritance only; fileFallback contains broader file dependencies, not proven symbol callers. TS/JS and Python static forms are supported; unresolved forms can be absent. path-heuristic tests are conservative and lower-confidence.",
    ...freshnessFromPending(indexId),
  };
  return out;
}
