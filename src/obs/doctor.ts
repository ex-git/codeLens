import type Database from "better-sqlite3";
import { checkIntegrity } from "../index/recovery.js";
import { CODE_SCHEMA_VERSION } from "../db/migrations.js";
import { detectScope } from "../git/scope.js";
import { spawnSync } from "node:child_process";

/**
 * Doctor (Step 25): cross-cutting health check. Reports runtime/DB/extension
 * status so users/agents can diagnose. Uses PRAGMA quick_check (fast, not
 * full integrity_check).
 */

export interface DoctorResult {
  nodeVersion: string;
  betterSqlite3: boolean;
  gitPresent: boolean;
  schemaVersion: number | null;
  integrityOk: boolean;
  integrityMessage: string;
  walMode: string | null;
  inGitRepo: boolean;
  codeVersion: number;
}

export function runDoctor(db: Database.Database | null, repoRoot: string = process.cwd()): DoctorResult {
  let betterSqlite3 = false;
  let schemaVersion: number | null = null;
  let integrityOk = true;
  let integrityMessage = "ok";
  let walMode: string | null = null;

  if (db) {
    betterSqlite3 = true;
    try {
      const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null };
      schemaVersion = v.v ?? null;
    } catch { schemaVersion = null; }
    try {
      const r = checkIntegrity(db);
      integrityOk = r.ok;
      integrityMessage = r.message;
    } catch (err) {
      integrityOk = false;
      integrityMessage = err instanceof Error ? err.message : String(err);
    }
    try { walMode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined)?.journal_mode ?? null; } catch { /* ignore */ }
  }

  const scope = detectScope(repoRoot);
  const gitPresent = (() => { try { return spawnSync("git", ["--version"]).status === 0; } catch { return false; } })();

  return {
    nodeVersion: process.versions.node,
    betterSqlite3,
    gitPresent,
    schemaVersion,
    integrityOk,
    integrityMessage,
    walMode,
    inGitRepo: scope !== null,
    codeVersion: CODE_SCHEMA_VERSION,
  };
}