import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openDb, openMemoryDb, CorruptDb } from "../src/db/db.js";
import { checkIntegrity, dropCoreTables, isCorruptionError, backupBeforeMigration, restoreBackup } from "../src/index/recovery.js";
import { runMigrations, CODE_SCHEMA_VERSION, DbVersionMismatch } from "../src/db/migrations.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-recover-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("checkIntegrity", () => {
  it("returns ok for a fresh memory db", () => {
    const db = openMemoryDb();
    const r = checkIntegrity(db);
    expect(r.ok).toBe(true);
    db.close();
  });
});

describe("isCorruptionError", () => {
  it("detects corruption messages", () => {
    expect(isCorruptionError(new Error("database disk image is malformed"))).toBe(true);
    expect(isCorruptionError(new Error("file is not a database"))).toBe(true); // SQLITE_NOTADB is corruption-like
    expect(isCorruptionError(new Error("syntax error"))).toBe(false);
  });
});

describe("dropCoreTables", () => {
  it("removes core tables but keeps indexes + schema_version", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    dropCoreTables(db);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain("files");
    expect(tables).not.toContain("chunks");
    expect(tables).toContain("indexes");
    expect(tables).toContain("schema_version");
    db.close();
  });
});

describe("file-backed openDb", () => {
  it("creates db, passes integrity, runs migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-file-"));
    try {
      const path = join(dir, "test.db");
      const db = openDb(path);
      const v = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(v.v).toBe(CODE_SCHEMA_VERSION);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopening an existing db is a no-op migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-file2-"));
    try {
      const path = join(dir, "test.db");
      const db1 = openDb(path);
      db1.close();
      const db2 = openDb(path);
      const v = db2.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
      expect(v.v).toBe(CODE_SCHEMA_VERSION);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("backupBeforeMigration + restoreBackup", () => {
  it("round-trips a file backup", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bak-"));
    try {
      const path = join(dir, "test.db");
      writeFileSync(path, "original");
      const bak = backupBeforeMigration(path, 1);
      expect(readFileSync(bak, "utf-8")).toBe("original");
      writeFileSync(path, "corrupted");
      expect(restoreBackup(path, 1)).toBe(true);
      expect(readFileSync(path, "utf-8")).toBe("original");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("version guard", () => {
  it("DbVersionMismatch thrown on higher-version DB", () => {
    const db = openMemoryDb();
    db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(CODE_SCHEMA_VERSION + 1, Date.now());
    expect(() => runMigrations(db)).toThrow(DbVersionMismatch);
    db.close();
  });
});

describe("corruption detection on open", () => {
  it("openDb throws CorruptDb when integrity check fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-corrupt-"));
    try {
      const path = join(dir, "test.db");
      // Write garbage bytes so SQLite detects corruption.
      writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]));
      expect(() => openDb(path)).toThrow(CorruptDb);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});