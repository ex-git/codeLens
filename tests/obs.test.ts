import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { gatherStats } from "../src/obs/stats.js";
import { runDoctor } from "../src/obs/doctor.js";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { ctxSearch } from "../src/tools/search.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-obs-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export function foo() { return 1; }\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("gatherStats", () => {
  it("reports active=false when no index", () => {
    const db = openMemoryDb();
    const s = gatherStats(db);
    expect(s.active).toBe(false);
    expect(s.totalIndexes).toBe(0);
    db.close();
  });

  it("reports counts after build", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const s = gatherStats(db);
    expect(s.active).toBe(true);
    expect(s.counts.files).toBeGreaterThan(0);
    expect(s.counts.symbols).toBeGreaterThan(0);
    db.close();
  });

  it("totalIndexes counts multiple branches", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    getOrCreateIndex(db, { ...scope!, branch: "other", headSha: "b".repeat(40) });
    const s = gatherStats(db);
    expect(s.totalIndexes).toBeGreaterThanOrEqual(2);
    db.close();
  });
});

describe("runDoctor", () => {
  it("reports node version + better-sqlite3 + integrity ok", () => {
    const db = openMemoryDb();
    const d = runDoctor(db);
    expect(d.nodeVersion).toBeTruthy();
    expect(d.betterSqlite3).toBe(true);
    expect(d.integrityOk).toBe(true);
    expect(d.schemaVersion).toBeGreaterThan(0);
    db.close();
  });

  it("handles null db gracefully", () => {
    const d = runDoctor(null);
    expect(d.betterSqlite3).toBe(false);
    expect(d.integrityOk).toBe(true);
  });
});

describe("freshness field in search results", () => {
  it("ctxSearch surfaces freshness=fresh by default", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxSearch(db, "foo", { scope: scope! });
    expect(["fresh", "partial"]).toContain(r.freshness);
    db.close();
  });
});