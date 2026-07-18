import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openMemoryDb, openDb } from "../src/db/db.js";
import { runMigrations, MIGRATIONS, CODE_SCHEMA_VERSION, DbVersionMismatch } from "../src/db/migrations.js";
import { SCHEMA_V1 } from "../src/db/schema.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PERFORMANCE_INDEXES = [
  "idx_symbols_index_path_name",
  "idx_edges_index_from_path",
  "idx_edges_index_to_path",
];

function chunkColumnNames(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[]).map((c) => c.name);
}

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[])
    .map((row) => row.name);
}

describe("migrations", () => {
  it("fresh DB → current schema, has all core tables and chunker columns", () => {
    const db = openMemoryDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of ["indexes", "files", "symbols", "chunks", "edges", "index_locks", "schema_version"]) {
      expect(names).toContain(expected);
    }
    // FTS5 virtual table is type='table' too.
    const fts = db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_fts'").get();
    expect(fts).toBeTruthy();
    expect(chunkColumnNames(db)).toEqual(expect.arrayContaining(["chunker", "chunker_version"]));
    expect(indexNames(db)).toEqual(expect.arrayContaining(PERFORMANCE_INDEXES));
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBe(CODE_SCHEMA_VERSION);
    db.close();
  });

  it("re-open current DB → no-op (version unchanged)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-mig-"));
    const path = join(dir, "test.db");
    try {
      const db1 = openDb(path);
      db1.close();
      const db2 = openDb(path);
      const v = db2.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(v.v).toBe(CODE_SCHEMA_VERSION);
      expect(chunkColumnNames(db2)).toEqual(expect.arrayContaining(["chunker", "chunker_version"]));
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades an existing v1 DB through pending migrations without editing schema.sql", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-mig-v1-"));
    const path = join(dir, "test.db");
    try {
      const legacy = new Database(path);
      legacy.exec(SCHEMA_V1);
      legacy.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(1, Date.now());
      expect(chunkColumnNames(legacy)).not.toContain("chunker");
      legacy.close();

      const db = openDb(path);
      const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(v.v).toBe(CODE_SCHEMA_VERSION);
      expect(chunkColumnNames(db)).toEqual(expect.arrayContaining(["chunker", "chunker_version"]));
      expect(indexNames(db)).toEqual(expect.arrayContaining(PERFORMANCE_INDEXES));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("higher-version DB → throws DbVersionMismatch", () => {
    const db = openMemoryDb();
    // Insert a schema_version row above the code max to simulate a future DB.
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(
      CODE_SCHEMA_VERSION + 5,
      Date.now(),
    );
    expect(() => runMigrations(db)).toThrow(DbVersionMismatch);
    db.close();
  });

  it("MIGRATIONS versions are unique and contiguous from 1", () => {
    const versions = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3]);
  });
});