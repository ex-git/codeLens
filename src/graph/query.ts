import type Database from "better-sqlite3";
import { isStalePath } from "../index/staleness.js";

export interface EdgeRow {
  from_path: string; to_path: string; from_id: string | null; to_id: string | null;
  from_symbol: string | null; to_symbol: string | null; type: string; confidence: number;
  source_start_line: number | null; source_end_line: number | null; method: string | null;
}
export interface GraphStep {
  fromPath: string; toPath: string; edgeType: string; confidence: number;
  fromSymbol?: string; toSymbol?: string; fromSymbolId?: string; toSymbolId?: string;
  resolution: { from: "symbol" | "file"; to: "symbol" | "file" };
  source?: { path: string; startLine: number; endLine: number };
  method: string; reversed: boolean; stale?: boolean;
}
export interface GraphNeighbor {
  path: string; edgeType: string; hops: number; confidence: number;
  symbolId?: string; symbol?: string; chain?: GraphStep[]; stale?: boolean;
}
export interface WalkOptions {
  types?: string[]; depth?: number; direction?: "out" | "in" | "both";
  symbolId?: string; maxNodes?: number; maxEdges?: number;
}
export const STRUCTURAL_TYPES = ["imports", "calls", "references", "inherits"];
const EDGE_TYPES_ALL = [...STRUCTURAL_TYPES, "tests", "defines", "exports", "belongs_to", "documents"];
export function bounded(value: number | undefined, fallback: number, max: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(1, Math.floor(value)));
}
export function edgeEvidence(indexId: string, row: EdgeRow, reversed = false): GraphStep {
  const step: GraphStep = { fromPath: row.from_path, toPath: row.to_path, edgeType: row.type,
    confidence: row.confidence, method: row.method ?? "unavailable", reversed,
    resolution: { from: row.from_id ? "symbol" : "file", to: row.to_id ? "symbol" : "file" } };
  if (row.from_id) step.fromSymbolId = row.from_id;
  if (row.to_id) step.toSymbolId = row.to_id;
  if (row.from_symbol) step.fromSymbol = row.from_symbol;
  if (row.to_symbol) step.toSymbol = row.to_symbol;
  if (row.source_start_line !== null && row.source_end_line !== null) step.source = {
    path: row.from_path, startLine: row.source_start_line, endLine: row.source_end_line,
  };
  if (isStalePath(indexId, row.from_path) || isStalePath(indexId, row.to_path)) step.stale = true;
  return step;
}

/** Bounded breadth-first traversal. Prefer the strongest chain among shortest paths. */
export function walkGraph(db: Database.Database, indexId: string, startPath: string, opts: WalkOptions = {}): { results: GraphNeighbor[]; truncated: boolean; visited: number } {
  const depth = bounded(opts.depth, 2, 12);
  const maxNodes = bounded(opts.maxNodes, 1000, 5000);
  const maxEdges = bounded(opts.maxEdges, 5000, 20000);
  const requested = opts.types ?? EDGE_TYPES_ALL;
  const types = [...new Set(requested.map(t => t === "imported_by" ? "imports" : t))];
  if (!types.length) return { results: [], truncated: false, visited: 1 };
  const mode = opts.symbolId ? "id" : "path";
  const direction = opts.direction ?? "both";
  // imported_by is the incoming view of imports, even when no imports are requested.
  const aliasOnly = requested.includes("imported_by") && !requested.includes("imports");
  const both = aliasOnly || direction === "both";
  // Select the endpoint index explicitly. SQLite can otherwise prefer a broad
  // ordering-index scan over an exact endpoint lookup.
  const selectEndpoint = (side: "from" | "to") => `SELECT * FROM edges INDEXED BY idx_edges_index_${side}${mode === "path" ? "_path" : ""}
    WHERE index_id = ? AND ${side}_${mode} = ?
    AND type IN (${types.map(() => "?").join(",")}) AND to_path IS NOT NULL
    AND (type != 'documents' OR to_symbol IS NULL OR to_id IS NOT NULL)
    ${mode === "path" ? "AND from_path != to_path" : ""}`;
  // UNION counts self-edges once before applying the shared edge budget.
  const select = both ? `${selectEndpoint("from")} UNION ${selectEndpoint("to")}` : selectEndpoint(direction === "in" ? "to" : "from");
  const statement = db.prepare(`${select}
    ORDER BY from_path, to_path, type, source_start_line, from_symbol, to_symbol LIMIT ?`);
  interface State { key: string; path: string; confidence: number; chain: GraphStep[] }
  const start = opts.symbolId ?? startPath;
  let frontier: State[] = [{ key: start, path: startPath, confidence: 1, chain: [] }];
  const visited = new Set([start]);
  const result = new Map<string, GraphNeighbor>();
  let scanned = 0;
  let truncated = false;
  for (let hops = 1; hops <= depth && frontier.length; hops++) {
    const next = new Map<string, State>();
    for (const state of frontier) {
      if (scanned >= maxEdges) { truncated = true; break; }
      const remaining = maxEdges - scanned;
      const args = both ? [indexId, state.key, ...types, indexId, state.key, ...types, remaining + 1] : [indexId, state.key, ...types, remaining + 1];
      const rows = statement.all(...args) as EdgeRow[];
      if (rows.length > remaining) truncated = true;
      for (const row of rows.slice(0, remaining)) {
        scanned++;
        const from = mode === "id" ? row.from_id : row.from_path;
        const to = mode === "id" ? row.to_id : row.to_path;
        const reversed = to === state.key && from !== state.key;
        if (row.type === "imports" && aliasOnly && !reversed) continue;
        if (row.type !== "imports" && direction !== "both" && (direction === "in") !== reversed) continue;
        const path = reversed ? row.from_path : row.to_path;
        const symbolId = reversed ? row.from_id : row.to_id;
        const key = mode === "id" ? symbolId ?? `file:${path}` : path;
        if (key === start) continue;
        const prior = next.get(key);
        if (!visited.has(key) && !prior && visited.size + next.size >= maxNodes) { truncated = true; continue; }
        const confidence = Math.min(state.confidence, row.confidence);
        const chain = [...state.chain, edgeEvidence(indexId, row, reversed)];
        const edgeType = row.type === "imports" && requested.includes("imported_by") && reversed ? "imported_by" : row.type;
        const item: GraphNeighbor = { path, edgeType, hops, confidence, chain };
        if (chain.some(e => e.stale)) item.stale = true;
        if (mode === "id" && symbolId) item.symbolId = symbolId;
        const symbol = reversed ? row.from_symbol : row.to_symbol;
        if (mode === "id" && symbol) item.symbol = symbol;
        const resultKey = `${key}\0${edgeType}`;
        const old = result.get(resultKey);
        if (!old || hops < old.hops || hops === old.hops && confidence > old.confidence) result.set(resultKey, item);
        if (!visited.has(key) && (!prior || confidence > prior.confidence)) next.set(key, { key, path, confidence, chain });
      }
    }
    frontier = [...next.values()].sort((a, b) => b.confidence - a.confidence || a.path.localeCompare(b.path) || a.key.localeCompare(b.key));
    for (const state of frontier) visited.add(state.key);
    if (mode === "id") frontier = frontier.filter(s => !s.key.startsWith("file:"));
    if (truncated && scanned >= maxEdges) break;
  }
  return { results: [...result.values()].sort((a, b) => a.hops - b.hops || b.confidence - a.confidence || a.path.localeCompare(b.path) || a.edgeType.localeCompare(b.edgeType)), truncated, visited: visited.size };
}

export function neighbors(db: Database.Database, indexId: string, startPath: string, opts: WalkOptions = {}): GraphNeighbor[] {
  return walkGraph(db, indexId, startPath, { ...opts, depth: bounded(opts.depth, 2, 3) }).results;
}
export function documentsFor(db: Database.Database, indexId: string, path: string, symbolId?: string, limit?: number): { results: GraphNeighbor[]; truncated: boolean } {
  const cap = bounded(limit, 1000, 1000);
  const rows = db.prepare(`SELECT * FROM edges WHERE index_id = ? AND type = 'documents' AND to_path = ?
    AND (to_symbol IS NULL OR to_id IS NOT NULL) AND (? IS NULL OR to_symbol IS NULL OR to_id = ?)
    ORDER BY from_path, source_start_line LIMIT ?`).all(indexId, path, symbolId ?? null, symbolId ?? null, cap + 1) as EdgeRow[];
  const seen = new Set<string>();
  return { truncated: rows.length > cap, results: rows.slice(0, cap).filter(row => {
    if (seen.has(row.from_path)) return false; seen.add(row.from_path); return true;
  }).map(row => {
    const step = edgeEvidence(indexId, row, true);
    return { path: row.from_path, edgeType: row.type, hops: 1, confidence: row.confidence, chain: [step], stale: step.stale };
  }) };
}

export function testsFor(db: Database.Database, indexId: string, sourcePath: string): GraphNeighbor[] {
  return neighbors(db, indexId, sourcePath, { types: ["tests"], depth: 1, direction: "in" });
}
