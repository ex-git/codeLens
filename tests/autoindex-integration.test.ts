import { describe, expect, it } from "vitest";
import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.js";
import { detectScope } from "../src/git/scope.js";
import { computeIndexId } from "../src/index/identity.js";
import { resolveReal } from "../src/util/paths.js";

function makeRepo(): { repo: string; realRepo: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), "ce-autoindex-e2e-repo-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "session.ts"), "export function validateSession(t: string): boolean { return !!t; }\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  return { repo, realRepo: resolveReal(repo), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

function dbPathFor(home: string, repoRoot: string): string {
  const rid = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(home, ".codelens", "indexes", `index-${rid}.db`);
}

async function waitForIndexedFiles(dbPath: string, indexId: string, timeoutMs = 20_000): Promise<number> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    if (existsSync(dbPath)) {
      try {
        const db = openDb(dbPath);
        try {
          const row = db.prepare("SELECT COUNT(*) AS n FROM files WHERE index_id = ? AND deleted = 0").get(indexId) as { n: number };
          if (row.n > 0) return row.n;
        } finally {
          db.close();
        }
      } catch (err) {
        lastError = err;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for auto-indexed files in ${dbPath}: ${lastError instanceof Error ? lastError.message : String(lastError ?? "no db")}`);
}

describe("auto-index MCP startup integration", () => {
  it("indexes a missing workspace in a detached child before any MCP tool call", async () => {
    execSync("npm run build", { stdio: "ignore" });
    const { repo, realRepo, cleanup } = makeRepo();
    const fakeHome = mkdtempSync(join(tmpdir(), "ce-autoindex-e2e-home-"));
    const serverJs = join(process.cwd(), "build", "src", "server.js");
    const scope = detectScope(realRepo)!;
    const indexId = computeIndexId(scope);
    const dbPath = dbPathFor(fakeHome, realRepo);
    const server = spawn(process.execPath, [serverJs, "--cwd", realRepo, "--auto-index", "missing"], {
      cwd: tmpdir(),
      stdio: "ignore",
      env: { ...process.env, HOME: fakeHome },
    });

    try {
      const indexedFiles = await waitForIndexedFiles(dbPath, indexId);
      expect(indexedFiles).toBeGreaterThan(0);
    } finally {
      server.kill("SIGTERM");
      cleanup();
      rmSync(fakeHome, { recursive: true, force: true });
    }
    void repo;
  }, 30_000);
});
