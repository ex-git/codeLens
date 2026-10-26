import { afterEach, describe, expect, it, vi } from "vitest";
import * as symbolExtractor from "../src/graph/symbols.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope } from "../src/git/scope.js";
import { ensureFreshIndex } from "../src/index/reindex.js";
import { ctxImpact } from "../src/tools/impact.js";
import { diffFiles } from "../src/index/freshness.js";
import { scanFiles } from "../src/index/scanner.js";
import { relinkEdges } from "../src/graph/edges.js";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cl-symbol-impact-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  const db = openMemoryDb();
  cleanups.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const scope = detectScope(root)!;
  const { indexId } = buildIndex(db, scope);
  return { db, root, scope, indexId };
}
const tsFiles = {
  "api.ts": "export function first() {}\nexport function second() {}\n",
  "one.ts": "import { first as run } from './api';\nexport function one() { run(); }\n",
  "two.ts": "import * as api from './api';\nexport function two() { api.second(); }\n",
  "local.ts": "export function left() {}\nexport function right() {}\nexport function entry() { left(); }\n",
  "shadow.ts": "import { first } from './api';\nexport function shadow(first: () => void) { first(); }\n",
};

describe("precise symbol graph", () => {
  it("distinguishes imported aliases and namespace members in the same target file", () => {
    const { db } = setup(tsFiles);
    expect(ctxImpact(db, { path: "api.ts", symbol: "first", depth: 1 }).callers.map(x => x.path)).toEqual(["one.ts"]);
    expect(ctxImpact(db, { path: "api.ts", symbol: "second", depth: 1 }).callers.map(x => x.path)).toEqual(["two.ts"]);
    expect(ctxImpact(db, { path: "local.ts", symbol: "left" }).callers.map(x => x.path)).toContain("local.ts");
    expect(ctxImpact(db, { path: "local.ts", symbol: "right" }).callers).toEqual([]);
  });

  it("does not turn loop bindings or private re-export shadows into precise callers", () => {
    const { db } = setup({ ...tsFiles,
      "loop.ts": "import { first } from './api';\nexport function loop(xs: Array<() => void>) { for (const first of xs) first(); }\n",
      "barrel.ts": "function first() {}\nfunction actual() {}\nexport { actual as first };\n",
      "consumer.ts": "import { first } from './barrel';\nexport function consume() { first(); }\n",
    });
    expect(ctxImpact(db, { path: "api.ts", symbol: "first", depth: 1 }).callers.map(x => x.path)).toEqual(["one.ts"]);
    expect(ctxImpact(db, { path: "barrel.ts", symbol: "first" }).callers).toEqual([]);
  });

  it("keeps unresolved default-export callees in file fallback only", () => {
    const { db } = setup({
      "default.ts": "export default function actual() {}\n",
      "use.ts": "import worker from './default';\nexport function use() { worker(); }\n",
    });
    const r = ctxImpact(db, { path: "use.ts", symbol: "use" });
    expect(r.callees).toEqual([]);
    expect(r.fileFallback!.callees.some(n => n.path === "default.ts")).toBe(true);
  });

  it("resolves Python aliases without mixing calls to sibling functions", () => {
    const { db } = setup({
      "api.py": "def first():\n    pass\ndef second():\n    pass\n",
      "one.py": "from api import first as run\ndef one():\n    run()\n",
      "two.py": "from api import second\ndef two():\n    second()\n",
    });
    expect(ctxImpact(db, { path: "api.py", symbol: "first" }).callers.map(x => x.path)).toEqual(["one.py"]);
    expect(ctxImpact(db, { path: "api.py", symbol: "second" }).callers.map(x => x.path)).toEqual(["two.py"]);
  });

  it("relinks unchanged callers after target edits and clears removed symbols", () => {
    const { db, root, scope, indexId } = setup(tsFiles);
    const before = ctxImpact(db, { path: "api.ts", symbol: "first" }).target!.symbolId;
    writeFileSync(join(root, "api.ts"), "// changed positions\nexport function first() { return 1; }\nexport function second() {}\n");
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    const result = ctxImpact(db, { path: "api.ts", symbol: "first", depth: 1 });
    expect(result.target!.symbolId).not.toBe(before);
    expect(result.callers.map(x => x.path)).toEqual(["one.ts"]);
    writeFileSync(join(root, "api.ts"), "export function second() {}\n");
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges e WHERE e.index_id = ? AND e.to_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = e.to_id)").get(indexId)).toEqual({ n: 0 });
    rmSync(join(root, "api.ts"));
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM edges WHERE index_id = ? AND to_path = 'api.ts'").get(indexId)).toEqual({ n: 0 });
  });

  it("respects enclosing Python bindings without treating class attributes as closure variables", () => {
    const { db } = setup({
      "local.py": "def target():\n    pass\ndef outer(target):\n    def inner():\n        target()\nclass Holder:\n    target = None\n    def method(self):\n        target()\n",
      "api.py": "def target():\n    pass\n",
      "imported.py": "from api import target\ndef outer(target):\n    def inner():\n        target()\ndef clear():\n    def inner():\n        target()\n",
    });
    expect(ctxImpact(db, { path: "local.py", symbol: "target" }).callers.map(x => x.symbol)).toEqual(["method"]);
    expect(ctxImpact(db, { path: "api.py", symbol: "target" }).callers.map(x => x.symbol)).toEqual(["inner"]);
    expect(ctxImpact(db, { path: "imported.py", symbol: "outer.inner" }).callees).toEqual([]);
    expect(ctxImpact(db, { path: "imported.py", symbol: "clear.inner" }).callees).toHaveLength(1);
  });

  it("treats var loop bindings as function-scoped and let/const bindings as loop-scoped", () => {
    const { db } = setup({
      "api.ts": "export function work() {}\n",
      "loops.ts": "import { work } from './api';\nexport function hoisted(xs: Array<() => void>) { work(); for (var work of xs) {} work(); }\nexport function lexical(xs: Array<() => void>) { for (let work of xs) { work(); } work(); }\nexport function constant(xs: Array<() => void>) { for (const work of xs) { work(); } work(); }\nexport class Holder { method(xs: Array<() => void>) { for (var work of xs) {} work(); } }\nexport function sibling() { work(); }\n",
    });
    expect(ctxImpact(db, { path: "api.ts", symbol: "work" }).callers.map(x => x.symbol).sort()).toEqual(["constant", "lexical", "sibling"]);
  });

  it("retains separate callers on one source line", () => {
    const { db } = setup({
      "api.ts": "export function work() {}\n",
      "use.ts": "import { work } from './api';\nexport function first() { work(); work(); } export function second() { work(); }\n",
    });
    expect(ctxImpact(db, { path: "api.ts", symbol: "work" }).callers.map(x => x.symbol).sort()).toEqual(["first", "second"]);
  });

  it("retains inheritance for sibling subclasses and distinct bases in one module", () => {
    const { db } = setup({
      "base.py": "class Base:\n    pass\nclass Other:\n    pass\n",
      "children.py": "from base import Base, Other\nclass First(Base):\n    pass\nclass Second(Base, Other):\n    pass\n",
    });
    expect(ctxImpact(db, { path: "base.py", symbol: "Base" }).callers.map(x => x.symbol).sort()).toEqual(["First", "Second"]);
    expect(ctxImpact(db, { path: "base.py", symbol: "Other" }).callers.map(x => x.symbol)).toEqual(["Second"]);
  });

  it("extracts symbol metadata once per indexed file", () => {
    const extract = vi.spyOn(symbolExtractor, "extractSymbols");
    setup({ "api.ts": "export function target() {}\nexport function caller() { target(); }\n" });
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("relinks only touched endpoints without updating unrelated files or branches", () => {
    const { db, root, scope, indexId } = setup({ ...tsFiles, "unrelated.ts": "export function untouched() {}\n" });
    buildIndex(db, { ...scope, branch: "other" });
    db.exec(`CREATE TEMP TABLE relink_updates (index_id TEXT, from_path TEXT, to_path TEXT);
      CREATE TEMP TRIGGER track_relinks AFTER UPDATE OF from_id, to_id ON edges BEGIN
        INSERT INTO relink_updates VALUES (NEW.index_id, NEW.from_path, NEW.to_path);
      END;`);
    writeFileSync(join(root, "api.ts"), "// moved\nexport function first() { return 1; }\nexport function second() {}\n");
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    const updates = db.prepare("SELECT * FROM relink_updates").all() as Array<{ index_id: string; from_path: string; to_path: string }>;
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(row => row.index_id === indexId && (row.from_path === "api.ts" || row.to_path === "api.ts"))).toBe(true);
    expect(updates.some(row => row.from_path === "one.ts" && row.to_path === "api.ts")).toBe(true);
    expect(ctxImpact(db, { path: "api.ts", symbol: "first", depth: 1 }).callers.map(x => x.path)).toEqual(["one.ts"]);
    relinkEdges(db, indexId, []);
    expect(db.prepare("SELECT COUNT(*) AS n FROM relink_updates").get()).toEqual({ n: updates.length });
  });

  it("invalidates legacy graph extraction even when text is unchanged", () => {
    const { db, root, indexId } = setup(tsFiles);
    db.prepare("UPDATE files SET graph_version = NULL WHERE index_id = ?").run(indexId);
    expect(diffFiles(db, indexId, scanFiles(root), root).changed.length).toBe(Object.keys(tsFiles).length);
  });
});
