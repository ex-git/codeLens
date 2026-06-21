import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb } from "../src/db/db.js";
import { detectScope } from "../src/git/scope.js";
import { buildIndex } from "../src/index/indexer.js";
import { computeIndexId } from "../src/index/identity.js";
import { clearAutoIndexing, getAutoIndexStatus, hasPersistentIndex, isAutoIndexing, markAutoIndexing, normalizeAutoIndexMode } from "../src/index/autoindex.js";
import { getOrCreateIndex } from "../src/index/manager.js";

function makeRepo(): { repo: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), "ce-autoindex-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

describe("auto-index helpers", () => {
  it("normalizes invalid modes to the provided fallback", () => {
    expect(normalizeAutoIndexMode("always")).toBe("always");
    expect(normalizeAutoIndexMode("missing")).toBe("missing");
    expect(normalizeAutoIndexMode("never")).toBe("never");
    expect(normalizeAutoIndexMode("bad", "never")).toBe("never");
  });

  it("tracks and clears indexing markers", () => {
    const { repo, cleanup } = makeRepo();
    const scope = detectScope(repo)!;
    const indexId = computeIndexId(scope);
    try {
      clearAutoIndexing(indexId);
      expect(isAutoIndexing(indexId)).toBe(false);
      markAutoIndexing(indexId, repo);
      expect(isAutoIndexing(indexId)).toBe(true);
      expect(getAutoIndexStatus(indexId)).toMatchObject({ indexId, repoRoot: repo, startedAt: expect.any(Number), ageMs: expect.any(Number) });
      clearAutoIndexing(indexId);
      expect(isAutoIndexing(indexId)).toBe(false);
    } finally {
      clearAutoIndexing(indexId);
      cleanup();
    }
  });

  it("requires indexed files before an index counts as persistent", () => {
    const { repo, cleanup } = makeRepo();
    const db = openMemoryDb();
    const scope = detectScope(repo)!;
    try {
      expect(hasPersistentIndex(db, scope)).toBe(false);
      getOrCreateIndex(db, scope);
      expect(hasPersistentIndex(db, scope)).toBe(false);
      buildIndex(db, scope);
      expect(hasPersistentIndex(db, scope)).toBe(true);
    } finally {
      db.close();
      cleanup();
    }
  });
});
