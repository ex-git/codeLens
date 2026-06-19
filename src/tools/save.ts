import type Database from "better-sqlite3";
import { saveContext, loadContext, listContexts, deleteContext, type SavedContext, type SavedContextItem } from "../context/store.js";

/**
 * cl_save / cl_load tools (Step 21).
 *
 * Persist working context (named handle sets + notes) in the separate contexts
 * DB so they survive core-index rebuilds. Items reference path+symbol (stable
 * across reindex), not chunk_id.
 */

export interface SaveResult {
  id: string;
  name: string;
  pinned: boolean;
  itemCount: number;
}

export function ctxSave(
  ctxDb: Database.Database,
  repoRoot: string,
  name: string,
  items: SavedContextItem[],
  opts?: { notes?: string; pinned?: boolean },
): SaveResult {
  const c = saveContext(ctxDb, repoRoot, name, items, opts);
  return { id: c.id, name: c.name, pinned: c.pinned, itemCount: items.length };
}

export interface LoadResult {
  context: SavedContext | null;
  items: SavedContextItem[];
}

export function ctxLoad(ctxDb: Database.Database, repoRoot: string, name: string): LoadResult {
  return loadContext(ctxDb, repoRoot, name);
}

export function ctxListContexts(ctxDb: Database.Database, repoRoot: string): SavedContext[] {
  return listContexts(ctxDb, repoRoot);
}

export function ctxDeleteContext(ctxDb: Database.Database, repoRoot: string, name: string): boolean {
  return deleteContext(ctxDb, repoRoot, name);
}