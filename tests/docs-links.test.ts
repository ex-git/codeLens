import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb, openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope } from "../src/git/scope.js";
import { ctxRelated } from "../src/tools/related.js";
import { ctxImpact } from "../src/tools/impact.js";
import { ctxExplore } from "../src/tools/explore.js";
import { ensureFreshIndex } from "../src/index/reindex.js";
import { scanFiles } from "../src/index/scanner.js";
import * as fts from "../src/index/fts.js";
import { setPendingPaths } from "../src/index/staleness.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const fn of cleanup.splice(0)) fn(); });
function setup(doc: string, persistent = false) {
  const root = mkdtempSync(join(tmpdir(), "cl-docs-")); execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "src")); mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src", "api.ts"), "export function first() {}\nexport function second() {}\nexport class Left { run() {} }\nexport class Right { run() {} }\n");
  writeFileSync(join(root, "docs", "design.md"), doc);
  const dbDir = persistent ? mkdtempSync(join(tmpdir(), "cl-docs-db-")) : undefined;
  const dbPath = dbDir ? join(dbDir, "index.db") : undefined;
  const db = dbPath ? openDb(dbPath) : openMemoryDb(), scope = detectScope(root)!;
  const { indexId } = buildIndex(db, scope);
  cleanup.push(() => {
    setPendingPaths(indexId, []); db.close(); rmSync(root, { recursive: true, force: true });
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });
  return { root, db, scope, indexId, dbPath };
}
function docs(db: ReturnType<typeof openMemoryDb>) { return ctxRelated(db, "src/api.ts", { types: ["documents"], depth: 1, direction: "in" }).results; }

describe("explicit documentation links", () => {
  it("resolves relative, root-relative, encoded, reference-style, and inline-code references", () => {
    const { db } = setup("[api](../src/api.ts)\n[root](/src/api.ts#first)\n[encoded](../src/%61pi.ts#second)\n[implementation][impl]\n[impl]: ../src/api.ts#first\nSee `src/api.ts#Left.run`.\n");
    const r = docs(db);
    expect(r).toHaveLength(1);
    expect(r[0]!.path).toBe("docs/design.md");
    expect(r[0]!.chain![0]!.method).toBe("explicit-reference");
    expect(r[0]!.chain![0]!.source?.path).toBe("docs/design.md");
    expect(ctxImpact(db, { path: "src/api.ts", symbol: "first" }).documents!.length).toBeGreaterThan(0);
    expect(ctxImpact(db, { path: "src/api.ts", symbol: "first" }).callers).toEqual([]);
    expect(ctxExplore(db, "first").related.some(n => n.edgeType === "documents")).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'documents'").get() as { n: number };
    expect(count.n).toBe(5);
  });
  it("does not guess ambiguous symbol names or count fenced examples", () => {
    const { db } = setup("[ambiguous](../src/api.ts#run)\n[qualified](../src/api.ts#Left.run)\n```md\n[example](../src/api.ts#second)\n```\n");
    const r = docs(db);
    expect(r).toHaveLength(1);
    expect(r[0]!.chain![0]!.toSymbol).toBe("Left.run");
    expect(r[0]!.chain![0]!.toSymbolId).toBeTruthy();
    expect(ctxImpact(db, { path: "src/api.ts", symbol: "run" }).candidates).toHaveLength(2);
    expect(ctxImpact(db, { path: "src/api.ts", symbol: "Left.run" }).documents).toHaveLength(1);
    expect(ctxImpact(db, { path: "src/api.ts", symbol: "second" }).documents).toEqual([]);
  });
  it("rejects external links, repository escapes, malformed escapes, and external symlinks", () => {
    const { root, db, scope } = setup("[external](https://example.com/src/api.ts)\n[protocol](//example.com/src/api.ts)\n[escape](../../src/api.ts)\n[encoded](%2e%2e/%2e%2e/src/api.ts)\n[bad](../src/%ZZ.ts)\n[symlink](../escape.ts)\n");
    const outside = mkdtempSync(join(tmpdir(), "cl-docs-outside-"));
    cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, "outside.ts"), "export function secret() {}\n");
    symlinkSync(join(outside, "outside.ts"), join(root, "escape.ts"));
    buildIndex(db, scope);
    expect(docs(db)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE type = 'documents'").get()).toEqual({ n: 0 });
  });
  it("relinks unchanged documents after symbol edits and hides removed symbols", () => {
    const { db, root, scope } = setup("[first](../src/api.ts#first)\n");
    const before = docs(db)[0]!.chain![0]!.toSymbolId;
    writeFileSync(join(root, "src", "api.ts"), "// moved\nexport function first() { return 1; }\n");
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    expect(docs(db)[0]!.chain![0]!.toSymbolId).not.toBe(before);
    writeFileSync(join(root, "src", "api.ts"), "export function second() {}\n");
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    expect(docs(db)).toEqual([]);
  });
  it("persists deferred document work across a real process restart", () => {
    const { db, root, scope, indexId, dbPath } = setup("[new](../src/new.ts#fresh)\n", true);
    writeFileSync(join(root, "src", "new.ts"), "export function fresh() {}\n");
    const original = fts.indexFile;
    const start = Date.now();
    let expired = false;
    vi.spyOn(Date, "now").mockImplementation(() => start + (expired ? 1000 : 0));
    vi.spyOn(fts, "indexFile").mockImplementation((...args) => {
      const result = original(...args);
      if (args[3].path === "src/new.ts") expired = true;
      return result;
    });
    expect(ensureFreshIndex(db, scope, { budgetMs: 500 }).pending).toBe(1);
    vi.restoreAllMocks();
    expect(db.prepare("SELECT graph_version FROM files WHERE index_id = ? AND path = 'docs/design.md'").get(indexId)).toEqual({ graph_version: null });
    setPendingPaths(indexId, []);
    const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
    const script = `
      import { openDb } from ${moduleUrl("../src/db/db.ts")};
      import { detectScope } from ${moduleUrl("../src/git/scope.ts")};
      import { ensureFreshIndex } from ${moduleUrl("../src/index/reindex.ts")};
      import { ctxRelated } from ${moduleUrl("../src/tools/related.ts")};
      const db = openDb(${JSON.stringify(dbPath)});
      const refresh = ensureFreshIndex(db, detectScope(${JSON.stringify(root)}), { budgetMs: 10000 });
      const related = ctxRelated(db, 'src/new.ts', { types: ['documents'], direction: 'in' });
      console.log(JSON.stringify({ refresh, related }));
      db.close();
    `;
    const result = JSON.parse(execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { encoding: "utf8" }));
    expect(result.refresh.refreshed).toBe(1);
    expect(result.refresh.pending).toBe(0);
    expect(result.related.freshness).toBe("fresh");
    expect(result.related.results.map((x: { path: string }) => x.path)).toEqual(["docs/design.md"]);
  });

  it("updates unchanged documents for new targets, resumes deferred docs, and removes deleted links", () => {
    const { db, root, scope, indexId } = setup("[new](../src/new.ts#fresh)\n");
    writeFileSync(join(root, "src", "new.ts"), "export function fresh() {}\n");
    const scanned = scanFiles(root);
    // Simulate a batch that indexed the target but deferred the unchanged document.
    fts.indexFile(db, indexId, root, scanned.find(f => f.path === "src/new.ts")!, new Set(scanned.map(f => f.path)));
    setPendingPaths(indexId, ["docs/design.md"]);
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    expect(ctxRelated(db, "src/new.ts", { types: ["documents"], direction: "in" }).results.map(x => x.path)).toEqual(["docs/design.md"]);
    rmSync(join(root, "src", "new.ts"));
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    expect(ctxRelated(db, "src/new.ts", { types: ["documents"] }).results).toEqual([]);
  });
});
