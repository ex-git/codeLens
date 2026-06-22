import type Database from "better-sqlite3";
import { requireActiveIndex } from "../index/manager.js";
import { freshnessFromPending, isStalePath, markStale } from "../index/staleness.js";
import { neighbors, testsFor, type GraphNeighbor } from "../graph/query.js";

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

export interface ImpactHandle {
  handle: string;
  path: string;
  edgeType: string;
  hops: number;
  confidence: number;
  /** Where this impact edge came from: graph traversal or a conservative path heuristic. */
  provenance?: "graph" | "path-heuristic";
  confidenceLabel?: "high" | "medium" | "low";
  stale?: boolean;
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
  depth: number;
  summary?: ImpactSummary;
  confidenceNote: string;
  freshness?: "fresh" | "partial";
  pendingFiles?: number;
}

interface SymbolRow {
  id: string;
  path: string;
  name: string;
  kind: string;
  signature: string | null;
  start_line: number;
  end_line: number;
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
    handle: `rel:${n.path}`,
    path: n.path,
    edgeType: n.edgeType,
    hops: n.hops,
    confidence: n.confidence,
    provenance,
    confidenceLabel: confidenceLabel(n.confidence),
  };
  markStale(item, indexId, n.path);
  return item;
}

function isTestPath(path: string): boolean {
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

function resolveSymbol(db: Database.Database, indexId: string, symbol: string, path?: string): SymbolRow[] {
  const pathClause = path ? " AND path = ?" : "";
  const params: unknown[] = path ? [indexId, symbol, path] : [indexId, symbol];
  const exact = db.prepare(
    `SELECT id, path, name, kind, signature, start_line, end_line
     FROM symbols WHERE index_id = ? AND name = ?${pathClause}
     ORDER BY path ASC, start_line ASC LIMIT 20`,
  ).all(...params) as SymbolRow[];
  if (exact.length > 0) return exact;
  const likeParams: unknown[] = path ? [indexId, `%${symbol}%`, path] : [indexId, `%${symbol}%`];
  return db.prepare(
    `SELECT id, path, name, kind, signature, start_line, end_line
     FROM symbols WHERE index_id = ? AND name LIKE ?${pathClause}
     ORDER BY path ASC, start_line ASC LIMIT 20`,
  ).all(...likeParams) as SymbolRow[];
}

function candidateFrom(row: SymbolRow, stale: boolean): ImpactCandidate {
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

function targetFrom(row: SymbolRow | undefined, path: string, stale: boolean): ImpactTarget {
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
  let targetSymbol: SymbolRow | undefined;

  if (opts.symbol) {
    const matches = resolveSymbol(db, indexId, opts.symbol, targetPath);
    if (matches.length > 1 && !targetPath) {
      const candidates = matches.map((m) => candidateFrom(m, isStalePath(indexId, m.path)));
      const out: ImpactResult = {
        indexId,
        candidates,
        callers: [],
        callees: [],
        affectedFiles: [],
        affectedTests: [],
        depth,
        confidenceNote: "Multiple symbols matched; pass both symbol and path to disambiguate before trusting impact results.",
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

  const callers = uniq(neighbors(db, indexId, targetPath, { types: ["calls", "references", "imports", "imported_by"], depth, direction: "in" }).map((n) => staleAware(indexId, n)));
  const callees = uniq(neighbors(db, indexId, targetPath, { types: ["calls", "references", "imports"], depth, direction: "out" }).map((n) => staleAware(indexId, n)));
  const affectedFiles = uniq([
    ...callers,
    ...neighbors(db, indexId, targetPath, { types: ["imported_by", "references", "calls"], depth, direction: "in" }).map((n) => staleAware(indexId, n)),
  ]);
  const affectedTests = includeTests
    ? uniq([
        ...testsFor(db, indexId, targetPath).map((n) => staleAware(indexId, n)),
        ...affectedFiles.flatMap((f) => testsFor(db, indexId, f.path).map((n) => staleAware(indexId, n))),
        ...affectedFiles.filter((f) => isTestPath(f.path)).map((f) => ({ ...f, edgeType: "tests", confidence: Math.min(f.confidence, 0.6), confidenceLabel: "medium" as const, provenance: "path-heuristic" as const })),
        ...callers.filter((f) => isTestPath(f.path)).map((f) => ({ ...f, edgeType: "tests", confidence: Math.min(f.confidence, 0.6), confidenceLabel: "medium" as const, provenance: "path-heuristic" as const })),
      ])
    : [];

  const out: ImpactResult = {
    indexId,
    target: targetFrom(targetSymbol, targetPath, isStalePath(indexId, targetPath)),
    callers,
    callees,
    affectedFiles,
    affectedTests,
    depth,
    summary: {
      callers: callers.length,
      callees: callees.length,
      affectedFiles: affectedFiles.length,
      affectedTests: affectedTests.length,
    },
    confidenceNote: "Impact is derived from indexed file/symbol edges. calls/references are currently strongest for TS/JS; path-heuristic tests are conservative and lower-confidence; sparse languages may need cl_search/cl_expand follow-up.",
    ...freshnessFromPending(indexId),
  };
  return out;
}
