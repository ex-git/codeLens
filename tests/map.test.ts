import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxMap } from "../src/tools/map.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-map-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "session.ts"),
    "export function validateSession(token: string): boolean { return !!token; }\nfunction internalHelper() { return 1; }\n");
  writeFileSync(join(repo, "src", "auth", "login.ts"),
    "export class LoginService { run() { return true; } }\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("ctxMap", () => {
  it("outlines exported symbols grouped by file under a dir prefix", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxMap(db, { path: "src/auth" });
    const paths = r.files.map((f) => f.path).sort();
    expect(paths).toContain("src/auth/session.ts");
    expect(paths).toContain("src/auth/login.ts");
    const session = r.files.find((f) => f.path === "src/auth/session.ts")!;
    const names = session.symbols.map((s) => s.name);
    expect(names).toContain("validateSession");
    expect(names).not.toContain("internalHelper"); // exported-only default
    expect(r.truncated).toBe(false);
    db.close();
  });

  it("all:true includes non-exported symbols", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxMap(db, { path: "src/auth/session.ts", all: true });
    const names = r.files.flatMap((f) => f.symbols.map((s) => s.name));
    expect(names).toContain("validateSession");
    expect(names).toContain("internalHelper");
    db.close();
  });

  it("respects the file cap and flags truncated", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxMap(db, { limit: 1 });
    expect(r.fileCount).toBe(1);
    expect(r.truncated).toBe(true);
    db.close();
  });

  it("throws when no active index", () => {
    const db = openMemoryDb();
    expect(() => ctxMap(db, {})).toThrow(/no active index/);
    db.close();
  });
});
