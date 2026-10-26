import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope } from "../src/git/scope.js";
import { ctxOverview } from "../src/tools/overview.js";
import { insertEdges } from "../src/graph/edges.js";
import { analyzeOverview } from "../src/graph/overview.js";
import { setPendingPaths } from "../src/index/staleness.js";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cl-overview-")); execFileSync("git", ["init", "-q"], { cwd: root });
  for (const name of ["a", "b", "c", "d", "e", "f", "isolated"]) writeFileSync(join(root, name + ".ts"), `export function ${name}() {}\n`);
  writeFileSync(join(root, "README.md"), "Architecture notes\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
function setup(pairs = [["a", "b"], ["b", "c"], ["c", "a"], ["d", "e"], ["e", "f"], ["f", "d"], ["c", "d"]]) {
  const db = openMemoryDb(); const { indexId } = buildIndex(db, detectScope(root)!);
  insertEdges(db, indexId, pairs.map(([a, b]) => ({ fromPath: a + ".ts", toPath: b + ".ts", fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9, method: "ast" as const, sourceStartLine: 1, sourceEndLine: 1 })));
  return { db, indexId };
}
describe("architecture overview", () => {
  it.each([
    { graph: "a pair", pairs: [["a", "b"]], groups: [["a", "b"]] },
    { graph: "a chain", pairs: [["a", "b"], ["b", "c"]], groups: [["a", "b", "c"]] },
    { graph: "disconnected pairs", pairs: [["a", "b"], ["d", "e"]], groups: [["a", "b"], ["d", "e"]] },
  ])("converges deterministically for $graph", ({ pairs, groups }) => {
    const { db } = setup(pairs);
    try {
      const result = ctxOverview(db);
      expect(result.communitiesConverged).toBe(true);
      expect(result).toEqual(ctxOverview(db));
      for (const group of groups) {
        expect(result.communities).toContainEqual(expect.objectContaining({
          size: group.length, members: group.map(name => ({ path: name + ".ts" })), cohesion: 1,
        }));
      }
      expect(result.bridges).toEqual([]);
    } finally { db.close(); }
  });

  it("returns stable groups, hubs, cross-group evidence, cycles, and isolates", () => {
    const { db } = setup();
    try {
      const r = ctxOverview(db);
      expect(r).toEqual(ctxOverview(db));
      expect(r.counts.nodes).toBe(7);
      expect(r.cycles.map(c => c.size)).toEqual([3, 3]);
      expect(r.communities.some(c => c.members.some(m => m.path === "isolated.ts"))).toBe(true);
      expect(r.communities.some(c => c.members.some(m => m.path === "README.md"))).toBe(false);
      expect(r.hubs[0]!.path).toBe("d.ts");
      expect(r.bridges).toContainEqual(expect.objectContaining({ fromPath: "c.ts", toPath: "d.ts", method: "ast" }));
    } finally { db.close(); }
  });
  it("reports bounded input and output and pending freshness", () => {
    const { db, indexId } = setup();
    try {
      expect(ctxOverview(db, { maxNodes: 2 }).inputTruncated).toBe(true);
      expect(ctxOverview(db, { maxEdges: 1 }).inputTruncated).toBe(true);
      const limited = ctxOverview(db, { limit: 1 });
      expect(limited.hubs).toHaveLength(1); expect(limited.truncated).toBe(true);
      setPendingPaths(indexId, ["d.ts"]);
      expect(ctxOverview(db).freshness).toBe("partial");
      expect(ctxOverview(db).hubs[0]!.stale).toBe(true);
      expect(analyzeOverview(db, "another-index").counts.nodes).toBe(0);
    } finally { setPendingPaths(indexId, []); db.close(); }
  });
});
