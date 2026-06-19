import type Database from "better-sqlite3";
import type { GitScope } from "../git/scope.js";
import { buildIndex } from "../index/indexer.js";

/**
 * cl_refresh tool handler (Step 7).
 *
 * Creates or updates the current branch/worktree index. Returns compact status.
 * Wired into the MCP server in Step 24; callable directly here for tests.
 */

export interface RefreshResult {
  indexId: string;
  branch: string;
  headSha: string;
  indexedFiles: number;
  totalChunks: number;
  skipped: number;
  status: "ready";
}

export function ctxRefresh(db: Database.Database, scope: GitScope): RefreshResult {
  const r = buildIndex(db, scope);
  return {
    indexId: r.indexId,
    branch: scope.branch,
    headSha: scope.headSha,
    indexedFiles: r.indexedFiles,
    totalChunks: r.totalChunks,
    skipped: r.skipped,
    status: "ready",
  };
}