import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openMemoryDb } from "../src/db/db.js";
import * as queries from "../src/db/queries.js";
import { buildIndex } from "../src/index/indexer.js";
import { deleteFileFromIndex, indexFile } from "../src/index/fts.js";
import { ensureFreshIndex } from "../src/index/reindex.js";
import { scanFiles } from "../src/index/scanner.js";
import { detectScope } from "../src/git/scope.js";
import { relinkEdges } from "../src/graph/edges.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(count = 2, disk = false) {
  const root = mkdtempSync(join(tmpdir(), "cl-index-performance-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "src"));
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, "src", `m${i}.ts`), i === 0
      ? "export function f0() { return 'originalValue'; }\n"
      : `import { f0 } from './m0';\nexport function f${i}() { return f0(); }\n`);
  }
  const dbPath = disk ? join(root, ".git", "codelens.sqlite") : undefined;
  const db = dbPath ? openDb(dbPath) : openMemoryDb();
  cleanups.push(() => {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, scope: detectScope(root)!, dbPath };
}

function snapshot(db: ReturnType<typeof openMemoryDb>, indexId: string) {
  return Object.fromEntries(["files", "symbols", "chunks", "edges", "chunks_fts"].map(table => [table,
    db.prepare(`SELECT ${table === "chunks_fts" ? "rowid, " : ""}* FROM ${table} WHERE index_id = ? ORDER BY ${table === "chunks_fts" ? "rowid" : "id"}`).all(indexId),
  ]));
}

describe("indexing hot paths", () => {
  it("does not clean up new paths, including the same paths in a new branch", () => {
    const { db, scope } = setup();
    const cleanup = vi.spyOn(queries, "deleteFileRows");
    buildIndex(db, scope);
    buildIndex(db, { ...scope, branch: "other" });
    expect(cleanup).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM files").get()).toEqual({ n: 4 });
  });

  it("prepares a bounded set of SQL statements for a cold build", () => {
    const { db, scope } = setup(100);
    const prepare = vi.spyOn(db, "prepare");
    const result = buildIndex(db, scope);
    expect(result.indexedFiles).toBe(100);
    expect(result.skipped).toBe(0);
    expect(prepare.mock.calls.length).toBeLessThan(40);
  });

  it("holds the writer lock before checking whether a file already exists", () => {
    const { db, root, scope, dbPath } = setup(1, true);
    const { indexId } = buildIndex(db, scope);
    const other = openDb(dbPath!);
    other.pragma("busy_timeout = 0");
    try {
      let blocked = false;
      const prepare = queries.prepareIndexStatement;
      vi.spyOn(queries, "prepareIndexStatement").mockImplementation((owner, sql) => {
        const statement = prepare(owner, sql);
        if (sql === "SELECT 1 FROM files WHERE index_id = ? AND path = ?") {
          const get = statement.get.bind(statement);
          statement.get = (...args: unknown[]) => {
            const row = get(...args);
            try {
              other.prepare("UPDATE files SET last_indexed_at = last_indexed_at + 1 WHERE index_id = ?").run(indexId);
            } catch (error) {
              if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
              blocked = true;
            }
            return row;
          };
        }
        return statement;
      });
      const scanned = scanFiles(root);
      expect(() => indexFile(db, indexId, root, scanned[0]!, new Set(scanned.map(f => f.path)))).not.toThrow();
      expect(blocked).toBe(true);
    } finally { other.close(); }
  });

  it("reuses statements only within the owning database", () => {
    const first = setup(1), second = setup(1);
    const sql = "SELECT COUNT(*) AS n FROM files";
    const firstStatement = queries.prepareIndexStatement(first.db, sql);
    expect(queries.prepareIndexStatement(first.db, sql)).toBe(firstStatement);
    const secondStatement = queries.prepareIndexStatement(second.db, sql);
    expect(secondStatement).not.toBe(firstStatement);
    buildIndex(first.db, first.scope);
    expect(firstStatement.get()).toEqual({ n: 1 });
    expect(secondStatement.get()).toEqual({ n: 0 });
    first.db.close();
    buildIndex(second.db, second.scope);
    expect(secondStatement.get()).toEqual({ n: 1 });
  });

  it("still replaces existing rows, relinks callers, and deletes within one branch", () => {
    const { db, root, scope } = setup();
    const { indexId } = buildIndex(db, scope);
    const otherId = buildIndex(db, { ...scope, branch: "other" }).indexId;
    const otherBefore = snapshot(db, otherId);
    const oldTarget = db.prepare("SELECT id FROM symbols WHERE index_id = ? AND name = 'f0'").get(indexId) as { id: string };
    const cleanup = vi.spyOn(queries, "deleteFileRows");
    writeFileSync(join(root, "src", "m0.ts"), "export function f0() { return 'updatedValue'; }\n");
    expect(ensureFreshIndex(db, scope, { budgetMs: 10000 }).refreshed).toBe(1);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith(db, indexId, "src/m0.ts", "out");
    const newTarget = db.prepare("SELECT id FROM symbols WHERE index_id = ? AND name = 'f0'").get(indexId) as { id: string };
    expect(newTarget.id).not.toBe(oldTarget.id);
    expect(db.prepare("SELECT to_id FROM edges WHERE index_id = ? AND from_path = 'src/m1.ts' AND type = 'calls'").get(indexId)).toEqual({ to_id: newTarget.id });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE index_id = ? AND chunks_fts MATCH 'originalValue'").get(indexId)).toEqual({ n: 0 });
    expect(snapshot(db, otherId)).toEqual(otherBefore);
    deleteFileFromIndex(db, indexId, "src/m0.ts");
    for (const table of ["files", "symbols", "chunks", "chunks_fts"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE index_id = ? AND path = 'src/m0.ts'`).get(indexId)).toEqual({ n: 0 });
    }
    expect(snapshot(db, otherId)).toEqual(otherBefore);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it.each(["new", "existing"])("rolls back a failed %s file and reuses statements on retry", kind => {
    const { db, root, scope } = setup();
    const { indexId } = buildIndex(db, scope);
    const before = snapshot(db, indexId);
    const path = kind === "new" ? "src/new.ts" : "src/m0.ts";
    const name = kind === "new" ? "fresh" : "f0";
    writeFileSync(join(root, path), `export function ${name}() { return 'updatedValue'; }\n`);
    db.exec(`CREATE TEMP TRIGGER fail_chunk BEFORE INSERT ON chunks
      WHEN NEW.path = '${path}' BEGIN SELECT RAISE(ABORT, 'forced write failure'); END;`);
    const scanned = scanFiles(root), file = scanned.find(f => f.path === path)!;
    const write = () => indexFile(db, indexId, root, file, new Set(scanned.map(f => f.path)));
    expect(write).toThrow("forced write failure");
    expect(snapshot(db, indexId)).toEqual(before);
    expect(db.inTransaction).toBe(false);
    db.exec("DROP TRIGGER fail_chunk");
    write();
    relinkEdges(db, indexId, [path]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM files WHERE index_id = ? AND path = ?").get(indexId, path)).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts f LEFT JOIN chunks c ON c.id = f.chunk_id AND c.index_id = f.index_id WHERE f.index_id = ? AND c.id IS NULL").get(indexId)).toEqual({ n: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
