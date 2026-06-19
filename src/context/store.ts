import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

/**
 * Saved context store (Step 21).
 *
 * Lives in a SEPARATE SQLite DB file (contexts.db) keyed by repo_id, so it
 * survives core-index corruption rebuilds (Step 12) — only the core index DB
 * is rebuilt; saved contexts are untouched. Items reference path+symbol (not
 * chunk_id) so they remain valid across reindexes.
 */

const SCHEMA = readSchema();

function readSchema(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "schema.sql"), "utf-8");
}

export function repoId(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

function contextDbPath(repoRoot: string): string {
  const dir = join(homedir(), ".codelens", "contexts");
  mkdirSync(dir, { recursive: true });
  return join(dir, `contexts-${repoId(repoRoot)}.db`);
}

export interface SavedContext {
  id: string;
  repo_id: string;
  name: string;
  notes: string | null;
  pinned: boolean;
  created_at: number;
  last_accessed_at: number;
}

export interface SavedContextItem {
  handle?: string;
  path?: string;
  symbol_id?: string;
  chunk_id?: string;
}

/** Open (or create) the separate contexts DB for a repo. */
export function openContextDb(repoRoot: string): Database.Database {
  const path = contextDbPath(repoRoot);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/** For tests: open an in-memory contexts DB. */
export function openMemoryContextDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

export function saveContext(
  db: Database.Database,
  repoRoot: string,
  name: string,
  items: SavedContextItem[],
  opts?: { notes?: string; pinned?: boolean },
): SavedContext {
  const rid = repoId(repoRoot);
  const now = Date.now();
  const id = "ctx_" + createHash("sha256").update(rid + name).digest("hex").slice(0, 16);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO saved_contexts (id, repo_id, name, notes, pinned, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET notes=excluded.notes, pinned=excluded.pinned, last_accessed_at=excluded.last_accessed_at`,
    ).run(id, rid, name, opts?.notes ?? null, opts?.pinned ? 1 : 0, now, now);
    db.prepare("DELETE FROM saved_context_items WHERE context_id = ?").run(id);
    const ins = db.prepare(
      `INSERT INTO saved_context_items (context_id, handle, path, symbol_id, chunk_id) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const it of items) {
      ins.run(id, it.handle ?? null, it.path ?? null, it.symbol_id ?? null, it.chunk_id ?? null);
    }
  });
  tx();
  return {
    id, repo_id: rid, name, notes: opts?.notes ?? null,
    pinned: !!opts?.pinned, created_at: now, last_accessed_at: now,
  };
}

export function loadContext(db: Database.Database, repoRoot: string, name: string): { context: SavedContext | null; items: SavedContextItem[] } {
  const rid = repoId(repoRoot);
  const ctx = db.prepare("SELECT * FROM saved_contexts WHERE repo_id = ? AND name = ?").get(rid, name) as SavedContext | undefined;
  if (!ctx) return { context: null, items: [] };
  db.prepare("UPDATE saved_contexts SET last_accessed_at = ? WHERE id = ?").run(Date.now(), ctx.id);
  const items = db.prepare("SELECT handle, path, symbol_id, chunk_id FROM saved_context_items WHERE context_id = ?").all(ctx.id) as SavedContextItem[];
  return { context: { ...ctx, pinned: !!ctx.pinned }, items };
}

export function listContexts(db: Database.Database, repoRoot: string): SavedContext[] {
  const rid = repoId(repoRoot);
  const rows = db.prepare("SELECT * FROM saved_contexts WHERE repo_id = ? ORDER BY last_accessed_at DESC").all(rid) as SavedContext[];
  return rows.map((r) => ({ ...r, pinned: !!r.pinned }));
}

export function deleteContext(db: Database.Database, repoRoot: string, name: string): boolean {
  const rid = repoId(repoRoot);
  const ctx = db.prepare("SELECT id FROM saved_contexts WHERE repo_id = ? AND name = ?").get(rid, name) as { id: string } | undefined;
  if (!ctx) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM saved_context_items WHERE context_id = ?").run(ctx.id);
    db.prepare("DELETE FROM saved_contexts WHERE id = ?").run(ctx.id);
  })();
  return true;
}

export { contextDbPath, existsSync };