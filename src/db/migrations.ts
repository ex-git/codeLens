import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { SCHEMA_V1 } from "./schema.js";
import { backupBeforeMigration, restoreBackup } from "../index/recovery.js";

/**
 * Versioned schema + migration runner.
 *
 * - `runMigrations(db)` applies additive migrations up to CODE_SCHEMA_VERSION.
 * - Version guard: if the DB's applied version > CODE_SCHEMA_VERSION, throw
 *   `DbVersionMismatch` (caller must rebuild core index; saved contexts survive
 *   in a separate DB — Step 21).
 * - Migrations run inside a single transaction; a pre-migration backup copy is
 *   made before the first migration (Step 12 enhances with restore-on-failure).
 */

export class DbVersionMismatch extends Error {
  constructor(public dbVersion: number, public codeVersion: number) {
    super(`DB schema version ${dbVersion} is newer than code ${codeVersion}; rebuild required`);
    this.name = "DbVersionMismatch";
  }
}

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

/** v1 migration: create the full initial schema. */
export const MIGRATIONS: Migration[] = [
  { version: 1, description: "initial schema", sql: SCHEMA_V1 },
];

export const CODE_SCHEMA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

/** Read the highest applied version from the DB (0 if fresh). */
function appliedVersion(db: Database.Database): number {
  // schema_version may not exist yet on a truly fresh DB.
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { name?: string } | undefined;
  if (!row?.name) return 0;
  const r = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
  return r.v ?? 0;
}

/**
 * Apply pending migrations. Throws DbVersionMismatch if the DB is newer than
 * the code. Each migration runs in its own transaction. For file-backed DBs,
 * a backup copy is made before the first migration; on failure the backup is
 * restored (Section 16 risk 3).
 */
export function runMigrations(db: Database.Database, dbPath?: string): number {
  const current = appliedVersion(db);
  if (current > CODE_SCHEMA_VERSION) {
    throw new DbVersionMismatch(current, CODE_SCHEMA_VERSION);
  }
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return current;

  // Ensure schema_version table exists (v1 migration creates it, but guard).
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");

  // Backup file-backed DB before the first migration so we can restore on failure.
  let backed = false;
  if (dbPath && existsSync(dbPath)) {
    try {
      backupBeforeMigration(dbPath, pending[0]!.version);
      backed = true;
    } catch {
      // best-effort backup; continue without it
    }
  }

  for (const m of pending) {
    try {
      const apply = db.transaction(() => {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
          m.version,
          Date.now(),
        );
      });
      apply();
    } catch (err) {
      // Migration failed: attempt restore from backup.
      if (backed && dbPath) {
        try { restoreBackup(dbPath, pending[0]!.version); } catch { /* best-effort */ }
      }
      throw err;
    }
  }
  return CODE_SCHEMA_VERSION;
}