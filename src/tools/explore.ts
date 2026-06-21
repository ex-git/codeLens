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

export interface ExploreTruncated {
  files?: number;
  results?: number;
  related?: number;
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
  /** Counts omitted by payload caps. */
  truncated?: ExploreTruncated;
}

interface SymbolSigRow {
  signature: string | null;
  name: string | null;
  kind: string | null;
}

const DEFAULT_LIMIT = 8;
const DEFAULT_MAX_FILES = 6;
const DEFAULT_MAX_RESULTS_PER_FILE = 3;
const DEFAULT_MAX_RELATED = 20;
const DEFAULT_RELATED_DEPTH = 1;
const MAX_RELATED_DEPTH = 3;
const RELATED_SOURCE_LIMIT = 3;

function clampPositive(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

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
  opts?: { limit?: number; cursor?: string; contentType?: "code" | "prose"; snippet?: SnippetMode; relatedDepth?: number; maxFiles?: number; maxResultsPerFile?: number; maxRelated?: number },
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

  const maxFiles = clampPositive(opts?.maxFiles, DEFAULT_MAX_FILES, 50);
  const maxResultsPerFile = clampPositive(opts?.maxResultsPerFile, DEFAULT_MAX_RESULTS_PER_FILE, 20);
  const maxRelated = clampPositive(opts?.maxRelated, DEFAULT_MAX_RELATED, 100);
  let omittedResults = 0;
  for (const file of byFile.values()) {
    file.results.sort((a, b) => b.score - a.score || a.lines.localeCompare(b.lines));
    if (file.results.length > maxResultsPerFile) {
      omittedResults += file.results.length - maxResultsPerFile;
      file.results = file.results.slice(0, maxResultsPerFile);
    }
  }
  const orderedFiles = [...byFile.values()].sort((a, b) => {
    const aScore = a.results[0]?.score ?? 0;
    const bScore = b.results[0]?.score ?? 0;
    return bScore - aScore || a.path.localeCompare(b.path);
  });
  const omittedFiles = Math.max(0, orderedFiles.length - maxFiles);
  const files = orderedFiles.slice(0, maxFiles);

  const relatedDepth = Math.min(Math.max(1, opts?.relatedDepth ?? DEFAULT_RELATED_DEPTH), MAX_RELATED_DEPTH);
  const related: ExploreRelation[] = [];
  const seenRelated = new Set<string>();
  for (const sourcePath of files.map((f) => f.path).slice(0, RELATED_SOURCE_LIMIT)) {
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

  related.sort((a, b) => a.hops - b.hops || b.confidence - a.confidence || a.sourcePath.localeCompare(b.sourcePath) || a.path.localeCompare(b.path));
  const omittedRelated = Math.max(0, related.length - maxRelated);
  const out: ExploreResult = {
    indexId,
    query: search.query,
    count: search.count,
    files,
    related: related.slice(0, maxRelated),
    freshness: search.freshness,
  };
  const truncated: ExploreTruncated = {};
  if (omittedFiles > 0) truncated.files = omittedFiles;
  if (omittedResults > 0) truncated.results = omittedResults;
  if (omittedRelated > 0) truncated.related = omittedRelated;
  if (Object.keys(truncated).length > 0) out.truncated = truncated;
  if (search.pendingFiles !== undefined) out.pendingFiles = search.pendingFiles;
  if (search.nextCursor) out.nextCursor = search.nextCursor;
  return out;
}
