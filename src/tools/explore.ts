import type Database from "better-sqlite3";
import { getActiveIndexId, getIndex } from "../index/manager.js";
import { getPendingPaths } from "../index/staleness.js";
import { neighbors, type GraphNeighbor } from "../graph/query.js";
import { ctxSearch, type SearchHandle, type SnippetMode } from "./search.js";

export interface ExploreItem {
  handle: string;
  lines: string;
  score: number;
  why: string;
  preview: string;
  signature?: string;
  collapsed?: number;
  stale?: boolean;
}

export interface ExploreFile {
  path: string;
  stale?: boolean;
  results: ExploreItem[];
}

export interface ExploreRelation extends GraphNeighbor {
  sourcePath: string;
  stale?: boolean;
}

export interface ExploreResult {
  indexId: string;
  query: string;
  count: number;
  files: ExploreFile[];
  related: ExploreRelation[];
  freshness: "fresh" | "partial";
  pendingFiles?: number;
  nextCursor?: string | null;
}

interface SymbolSigRow {
  signature: string | null;
  name: string | null;
  kind: string | null;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_RELATED_DEPTH = 1;
const MAX_RELATED_DEPTH = 3;
const RELATED_SOURCE_LIMIT = 3;

function signatureFor(db: Database.Database, indexId: string, handle: string): string | undefined {
  if (!handle) return undefined;
  const row = db.prepare(
    `SELECT s.signature AS signature, s.name AS name, s.kind AS kind
     FROM chunks c
     LEFT JOIN symbols s ON s.id = c.symbol_id AND s.index_id = c.index_id
     WHERE c.index_id = ? AND c.id = ?
     LIMIT 1`,
  ).get(indexId, handle) as SymbolSigRow | undefined;
  if (!row) return undefined;
  return row.signature ?? (row.kind && row.name ? `${row.kind} ${row.name}` : undefined);
}

function toExploreItem(hit: SearchHandle, signature?: string): ExploreItem {
  const item: ExploreItem = {
    handle: hit.handle,
    lines: hit.lines,
    score: hit.score,
    why: hit.why,
    preview: hit.preview,
  };
  if (signature) item.signature = signature;
  if (hit.stale) item.stale = true;
  return item;
}

export function ctxExplore(
  db: Database.Database,
  query: string,
  opts?: { limit?: number; cursor?: string; contentType?: "code" | "prose"; snippet?: SnippetMode; relatedDepth?: number },
): ExploreResult {
  const indexId = getActiveIndexId();
  if (!indexId || !getIndex(db, indexId)) throw new Error("no active index — call cl_refresh first");

  const search = ctxSearch(db, query, {
    limit: opts?.limit ?? DEFAULT_LIMIT,
    cursor: opts?.cursor,
    contentType: opts?.contentType,
    snippet: opts?.snippet ?? "compact",
  });
  const pendingPaths = getPendingPaths(indexId);
  const byFile = new Map<string, ExploreFile>();
  const seenSignatureByFile = new Map<string, Map<string, ExploreItem>>();

  for (const hit of search.results) {
    let file = byFile.get(hit.path);
    if (!file) {
      file = { path: hit.path, results: [] };
      if (pendingPaths.has(hit.path)) file.stale = true;
      byFile.set(hit.path, file);
    }

    const signature = signatureFor(db, indexId, hit.handle);
    if (signature) {
      let seenForFile = seenSignatureByFile.get(hit.path);
      if (!seenForFile) {
        seenForFile = new Map<string, ExploreItem>();
        seenSignatureByFile.set(hit.path, seenForFile);
      }
      const existing = seenForFile.get(signature);
      if (existing) {
        existing.collapsed = (existing.collapsed ?? 1) + 1;
        continue;
      }
      const item = toExploreItem(hit, signature);
      seenForFile.set(signature, item);
      file.results.push(item);
    } else {
      file.results.push(toExploreItem(hit));
    }
  }

  const relatedDepth = Math.min(Math.max(1, opts?.relatedDepth ?? DEFAULT_RELATED_DEPTH), MAX_RELATED_DEPTH);
  const related: ExploreRelation[] = [];
  const seenRelated = new Set<string>();
  for (const sourcePath of [...byFile.keys()].slice(0, RELATED_SOURCE_LIMIT)) {
    try {
      for (const n of neighbors(db, indexId, sourcePath, { types: ["imports", "imported_by", "tests", "calls", "references"], depth: relatedDepth })) {
        const key = `${sourcePath}\0${n.path}\0${n.edgeType}\0${n.hops}`;
        if (seenRelated.has(key)) continue;
        seenRelated.add(key);
        const item: ExploreRelation = { sourcePath, ...n };
        if (pendingPaths.has(n.path)) item.stale = true;
        related.push(item);
      }
    } catch {
      // Graph is best-effort; search results remain useful without it.
    }
  }

  const out: ExploreResult = {
    indexId,
    query: search.query,
    count: search.count,
    files: [...byFile.values()],
    related,
    freshness: search.freshness,
  };
  if (search.pendingFiles !== undefined) out.pendingFiles = search.pendingFiles;
  if (search.nextCursor) out.nextCursor = search.nextCursor;
  return out;
}
