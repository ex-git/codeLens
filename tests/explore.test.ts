import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxExplore } from "../src/tools/explore.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-explore-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "session.ts"),
    "export function validateSession(token: string): boolean {\n  return token.length > 0;\n}\n");
  writeFileSync(join(repo, "src", "auth", "auth.ts"),
    "import { validateSession } from './session';\nexport const ok = validateSession('x');\n");
  writeFileSync(join(repo, "src", "auth", "dupes.ts"),
    "export function duplicateThing() {\n  return 'duplicate duplicate';\n}\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("ctxExplore", () => {
  it("groups search results by file with compact previews and signatures", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxExplore(db, "validateSession", { limit: 5 });
    expect(r.indexId).toBeTruthy();
    expect(r.query).toBe("validateSession");
    expect(r.count).toBeGreaterThan(0);
    const session = r.files.find((f) => f.path === "src/auth/session.ts");
    expect(session).toBeDefined();
    expect(session!.results[0]!.preview).toContain("**validateSession**");
    expect(session!.results[0]!.signature).toContain("validateSession");
    db.close();
  });

  it("includes a relationship map from top files", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxExplore(db, "validateSession", { limit: 5, relatedDepth: 1 });
    expect(r.related.some((n) => n.path === "src/auth/auth.ts" || n.sourcePath === "src/auth/auth.ts")).toBe(true);
    db.close();
  });

  it("returns empty groups for an empty/unsafe query", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxExplore(db, "!!!", { limit: 5 });
    expect(r.count).toBe(0);
    expect(r.files).toEqual([]);
    expect(r.related).toEqual([]);
    db.close();
  });
});
