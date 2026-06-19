import type Database from "better-sqlite3";
import { getActiveIndexId, touchIndex, getIndex } from "../index/manager.js";
import { extractSnippet } from "../search/snippet.js";
import { rank, normalize, type SignalScore } from "../search/rank.js";
import { neighbors, type GraphNeighbor } from "../graph/query.js";
import { ensureFreshIndex } from "../index/reindex.js";
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
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  cursor: string;
  why?: string[];
}

export interface SearchResult {
  indexId: string;
  results: SearchHandle[];
  nextCursor: string | null;
  freshness: "fresh" | "partial";
  pendingFiles?: number;
  /** Graph neighbors of the top result, when `related: true` was requested. */
  related?: GraphNeighbor[];
}

const DEFAULT_LIMIT = 5;

function ftsQuery(query: string): string {
  const terms = query.split(/[^A-Za-z0-9_]+/i).filter((t) => t.length > 0);
  if (terms.length === 0) return "";
  return terms.map((t) => `"${t}"`).join(" OR ");
}

interface FtsRow { path: string; startLine: number; endLine: number; content: string; chunkId: string; rank: number; contentType: string; }

function gatherFts(db: Database.Database, indexId: string, fts: string, limit: number, contentType?: "code" | "prose"): FtsRow[] {
  const typeClause = contentType ? " AND c.content_type = ?" : "";
  const params: unknown[] = contentType ? [fts, indexId, contentType, limit] : [fts, indexId, limit];
  return db
    .prepare(
      `SELECT c.path AS path, c.start_line AS startLine, c.end_line AS endLine,
              c.content AS content, c.id AS chunkId, c.content_type AS contentType,
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
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/i).filter((t) => t.length > 1);
  const symbolStmt = db.prepare(
    `SELECT 1 FROM symbols WHERE index_id = ? AND path = ? AND lower(name) LIKE ? LIMIT 1`,
  );
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
    const symMatch = terms.some((t) => !!symbolStmt.get(indexId, r.path, "%" + t + "%"));
    return {
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      chunkId: r.chunkId,
      fts: ftsNorm[i],
      symbol: symMatch ? 1 : 0,
      graph: graphPaths.has(r.path) ? 1 : 0,
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
  return { freshness, pendingFiles };
}

export function ctxSearch(
  db: Database.Database,
  query: string,
  opts?: { limit?: number; cursor?: string; scope?: GitScope; refreshBudgetMs?: number; contentType?: "code" | "prose"; related?: boolean },
): SearchResult {
  const indexId = getActiveIndexId();
  if (!indexId || !getIndex(db, indexId)) throw new Error("no active index — call cl_refresh first");
  touchIndex(db, indexId);
  const { freshness, pendingFiles } = prelude(db, opts);
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const offset = decodeCursor(opts?.cursor);
  const fts = ftsQuery(query);
  if (fts.length === 0) return { indexId, results: [], nextCursor: null, freshness: "fresh" };
  const ftsRows = gatherFts(db, indexId, fts, limit * 4, opts?.contentType);
  const signals = buildSignals(db, indexId, query, ftsRows);
  const ranked = rank(signals);
  const page = ranked.slice(offset, offset + limit);
  const hasMore = offset + limit < ranked.length;
  const byChunk = new Map(ftsRows.map((r) => [r.chunkId, r]));
  const results: SearchHandle[] = page.map((r, i) => {
    const src = r.chunkId ? byChunk.get(r.chunkId) : undefined;
    const rankOffset = offset + i;
    return {
      handle: r.chunkId ?? "",
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      score: r.score,
      snippet: src ? extractSnippet(src.content, query) : r.path,
      cursor: encodeCursor(rankOffset, r.chunkId ?? `${rankOffset}`),
      why: r.why,
    };
  });
  const nextCursor = hasMore && results.length > 0 ? encodeCursor(offset + results.length, results[results.length - 1]!.handle || `${offset}`) : null;
  const out: SearchResult = { indexId, results, nextCursor, freshness, pendingFiles };
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