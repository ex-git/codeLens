import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxImpact } from "../src/tools/impact.js";
import { ctxPath } from "../src/tools/path.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-impact-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "session.ts"),
    "export function validateSession(token: string): boolean { return token.length > 0; }\nexport function sharedName() { return true; }\nexport class Left { run() {} }\nexport class Right { run() {} }\n");
  writeFileSync(join(repo, "src", "auth", "auth.ts"),
    "import { validateSession } from './session';\nexport const ok = validateSession('x');\nexport function sharedName() { return ok; }\n");
  writeFileSync(join(repo, "tests", "session.test.ts"),
    "import { validateSession } from '../src/auth/session';\ntest('session', () => validateSession('x'));\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("ctxImpact", () => {
  it("returns callers, callees/affected files, and affected tests", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxImpact(db, { symbol: "validateSession", path: "src/auth/session.ts", depth: 2 });
    expect(r.target?.path).toBe("src/auth/session.ts");
    expect(r.callers.some((h) => h.path === "src/auth/auth.ts" || h.path === "tests/session.test.ts")).toBe(true);
    expect(r.affectedFiles.some((h) => h.path === "src/auth/auth.ts" || h.path === "tests/session.test.ts")).toBe(true);
    expect(r.affectedTests.some((h) => h.path === "tests/session.test.ts")).toBe(true);
    expect(r.summary?.affectedTests).toBe(r.affectedTests.length);
    expect(r.target?.symbolId).toBeTruthy();
    expect(r.callers.every((h) => h.provenance && h.confidenceLabel)).toBe(true);
    expect(r.confidenceNote).toContain("Impact is derived");
    db.close();
  });

  it("returns candidates instead of guessing an ambiguous symbol", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxImpact(db, { symbol: "sharedName" });
    expect(r.candidates?.length).toBeGreaterThan(1);
    expect(r.candidates?.every((c) => c.symbolId)).toBe(true);
    expect(r.target).toBeUndefined();
    expect(r.confidenceNote).toContain("Multiple symbols matched");
    db.close();
  });

  it("shares qualified exact identities with path queries", () => {
    const db = openMemoryDb();
    try {
      buildIndex(db, scope!);
      const input = "src/auth/session.ts#Left.run";
      const path = ctxPath(db, { from: input, to: input });
      const impact = ctxImpact(db, { path: "src/auth/session.ts", symbol: "Left.run" });
      expect(path.found).toBe(true);
      expect(path.from!.symbolId).toBe(impact.target!.symbolId);
      expect(impact.target).toMatchObject({ symbol: "run", kind: "method" });
      expect(ctxImpact(db, { path: "src/auth/session.ts", symbol: "run" }).candidates).toHaveLength(2);
    } finally { db.close(); }
  });

  it("keeps fuzzy lookup in impact without making path targets fuzzy", () => {
    const db = openMemoryDb();
    try {
      buildIndex(db, scope!);
      const exact = ctxImpact(db, { symbol: "validateSession" });
      const fuzzy = ctxImpact(db, { symbol: "validateSess" });
      expect(fuzzy.target).toEqual(exact.target);
      expect(ctxPath(db, { from: "validateSess", to: "src/auth/session.ts#validateSession" }).status).toBe("unresolved");
    } finally { db.close(); }
  });

  it("supports path-only impact with an honest confidence note", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxImpact(db, { path: "src/auth/session.ts", depth: 1, includeTests: false });
    expect(r.target?.path).toBe("src/auth/session.ts");
    expect(r.affectedTests).toEqual([]);
    expect(r.summary?.affectedTests).toBe(0);
    expect(r.confidenceNote).toContain("path-heuristic");
    db.close();
  });
});
