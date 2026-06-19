import type Database from "better-sqlite3";
import { pruneIndexes } from "./ttl.js";
import { enqueue } from "./queue.js";

/**
 * Automatic pruning scheduler (Step 23).
 *
 * Runs pruneIndexes on server startup, after index creation, and on a periodic
 * idle timer. All pruning goes through the single-writer queue so it never
 * blocks queries (WAL lets readers see the prior snapshot).
 */

const IDLE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

let timer: ReturnType<typeof setInterval> | null = null;

/** Run an immediate prune (queued, non-blocking). */
export function pruneNow(db: Database.Database): void {
  void enqueue(() => pruneIndexes(db));
}

/** Schedule startup + periodic idle pruning. Returns a stop() function. */
export function scheduleAutoPrune(db: Database.Database): () => void {
  pruneNow(db);
  if (timer) clearInterval(timer);
  timer = setInterval(() => pruneNow(db), IDLE_INTERVAL_MS);
  return () => {
    if (timer) { clearInterval(timer); timer = null; }
  };
}