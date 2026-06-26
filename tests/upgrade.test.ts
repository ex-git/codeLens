import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { pruneInstalledIndexes, readRootVersion } from "../src/upgrade.js";
import { VERSION } from "../src/version.js";

function insertExpiredIndex(db: ReturnType<typeof openDb>, id: string): void {
  db.prepare(
    `INSERT INTO indexes (id, repo_root, worktree_path, branch_name, head_sha, created_at, last_accessed_at, expires_at, pinned, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active')`,
  ).run(id, "/repo", "/repo", "old-branch", "a".repeat(40), 1, 1, 2);
}

describe("readRootVersion", () => {
  it("reads version from a root package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-upg-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
      expect(readRootVersion(dir)).toBe("9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the running VERSION when package.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-upg2-"));
    try {
      expect(readRootVersion(dir)).toBe(VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pruneInstalledIndexes", () => {
  it("prunes expired indexes across installed index DBs", () => {
    const home = mkdtempSync(join(tmpdir(), "ce-upg-prune-home-"));
    try {
      const indexDir = join(home, ".codelens", "indexes");
      mkdirSync(indexDir, { recursive: true });
      const dbPath = join(indexDir, "index-test.db");
      const db = openDb(dbPath);
      try {
        insertExpiredIndex(db, "idx_expired_upgrade_test");
      } finally {
        db.close();
      }

      const result = pruneInstalledIndexes(home);

      expect(result).toEqual({ scannedDbs: 1, deletedIndexes: 1, failedDbs: 0 });
      const check = openDb(dbPath);
      try {
        const row = check.prepare("SELECT COUNT(*) AS n FROM indexes WHERE id = ?").get("idx_expired_upgrade_test") as { n: number };
        expect(row.n).toBe(0);
      } finally {
        check.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
