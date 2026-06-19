import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isTestFile, inferTestTargets, resolveTestTargets } from "../src/graph/tests.js";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isTestFile", () => {
  it("detects *.test.* and *.spec.*", () => {
    expect(isTestFile("src/auth/session.test.ts")).toBe(true);
    expect(isTestFile("src/auth/session.spec.ts")).toBe(true);
    expect(isTestFile("src/auth/session.ts")).toBe(false);
  });
  it("detects test dirs", () => {
    expect(isTestFile("src/__tests__/foo.ts")).toBe(true);
    expect(isTestFile("tests/foo.ts")).toBe(true);
  });
  it("detects test_ prefix / _test suffix (go/python)", () => {
    expect(isTestFile("session_test.go")).toBe(true);
    expect(isTestFile("test_session.py")).toBe(true);
  });
});

describe("inferTestTargets", () => {
  it("foo.test.ts → foo.ts", () => {
    const t = inferTestTargets("src/auth/session.test.ts");
    expect(t).toContain("src/auth/session.ts");
  });
  it("__tests__/foo.test.ts → ../foo.ts", () => {
    const t = inferTestTargets("src/__tests__/foo.test.ts");
    expect(t.some((p) => p.endsWith("/foo.ts"))).toBe(true);
  });
});

describe("resolveTestTargets", () => {
  it("only returns targets present in known files", () => {
    const known = new Set(["src/auth/session.ts"]);
    expect(resolveTestTargets("src/auth/session.test.ts", known)).toEqual(["src/auth/session.ts"]);
    expect(resolveTestTargets("src/auth/missing.test.ts", known)).toEqual([]);
  });
});

describe("indexer test edge integration", () => {
  let repo: string;
  let scope: GitScope | null;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ce-testedge-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
    mkdirSync(join(repo, "src", "auth"), { recursive: true });
    writeFileSync(join(repo, "src", "auth", "session.ts"), "export function validateSession() { return true; }\n");
    writeFileSync(join(repo, "src", "auth", "session.test.ts"), "import { validateSession } from './session';\ntest('works', () => {});\n");
    execSync("git add -A && git commit -q -m init", { cwd: repo });
    scope = detectScope(repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("emits tests edge session.test.ts → session.ts", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const edge = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND type = 'tests' AND from_path = ?",
    ).get(r.indexId, "src/auth/session.test.ts") as { to_path: string } | undefined;
    expect(edge?.to_path).toBe("src/auth/session.ts");
    db.close();
  });

  it("non-test source file has no outgoing tests edge", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const edge = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND type = 'tests' AND from_path = ?",
    ).get(r.indexId, "src/auth/session.ts") as { to_path: string } | undefined;
    expect(edge).toBeUndefined();
    db.close();
  });
});