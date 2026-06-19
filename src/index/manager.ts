import type Database from "better-sqlite3";
import type { GitScope } from "../git/scope.js";
import { computeIndexId } from "./identity.js";

/**
 * Index manager: create/activate branch-scoped indexes and track the active
 * index for the current process. WAL is already configured by openDb (Step 2).
 */

export interface IndexRow {
  id: string;
  repo_root: string;
  worktree_path: string;
  branch_name: string;
  head_sha: string;
  created_at: number;
  last_accessed_at: number;
  expires_at: number | null;
  pinned: number;
  status: string;
}

let activeIndexId: string | null = null;

/** Get or create the index row for the current git scope; touch access time. */
export function getOrCreateIndex(db: Database.Database, scope: GitScope): IndexRow {
  const id = computeIndexId(scope);
  const now = Date.now();
  const existing = db
    .prepare("SELECT * FROM indexes WHERE id = ?")
    .get(id) as IndexRow | undefined;
  if (existing) {
    db.prepare("UPDATE indexes SET last_accessed_at = ?, status = 'active', expires_at = NULL WHERE id = ?")
      .run(now, id);
    activeIndexId = id;
    return { ...existing, last_accessed_at: now, status: "active", expires_at: null };
  }
  db.prepare(
    `INSERT INTO indexes (id, repo_root, worktree_path, branch_name, head_sha, created_at, last_accessed_at, expires_at, pinned, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 'active')`,
  ).run(id, scope.repoRoot, scope.worktreePath, scope.branch, scope.headSha, now, now);
  activeIndexId = id;
  return {
    id,
    repo_root: scope.repoRoot,
    worktree_path: scope.worktreePath,
    branch_name: scope.branch,
    head_sha: scope.headSha,
    created_at: now,
    last_accessed_at: now,
    expires_at: null,
    pinned: 0,
    status: "active",
  };
}

/** Bump last_accessed_at for an index (used on every query). */
export function touchIndex(db: Database.Database, indexId: string): void {
  db.prepare("UPDATE indexes SET last_accessed_at = ? WHERE id = ?").run(Date.now(), indexId);
}

/** Set the active index for the current process. */
export function setActiveIndex(indexId: string): void {
  activeIndexId = indexId;
}

/** Current active index id (null if none activated yet). */
export function getActiveIndexId(): string | null {
  return activeIndexId;
}

/** Fetch an index row by id. */
export function getIndex(db: Database.Database, indexId: string): IndexRow | undefined {
  return db.prepare("SELECT * FROM indexes WHERE id = ?").get(indexId) as IndexRow | undefined;
}