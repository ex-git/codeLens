import type Database from "better-sqlite3";
import { getActiveIndexId } from "./manager.js";
import { deleteIndexRows as deleteIndexRowsStmt } from "../db/queries.js";

// Re-export the whole-index deletion helper for backward-compatible callers
// (e.g. tools/prune.ts). The statements live in db/queries.ts; this thin wrapper
// preserves the transactional contract existing callers rely on.
export function deleteIndexRows(db: Database.Database, indexId: string): void {
  const tx = db.transaction(() => deleteIndexRowsStmt(db, indexId));
  tx();
}

/**
 * TTL pruner (Step 22).
 *
 * Deletes inactive indexes per retention policy. NEVER deletes:
 *   - the active index
 *   - pinned indexes
 *   - indexes with an active (non-expired) write lease
 *   - indexes accessed within the grace window
 *
 * Default retention:
 *   active index: never (expires_at NULL)
 *   inactive branch: 14 days since last_access
 *   detached: 3 days
 *   temp worktree: 48h
 * Grace window: 1h (don't prune if accessed in the last hour even if expired).
 */

export const RETENTION = {
  inactiveBranchDays: 14,
  detachedDays: 3,
  worktreeHours: 48,
  graceMs: 3600_000,
};

export interface PruneResult {
  deletedIndexes: string[];
  skipped: number;
  bytesFreed: number; // estimated via row count * rough size; 0 if unknown
}

/** Compute an expires_at timestamp for an index row (ms since epoch). */
export function computeExpiry(row: {
  pinned: number;
  status: string;
  branch_name: string;
  head_sha: string;
  last_accessed_at: number;
  expires_at: number | null;
  worktree_path?: string;
}, _now = Date.now()): number | null {
  if (row.pinned) return null;
  // Explicit expires_at wins; NULL means "compute from last_accessed_at".
  // The currently-active index is guarded in pruneIndexes, not here: status='active'
  // just means "was active once", not "currently in use", so it must NOT bypass TTL
  // or no index would ever expire (every index is created with status='active').
  if (row.expires_at !== null) return row.expires_at;
  if (row.branch_name === "DETACHED") return row.last_accessed_at + RETENTION.detachedDays * 86400_000;
  if (row.worktree_path && row.worktree_path !== (row as { repo_root?: string }).repo_root) {
    return row.last_accessed_at + RETENTION.worktreeHours * 3600_000;
  }
  return row.last_accessed_at + RETENTION.inactiveBranchDays * 86400_000;
}


/** Prune expired inactive indexes. Respects never-delete guards. */
export function pruneIndexes(db: Database.Database, now = Date.now()): PruneResult {
  const active = getActiveIndexId();
  // Exclude indexes with an active (non-expired) write lease via NOT EXISTS.
  const rows = db.prepare(
    `SELECT i.id AS id, i.pinned AS pinned, i.status AS status, i.branch_name AS branch,
            i.last_accessed_at AS last, i.expires_at AS expires_at, i.worktree_path AS wpath, i.repo_root AS root
     FROM indexes i
     WHERE NOT EXISTS (
       SELECT 1 FROM index_locks l WHERE l.index_id = i.id AND l.expires_at > ?
     )`,
  ).all(now) as {
    id: string; pinned: number; status: string; branch: string; last: number;
    expires_at: number | null; wpath: string; root: string;
  }[];

  const deleted: string[] = [];
  let skipped = 0;

  for (const r of rows) {
    // Never-delete guards.
    if (r.id === active) { skipped++; continue; }
    if (r.pinned) { skipped++; continue; }
    if (now - r.last < RETENTION.graceMs) { skipped++; continue; }
    const expiry = r.expires_at ?? computeExpiry({ pinned: r.pinned, status: r.status, branch_name: r.branch, head_sha: "", last_accessed_at: r.last, expires_at: r.expires_at, worktree_path: r.wpath }, now);
    if (expiry === null || now < expiry) { skipped++; continue; }

    deleteIndexRows(db, r.id);
    deleted.push(r.id);
  }

  return { deletedIndexes: deleted, skipped, bytesFreed: 0 };
}