import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope } from "../src/git/scope.js";
import { ctxPath } from "../src/tools/path.js";
import { setPendingPaths } from "../src/index/staleness.js";
import { z } from "zod";
import { TOOLS } from "../src/tools/registry.js";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cl-path-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries({
    "a.ts": "import { middle } from './b';\nexport function entry() { const result = middle(); return result; }\n",
    "b.ts": "import { end } from './c';\nexport function middle() { const result = end(); return result; }\n",
    "c.ts": "export function end() {}\n",
    "isolated.ts": "export function end() {}\n",
  })) writeFileSync(join(root, path), text);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function setup() { const db = openMemoryDb(); const { indexId } = buildIndex(db, detectScope(root)!); return { db, indexId }; }

describe("connection paths", () => {
  it("returns file and symbol chains with source evidence", () => {
    const { db } = setup();
    try {
      const file = ctxPath(db, { from: "a.ts", to: "c.ts" });
      expect(file.found).toBe(true); expect(file.chain).toHaveLength(2);
      expect(file.chain.every(x => x.source && !x.reversed)).toBe(true);
      const symbol = ctxPath(db, { from: "a.ts#entry", to: "c.ts#end" });
      expect(symbol.found).toBe(true); expect(symbol.chain.map(x => x.toSymbol)).toEqual(["middle", "end"]);
    } finally { db.close(); }
  });
  it("does not reverse directed edges unless requested", () => {
    const { db } = setup();
    try {
      expect(ctxPath(db, { from: "c.ts", to: "a.ts" }).found).toBe(false);
      expect(ctxPath(db, { from: "c.ts", to: "a.ts", direction: "both" }).chain.every(x => x.reversed)).toBe(true);
    } finally { db.close(); }
  });
  it("returns ambiguity, missing targets, mixed granularity, and zero-hop paths honestly", () => {
    const { db } = setup();
    try {
      expect(ctxPath(db, { from: "entry", to: "end" }).candidates?.to).toHaveLength(2);
      expect(ctxPath(db, { from: "a.ts", to: "missing.ts" }).status).toBe("unresolved");
      expect(ctxPath(db, { from: "a.ts", to: "c.ts#end" }).status).toBe("incompatible-targets");
      expect(ctxPath(db, { from: "a.ts", to: "a.ts" })).toMatchObject({ found: true, chain: [], confidence: 1 });
      expect(ctxPath(db, { from: "a.ts", to: "isolated.ts" }).status).toBe("not-found-within-limits");
    } finally { db.close(); }
  });
  it("enforces depth/work bounds and propagates pending intermediate files", () => {
    const { db, indexId } = setup();
    try {
      expect(ctxPath(db, { from: "a.ts", to: "c.ts", depth: 1 }).found).toBe(false);
      expect(ctxPath(db, { from: "a.ts", to: "c.ts", maxNodes: 1 }).truncated).toBe(true);
      setPendingPaths(indexId, ["b.ts"]);
      expect(ctxPath(db, { from: "a.ts", to: "c.ts" })).toMatchObject({ stale: true, freshness: "partial" });
    } finally { setPendingPaths(indexId, []); db.close(); }
  });
  it("rejects unbounded tool inputs", () => {
    const schema = z.object(TOOLS.find(t => t.name === "cl_path")!.schema);
    expect(schema.safeParse({ from: "a", to: "b", maxNodes: Infinity }).success).toBe(false);
    expect(schema.safeParse({ from: "a", to: "b", depth: 100 }).success).toBe(false);
  });
});
