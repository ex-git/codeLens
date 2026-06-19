import { describe, it, expect } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { pruneIndexes, computeExpiry, RETENTION } from "../src/index/ttl.js";
import { acquireWriteLease, newOwnerId } from "../src/index/queue.js";

function scope(branch = "main", head = "a".repeat(40)) {
  return { repoRoot: "/r", worktreePath: "/r", branch, headSha: head, dirtyFiles: [], detached: false };
}

function expire(db: ReturnType<typeof openMemoryDb>, indexId: string, daysAgo: number) {
  const old = Date.now() - daysAgo * 86400_000;
  db.prepare("UPDATE indexes SET last_accessed_at = ?, expires_at = ?, status = 'stale' WHERE id = ?")
    .run(old, old + 1000, indexId); // expires_at already in the past
}

describe("computeExpiry", () => {
  it("active non-pinned with null expires_at → computed expiry (never-expire is the prune-time active guard, not status)", () => {
    // status='active' no longer means never-expire; the currently-active index
    // is guarded in pruneIndexes. So expiry is computed from last_accessed_at.
    const e = computeExpiry({ pinned: 0, status: "active", branch_name: "main", head_sha: "x", last_accessed_at: 2000, expires_at: null });
    expect(e).toBe(2000 + RETENTION.inactiveBranchDays * 86400_000);
  });
  it("explicit expires_at wins over computed", () => {
    const e = computeExpiry({ pinned: 0, status: "active", branch_name: "main", head_sha: "x", last_accessed_at: 2000, expires_at: 999 });
    expect(e).toBe(999);
  });
  it("pinned → null", () => {
    expect(computeExpiry({ pinned: 1, status: "stale", branch_name: "main", head_sha: "x", last_accessed_at: 0, expires_at: null })).toBeNull();
  });
  it("detached → 3 days from last access", () => {
    const e = computeExpiry({ pinned: 0, status: "stale", branch_name: "DETACHED", head_sha: "x", last_accessed_at: 1000, expires_at: null });
    expect(e).toBe(1000 + RETENTION.detachedDays * 86400_000);
  });
  it("inactive branch → 14 days from last access", () => {
    const e = computeExpiry({ pinned: 0, status: "stale", branch_name: "feature", head_sha: "x", last_accessed_at: 2000, expires_at: null });
    expect(e).toBe(2000 + RETENTION.inactiveBranchDays * 86400_000);
  });
});

describe("pruneIndexes guards", () => {
  it("deletes expired inactive index", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope("old-branch"));
    // Make a different index active so old-branch is considered inactive.
    getOrCreateIndex(db, scope("main", "b".repeat(40)));
    expire(db, id, 20); // 20 days ago, well past 14-day retention
    const before = db.prepare("SELECT COUNT(*) AS c FROM indexes").get() as { c: number };
    const r = pruneIndexes(db);
    const after = db.prepare("SELECT COUNT(*) AS c FROM indexes").get() as { c: number };
    expect(r.deletedIndexes).toContain(id);
    expect(after.c).toBe(before.c - 1);
    db.close();
  });

  it("never deletes the active index", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope("main"));
    expire(db, id, 99);
    const r = pruneIndexes(db);
    expect(r.deletedIndexes).not.toContain(id);
    expect((db.prepare("SELECT COUNT(*) AS c FROM indexes WHERE id = ?").get(id) as { c: number }).c).toBe(1);
    db.close();
  });

  it("never deletes pinned index", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope("pinned-branch"));
    db.prepare("UPDATE indexes SET pinned = 1 WHERE id = ?").run(id);
    expire(db, id, 99);
    const r = pruneIndexes(db);
    expect(r.deletedIndexes).not.toContain(id);
    db.close();
  });

  it("never deletes locked index", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope("locked-branch"));
    expire(db, id, 99);
    acquireWriteLease(db, id, newOwnerId(), 60000);
    const r = pruneIndexes(db);
    expect(r.deletedIndexes).not.toContain(id);
    db.close();
  });

  it("never deletes recently-accessed (grace window)", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope("recent-branch"));
    // set status stale but last_accessed very recent
    db.prepare("UPDATE indexes SET status = 'stale', expires_at = 1 WHERE id = ?").run(id);
    const r = pruneIndexes(db);
    expect(r.deletedIndexes).not.toContain(id);
    db.close();
  });

  it("deletes scoped rows (files/chunks/edges) with the index", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope("doomed"));
    db.prepare("INSERT INTO files (id, index_id, path, language, size, mtime_ms, content_hash, git_blob_sha, deleted, last_indexed_at) VALUES (?, ?, 'p.ts', 'ts', 1, 0, NULL, NULL, 0, 0)").run("f", id);
    db.prepare("INSERT INTO edges (id, index_id, from_id, to_id, from_path, to_path, type, confidence) VALUES (?, ?, NULL, NULL, 'a','b','imports', 1)").run("e", id);
    getOrCreateIndex(db, scope("main", "c".repeat(40))); // active = main, doomed inactive
    expire(db, id, 20);
    pruneIndexes(db);
    const f = db.prepare("SELECT COUNT(*) AS c FROM files WHERE index_id = ?").get(id) as { c: number };
    const e = db.prepare("SELECT COUNT(*) AS c FROM edges WHERE index_id = ?").get(id) as { c: number };
    expect(f.c).toBe(0);
    expect(e.c).toBe(0);
    db.close();
  });
});