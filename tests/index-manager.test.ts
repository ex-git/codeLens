import { describe, it, expect } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { computeIndexId } from "../src/index/identity.js";
import { getOrCreateIndex, touchIndex, getActiveIndexId, getIndex } from "../src/index/manager.js";
import type { GitScope } from "../src/git/scope.js";

function scope(branch: string, head = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"): GitScope {
  return {
    repoRoot: "/repo",
    worktreePath: "/repo",
    branch,
    headSha: head,
    dirtyFiles: [],
    detached: false,
  };
}

describe("computeIndexId", () => {
  it("produces distinct ids for different branches", () => {
    expect(computeIndexId(scope("main"))).not.toBe(computeIndexId(scope("feature-a")));
  });
  it("produces distinct ids for different heads on same branch", () => {
    expect(computeIndexId(scope("main", "aaa"))).not.toBe(computeIndexId(scope("main", "bbb")));
  });
  it("is stable for the same scope", () => {
    expect(computeIndexId(scope("main"))).toBe(computeIndexId(scope("main")));
  });
  it("throws on missing repoRoot", () => {
    const s = scope("main"); s.repoRoot = "";
    expect(() => computeIndexId(s)).toThrow();
  });
  it("allows empty headSha when detached", () => {
    const s = scope("DETACHED"); s.headSha = ""; s.detached = true;
    expect(() => computeIndexId(s)).not.toThrow();
  });
});

describe("index manager", () => {
  it("getOrCreateIndex inserts then returns existing", () => {
    const db = openMemoryDb();
    const a = getOrCreateIndex(db, scope("main"));
    expect(a.id).toBeTruthy();
    expect(getActiveIndexId()).toBe(a.id);
    const b = getOrCreateIndex(db, scope("main"));
    expect(b.id).toBe(a.id);
    db.close();
  });

  it("distinct scopes produce distinct index rows", () => {
    const db = openMemoryDb();
    const a = getOrCreateIndex(db, scope("main"));
    const b = getOrCreateIndex(db, scope("feature"));
    expect(a.id).not.toBe(b.id);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM indexes").get() as { c: number };
    expect(rows.c).toBe(2);
    db.close();
  });

  it("touchIndex updates last_accessed_at", () => {
    const db = openMemoryDb();
    const a = getOrCreateIndex(db, scope("main"));
    const before = getIndex(db, a.id)!.last_accessed_at;
    // Force a stale value in the past.
    db.prepare("UPDATE indexes SET last_accessed_at = ? WHERE id = ?").run(before - 10000, a.id);
    touchIndex(db, a.id);
    const after = getIndex(db, a.id)!.last_accessed_at;
    expect(after).toBeGreaterThan(before - 10000);
    db.close();
  });

  it("re-query reactivates and clears expires_at", () => {
    const db = openMemoryDb();
    const a = getOrCreateIndex(db, scope("main"));
    db.prepare("UPDATE indexes SET expires_at = ?, status = 'stale' WHERE id = ?").run(Date.now() + 1000, a.id);
    getOrCreateIndex(db, scope("main"));
    const row = getIndex(db, a.id)!;
    expect(row.status).toBe("active");
    expect(row.expires_at).toBeNull();
    db.close();
  });
});