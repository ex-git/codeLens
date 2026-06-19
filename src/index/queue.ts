/**
 * Single-writer queue (Design Decisions #4 + Section 16 risk 2).
 *
 * Serializes all index writes through one promise chain per process so two
 * agent processes never corrupt rows. Readers (search/expand) bypass the queue
 * and read the prior committed snapshot (WAL allows this).
 *
 * Cross-process safety: index_locks table holds an advisory lease. If another
 * process holds a non-expired lease, writes skip (return a "locked" result) and
 * the caller surfaces partial freshness rather than blocking.
 */

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

type Task<T> = () => T | Promise<T>;

interface QueueState {
  tail: Promise<unknown>;
  active: boolean;
}

const state: QueueState = { tail: Promise.resolve(), active: false };

/** Enqueue a write task; runs after all prior writes complete. */
export function enqueue<T>(task: Task<T>): Promise<T> {
  const run = state.tail.then(task, task) as Promise<T>;
  state.tail = run.catch(() => { /* swallow to keep chain alive */ });
  return run;
}

/** Whether a write is currently executing. */
export function isWriteActive(): boolean {
  return state.active;
}

/**
 * Acquire an advisory cross-process write lease for an index. Returns true if
 * acquired (or already held by this process), false if another process holds a
 * non-expired lease. Releases on the next ensureFreshIndex completion.
 */
export function acquireWriteLease(db: Database.Database, indexId: string, owner = process.pid.toString(), leaseMs = 30000): boolean {
  const now = Date.now();
  const existing = db.prepare("SELECT owner, expires_at FROM index_locks WHERE index_id = ?").get(indexId) as
    | { owner: string; expires_at: number } | undefined;
  if (existing && existing.expires_at > now && existing.owner !== owner) {
    return false; // another process holds it
  }
  db.prepare(
    "INSERT INTO index_locks (index_id, owner, expires_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(index_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at",
  ).run(indexId, owner, now + leaseMs);
  return true;
}

/** Release the write lease if owned by this process. */
export function releaseWriteLease(db: Database.Database, indexId: string, owner = process.pid.toString()): void {
  db.prepare("DELETE FROM index_locks WHERE index_id = ? AND owner = ?").run(indexId, owner);
}

/** Generate a unique owner id (for tests that want isolation). */
export function newOwnerId(): string {
  return "own_" + randomUUID();
}