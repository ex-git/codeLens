import type Database from "better-sqlite3";
import { getActiveIndexId, getIndex, getOrCreateIndex } from "../index/manager.js";
import { pruneIndexes, type PruneResult } from "../index/ttl.js";

/**
 * cl_prune + cl_drop tools (Step 23).
 *
 * `cl_prune` runs the TTL sweep manually. `cl_drop` deletes a specific
 * branch/index by id, refusing to drop the currently active index.
 */

export function ctxPrune(db: Database.Database): PruneResult {
  return pruneIndexes(db);
}

export interface DropResult {
  deleted: boolean;
  indexId: string;
  reason?: string;
}

/** Drop a specific index by id or branch name. Refuses the active index. */
export function ctxDrop(db: Database.Database, target: { indexId?: string; branch?: string; worktreePath?: string }): DropResult {
  const active = getActiveIndexId();
  let indexId: string | undefined = target.indexId;

  if (!indexId && target.branch) {
    // Prefer an exact (branch, worktree) match; fall back to the most-recently-
    // accessed index on that branch so same-branch worktrees don't collide.
    const row = (target.worktreePath
      ? db.prepare("SELECT id FROM indexes WHERE branch_name = ? AND worktree_path = ? ORDER BY last_accessed_at DESC LIMIT 1").get(target.branch, target.worktreePath)
      : db.prepare("SELECT id FROM indexes WHERE branch_name = ? ORDER BY last_accessed_at DESC LIMIT 1").get(target.branch)) as { id: string } | undefined;
    indexId = row?.id;
  }
  if (!indexId) return { deleted: false, indexId: "", reason: "not found" };
  if (indexId === active) return { deleted: false, indexId, reason: "refused: active index" };

  const row = getIndex(db, indexId);
  if (!row) return { deleted: false, indexId, reason: "not found" };
  if (row.pinned) return { deleted: false, indexId, reason: "refused: pinned" };

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM chunks_fts WHERE index_id = ?").run(indexId);
    db.prepare("DELETE FROM chunks WHERE index_id = ?").run(indexId);
    db.prepare("DELETE FROM symbols WHERE index_id = ?").run(indexId);
    db.prepare("DELETE FROM edges WHERE index_id = ?").run(indexId);
        db.prepare("DELETE FROM files WHERE index_id = ?").run(indexId);
    db.prepare("DELETE FROM index_locks WHERE index_id = ?").run(indexId);
    db.prepare("DELETE FROM indexes WHERE id = ?").run(indexId);
  });
  tx();
  return { deleted: true, indexId };
}

void getOrCreateIndex;