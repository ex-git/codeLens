import type Database from "better-sqlite3";
import DatabaseSync from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Usage tracking — GLOBAL (per-user, not per-repo).
 *
 * Stored in a single ~/.codelens/usage.db so switching repos doesn't
 * hide your real usage. Each row is keyed by (tool, repo_id), so the snapshot
 * can show both totals and a per-repo breakdown.
 *
 * "bytes_saved" is a defensible estimate for DISCOVERY tools (cl_search,
 * cl_explore, cl_related, cl_impact): the agent would otherwise grep + read ~N files at ~avg file
 * size; instead it got compact handles. saved ≈ max(0, N*AVG_FILE_BYTES -
 * bytesServed). Non-discovery tools record calls + bytes_served but claim no
 * savings.
 */

const AVG_FILE_BYTES = 4096;
export const DISCOVERY_TOOLS = new Set(["cl_search", "cl_explore", "cl_related", "cl_impact"]);
/** Tools that count as "usage" (retrieval + context management). Operational
 *  tools (refresh/doctor/stats/prune/drop/current/usage) are NOT tracked — they
 *  are maintenance, not the agent using the retrieval system. */
export const TRACKED_TOOLS = new Set(["cl_search", "cl_explore", "cl_related", "cl_impact", "cl_expand", "cl_save", "cl_load"]);

function usageDbPath(): string {
  const dir = join(homedir(), ".codelens");
  mkdirSync(dir, { recursive: true });
  return join(dir, "usage.db");
}

export function repoId(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

/** Open the global usage DB (creates the table if missing). */
export function initUsageTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_usage (
    tool           TEXT NOT NULL,
    repo_id        TEXT NOT NULL,
    calls          INTEGER NOT NULL DEFAULT 0,
    last_called_at INTEGER,
    bytes_served   INTEGER NOT NULL DEFAULT 0,
    bytes_saved    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tool, repo_id)
  )`);
}

export function openGlobalUsageDb(): Database.Database {
  const db = new DatabaseSync(usageDbPath());
  db.pragma("journal_mode = WAL");
  initUsageTable(db);
  return db;
}

export interface ToolUsageRow {
  tool: string;
  calls: number;
  last_called_at: number | null;
  bytes_served: number;
  bytes_saved: number;
}
export interface RepoUsageRow { repo_id: string; calls: number; bytes_served: number; bytes_saved: number; }

export interface UsageSnapshot {
  perTool: ToolUsageRow[];
  perRepo: RepoUsageRow[];
  totals: { calls: number; bytes_served: number; bytes_saved: number };
}

export class UsageTracker {
  constructor(private db: Database.Database) {}

  /**
   * Record one tool call. `repoRoot` scopes the row; `resultText` is the JSON
   * returned. `savedOverride` (when provided) is a precomputed savings estimate
   * from actual indexed file sizes — used by the server wrapper for discovery
   * tools. When omitted, falls back to the flat `handles × AVG_FILE_BYTES` proxy.
   */
  record(tool: string, repoRoot: string, resultText: string, isError = false, savedOverride?: number): void {
    if (isError) return;
    const bytesServed = Buffer.byteLength(resultText, "utf-8");
    let bytesSaved: number;
    if (savedOverride !== undefined) {
      bytesSaved = Math.max(0, savedOverride);
    } else if (DISCOVERY_TOOLS.has(tool)) {
      const handles = countHandles(tool, resultText);
      bytesSaved = Math.max(0, handles * AVG_FILE_BYTES - bytesServed);
    } else {
      bytesSaved = 0;
    }
    const now = Date.now();
    const rid = repoId(repoRoot);
    this.db.prepare(
      `INSERT INTO tool_usage (tool, repo_id, calls, last_called_at, bytes_served, bytes_saved)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(tool, repo_id) DO UPDATE SET
         calls = calls + 1,
         last_called_at = excluded.last_called_at,
         bytes_served = bytes_served + excluded.bytes_served,
         bytes_saved = bytes_saved + excluded.bytes_saved`,
    ).run(tool, rid, now, bytesServed, bytesSaved);
  }

  snapshot(): UsageSnapshot {
    // Only report tracked (retrieval/context) tools — operational tools
    // (refresh/doctor/stats/...) are never usage even if stale rows exist.
    const tracked = [...TRACKED_TOOLS].map((t) => `'${t}'`).join(",");
    const perTool = this.db.prepare(
      `SELECT tool, SUM(calls) AS calls, MAX(last_called_at) AS last_called_at,
              SUM(bytes_served) AS bytes_served, SUM(bytes_saved) AS bytes_saved
       FROM tool_usage WHERE tool IN (${tracked}) GROUP BY tool ORDER BY calls DESC`,
    ).all() as ToolUsageRow[];
    const perRepo = this.db.prepare(
      `SELECT repo_id, SUM(calls) AS calls, SUM(bytes_served) AS bytes_served, SUM(bytes_saved) AS bytes_saved
       FROM tool_usage WHERE tool IN (${tracked}) GROUP BY repo_id ORDER BY calls DESC`,
    ).all() as RepoUsageRow[];
    const totals = perTool.reduce(
      (a, r) => ({ calls: a.calls + r.calls, bytes_served: a.bytes_served + r.bytes_served, bytes_saved: a.bytes_saved + r.bytes_saved }),
      { calls: 0, bytes_served: 0, bytes_saved: 0 },
    );
    return { perTool, perRepo, totals };
  }

  reset(): void { this.db.prepare("DELETE FROM tool_usage").run(); }
}

function countHandles(tool: string, resultText: string): number {
  try {
    const obj = JSON.parse(resultText) as {
      results?: unknown[];
      files?: unknown[];
      callers?: unknown[];
      callees?: unknown[];
      affectedFiles?: unknown[];
      affectedTests?: unknown[];
      candidates?: unknown[];
    };
    if (tool === "cl_explore") return Array.isArray(obj.files) ? obj.files.length : 0;
    if (tool === "cl_impact") {
      return [obj.callers, obj.callees, obj.affectedFiles, obj.affectedTests, obj.candidates]
        .filter(Array.isArray)
        .reduce((n, arr) => n + arr.length, 0);
    }
    return Array.isArray(obj.results) ? obj.results.length : 0;
  } catch { return 0; }
}

/**
 * Estimate context saved for a discovery call using ACTUAL indexed file sizes.
 * saved = max(0, sum(distinct result files' sizes) − bytesServed).
 * Capped at `cap` distinct files so a 100-neighbor `cl_related` result doesn't
 * inflate the total (the agent wouldn't read all 100 without the tool).
 */
export function estimateSavedFromPaths(
  db: Database.Database, indexId: string, paths: string[], bytesServed: number, cap = 50,
): number {
  const distinct = [...new Set(paths)].slice(0, cap);
  if (distinct.length === 0) return 0;
  const placeholders = distinct.map(() => "?").join(",");
  const row = db.prepare(
    `SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE index_id = ? AND path IN (${placeholders})`,
  ).get(indexId, ...distinct) as { total: number };
  return Math.max(0, (row.total ?? 0) - bytesServed);
}

/** Extract distinct result paths from a discovery tool's JSON result. */
export function extractDiscoveryPaths(resultText: string): string[] {
  try {
    const obj = JSON.parse(resultText) as {
      path?: string;
      target?: { path?: string };
      results?: Array<{ path?: string }>;
      files?: Array<{ path?: string }>;
      related?: Array<{ path?: string; sourcePath?: string }>;
      candidates?: Array<{ path?: string }>;
      callers?: Array<{ path?: string }>;
      callees?: Array<{ path?: string }>;
      affectedFiles?: Array<{ path?: string }>;
      affectedTests?: Array<{ path?: string }>;
    };
    const paths: string[] = [];
    if (typeof obj.path === "string") paths.push(obj.path);
    if (typeof obj.target?.path === "string") paths.push(obj.target.path);
    for (const r of obj.results ?? []) if (typeof r.path === "string") paths.push(r.path);
    for (const f of obj.files ?? []) if (typeof f.path === "string") paths.push(f.path);
    for (const r of obj.related ?? []) {
      if (typeof r.sourcePath === "string") paths.push(r.sourcePath);
      if (typeof r.path === "string") paths.push(r.path);
    }
    for (const arr of [obj.candidates, obj.callers, obj.callees, obj.affectedFiles, obj.affectedTests]) {
      for (const r of arr ?? []) if (typeof r.path === "string") paths.push(r.path);
    }
    return paths;
  } catch { return []; }
}

export { AVG_FILE_BYTES };