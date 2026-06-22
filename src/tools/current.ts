import type Database from "better-sqlite3";
import { detectScope, type GitScope } from "../git/scope.js";
import { getIndex, setActiveIndex } from "../index/manager.js";
import { computeIndexId } from "../index/identity.js";
import { getAutoIndexStatus, hasPersistentIndex } from "../index/autoindex.js";

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
  status: "active" | "missing" | "stale" | "indexing";
  dirtyFiles: number;
  lastIndexedAt: number | null;
  indexStatus: string | null; // indexes.status column
  indexingStartedAt: number | null;
  indexingAgeMs: number | null;
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
      indexingStartedAt: null,
      indexingAgeMs: null,
      inGitRepo: false,
    };
  }
  const indexId = computeIndexId(s);
  const row = getIndex(db, indexId);
  const indexing = getAutoIndexStatus(indexId);
  const complete = hasPersistentIndex(db, s);
  if (complete && !indexing) setActiveIndex(indexId);
  return {
    repo: s.repoRoot,
    branch: s.branch,
    headSha: s.headSha,
    indexId: complete ? indexId : null,
    status: indexing ? "indexing" : complete ? (row?.status === "active" ? "active" : "stale") : "missing",
    dirtyFiles: s.dirtyFiles.length,
    lastIndexedAt: row?.last_accessed_at ?? null,
    indexStatus: row?.status ?? null,
    indexingStartedAt: indexing?.startedAt ?? null,
    indexingAgeMs: indexing?.ageMs ?? null,
    inGitRepo: true,
  };
}