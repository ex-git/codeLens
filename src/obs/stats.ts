import type Database from "better-sqlite3";
import { getActiveIndexId, getIndex } from "../index/manager.js";

/**
 * Stats (Step 25): per-active-index counts, embedding backlog, last indexed.
 */

export interface StatsResult {
  active: boolean;
  indexId: string | null;
  branch: string | null;
  counts: Record<string, number>;
  lastIndexedAt: number | null;
  totalIndexes: number;
}

export function gatherStats(db: Database.Database): StatsResult {
  const id = getActiveIndexId();
  if (!id) {
    const total = db.prepare("SELECT COUNT(*) AS c FROM indexes").get() as { c: number };
    return { active: false, indexId: null, branch: null, counts: {}, lastIndexedAt: null, totalIndexes: total.c };
  }
  const row = getIndex(db, id);
  const tables = ["files", "symbols", "chunks", "edges", "index_locks"] as const;
  const counts = Object.fromEntries(
    tables.map((t) => {
      try {
        const r = db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE index_id = ?`).get(id) as { c: number };
        return [t, r.c];
      } catch {
        return [t, 0];
      }
    }),
  ) as Record<string, number>;
  return {
    active: true,
    indexId: id,
    branch: row?.branch_name ?? null,
    counts,
    lastIndexedAt: row?.last_accessed_at ?? null,
    totalIndexes: (db.prepare("SELECT COUNT(*) AS c FROM indexes").get() as { c: number }).c,
  };
}
