import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope } from "../src/git/scope.js";
import { setPendingPaths } from "../src/index/staleness.js";
import { ctxTour } from "../src/tools/tour.js";
import { insertEdges } from "../src/graph/edges.js";
import { getOrCreateIndex, setActiveIndex } from "../src/index/manager.js";
import { TOOLS } from "../src/tools/registry.js";
import { z } from "zod";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(files: Record<string, string> = {
  "entry.ts": "import { service } from './service';\nexport function entry() { return service(); }\n",
  "service.ts": "import { store } from './store';\nexport function service() { return store(); }\n",
  "store.ts": "export function store() { return 1; }\n",
  "isolated.ts": "export function standalone() {}\n",
  "tests/entry.test.ts": "import { entry } from '../entry';\nentry();\n",
  "guide.md": "[entry](entry.ts)\n",
}) {
  const root = mkdtempSync(join(tmpdir(), "cl-tour-")); roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  const db = openMemoryDb(); const { indexId } = buildIndex(db, detectScope(root)!);
  return { root, db, indexId };
}

describe("evidence-backed reading tours", () => {
  it("returns deterministic stops with source locations and graph-supported reasons", () => {
    const { db } = setup();
    try {
      const r = ctxTour(db, { start: "entry.ts" });
      expect(r).toEqual(ctxTour(db, { start: "entry.ts" }));
      expect(r.stops.map(s => s.path)).toEqual(expect.arrayContaining(["entry.ts", "service.ts", "store.ts", "guide.md", "tests/entry.test.ts"]));
      expect(r.stops[0]).toMatchObject({ path: "entry.ts", reason: { kind: "selected-start" }, chain: [] });
      expect(r.stops[0]!.symbols[0]!.lines).toBe("2-2");
      const store = r.stops.find(s => s.path === "store.ts")!;
      expect(store.reason.kind).toBe("dependency"); expect(store.chain).toHaveLength(2);
      expect(store.chain.every(e => e.source && !e.reversed)).toBe(true);
      expect(store.reason.anchor).toBe("entry.ts");
      expect(r.stops.find(s => s.kind === "document")!.chain[0]!.edgeType).toBe("documents");
      expect(r.stops.every(s => s.source.path === s.path && s.source.startLine > 0)).toBe(true);
    } finally { db.close(); }
  });

  it("labels disconnected sections without inventing connecting edges", () => {
    const { db } = setup();
    try {
      const r = ctxTour(db);
      const stop = r.stops.find(s => s.path === "isolated.ts")!;
      expect(stop.reason.kind).toBe("community-root"); expect(stop.chain).toEqual([]);
      expect(ctxTour(db, { start: "entry.ts" }).stops.some(s => s.path === "isolated.ts")).toBe(false);
    } finally { db.close(); }
  });

  it("propagates stale intermediate evidence and avoids duplicate stops in cycles", () => {
    const { db, indexId } = setup();
    try {
      insertEdges(db, indexId, [{ fromPath: "store.ts", toPath: "entry.ts", fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9, sourceStartLine: 1, sourceEndLine: 1, method: "ast" }]);
      setPendingPaths(indexId, ["service.ts"]);
      const r = ctxTour(db, { start: "entry.ts" });
      expect(r.stops.find(s => s.path === "store.ts")!.stale).toBe(true);
      expect(r.freshness).toBe("partial"); expect(new Set(r.stops.map(s => s.path)).size).toBe(r.stops.length);
    } finally { setPendingPaths(indexId, []); db.close(); }
  });

  it("handles empty graphs and missing starts explicitly", () => {
    const { db } = setup({ "notes.md": "notes\n" });
    try {
      expect(ctxTour(db).status).toBe("empty"); expect(ctxTour(db).stops).toEqual([]);
      expect(ctxTour(db, { start: "missing.ts" }).status).toBe("unresolved-start");
    } finally { db.close(); }
  });

  it("honors stop bounds and reports omissions", () => {
    const { db } = setup();
    try {
      const r = ctxTour(db, { start: "entry.ts", limit: 1 });
      expect(r.stops).toHaveLength(1); expect(r.truncated).toBe(true); expect(r.omittedStops).toBeGreaterThan(0);
      const schema = z.object(TOOLS.find(t => t.name === "cl_tour")!.schema);
      expect(schema.safeParse({ limit: 21 }).success).toBe(false);
      expect(schema.safeParse({ start: "" }).success).toBe(false);
    } finally { db.close(); }
  });

  it("bounds high-fanout work and serialized output", () => {
    const files: Record<string, string> = { "root.ts": "export function root() {}\n" };
    for (let i = 0; i < 250; i++) files[`leaf${i}.ts`] = `export function leaf${i}() {}\n`;
    const { db, indexId } = setup(files);
    try {
      insertEdges(db, indexId, Array.from({ length: 250 }, (_, i) => ({ fromPath: "root.ts", toPath: `leaf${i}.ts`, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9, sourceStartLine: 1, sourceEndLine: 1, method: "ast" as const })));
      const prepare = vi.spyOn(db, "prepare");
      const r = ctxTour(db, { start: "root.ts" });
      expect(prepare.mock.calls.length).toBeLessThan(600); prepare.mockRestore();
      expect(r.stops).toHaveLength(8); expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(32768);
      expect(r.stops.slice(1).every(s => s.chain.length === 1 && s.reason.anchor === "root.ts")).toBe(true);
    } finally { db.close(); }
  });

  it("never includes another branch's edges", () => {
    const { root, db, indexId } = setup();
    try {
      const other = getOrCreateIndex(db, { ...detectScope(root)!, branch: "other" });
      insertEdges(db, other.id, [{ fromPath: "entry.ts", toPath: "isolated.ts", fromSymbol: null, toSymbol: null, type: "imports", confidence: 1 }]);
      setActiveIndex(indexId);
      expect(ctxTour(db, { start: "entry.ts" }).stops.some(s => s.path === "isolated.ts")).toBe(false);
    } finally { db.close(); }
  });
});
