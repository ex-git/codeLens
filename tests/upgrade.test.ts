import { afterEach, describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { performUpgrade, pruneInstalledIndexes, readRootVersion } from "../src/upgrade.js";
import { VERSION } from "../src/version.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawnSync: vi.fn(),
}));
vi.mock("../src/runtime/daemon.js", () => ({
  shutdownAllDaemons: async () => ({ scanned: 0, signaled: 0, stopped: 0, staleCleaned: 0, failed: 0 }),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

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

describe("upgrade installation verification", () => {
  for (const failed of ["install", "build", "check", "none"]) {
    it(`verifies before configuration refresh (${failed})`, async () => {
      const home = mkdtempSync(join(tmpdir(), "ce-upgrade-verify-"));
      vi.stubEnv("HOME", home);
      vi.stubEnv("USERPROFILE", home);
      const steps: string[] = [];
      vi.mocked(spawnSync).mockImplementation((command, args) => {
        const words = args as string[];
        const step = command === "git" ? "git" : command === "npm" ? (words[0] === "install" ? "install" : "build") : words.includes("--check-install") ? "check" : "refresh";
        steps.push(step);
        return { status: step === failed ? 9 : 0, stdout: step === "git" ? "main" : "", stderr: step === failed ? "simulated dependency failure" : "", pid: 1, output: [], signal: null };
      });
      try {
        const result = await performUpgrade();
        expect(result.ok).toBe(failed === "none");
        expect(steps.includes("refresh")).toBe(failed === "none");
        if (failed === "check") expect(result.message).toContain("installation verification failed");
        if (failed === "none") expect(steps.indexOf("check")).toBeLessThan(steps.indexOf("refresh"));
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  }
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
