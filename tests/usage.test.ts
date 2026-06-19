import { describe, it, expect } from "vitest";
import { UsageTracker, initUsageTable, repoId, TRACKED_TOOLS } from "../src/obs/usage.js";
import Database from "better-sqlite3";

function memDb() { const db = new Database(":memory:"); initUsageTable(db); return db; }

const REPO = "/repo/test";

describe("UsageTracker (global)", () => {
  it("records calls + bytes_served + bytes_saved for discovery tools", () => {
    const db = memDb();
    const u = new UsageTracker(db);
    u.record("cl_search", REPO, JSON.stringify({ results: [{}, {}, {}] }));
    const snap = u.snapshot();
    expect(snap.totals.calls).toBe(1);
    expect(snap.perTool[0]!.tool).toBe("cl_search");
    expect(snap.perTool[0]!.bytes_saved).toBeGreaterThan(0);
    db.close();
  });

  it("does not claim savings for non-discovery tools (cl_expand)", () => {
    const db = memDb();
    const u = new UsageTracker(db);
    u.record("cl_expand", REPO, "x".repeat(1000));
    const snap = u.snapshot();
    const expand = snap.perTool.find((t) => t.tool === "cl_expand")!;
    expect(expand.bytes_saved).toBe(0);
    expect(expand.bytes_served).toBe(1000);
    db.close();
  });

  it("aggregates across calls + repos (global totals)", () => {
    const db = memDb();
    const u = new UsageTracker(db);
    u.record("cl_search", "/repo/a", JSON.stringify({ results: [{}, {}] }));
    u.record("cl_search", "/repo/b", JSON.stringify({ results: [{}] }));
    u.record("cl_related", "/repo/a", JSON.stringify({ results: [{}] }));
    const snap = u.snapshot();
    expect(snap.totals.calls).toBe(3);
    expect(snap.perTool.find((t) => t.tool === "cl_search")!.calls).toBe(2);
    expect(snap.perRepo.length).toBe(2); // two distinct repos
    expect(snap.perRepo.find((r) => r.repo_id === repoId("/repo/a"))!.calls).toBe(2);
    db.close();
  });

  it("ignores error calls", () => {
    const db = memDb();
    const u = new UsageTracker(db);
    u.record("cl_search", REPO, "Error: boom", true);
    expect(u.snapshot().totals.calls).toBe(0);
    db.close();
  });

  it("reset clears all usage", () => {
    const db = memDb();
    const u = new UsageTracker(db);
    u.record("cl_search", REPO, JSON.stringify({ results: [] }));
    u.reset();
    expect(u.snapshot().totals.calls).toBe(0);
    db.close();
  });

  it("operational tools are NOT tracked by the server wrapper (TRACKED_TOOLS gate)", () => {
    // TRACKED_TOOLS is the server-side gate; UsageTracker itself records whatever
    // it's told. This test pins the tracked set so accidental inclusion of
    // cl_refresh/cl_doctor/etc. is caught.
    expect(TRACKED_TOOLS.has("cl_search")).toBe(true);
    expect(TRACKED_TOOLS.has("cl_related")).toBe(true);
    expect(TRACKED_TOOLS.has("cl_expand")).toBe(true);
    expect(TRACKED_TOOLS.has("cl_save")).toBe(true);
    expect(TRACKED_TOOLS.has("cl_load")).toBe(true);
    for (const op of ["cl_refresh", "cl_doctor", "cl_stats", "cl_prune", "cl_drop", "cl_current", "cl_usage"]) {
      expect(TRACKED_TOOLS.has(op)).toBe(false);
    }
  });
});
import { estimateSavedFromPaths, extractDiscoveryPaths } from "../src/obs/usage.js";
import { openMemoryDb } from "../src/db/db.js";
import { getOrCreateIndex } from "../src/index/manager.js";

describe("estimateSavedFromPaths (actual file sizes)", () => {
  it("sums distinct result files' indexed sizes minus bytes served", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, { repoRoot: "/r", worktreePath: "/r", branch: "main", headSha: "a".repeat(40), dirtyFiles: [], detached: false });
    db.prepare("INSERT INTO files (id,index_id,path,language,size,mtime_ms,content_hash,git_blob_sha,deleted,last_indexed_at) VALUES (?,?,'a.ts','ts',8000,0,NULL,NULL,0,0)").run("f1", id);
    db.prepare("INSERT INTO files (id,index_id,path,language,size,mtime_ms,content_hash,git_blob_sha,deleted,last_indexed_at) VALUES (?,?,'b.ts','ts',2000,0,NULL,NULL,0,0)").run("f2", id);
    // two result paths, 500 bytes served → saved = (8000+2000) - 500 = 9500
    const saved = estimateSavedFromPaths(db, id, ["a.ts", "b.ts"], 500);
    expect(saved).toBe(9500);
    db.close();
  });
  it("caps distinct files so huge cl_related results don't inflate", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, { repoRoot: "/r", worktreePath: "/r", branch: "main", headSha: "a".repeat(40), dirtyFiles: [], detached: false });
    for (let i = 0; i < 80; i++) db.prepare("INSERT INTO files (id,index_id,path,language,size,mtime_ms,content_hash,git_blob_sha,deleted,last_indexed_at) VALUES (?,?,?,?,?,0,NULL,NULL,0,0)").run("f"+i, id, `m${i}.ts`, "ts", 4000);
    const paths = Array.from({ length: 80 }, (_, i) => `m${i}.ts`);
    const savedCapped = estimateSavedFromPaths(db, id, paths, 100, 50); // cap 50 → 50*4000 - 100
    expect(savedCapped).toBe(50 * 4000 - 100);
    const savedUncapped = estimateSavedFromPaths(db, id, paths, 100, 200);
    expect(savedUncapped).toBe(80 * 4000 - 100);
    db.close();
  });
  it("dedupes repeated paths", () => {
    const db = openMemoryDb();
    const { id } = getOrCreateIndex(db, { repoRoot: "/r", worktreePath: "/r", branch: "main", headSha: "a".repeat(40), dirtyFiles: [], detached: false });
    db.prepare("INSERT INTO files (id,index_id,path,language,size,mtime_ms,content_hash,git_blob_sha,deleted,last_indexed_at) VALUES (?,?,'a.ts','ts',8000,0,NULL,NULL,0,0)").run("f1", id);
    expect(estimateSavedFromPaths(db, id, ["a.ts", "a.ts", "a.ts"], 100)).toBe(8000 - 100);
    db.close();
  });
  it("extractDiscoveryPaths pulls paths from a discovery result", () => {
    const text = JSON.stringify({ results: [{ path: "a.ts" }, { path: "b.ts" }, { path: "a.ts" }] });
    expect(extractDiscoveryPaths(text).sort()).toEqual(["a.ts", "a.ts", "b.ts"]); // dedup happens in estimateSavedFromPaths
  });
  it("record() honors savedOverride when provided", () => {
    const db = memDb();
    const u = new UsageTracker(db);
    u.record("cl_search", REPO, JSON.stringify({ results: [{ path: "a.ts" }] }), false, 9999);
    expect(u.snapshot().perTool[0]!.bytes_saved).toBe(9999);
    db.close();
  });
  it("record() falls back to flat proxy when no override", () => {
    const db = memDb();
    const u = new UsageTracker(db);
    u.record("cl_search", REPO, JSON.stringify({ results: [{}, {}, {}] })); // 3 handles, ~small text
    const saved = u.snapshot().perTool[0]!.bytes_saved;
    expect(saved).toBe(3 * 4096 - Buffer.byteLength(JSON.stringify({ results: [{}, {}, {}] }), "utf-8"));
    db.close();
  });
});
