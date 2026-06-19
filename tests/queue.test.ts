import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { enqueue, acquireWriteLease, releaseWriteLease, newOwnerId, isWriteActive } from "../src/index/queue.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { ensureFreshIndex } from "../src/index/reindex.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-queue-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("enqueue", () => {
  it("runs tasks serially in order", async () => {
    const order: number[] = [];
    const t1 = enqueue(() => { order.push(1); return 1; });
    const t2 = enqueue(async () => { order.push(2); return 2; });
    const t3 = enqueue(() => { order.push(3); return 3; });
    await Promise.all([t1, t2, t3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("a rejected task does not break the chain", async () => {
    const r1 = enqueue(() => { throw new Error("boom"); });
    await r1.catch(() => {});
    const r2 = enqueue(() => "ok");
    expect(await r2).toBe("ok");
    expect(isWriteActive()).toBe(false);
  });
});

describe("write lease", () => {
  it("acquire then release allows re-acquire", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope!);
    const owner = newOwnerId();
    expect(acquireWriteLease(db, id, owner)).toBe(true);
    // same owner can re-acquire (idempotent)
    expect(acquireWriteLease(db, id, owner)).toBe(true);
    releaseWriteLease(db, id, owner);
    expect(acquireWriteLease(db, id, owner)).toBe(true);
    releaseWriteLease(db, id, owner);
    db.close();
  });

  it("second owner cannot acquire while first holds", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope!);
    const o1 = newOwnerId();
    const o2 = newOwnerId();
    acquireWriteLease(db, id, o1);
    expect(acquireWriteLease(db, id, o2)).toBe(false);
    releaseWriteLease(db, id, o1);
    expect(acquireWriteLease(db, id, o2)).toBe(true);
    releaseWriteLease(db, id, o2);
    db.close();
  });

  it("expired lease can be taken over", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope!);
    const o1 = newOwnerId();
    acquireWriteLease(db, id, o1, 1); // 1ms lease
    // wait for expiry
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    void wait(5).then(() => {
      const o2 = newOwnerId();
      expect(acquireWriteLease(db, id, o2)).toBe(true);
      releaseWriteLease(db, id, o2);
      db.close();
    });
  });
});

describe("ensureFreshIndex lease integration", () => {
  it("returns locked when another process holds lease", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, scope!);
    // Hold the lease with a different owner.
    const other = newOwnerId();
    acquireWriteLease(db, id, other, 60000);
    const r = ensureFreshIndex(db, scope!);
    expect(r.locked).toBe(true);
    expect(r.refreshed).toBe(0);
    releaseWriteLease(db, id, other);
    db.close();
  });

  it("completes normally when lease is free", () => {
    const db = openMemoryDb();
    ensureFreshIndex(db, scope!); // first run builds lease
    const r = ensureFreshIndex(db, scope!);
    expect(r.locked).toBeFalsy();
    db.close();
  });
});