import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectScope, listDirty } from "../src/git/scope.js";
import { FileWatcher } from "../src/index/watcher.js";
import * as gitScope from "../src/git/scope.js";
import { TOOLS, type ServerContext } from "../src/tools/registry.js";
import { openMemoryDb } from "../src/db/db.js";
import { openMemoryContextDb } from "../src/context/store.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxDiff } from "../src/tools/diff.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cl-request-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
  git("config", "maintenance.auto", "false"); git("config", "gc.auto", "0");
  writeFileSync(join(root, "a.ts"), "export const original = 1;\n");
  git("add", "."); git("commit", "-qm", "base");
  return { root, git, close: () => rmSync(root, { recursive: true, force: true }) };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 100));
const call = (name: string, ctx: ServerContext, args: Record<string, unknown> = {}) => TOOLS.find(t => t.name === name)!.handler(ctx, args);

describe("request-local scope handoff", () => {
  it("reuses the supplied scope while direct registry calls still resolve it", async () => {
    const f = fixture(), db = openMemoryDb(), ctxDb = openMemoryContextDb();
    const scope = detectScope(f.root)!; buildIndex(db, scope);
    const context: ServerContext = { coreDb: db, ctxDb, repoRoot: f.root };
    const detect = vi.spyOn(gitScope, "detectScope");
    try {
      await call("cl_search", { ...context, requestScope: scope }, { query: "original" });
      await call("cl_current", { ...context, requestScope: scope });
      expect(detect).not.toHaveBeenCalled();
      await call("cl_search", context, { query: "original" });
      expect(detect).toHaveBeenCalledTimes(1);
      expect(Object.hasOwn(context, "requestScope")).toBe(false);
    } finally { detect.mockRestore(); db.close(); ctxDb.close(); f.close(); }
  });

  it("does not redetect a known non-Git scope, including after an error", async () => {
    const f = fixture(), db = openMemoryDb(), ctxDb = openMemoryContextDb();
    const context: ServerContext = { coreDb: db, ctxDb, repoRoot: f.root, requestScope: null };
    const detect = vi.spyOn(gitScope, "detectScope");
    try {
      expect(await call("cl_current", context)).toMatchObject({ inGitRepo: false });
      expect(() => call("cl_search", context, { query: "original" })).toThrow("not inside a git repo");
      expect(await call("cl_current", context)).toMatchObject({ inGitRepo: false });
      expect(detect).not.toHaveBeenCalled();
    } finally { detect.mockRestore(); db.close(); ctxDb.close(); f.close(); }
  });

  it("uses a new scope for the next branch without retaining it on shared context", async () => {
    const f = fixture(), db = openMemoryDb(), ctxDb = openMemoryContextDb();
    const scopeA = detectScope(f.root)!; buildIndex(db, scopeA);
    const context: ServerContext = { coreDb: db, ctxDb, repoRoot: f.root };
    const requestA = { ...context, requestScope: scopeA };
    try {
      f.git("checkout", "-qb", "next");
      writeFileSync(join(f.root, "a.ts"), "export const replacement = 2;\n");
      f.git("add", "."); f.git("commit", "-qm", "replacement");
      const scopeB = detectScope(f.root)!; const requestB = { ...context, requestScope: scopeB };
      const [a, b] = await Promise.all([call("cl_current", requestA), call("cl_current", requestB)]);
      expect(a).toMatchObject({ branch: scopeA.branch }); expect(b).toMatchObject({ branch: "next" });
      expect(await call("cl_search", requestB, { query: "replacement" })).toMatchObject({ count: 1 });
      expect(Object.hasOwn(context, "requestScope")).toBe(false);
    } finally { db.close(); ctxDb.close(); f.close(); }
  });

  it("keeps the diff final scope guard even when its entry scope is supplied", () => {
    const f = fixture(), db = openMemoryDb();
    const scope = detectScope(f.root)!; buildIndex(db, scope);
    const detect = vi.spyOn(gitScope, "detectScope");
    try {
      ctxDiff(db, f.root, {}, scope);
      expect(detect).toHaveBeenCalledTimes(1);
      detect.mockReturnValue({ ...scope, branch: "changed-mid-request" });
      expect(() => ctxDiff(db, f.root, {}, scope)).toThrow("scope changed");
    } finally { detect.mockRestore(); db.close(); f.close(); }
  });
});

describe("read-only scope observation", () => {
  it("does not refresh Git index bytes when unchanged content has a new mtime", () => {
    const f = fixture();
    try {
      const index = join(f.root, ".git", "index"), before = readFileSync(index);
      const future = new Date(Date.now() + 2000); utimesSync(join(f.root, "a.ts"), future, future);
      expect(listDirty(f.root)).toEqual([]);
      expect(readFileSync(index)).toEqual(before);
    } finally { f.close(); }
  });

  it("keeps a real watcher quiet during status reads but observes source edits", async () => {
    const f = fixture(), watcher = new FileWatcher(f.root);
    try {
      watcher.start(); expect(watcher.active).toBe(true);
      await settle(); watcher.consume();
      for (let i = 0; i < 3; i++) { expect(detectScope(f.root)!.dirtyFiles).toEqual([]); await settle(); }
      expect([...watcher.dirty]).toEqual([]);
      writeFileSync(join(f.root, "a.ts"), "export const changed = 2;\n");
      await settle();
      expect(watcher.dirty.has("a.ts")).toBe(true);
      expect(listDirty(f.root)).toContain("a.ts");
    } finally { watcher.stop(); f.close(); }
  });
});
