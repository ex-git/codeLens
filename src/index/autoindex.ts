import type Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitScope } from "../git/scope.js";
import { computeIndexId } from "./identity.js";
import { getIndex, setActiveIndex } from "./manager.js";

export type AutoIndexMode = "missing" | "always" | "never";

const MARKER_MAX_AGE_MS = 30 * 60 * 1000;

export interface AutoIndexStatus {
  indexId: string;
  repoRoot: string;
  startedAt: number;
  ageMs: number;
}

export function normalizeAutoIndexMode(value: string | undefined, fallback: AutoIndexMode = "missing"): AutoIndexMode {
  return value === "always" || value === "missing" || value === "never" ? value : fallback;
}

function markerDir(): string {
  return join(homedir(), ".codelens", "indexing");
}

function markerName(indexId: string): string {
  return createHash("sha256").update(indexId).digest("hex").slice(0, 32) + ".json";
}

export function autoIndexMarkerPath(indexId: string): string {
  return join(markerDir(), markerName(indexId));
}

export function markAutoIndexing(indexId: string, repoRoot: string): void {
  mkdirSync(markerDir(), { recursive: true });
  writeFileSync(autoIndexMarkerPath(indexId), JSON.stringify({ indexId, repoRoot, startedAt: Date.now() }) + "\n", "utf-8");
}

export function clearAutoIndexing(indexId: string): void {
  try { rmSync(autoIndexMarkerPath(indexId), { force: true }); } catch { /* best-effort */ }
}

export function getAutoIndexStatus(indexId: string): AutoIndexStatus | null {
  const marker = autoIndexMarkerPath(indexId);
  if (!existsSync(marker)) return null;
  try {
    const stat = statSync(marker);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > MARKER_MAX_AGE_MS) {
      clearAutoIndexing(indexId);
      return null;
    }
    const parsed = JSON.parse(readFileSync(marker, "utf-8")) as Partial<AutoIndexStatus>;
    if (parsed.indexId !== indexId || typeof parsed.repoRoot !== "string" || typeof parsed.startedAt !== "number") {
      clearAutoIndexing(indexId);
      return null;
    }
    return { indexId, repoRoot: parsed.repoRoot, startedAt: parsed.startedAt, ageMs: Date.now() - parsed.startedAt };
  } catch { /* stale/broken marker */ }
  clearAutoIndexing(indexId);
  return null;
}

export function isAutoIndexing(indexId: string): boolean {
  return getAutoIndexStatus(indexId) !== null;
}

export function hasPersistentIndex(db: Database.Database, scope: GitScope): boolean {
  const indexId = computeIndexId(scope);
  if (!getIndex(db, indexId)) return false;
  const row = db.prepare("SELECT COUNT(*) AS n FROM files WHERE index_id = ? AND deleted = 0").get(indexId) as { n: number };
  return row.n > 0;
}

export function activatePersistentIndexIfReady(db: Database.Database, scope: GitScope): string | null {
  const indexId = computeIndexId(scope);
  if (!hasPersistentIndex(db, scope) || isAutoIndexing(indexId)) return null;
  setActiveIndex(indexId);
  return indexId;
}

/**
 * Spawn a separate CodeLens CLI process to build the current branch index.
 * This keeps the MCP server responsive and gives the child its own DB handle.
 */
export function spawnAutoIndex(repoRoot: string, indexId: string): boolean {
  try {
    const serverJs = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
    if (!existsSync(serverJs)) return false;
    markAutoIndexing(indexId, repoRoot);
    const child = spawn(process.execPath, [serverJs, "--cwd", repoRoot, "--auto-index", "never", "index"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CODELENS_AUTO_INDEX_ID: indexId },
    });
    child.once("error", () => clearAutoIndexing(indexId));
    child.unref();
    return true;
  } catch {
    clearAutoIndexing(indexId);
    return false;
  }
}
