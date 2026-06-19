import { describe, it, expect } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { ctxPrune, ctxDrop } from "../src/tools/prune.js";
import { scheduleAutoPrune } from "../src/index/autoprune.js";
import { enqueue } from "../src/index/queue.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";

function scope(branch = "main", head = "a".repeat(40)) {
  return { repoRoot: "/r", worktreePath: "/r", branch, headSha: head, dirtyFiles: [], detached: false };
}

describe("cl_prune", () => {
  it("runs a TTL sweep and returns a result", () => {
    const db = openMemoryDb();
    getOrCreateIndex(db, scope("main"));
    const r = ctxPrune(db);
    expect(r).toBeDefined();
    expect(Array.isArray(r.deletedIndexes)).toBe(true);
    db.close();
  });
});

describe("cl_drop", () => {
  it("drops an inactive index by id", () => {
    const db = openMemoryDb();
    const { id: doomed } = getOrCreateIndex(db, scope("old", "b".repeat(40)));
    getOrCreateIndex(db, scope("main", "c".repeat(40))); // make doomed inactive
    const r = ctxDrop(db, { indexId: doomed });
    expect(r.deleted).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS c FROM indexes WHERE id = ?").get(doomed) as { c: number }).c).toBe(0);
    db.close();
  });

  it("drops an inactive index by branch name", () => {
    const db = openMemoryDb();
    getOrCreateIndex(db, scope("feature-x", "d".repeat(40)));
    getOrCreateIndex(db, scope("main", "e".repeat(40))); // active = main
    const r = ctxDrop(db, { branch: "feature-x" });
    expect(r.deleted).toBe(true);
    db.close();
  });

  it("refuses to drop the active index", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope("main"));
    const r = ctxDrop(db, { indexId: id });
    expect(r.deleted).toBe(false);
    expect(r.reason).toMatch(/active/);
    db.close();
  });

  it("refuses to drop a pinned index", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope("pinned", "f".repeat(40)));
    db.prepare("UPDATE indexes SET pinned = 1 WHERE id = ?").run(id);
    getOrCreateIndex(db, scope("main", "g".repeat(40))); // active = main
    const r = ctxDrop(db, { indexId: id });
    expect(r.deleted).toBe(false);
    expect(r.reason).toMatch(/pinned/);
    db.close();
  });

  it("not found returns deleted=false", () => {
    const db = openMemoryDb();
    getOrCreateIndex(db, scope("main"));
    const r = ctxDrop(db, { indexId: "idx_nonexistent" });
    expect(r.deleted).toBe(false);
    expect(r.reason).toMatch(/not found/);
    db.close();
  });
});

describe("scheduleAutoPrune", () => {
  it("runs prune on startup (queued) and returns a stop fn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-autoprune-"));
    try {
      const path = join(dir, "test.db");
      const db = openDb(path);
      const stop = scheduleAutoPrune(db);
      // drain the queue so the queued prune completes
      await enqueue(() => undefined);
      expect(typeof stop).toBe("function");
      stop();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});