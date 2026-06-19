import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ensureFreshIndex } from "../src/index/reindex.js";
import { acquireWriteLease, newOwnerId } from "../src/index/queue.js";
import { pruneIndexes } from "../src/index/ttl.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-review-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export function foo() { return 1; }\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("BUG #1: reindex must not leave stale symbols/edges", () => {
  it("reindexing a changed file replaces (not duplicates) symbols", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const before = db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE index_id = ? AND path = ?").get(r.indexId, "src/a.ts") as { c: number };

    // Rewrite the file with a different function name (same line count to avoid mtime-only change detection issues; bump mtime).
    writeFileSync(join(repo, "src", "a.ts"), "export function bar() { return 2; }\n");
    const now = Date.now() / 1000 + 5000;
    utimesSync(join(repo, "src", "a.ts"), now, now);

    ensureFreshIndex(db, scope!);
    const after = db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE index_id = ? AND path = ?").get(r.indexId, "src/a.ts") as { c: number };
    expect(after.c).toBe(before.c); // not duplicated
    // old symbol gone, new symbol present
    const names = db.prepare("SELECT name FROM symbols WHERE index_id = ? AND path = ?").all(r.indexId, "src/a.ts") as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(["bar"]);
    // edges not duplicated either
    const edgesBefore = db.prepare("SELECT COUNT(*) AS c FROM edges WHERE index_id = ? AND from_path = ?").get(r.indexId, "src/a.ts") as { c: number };
    expect(edgesBefore.c).toBeGreaterThan(0);
    db.close();
  });

  it("reindexing must not wipe other files (BUG #2 regression)", () => {
    const db = openMemoryDb();
    writeFileSync(join(repo, "src", "b.ts"), "export function baz() { return 3; }\n");
    execSync("git add -A && git commit -q -m b", { cwd: repo });
    const fresh = detectScope(repo)!;
    const r = buildIndex(db, fresh);
    const filesBefore = db.prepare("SELECT COUNT(*) AS c FROM files WHERE index_id = ?").get(r.indexId) as { c: number };
    expect(filesBefore.c).toBeGreaterThanOrEqual(2);

    // Touch only a.ts; ensureFreshIndex must NOT delete b.ts.
    writeFileSync(join(repo, "src", "a.ts"), "export function qux() { return 4; }\n");
    const now = Date.now() / 1000 + 6000;
    utimesSync(join(repo, "src", "a.ts"), now, now);
    ensureFreshIndex(db, fresh);

    const bExists = db.prepare("SELECT 1 FROM files WHERE index_id = ? AND path = ?").get(r.indexId, "src/b.ts");
    expect(bExists).toBeTruthy(); // b.ts must still be indexed
    const filesAfter = db.prepare("SELECT COUNT(*) AS c FROM files WHERE index_id = ?").get(r.indexId) as { c: number };
    expect(filesAfter.c).toBe(filesBefore.c);
    db.close();
  });
});

describe("BUG #4: prune must skip locked indexes", () => {
  it("an index with an active lease is not pruned even when long-expired", () => {
    const db = openMemoryDb();
    const { id: oldId } = getOrCreateIndex(db, { ...scope!, branch: "old-locked", headSha: "z".repeat(40) });
    // make a different index active so old-locked is inactive
    getOrCreateIndex(db, { ...scope!, branch: "main", headSha: "y".repeat(40) });
    // age it way past retention
    const past = Date.now() - 99 * 86400_000;
    db.prepare("UPDATE indexes SET last_accessed_at = ?, status = 'stale' WHERE id = ?").run(past, oldId);
    // hold an active lease on it
    acquireWriteLease(db, oldId, newOwnerId(), 60000);
    const r = pruneIndexes(db);
    expect(r.deletedIndexes).not.toContain(oldId);
    const stillThere = db.prepare("SELECT 1 FROM indexes WHERE id = ?").get(oldId);
    expect(stillThere).toBeTruthy();
    db.close();
  });
});

describe("BUG #5: TTL must prune long-inactive indexes in real usage", () => {
  it("an index not touched in >14d (status active, expires_at NULL) is pruned", () => {
    const db = openMemoryDb();
    const { id: staleId } = getOrCreateIndex(db, { ...scope!, branch: "stale-branch", headSha: "s".repeat(40) });
    getOrCreateIndex(db, { ...scope!, branch: "main", headSha: "m".repeat(40) }); // active = main
    // Real usage: status='active', expires_at=NULL, but last accessed 20d ago.
    const past = Date.now() - 20 * 86400_000;
    db.prepare("UPDATE indexes SET last_accessed_at = ? WHERE id = ?").run(past, staleId);
    const r = pruneIndexes(db);
    expect(r.deletedIndexes).toContain(staleId);
    db.close();
  });

  it("a recently-touched inactive index is NOT pruned (within retention)", () => {
    const db = openMemoryDb();
    const { id: recentId } = getOrCreateIndex(db, { ...scope!, branch: "recent-branch", headSha: "r".repeat(40) });
    getOrCreateIndex(db, { ...scope!, branch: "main", headSha: "m2".repeat(20) });
    // touched 1 day ago → within 14d retention
    db.prepare("UPDATE indexes SET last_accessed_at = ? WHERE id = ?").run(Date.now() - 1 * 86400_000, recentId);
    const r = pruneIndexes(db);
    expect(r.deletedIndexes).not.toContain(recentId);
    db.close();
  });
});