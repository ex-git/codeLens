import type Database from "better-sqlite3";
import { copyFileSync, existsSync } from "node:fs";

/**
 * Corruption recovery (Section 16 risk 6) + migration backup (Section 16 risk 3).
 *
 * - `checkIntegrity(db)` runs PRAGMA quick_check (fast). On failure or on a
 *   SQLITE_CORRUPT error during a query, the caller rebuilds the core index.
 * - `backupBeforeMigration(dbPath)` copies the DB file to `.backup-vN` so a
 *   failed migration can be restored.
 * - `rebuildCoreIndex(db)` drops core tables (files/symbols/chunks/edges/
 *   chunks_fts) but NOT indexes rows metadata and NOT saved_contexts
 *   (which live in a separate DB — Step 21). Then re-runs migrations.
 */

export interface IntegrityResult {
  ok: boolean;
  message: string;
}

/** Fast integrity check via PRAGMA quick_check. */
export function checkIntegrity(db: Database.Database): IntegrityResult {
  try {
    const rows = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
    const msg = rows.map((r) => r.quick_check).join(" ");
    return { ok: msg === "ok", message: msg };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Copy the DB file to `<path>.backup-v<version>` for restore-on-migration-failure. */
export function backupBeforeMigration(dbPath: string, version: number): string {
  const backup = `${dbPath}.backup-v${version}`;
  copyFileSync(dbPath, backup);
  return backup;
}

/** Restore a backup over the DB file (used if migration fails). Caller closes DB first. */
export function restoreBackup(dbPath: string, version: number): boolean {
  const backup = `${dbPath}.backup-v${version}`;
  if (!existsSync(backup)) return false;
  copyFileSync(backup, dbPath);
  return true;
}

/**
 * Drop core index tables (keep indexes rows + schema_version) so the caller can
 * re-scan + reindex from scratch. saved_contexts are in a separate DB (Step 21)
 * and are untouched. This is the recovery path on corruption.
 */
export function dropCoreTables(db: Database.Database): void {
  // Order matters for FK: drop dependents first.
  db.exec(`
    DROP TABLE IF EXISTS embeddings;
    DROP TABLE IF EXISTS edges;
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS symbols;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS index_locks;
  `);
}

/** True if a thrown error looks like SQLite corruption. */
export function isCorruptionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("corrupt") || msg.includes("database disk image is malformed") || msg.includes("not a database");
}