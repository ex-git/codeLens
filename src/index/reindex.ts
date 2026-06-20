import type Database from "better-sqlite3";
import type { GitScope } from "../git/scope.js";
import { scanFiles } from "./scanner.js";
import { diffFiles, type FreshnessDiff } from "./freshness.js";
import { indexFile, deleteFileFromIndex } from "./fts.js";
import { buildGDScriptClassNameMap } from "./indexer.js";
import { getOrCreateIndex } from "./manager.js";
import { acquireWriteLease, releaseWriteLease, newOwnerId } from "./queue.js";
import type { FileWatcher } from "./watcher.js";

/**
 * Incremental reindex (Step 10) + cross-process write lease (Step 11).
 *
 * Refreshes only changed/new/deleted files in per-file transactions, bounded
 * by a time budget. Acquires an advisory cross-process lease so two agent
 * processes don't both rebuild; readers see the prior committed snapshot (WAL).
 *
 * better-sqlite3 is synchronous + JS is single-threaded, so in-process writes
 * cannot interleave. The lease guards cross-process concurrency. The async
 * `enqueue` in queue.ts is used by the embedding worker (Step 18).
 */

export interface RefreshSummary {
  refreshed: number;
  deleted: number;
  pending: number;
  durationMs: number;
  locked?: boolean;
}

const DEFAULT_BUDGET_MS = 500;
const FULL_SCAN_INTERVAL_MS = 5000;
let lastFullScanAt = 0;
let activeWatcher: FileWatcher | null = null;

/** Register the process file watcher (called on server startup). */
export function registerWatcher(w: FileWatcher | null): void { activeWatcher = w; }

export function ensureFreshIndex(
  db: Database.Database,
  scope: GitScope,
  opts?: { budgetMs?: number; watcher?: FileWatcher },
): RefreshSummary {
  const row = getOrCreateIndex(db, scope);
  const indexId = row.id;
  const start = Date.now();
  const budget = opts?.budgetMs ?? DEFAULT_BUDGET_MS;
  const watcher = opts?.watcher ?? activeWatcher;

  // Watcher short-circuit: if a watcher is active, it has reported no changes
  // since the last full scan, and we scanned recently, skip the re-scan
  // entirely (the quiet-period optimization). A periodic full scan
  // (FULL_SCAN_INTERVAL_MS) catches anything the watcher missed.
  if (watcher?.active && watcher.dirty.size === 0 && (Date.now() - lastFullScanAt) < FULL_SCAN_INTERVAL_MS) {
    return { refreshed: 0, deleted: 0, pending: 0, durationMs: 0 };
  }

  // Cross-process write lease: skip if another process is mid-reindex.
  const owner = newOwnerId();
  // Lease duration must cover the full operation so a long-budget reindex isn't
  // stolen mid-flight by another process. >= 3x budget, minimum 30s.
  const leaseMs = Math.max(30000, budget * 3);
  if (!acquireWriteLease(db, indexId, owner, leaseMs)) {
    return { refreshed: 0, deleted: 0, pending: 0, durationMs: 0, locked: true };
  }
  try {
    lastFullScanAt = Date.now();
    // Always full-scan for correct changed/new/deleted detection. The watcher's
    // value is the quiet-period short-circuit above (skip the scan entirely when
    // nothing changed); a narrow "only dirty paths" path was removed because it
    // mis-classified every non-dirty stored file as deleted.
    if (watcher?.active) watcher.consume(); // drain any dirty set
    const scanned = scanFiles(scope.repoRoot);
    const diff: FreshnessDiff = diffFiles(db, indexId, scanned, scope.repoRoot);

    const toProcess = [...diff.changed, ...diff.newFiles];
    let refreshed = 0;
    const classNameMap = buildGDScriptClassNameMap(scanned, scope.repoRoot);
    let pending = 0;
    for (const f of toProcess) {
      if (Date.now() - start > budget) {
        pending = toProcess.length - refreshed;
        break;
      }
      try {
        indexFile(db, indexId, scope.repoRoot, f, new Set(), classNameMap);
        refreshed++;
      } catch {
        // skip unreadable
      }
    }

    let deleted = 0;
    for (const d of diff.deleted) {
      deleteFileFromIndex(db, indexId, d.path);
      deleted++;
    }

    return { refreshed, deleted, pending, durationMs: Date.now() - start };
  } finally {
    releaseWriteLease(db, indexId, owner);
  }
}