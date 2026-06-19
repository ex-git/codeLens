import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxRelated, ctxRelatedTests } from "../src/tools/related.js";
import { neighbors, testsFor } from "../src/graph/query.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-related-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "session.ts"), "export function validateSession() { return true; }\n");
  writeFileSync(join(repo, "src", "auth", "auth.ts"), "import { validateSession } from './session';\nexport const ok = validateSession();\n");
  writeFileSync(join(repo, "src", "auth", "session.test.ts"), "import { validateSession } from './session';\ntest('x', () => {});\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("graph query", () => {
  it("neighbors: auth.ts imports session.ts", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const ns = neighbors(db, r.indexId, "src/auth/auth.ts", { types: ["imports"], depth: 1, direction: "out" });
    expect(ns.map((n) => n.path)).toContain("src/auth/session.ts");
    db.close();
  });

  it("testsFor: session.ts has session.test.ts", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const ts = testsFor(db, r.indexId, "src/auth/session.ts");
    expect(ts.map((t) => t.path)).toContain("src/auth/session.test.ts");
    db.close();
  });

  it("neighbors respects depth bound", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const ns = neighbors(db, r.indexId, "src/auth/auth.ts", { depth: 1 });
    expect(ns.every((n) => n.hops <= 1)).toBe(true);
    db.close();
  });
});

describe("ctxRelated tool", () => {
  it("returns imports neighbors", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const rel = ctxRelated(db, "src/auth/auth.ts", { types: ["imports"], direction: "out" });
    expect(rel.results.map((r) => r.path)).toContain("src/auth/session.ts");
    db.close();
  });

  it("ctxRelatedTests returns tests for source", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const rel = ctxRelatedTests(db, "src/auth/session.ts");
    expect(rel.results.map((r) => r.path)).toContain("src/auth/session.test.ts");
    db.close();
  });

  it("throws when no active index", () => {
    const db = openMemoryDb();
    expect(() => ctxRelated(db, "src/x.ts")).toThrow(/no active index/);
    db.close();
  });
});