import { describe, expect, it, vi } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { insertEdges } from "../src/graph/edges.js";
import { walkGraph } from "../src/graph/query.js";
import { ctxRelated } from "../src/tools/related.js";
import { setPendingPaths } from "../src/index/staleness.js";

function graph() {
  const db = openMemoryDb();
  const { id } = getOrCreateIndex(db, { repoRoot: "/test", worktreePath: "/test", branch: "main", headSha: "a", dirtyFiles: [], detached: false });
  const edge = (fromPath: string, toPath: string, confidence: number) => ({ fromPath, toPath, fromSymbol: null, toSymbol: null, type: "imports", confidence, sourceStartLine: 2, sourceEndLine: 2, method: "ast" as const });
  insertEdges(db, id, [edge("a.ts", "b.ts", 0.2), edge("b.ts", "c.ts", 0.9), edge("c.ts", "a.ts", 0.9)]);
  return { db, id, edge };
}
describe("relationship evidence", () => {
  it.each((["path", "id"] as const).flatMap(mode => (["out", "in", "both"] as const).map(direction => ({ mode, direction }))))(
    "uses selective endpoint indexes for $mode / $direction",
    ({ mode, direction }) => {
      const { db, id } = graph();
      const nativePrepare = db.prepare.bind(db);
      if (mode === "id") db.prepare("UPDATE edges SET type = 'calls', from_id = 'symbol:' || from_path, to_id = 'symbol:' || to_path WHERE index_id = ?").run(id);
      const queries: Array<{ sql: string; args: unknown[] }> = [];
      const prepare = vi.spyOn(db, "prepare").mockImplementation(sql => {
        const statement = nativePrepare(sql);
        if (sql.startsWith("SELECT * FROM edges")) {
          const all = statement.all.bind(statement);
          statement.all = (...args: unknown[]) => { queries.push({ sql, args }); return all(...args); };
        }
        return statement;
      });
      try {
        const result = walkGraph(db, id, "a.ts", { symbolId: mode === "id" ? "symbol:a.ts" : undefined, types: ["calls", "imports"], depth: 1, direction });
        expect(result.results.map(r => r.path).sort()).toEqual(direction === "out" ? ["b.ts"] : direction === "in" ? ["c.ts"] : ["b.ts", "c.ts"]);
        prepare.mockRestore();
        expect(queries).toHaveLength(1);
        const plan = queries.flatMap(q => (nativePrepare("EXPLAIN QUERY PLAN " + q.sql).all(...q.args) as Array<{ detail: string }>).map(row => row.detail));
        for (const side of direction === "both" ? ["from", "to"] : [direction === "out" ? "from" : "to"]) {
          const index = `idx_edges_index_${side}${mode === "path" ? "_path" : ""}`;
          expect(plan.some(detail => detail.includes(index) && detail.includes(`${side}_${mode}=?`))).toBe(true);
        }
      } finally { prepare.mockRestore(); db.close(); }
    },
  );

  it("counts a self-edge once before applying the shared edge budget", () => {
    const { db, id, edge } = graph();
    try {
      db.prepare("DELETE FROM edges WHERE index_id = ?").run(id);
      insertEdges(db, id, [edge("a.ts", "a.ts", 0.9), edge("a.ts", "b.ts", 0.8)]);
      db.prepare("UPDATE edges SET type = 'calls', from_id = 'symbol:' || from_path, to_id = 'symbol:' || to_path WHERE index_id = ?").run(id);
      const result = walkGraph(db, id, "a.ts", { symbolId: "symbol:a.ts", types: ["calls"], direction: "both", depth: 1, maxEdges: 2 });
      expect(result.results.map(r => r.symbolId)).toEqual(["symbol:b.ts"]);
      expect(result.truncated).toBe(false);
      expect(result.visited).toBe(2);
      const file = walkGraph(db, id, "a.ts", { types: ["calls"], direction: "both", depth: 1, maxEdges: 1 });
      expect(file.results.map(r => r.path)).toEqual(["b.ts"]);
      expect(file.truncated).toBe(false);
    } finally { db.close(); }
  });

  it.each(["out", "in", "both"] as const)("preserves mixed imported_by aliases for direction %s", direction => {
    const { db, id, edge } = graph();
    try {
      insertEdges(db, id, [{ ...edge("a.ts", "d.ts", 0.7), type: "calls" }, { ...edge("d.ts", "a.ts", 0.8), type: "calls" }]);
      const other = getOrCreateIndex(db, { repoRoot: "/test", worktreePath: "/test", branch: "other", headSha: "a", dirtyFiles: [], detached: false });
      insertEdges(db, other.id, [edge("a.ts", "leaked.ts", 1), edge("leaked.ts", "a.ts", 1)]);
      const result = walkGraph(db, id, "a.ts", { types: ["imported_by", "calls"], direction, depth: 1 });
      expect(result.results.map(r => ({ path: r.path, type: r.edgeType, confidence: r.confidence, reversed: r.chain![0]!.reversed }))).toEqual([
        { path: "c.ts", type: "imported_by", confidence: 0.9, reversed: true },
        { path: "d.ts", type: "calls", confidence: direction === "out" ? 0.7 : 0.8, reversed: direction !== "out" },
      ]);
    } finally { db.close(); }
  });

  it("returns no relationships for an empty type filter", () => {
    const { db, id } = graph();
    try { expect(walkGraph(db, id, "a.ts", { types: [] })).toEqual({ results: [], truncated: false, visited: 1 }); }
    finally { db.close(); }
  });

  it("uses the weakest edge in the complete shortest chain", () => {
    const { db, id } = graph();
    try {
      const c = walkGraph(db, id, "a.ts", { direction: "out", depth: 3 }).results.find(x => x.path === "c.ts")!;
      expect(c.confidence).toBe(0.2);
      expect(c.chain).toHaveLength(2);
      expect(c.chain![0]!.source).toEqual({ path: "a.ts", startLine: 2, endLine: 2 });
      expect(c.chain![0]!.method).toBe("ast");
      expect(walkGraph(db, id, "a.ts").results.some(x => x.path === "a.ts")).toBe(false);
    } finally { db.close(); }
  });
  it("marks stale intermediate evidence on an otherwise fresh destination", () => {
    const { db, id } = graph();
    try {
      setPendingPaths(id, ["b.ts"]);
      const c = ctxRelated(db, "a.ts", { direction: "out" }).results.find(x => x.path === "c.ts")!;
      expect(c.stale).toBe(true);
      expect(c.chain!.every(x => x.stale)).toBe(true);
    } finally { setPendingPaths(id, []); db.close(); }
  });
  it("exposes bounds and supports the incoming imported_by view", () => {
    const { db, id } = graph();
    try {
      expect(walkGraph(db, id, "a.ts", { direction: "out", maxNodes: 1 }).truncated).toBe(true);
      const reverse = walkGraph(db, id, "b.ts", { types: ["imported_by"], depth: 1 });
      expect(reverse.results.map(x => x.path)).toEqual(["a.ts"]);
      expect(reverse.results[0]!.chain![0]!.reversed).toBe(true);
    } finally { db.close(); }
  });
  it("prefers the strongest equal-length chain and does not leak another index", () => {
    const { db, id, edge } = graph();
    try {
      insertEdges(db, id, [edge("a.ts", "d.ts", 0.8), edge("d.ts", "c.ts", 0.8)]);
      const r = walkGraph(db, id, "a.ts", { direction: "out" }).results.find(x => x.path === "c.ts")!;
      expect(r.confidence).toBe(0.8);
      expect(r.chain![0]!.toPath).toBe("d.ts");
      expect(walkGraph(db, "another-index", "a.ts").results).toEqual([]);
    } finally { db.close(); }
  });
});
