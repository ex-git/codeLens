import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope } from "../src/git/scope.js";
import { collectDiff } from "../src/git/diff.js";
import { ctxDiff } from "../src/tools/diff.js";
import { setPendingPaths } from "../src/index/staleness.js";
import { getOrCreateIndex, setActiveIndex } from "../src/index/manager.js";
import { insertEdges } from "../src/graph/edges.js";
import { TOOLS } from "../src/tools/registry.js";
import { z } from "zod";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cl-diff-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const put = (path: string, text: string | Buffer) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  git("init", "-q"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
  put("api.ts", "export function first() {\n  return 1;\n}\nexport function second() {\n  return 2;\n}\n");
  put("use.ts", "import { first, second } from './api';\nexport function caller() { return first(); }\nexport function other() { return second(); }\n");
  put("tests/api.test.ts", "import { first } from '../api';\nfirst();\n");
  put("guide.md", "[first](api.ts#first)\n");
  put(".gitignore", "ignored.ts\n");
  git("add", "."); git("commit", "-qm", "base");
  return { root, git, put, setup: () => { const db = openMemoryDb(); const { indexId } = buildIndex(db, detectScope(root)!); return { db, indexId }; } };
}

describe("diff-aware impact", () => {
  it("maps only changed current symbols and retains caller, test, and document evidence", () => {
    const f = fixture();
    f.put("api.ts", "export function first() {\n  return 10;\n}\nexport function second() {\n  return 2;\n}\n");
    const { db } = f.setup();
    try {
      const r = ctxDiff(db, f.root);
      expect(r.targets.filter(t => t.symbol).map(t => t.symbol)).toEqual(["first"]);
      expect(r.callers.some(x => x.path === "use.ts" && x.symbol === "caller" && x.chain?.length)).toBe(true);
      expect(r.callers.some(x => x.symbol === "other")).toBe(false);
      expect(r.affectedTests.some(x => x.path === "tests/api.test.ts")).toBe(true);
      expect(r.documents.some(x => x.path === "guide.md")).toBe(true);
      expect(r.gaps.some(x => x.reason === "historical-impact-unavailable")).toBe(true);
    } finally { db.close(); }
  });

  it("combines staged/unstaged changes, includes untracked paths, and honors an explicit base", () => {
    const f = fixture(), base = f.git("rev-parse", "HEAD").trim();
    f.put("api.ts", "export function first() { return 3; }\n"); f.git("add", "api.ts");
    f.put("api.ts", "export function first() { return 4; }\n");
    f.put("new.ts", "export function added() {}\n"); f.put("ignored.ts", "export const ignored = 1;\n");
    const before = f.git("status", "--porcelain=v1", "-z"), index = f.git("diff", "--cached");
    const r = collectDiff(f.root, { base });
    expect(r.baseSha).toBe(base);
    expect(r.files.map(x => x.path)).toEqual(["api.ts", "new.ts"]);
    expect(r.files[0]!.ranges).toEqual([{ oldStart: 1, oldCount: 6, newStart: 1, newCount: 1 }]);
    expect(f.git("status", "--porcelain=v1", "-z")).toBe(before); expect(f.git("diff", "--cached")).toBe(index);
  });

  it("never assigns a deleted function to the next surviving symbol", () => {
    const f = fixture(); f.put("api.ts", "export function second() {\n  return 2;\n}\n");
    const { db } = f.setup();
    try {
      const r = ctxDiff(db, f.root);
      expect(r.targets.filter(t => t.symbol)).toEqual([]);
      expect(r.gaps.some(x => x.reason === "historical-impact-unavailable")).toBe(true);
      expect(r.fileFallback.some(x => x.path === "use.ts")).toBe(true);
    } finally { db.close(); }
  });

  it("includes current content recreated after a staged deletion", () => {
    const f = fixture(); f.git("rm", "api.ts"); f.put("api.ts", "export function recreated() { return 42; }\n");
    const { db } = f.setup();
    try {
      const r = ctxDiff(db, f.root);
      expect(r.files[0]).toMatchObject({ path: "api.ts", status: "untracked", oldPath: "api.ts" });
      expect(r.targets.some(t => t.symbol === "recreated")).toBe(true);
      expect(r.gaps.some(g => g.reason === "historical-impact-unavailable")).toBe(true);
    } finally { db.close(); }
  });

  it("reports deleted files and rename history without inventing historical callers", () => {
    const f = fixture(); renameSync(join(f.root, "api.ts"), join(f.root, "renamed.ts")); f.git("add", "-A");
    const r = collectDiff(f.root);
    expect(r.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: "renamed.ts", oldPath: "api.ts", status: "renamed" })]));
    f.git("rm", "use.ts"); const { db } = f.setup();
    try { expect(ctxDiff(db, f.root).gaps).toEqual(expect.arrayContaining([expect.objectContaining({ path: "use.ts", reason: "historical-impact-unavailable" })])); }
    finally { db.close(); }
  });

  it("handles literal unusual filenames and excludes binary files and symlink targets from mapping", () => {
    const f = fixture();
    f.put("odd\nname [x].ts", "export const odd = 1;\n"); f.put(":(glob)*.ts", "export const literal = 1;\n");
    f.put("bytes.ts", Buffer.from([0, 1, 2])); symlinkSync("api.ts", join(f.root, "link.ts"));
    const r = collectDiff(f.root);
    expect(r.files.map(x => x.path)).toContain("odd\nname [x].ts");
    expect(r.files.map(x => x.path)).toContain(":(glob)*.ts");
    expect(r.files.find(x => x.path === "bytes.ts")!.issue).toBe("binary");
    expect(r.files.find(x => x.path === "link.ts")!.issue).toBe("not-regular-file");
  });

  it("does not trust stale symbol ranges or missing index rows", () => {
    const f = fixture(); const { db, indexId } = f.setup();
    try {
      f.put("api.ts", "// shifted\nexport function first() { return 3; }\n"); f.put("new.ts", "export function added() {}\n");
      setPendingPaths(indexId, ["api.ts"]);
      const r = ctxDiff(db, f.root);
      expect(r.targets.filter(t => t.symbol)).toEqual([]);
      expect(r.gaps.map(x => x.reason)).toEqual(expect.arrayContaining(["stale-index", "not-indexed"]));
      expect(r.freshness).toBe("partial");
    } finally { setPendingPaths(indexId, []); db.close(); }
  });

  it("returns empty changes honestly and rejects invalid revisions", () => {
    const f = fixture(); const { db } = f.setup();
    try { expect(ctxDiff(db, f.root).targets).toEqual([]); expect(() => collectDiff(f.root, { base: "--help" })).toThrow(); }
    finally { db.close(); }
  });

  it("keeps branch evidence isolated and rejects a mismatched active scope", () => {
    const f = fixture(); f.put("api.ts", "export function first() { return 3; }\n");
    const { db, indexId } = f.setup();
    try {
      const other = getOrCreateIndex(db, { ...detectScope(f.root)!, branch: "other" });
      insertEdges(db, other.id, [{ fromPath: "leaked.ts", toPath: "api.ts", fromSymbol: null, toSymbol: null, type: "imports", confidence: 1 }]);
      expect(() => ctxDiff(db, f.root)).toThrow("Active index");
      setActiveIndex(indexId);
      expect(ctxDiff(db, f.root).fileFallback.some(x => x.path === "leaked.ts")).toBe(false);
    } finally { db.close(); }
  });

  it("uses exact IDs for same-named scoped methods and rejects old graph versions", () => {
    const f = fixture(); f.put("classes.ts", "export class A {\n run() { return 1; }\n}\nexport class B {\n run() { return 2; }\n}\n");
    f.git("add", "."); f.git("commit", "-qm", "classes");
    f.put("classes.ts", "export class A {\n run() { return 3; }\n}\nexport class B {\n run() { return 2; }\n}\n");
    const { db, indexId } = f.setup();
    try {
      const r = ctxDiff(db, f.root);
      expect(r.targets.map(t => t.symbol)).toContain("A.run");
      expect(r.targets.map(t => t.symbol)).not.toContain("B.run");
      db.prepare("UPDATE files SET graph_version = 1 WHERE index_id = ?").run(indexId);
      expect(ctxDiff(db, f.root).targets.every(t => !t.symbolId)).toBe(true);
    } finally { db.close(); }
  });

  it("does not invoke external diff commands and treats special tracked paths literally", () => {
    const f = fixture(); f.put(":(glob)*.ts", "export const value = 1;\n"); f.git("add", "."); f.git("commit", "-qm", "literal");
    f.git("config", "diff.external", "false");
    f.put(":(glob)*.ts", "export const value = 2;\n");
    const r = collectDiff(f.root);
    expect(r.files).toHaveLength(1); expect(r.files[0]!.issue).toBeUndefined();
    expect(r.files[0]!.ranges).toHaveLength(1);
  });

  it("supports detached HEAD and reports an unborn base as unavailable", () => {
    const f = fixture(); f.git("checkout", "--detach", "-q"); f.put("new.ts", "export const added = 1;\n");
    const { db } = f.setup();
    try { expect(ctxDiff(db, f.root).targets.length).toBeGreaterThan(0); } finally { db.close(); }
    const empty = mkdtempSync(join(tmpdir(), "cl-diff-unborn-")); roots.push(empty);
    execFileSync("git", ["init", "-q"], { cwd: empty });
    expect(() => collectDiff(empty)).toThrow("Git comparison failed");
  });

  it("reports merge conflicts without interpreting conflict-marker lines as changed symbols", () => {
    const f = fixture(), branch = f.git("branch", "--show-current").trim();
    f.git("checkout", "-qb", "conflicting"); f.put("api.ts", "export function first() { return 8; }\n");
    f.git("add", "."); f.git("commit", "-qm", "side"); f.git("checkout", "-q", branch);
    f.put("api.ts", "export function first() { return 9; }\n"); f.git("add", "."); f.git("commit", "-qm", "main");
    expect(() => f.git("merge", "conflicting")).toThrow();
    const { db } = f.setup();
    try {
      const r = ctxDiff(db, f.root);
      expect(r.targets).toEqual([]); expect(r.gaps.some(g => g.reason === "unmerged-file")).toBe(true);
    } finally { db.close(); }
  });

  it("uses the linked worktree contents rather than the main checkout", () => {
    const f = fixture(), linked = join(f.root, "..", `linked-${Date.now()}`); roots.push(linked);
    f.git("worktree", "add", "--detach", linked, "HEAD");
    writeFileSync(join(linked, "api.ts"), "export function first() { return 7; }\n");
    const db = openMemoryDb();
    try {
      buildIndex(db, detectScope(linked)!);
      expect(ctxDiff(db, linked).targets.some(t => t.symbol === "first")).toBe(true);
      expect(collectDiff(f.root).files).toEqual([]);
    } finally { db.close(); }
  });

  it("rejects invalid public bounds", () => {
    const schema = z.object(TOOLS.find(t => t.name === "cl_diff")!.schema);
    expect(schema.safeParse({ maxFiles: 201 }).success).toBe(false);
    expect(schema.safeParse({ depth: Infinity }).success).toBe(false);
    expect(schema.safeParse({ maxTargets: 0 }).success).toBe(false);
  });

  it("bounds dense symbol mapping and preserves valid cause references", () => {
    const f = fixture(); f.put("dense.ts", Array.from({ length: 1200 }, (_, i) => `export function dense${i}() {}\n`).join(""));
    const { db } = f.setup();
    try {
      const r = ctxDiff(db, f.root, { maxTargets: 2 });
      expect(r.targets).toHaveLength(2); expect(r.truncated).toBe(true);
      expect(r.gaps.some(g => g.reason === "symbol-limit")).toBe(true);
      expect(r.omitted.targets).toBeGreaterThan(900);
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(32768);
      for (const item of [...r.callers, ...r.dependencies, ...r.fileFallback, ...r.documents, ...r.affectedTests]) {
        expect(item.causedBy.every(i => i >= 0 && i < r.targets.length)).toBe(true);
      }
    } finally { db.close(); }
  });

  it("caps returned hunk metadata without silently omitting analyzed changes", () => {
    const f = fixture();
    const source = (value: number) => Array.from({ length: 30 }, (_, i) => `export function h${i}() {\n return ${value};\n}\n`).join("");
    f.put("hunks.ts", source(1)); f.git("add", "."); f.git("commit", "-qm", "hunks");
    f.put("hunks.ts", source(2)); const { db } = f.setup();
    try {
      const r = ctxDiff(db, f.root, { maxTargets: 50 });
      expect(r.targets).toHaveLength(30); expect(r.files[0]!.ranges).toHaveLength(20);
      expect(r.files[0]!.omittedRanges).toBe(10); expect(r.truncated).toBe(true);
    } finally { db.close(); }
  });

  it("bounds files, targets, and each aggregate section", () => {
    const f = fixture(); for (let i = 0; i < 6; i++) f.put(`new${i}.ts`, `export function f${i}() {}\n`);
    const { db } = f.setup();
    try {
      const r = ctxDiff(db, f.root, { maxFiles: 3, maxTargets: 1, limit: 1 });
      expect(r.files).toHaveLength(3); expect(r.targets).toHaveLength(1); expect(r.truncated).toBe(true);
      expect(r.omitted.files).toBe(3); expect(r.omitted.targets).toBeGreaterThan(0);
      for (const list of [r.callers, r.dependencies, r.affectedTests, r.documents, r.fileFallback]) expect(list.length).toBeLessThanOrEqual(1);
    } finally { db.close(); }
  });
});
