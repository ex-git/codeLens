import type Database from "better-sqlite3";
import { getActiveIndexId, touchIndex, getIndex } from "../index/manager.js";
import { extractSnippet, headlineSnippet } from "../search/snippet.js";
import { rank, normalize, type SignalScore } from "../search/rank.js";
import { neighbors, type GraphNeighbor } from "../graph/query.js";
import { ensureFreshIndex } from "../index/reindex.js";
import { getPendingPaths } from "../index/staleness.js";
import { splitIdentifiers } from "../search/identifiers.js";
import { queryTokens, quoteFtsTerm } from "../search/query.js";
import type { GitScope } from "../git/scope.js";

/**
 * cl_search: hybrid search scoped by the active index_id.
 *
 * FTS5 BM25 + symbol-name match + graph proximity, fused via
 * src/search/rank.ts. Returns compact ranked handles with cursor pagination.
 * Branch isolation: every query filters by the active index_id.
 */

export interface SearchHandle {
  handle: string;
  path: string;
  lines: string;
  score: number;
  why: string;
  preview: string;
  /** True when this file is known stale and should be read from disk directly. */
  stale?: boolean;
}

export interface SearchResult {
  indexId: string;
  query: string;
  count: number;
  results: SearchHandle[];
  freshness: "fresh" | "partial";
  pendingFiles?: number;
  nextCursor?: string | null;
  /** Graph neighbors of the top result, when `related: true` was requested. */
  related?: GraphNeighbor[];
}

const DEFAULT_LIMIT = 5;

export type SnippetMode = "none" | "headline" | "compact" | "full";
/** Ranks below this (0-indexed) keep a richer preview when no mode is forced. */
const RICH_PREVIEW_TOP_N = 3;

const QUERY_EXPANSION_MAX_TERMS = 16;

function queryTerms(query: string): string[] {
  const original = queryTokens(query);
  const seen = new Set(original.map((t) => t.toLowerCase()));
  const expanded = splitIdentifiers(query, { maxTokens: QUERY_EXPANSION_MAX_TERMS });
  const terms = [...original];
  for (const term of expanded) {
    const lower = term.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    terms.push(term);
  }
  return terms;
}

function ftsQuery(query: string): string {
  const original = queryTokens(query);
  if (original.length === 0) return "";
  const expressions: string[] = [];
  const seen = new Set<string>();
  for (const term of original) {
    const quoted = quoteFtsTerm(term);
    if (!seen.has(quoted)) {
      seen.add(quoted);
      expressions.push(quoted);
    }
    const parts = splitIdentifiers(term, { maxTokens: QUERY_EXPANSION_MAX_TERMS });
    if (parts.length > 1) {
      const group = `(${parts.map(quoteFtsTerm).join(" AND ")})`;
      if (!seen.has(group)) {
        seen.add(group);
        expressions.push(group);
      }
    }
  }
  return expressions.join(" OR ");
}

interface FtsRow { path: string; startLine: number; endLine: number; content: string; chunkId: string; symbolId: string | null; rank: number; contentType: string; }

function gatherFts(db: Database.Database, indexId: string, fts: string, limit: number, contentType?: "code" | "prose"): FtsRow[] {
  const typeClause = contentType ? " AND c.content_type = ?" : "";
  const params: unknown[] = contentType ? [fts, indexId, contentType, limit] : [fts, indexId, limit];
  return db
    .prepare(
      `SELECT c.path AS path, c.start_line AS startLine, c.end_line AS endLine,
              c.content AS content, c.id AS chunkId, c.symbol_id AS symbolId, c.content_type AS contentType,
              bm25(chunks_fts) AS rank
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.chunk_id
       WHERE chunks_fts MATCH ? AND chunks_fts.index_id = ?${typeClause}
       ORDER BY rank ASC LIMIT ?`,
    )
    .all(...params) as FtsRow[];
}

/** Build hybrid signals (FTS + symbol + graph). */
function buildSignals(db: Database.Database, indexId: string, query: string, ftsRows: FtsRow[]): SignalScore[] {
  const ftsNorm = normalize(ftsRows.map((r) => -r.rank));
  const terms = queryTerms(query).map((t) => t.toLowerCase()).filter((t) => t.length > 1);
  const symbolStmt = db.prepare(
    `SELECT 1 FROM symbols WHERE index_id = ? AND path = ? AND lower(name) LIKE ? LIMIT 1`,
  );
  const exactStmt = db.prepare(
    `SELECT 1 FROM symbols WHERE index_id = ? AND path = ? AND lower(name) = ? LIMIT 1`,
  );
  const chunkSymbolStmt = db.prepare(
    `SELECT lower(name) AS name FROM symbols WHERE index_id = ? AND id = ? LIMIT 1`,
  );
  const symbolNameById = new Map<string, string | null>();
  const topPaths = new Set(ftsRows.slice(0, 8).map((r) => r.path));
  const graphPaths = new Set<string>();
  for (const p of topPaths) {
    try {
      const ns = neighbors(db, indexId, p, { depth: 1 });
      graphPaths.add(p);
      for (const n of ns) graphPaths.add(n.path);
    } catch { /* ignore */ }
  }
  return ftsRows.map((r, i) => {
    let chunkSymbolName: string | null = null;
    if (r.symbolId) {
      if (!symbolNameById.has(r.symbolId)) {
        const row = chunkSymbolStmt.get(indexId, r.symbolId) as { name: string } | undefined;
        symbolNameById.set(r.symbolId, row?.name ?? null);
      }
      chunkSymbolName = symbolNameById.get(r.symbolId) ?? null;
    }
    const chunkSymMatch = !!chunkSymbolName && terms.some((t) => chunkSymbolName.includes(t));
    const chunkExactMatch = !!chunkSymbolName && terms.some((t) => chunkSymbolName === t);
    const fileSymMatch = terms.some((t) => !!symbolStmt.get(indexId, r.path, "%" + t + "%"));
    const fileExactMatch = terms.some((t) => !!exactStmt.get(indexId, r.path, t));
    const symMatch = chunkSymMatch ? 1 : (fileSymMatch ? 0.5 : 0);
    const exactMatch = chunkExactMatch ? 1 : (fileExactMatch ? 0.5 : 0);
    const pathLower = r.path.toLowerCase();
    const pathMatch = terms.some((t) => pathLower.includes(t));
    return {
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      chunkId: r.chunkId,
      fts: ftsNorm[i],
      symbol: symMatch,
      exact: exactMatch,
      graph: graphPaths.has(r.path) ? 1 : 0,
      pathHit: pathMatch ? 1 : 0,
      code: r.contentType === "code" ? 1 : 0,
    };
  });
}

function prelude(db: Database.Database, opts?: { scope?: GitScope; refreshBudgetMs?: number }): { freshness: "fresh" | "partial"; pendingFiles?: number } {
  let freshness: "fresh" | "partial" = "fresh";
  let pendingFiles: number | undefined;
  if (opts?.scope) {
    const r = ensureFreshIndex(db, opts.scope, { budgetMs: opts?.refreshBudgetMs });
    if (r.pending > 0) { freshness = "partial"; pendingFiles = r.pending; }
  }
  const indexId = getActiveIndexId();
  if (indexId) {
    const pending = getPendingPaths(indexId).size;
    if (pending > 0) { freshness = "partial"; pendingFiles = pending; }
  }
  return { freshness, pendingFiles };
}

export function ctxSearch(
  db: Database.Database,
  query: string,
  opts?: { limit?: number; cursor?: string; scope?: GitScope; refreshBudgetMs?: number; contentType?: "code" | "prose"; related?: boolean; snippet?: SnippetMode },
): SearchResult {
  const indexId = getActiveIndexId();
  if (!indexId || !getIndex(db, indexId)) throw new Error("no active index — call cl_refresh first");
  touchIndex(db, indexId);
  const { freshness, pendingFiles } = prelude(db, opts);
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const offset = decodeCursor(opts?.cursor);
  const fts = ftsQuery(query);
  if (fts.length === 0) {
    const out: SearchResult = { indexId, query, count: 0, results: [], freshness };
    if (pendingFiles !== undefined) out.pendingFiles = pendingFiles;
    return out;
  }
  const ftsRows = gatherFts(db, indexId, fts, limit * 4, opts?.contentType);
  const signals = buildSignals(db, indexId, query, ftsRows);
  const ranked = rank(signals);
  const page = ranked.slice(offset, offset + limit);
  const hasMore = offset + limit < ranked.length;
  const byChunk = new Map(ftsRows.map((r) => [r.chunkId, r]));
  const explicitMode = opts?.snippet;
  // Look up the smallest symbol overlapping a chunk's line range for a
  // signature-first headline preview.
  const sigStmt = db.prepare(
    `SELECT name, kind, signature FROM symbols
     WHERE index_id = ? AND path = ? AND start_line <= ? AND end_line >= ?
     ORDER BY (end_line - start_line) ASC`,
  );
  const queryTerms = query.toLowerCase().split(/[^a-z0-9_]+/i).filter((t) => t.length > 1);
  const headlineFor = (src: FtsRow): string => {
    let sig: string | null = null;
    try {
      const syms = sigStmt.all(indexId, src.path, src.endLine, src.startLine) as { name: string; kind: string; signature: string | null }[];
      const chosen = syms.find((s) => queryTerms.some((t) => s.name.toLowerCase().includes(t))) ?? syms[0];
      if (chosen) sig = chosen.signature ?? `${chosen.kind} ${chosen.name}`;
    } catch { /* symbols best-effort */ }
    return headlineSnippet(src.content, query, sig);
  };
  const renderPreview = (src: FtsRow, rankOffset: number): string => {
    const mode: SnippetMode = explicitMode ?? (rankOffset < RICH_PREVIEW_TOP_N ? "compact" : "headline");
    switch (mode) {
      case "none": return "";
      case "headline": return headlineFor(src);
      case "compact": return extractSnippet(src.content, query, 500);
      case "full": return extractSnippet(src.content, query, 1500);
    }
  };
  const pendingPaths = getPendingPaths(indexId);
  const results: SearchHandle[] = page.map((r, i) => {
    const src = r.chunkId ? byChunk.get(r.chunkId) : undefined;
    const rankOffset = offset + i;
    const item: SearchHandle = {
      handle: r.chunkId ?? "",
      path: r.path,
      lines: `${r.startLine}-${r.endLine}`,
      score: Math.round(r.score * 1000) / 1000,
      why: r.why.join(","),
      preview: src ? renderPreview(src, rankOffset) : "",
    };
    if (pendingPaths.has(r.path)) item.stale = true;
    return item;
  });
  const nextCursor = hasMore && results.length > 0 ? encodeCursor(offset + results.length, results[results.length - 1]!.handle || `${offset}`) : null;
  const out: SearchResult = { indexId, query, count: results.length, results, freshness };
  if (pendingFiles !== undefined) out.pendingFiles = pendingFiles;
  if (nextCursor) out.nextCursor = nextCursor;
  if (opts?.related && results[0]) {
    try {
      out.related = neighbors(db, indexId, results[0]!.path, { types: ["imports", "imported_by", "tests"], depth: 1 });
    } catch { /* graph best-effort */ }
  }
  return out;
}

function encodeCursor(rank: number, tiebreaker: string): string {
  return Buffer.from(`${rank}|${tiebreaker}`, "utf-8").toString("base64url");
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const dec = Buffer.from(cursor, "base64url").toString("utf-8");
    const rank = parseInt(dec.split("|")[0] ?? "0", 10);
    return Number.isFinite(rank) ? rank : 0;
  } catch {
    return 0;
  }
}