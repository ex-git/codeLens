import Database from "better-sqlite3";
import { runMigrations, DbVersionMismatch } from "./migrations.js";
import { checkIntegrity, isCorruptionError } from "../index/recovery.js";

/**
 * Open a codelens SQLite database with safe defaults:
 *   - WAL journal mode (concurrent readers, single writer — Step 11)
 *   - foreign keys ON (cascade deletes scoped by index_id)
 *   - busy_timeout to tolerate brief write locks
 *   - migrations applied with version guard
 *
 * On `DbVersionMismatch`, the caller (recovery.ts — Step 12) decides whether
 * to rebuild the core index.
 */
export function openDb(path: string, opts?: { readonly?: boolean; skipIntegrityCheck?: boolean }): Database.Database {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: opts?.readonly ?? false });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    // Quick integrity check on startup (Section 16 risk 6). On corruption the
    // caller may catch CorruptDb and rebuild the core index.
    if (!opts?.skipIntegrityCheck) {
      const integrity = checkIntegrity(db);
      if (!integrity.ok) {
        db.close();
        throw new CorruptDb(integrity.message);
      }
    }
    runMigrations(db, path);
  } catch (err) {
    if (err instanceof DbVersionMismatch) throw err;
    if (err instanceof CorruptDb) throw err;
    if (isCorruptionError(err)) {
      try { db?.close(); } catch { /* ignore */ }
      throw new CorruptDb(err instanceof Error ? err.message : String(err));
    }
    try { db?.close(); } catch { /* ignore */ }
    throw err;
  }
  return db;
}

/** In-memory DB for tests (still applies migrations; no integrity backup path). */
export function openMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

export class CorruptDb extends Error {
  constructor(message: string) {
    super(`database corruption detected: ${message}`);
    this.name = "CorruptDb";
  }
}