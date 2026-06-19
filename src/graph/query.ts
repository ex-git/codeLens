import type Database from "better-sqlite3";

/** Bounded graph traversal via SQLite recursive CTE over the edges table,
 * scoped by index_id. Returns neighbors of a file, deduped, ranked by hop
 * distance + edge type.
 */

export interface GraphNeighbor {
  path: string;
  edgeType: string;
  hops: number;
  confidence: number;
}

const EDGE_TYPES_ALL = ["imports", "imported_by", "defines", "exports", "references", "calls", "tests", "belongs_to"];
const MAX_DEPTH = 3;

/** Recursive CTE neighbors of `startPath`, filtered by edge types, bounded by depth. */
export function neighbors(
  db: Database.Database,
  indexId: string,
  startPath: string,
  opts: { types?: string[]; depth?: number; direction?: "out" | "in" | "both" } = {},
): GraphNeighbor[] {
  const types = opts.types ?? EDGE_TYPES_ALL;
  const depth = Math.min(opts.depth ?? 2, MAX_DEPTH);
  const direction = opts.direction ?? "both";

  // Direction determines which edge column must equal the current node, and
  // which end is the neighbor.
  //   out: match e.from_path = node → neighbor = e.to_path
  //   in:  match e.to_path   = node → neighbor = e.from_path
  //   both: either end matches → neighbor is the other end
  const matchClause =
    direction === "out" ? "e.from_path = w.node" :
    direction === "in" ? "e.to_path = w.node" :
    "(e.from_path = w.node OR e.to_path = w.node)";
  const neighborExpr =
    direction === "out" ? "e.to_path" :
    direction === "in" ? "e.from_path" :
    "CASE WHEN e.from_path = w.node THEN e.to_path ELSE e.from_path END";

  const typePlaceholders = types.map(() => "?").join(",");
  const seenGuard = `instr(w.seen, ',' || ${neighborExpr} || ',') = 0`;

  const sql = `
    WITH RECURSIVE walk(node, edge_type, hops, confidence, seen) AS (
      SELECT ?, NULL, 0, 1.0, ',' || ? || ','
      UNION
      SELECT
        ${neighborExpr},
        e.type,
        w.hops + 1,
        e.confidence,
        w.seen || ${neighborExpr} || ','
      FROM edges e
      JOIN walk w ON ${matchClause}
      WHERE e.index_id = ?
        AND e.type IN (${typePlaceholders})
        AND w.hops < ?
        AND ${seenGuard}
    )
    SELECT node AS path, edge_type AS edgeType, MIN(hops) AS hops, MAX(confidence) AS confidence
    FROM walk
    WHERE node != ? AND edge_type IS NOT NULL
    GROUP BY node, edge_type
    ORDER BY hops ASC, confidence DESC
  `;

  const rows = db.prepare(sql).all(
    startPath, startPath,
    indexId, ...types, depth, startPath,
  ) as { path: string; edgeType: string; hops: number; confidence: number }[];

  return rows.map((r) => ({ path: r.path, edgeType: r.edgeType, hops: r.hops, confidence: r.confidence }));
}

/** Files that emit `tests` edges pointing at `sourcePath`. */
export function testsFor(db: Database.Database, indexId: string, sourcePath: string): GraphNeighbor[] {
  const rows = db.prepare(
    `SELECT from_path AS path, confidence FROM edges WHERE index_id = ? AND type = 'tests' AND to_path = ?`,
  ).all(indexId, sourcePath) as { path: string; confidence: number }[];
  return rows.map((r) => ({ path: r.path, edgeType: "tests", hops: 1, confidence: r.confidence }));
}