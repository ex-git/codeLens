import type Database from "better-sqlite3";
import { detectScope, type GitScope } from "../git/scope.js";
import { getActiveIndexId, getIndex } from "../index/manager.js";

/**
 * cl_current (Step 8): repo/branch/index status with freshness fields.
 *
 * Tells the agent whether an index exists, is active, and how stale it is.
 */

export interface CurrentResult {
  repo: string;
  branch: string;
  headSha: string;
  indexId: string | null;
  status: "active" | "missing" | "stale";
  dirtyFiles: number;
  lastIndexedAt: number | null;
  indexStatus: string | null; // indexes.status column
  inGitRepo: boolean;
}

export function ctxCurrent(db: Database.Database, repoRoot: string, scope?: GitScope | null): CurrentResult {
  const s = scope ?? detectScope(repoRoot);
  if (!s) {
    return {
      repo: repoRoot,
      branch: "",
      headSha: "",
      indexId: null,
      status: "missing",
      dirtyFiles: 0,
      lastIndexedAt: null,
      indexStatus: null,
      inGitRepo: false,
    };
  }
  const activeId = getActiveIndexId();
  const row = activeId ? getIndex(db, activeId) : undefined;
  return {
    repo: s.repoRoot,
    branch: s.branch,
    headSha: s.headSha,
    indexId: activeId,
    status: row ? (row.status === "active" ? "active" : "stale") : "missing",
    dirtyFiles: s.dirtyFiles.length,
    lastIndexedAt: row?.last_accessed_at ?? null,
    indexStatus: row?.status ?? null,
    inGitRepo: true,
  };
}