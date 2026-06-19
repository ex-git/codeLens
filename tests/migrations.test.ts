import { describe, it, expect } from "vitest";
import { openMemoryDb, openDb } from "../src/db/db.js";
import { runMigrations, MIGRATIONS, CODE_SCHEMA_VERSION, DbVersionMismatch } from "../src/db/migrations.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("migrations", () => {
  it("fresh DB → v1, has all core tables", () => {
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
    db.close();
  });

  it("re-open v1 DB → no-op (version unchanged)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-mig-"));
    const path = join(dir, "test.db");
    const db1 = openDb(path);
    db1.close();
    const db2 = openDb(path);
    const v = db2.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
    expect(v.v).toBe(CODE_SCHEMA_VERSION);
    db2.close();
    rmSync(dir, { recursive: true, force: true });
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
    expect(versions).toEqual([1]);
  });
});