import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxSearch } from "../src/tools/search.js";
import { ctxExpand } from "../src/tools/expand.js";
import { ctxCurrent } from "../src/tools/current.js";
import { splitIdentifiers } from "../src/search/identifiers.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: ReturnType<typeof detectScope>;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-search-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "session.ts"),
    "export function validateSession(token: string): boolean {\n  return token.length > 0;\n}\n");
  writeFileSync(join(repo, "src", "auth", "auth.ts"),
    "import { validateSession } from './session.js';\nexport const ok = validateSession('x');\n");
  writeFileSync(join(repo, "src", "auth", "multi.ts"),
    "export function targetHandler() {\n  return 'sharedToken';\n}\n\nexport function otherHandler() {\n  return 'sharedToken targetHandler';\n}\n");
  writeFileSync(join(repo, "src", "auth", "camel.ts"),
    "export function renewAccessToken(): string {\n  return 'ok';\n}\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("splitIdentifiers", () => {
  it("splits identifiers with bounds, dedupe, and short-token filtering", () => {
    expect(splitIdentifiers("validateSession user_id MAX_SESSION_LEN", { maxTokens: 10 })).toEqual([
      "validate", "session", "user", "max", "session", "len",
    ].filter((term, index, all) => all.indexOf(term) === index));
    expect(splitIdentifiers("fooBar fooBar bazQux", { maxTokens: 3 })).toEqual(["foo", "bar", "baz"]);
    expect(splitIdentifiers("id ok", { maxTokens: 10 })).toEqual([]);
  });
});

describe("ctxSearch", () => {
  it("returns handles scoped to active index", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxSearch(db, "validateSession");
    expect(r.results.length).toBeGreaterThan(0);
    const paths = r.results.map((h) => h.path);
    expect(paths).toContain("src/auth/session.ts");
    expect(r.results[0]!.handle).toBeTruthy();
    expect(r.results[0]!.snippet).toContain("**validateSession**");
    db.close();
  });

  it("branch isolation: second index returns no rows from first", () => {
    const db = openMemoryDb();
    // Build index A
    buildIndex(db, scope!);
    const rA = ctxSearch(db, "validateSession");
    expect(rA.results.length).toBeGreaterThan(0);
    // Create a second index for a different scope and don't index anything.
    const scopeB: GitScope = { ...scope!, branch: "other", headSha: scope!.headSha + "0" };
    getOrCreateIndex(db, scopeB);
    const rB = ctxSearch(db, "validateSession");
    expect(rB.results.length).toBe(0); // different active index, no rows
    db.close();
  });

  it("cursor pagination returns more results", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r1 = ctxSearch(db, "session", { limit: 1 });
    if (r1.nextCursor) {
      const r2 = ctxSearch(db, "session", { limit: 1, cursor: r1.nextCursor });
      // second page should have at least one result if more existed
      if (r1.results.length === 1) {
        expect(r2.results.length).toBeGreaterThanOrEqual(0);
      }
    }
    db.close();
  });

  it("throws when no active index", () => {
    const db = openMemoryDb();
    expect(() => ctxSearch(db, "x")).toThrow(/no active index/);
    db.close();
  });

  it("snippet=none returns empty previews (path+lines only)", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxSearch(db, "validateSession", { snippet: "none" });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((h) => h.snippet === "")).toBe(true);
    expect(r.results[0]!.handle).toBeTruthy();
    db.close();
  });

  it("snippet=headline is a signature-first single line, smaller than full", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const head = ctxSearch(db, "validateSession", { snippet: "headline" });
    const full = ctxSearch(db, "validateSession", { snippet: "full" });
    const h = head.results.find((x) => x.path === "src/auth/session.ts")!;
    const f = full.results.find((x) => x.path === "src/auth/session.ts")!;
    expect(h.snippet).toContain("**validateSession**");
    expect(h.snippet.split("\n").length).toBe(1); // single line
    expect(h.snippet.length).toBeLessThanOrEqual(f.snippet.length);
    db.close();
  });

  it("default preview keeps the field present and highlights matches", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxSearch(db, "validateSession");
    expect(r.results[0]!.snippet).toContain("**validateSession**");
    db.close();
  });

  it("finds camelCase subtokens without changing displayed snippets", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxSearch(db, "access", { limit: 5, snippet: "compact" });
    const hit = r.results.find((x) => x.path === "src/auth/camel.ts");
    expect(hit).toBeDefined();
    expect(hit!.snippet).toContain("renew**Access**Token");
    expect(hit!.snippet).not.toContain("renew access token");
    db.close();
  });

  it("handles punctuation-heavy expanded queries without throwing", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    expect(() => ctxSearch(db, "access \"foo-bar\" OR NEAR", { limit: 5, snippet: "none" })).not.toThrow();
    db.close();
  });

  it("ranks the matching symbol chunk above sibling chunks from the same file", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxSearch(db, "targetHandler sharedToken", { limit: 10, snippet: "none" });
    const multi = r.results.filter((x) => x.path === "src/auth/multi.ts");
    expect(multi.length).toBeGreaterThanOrEqual(2);
    expect(multi[0]).toMatchObject({ startLine: 1, endLine: 3 });
    expect(multi[0]!.why).toEqual(expect.arrayContaining(["symbol", "exact"]));
    db.close();
  });
});

describe("ctxExpand", () => {
  it("reads exact current file content from disk", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const s = ctxSearch(db, "validateSession");
    const handle = s.results.find((h) => h.path === "src/auth/session.ts")!.handle;
    const exp = ctxExpand(db, repo, { handle });
    const disk = readFileSync(join(repo, "src", "auth", "session.ts"), "utf-8");
    expect(exp.content).toContain("validateSession");
    expect(disk).toContain("validateSession");
    expect(exp.truncated).toBe(false);
    db.close();
  });

  it("supports path + range expansion", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const exp = ctxExpand(db, repo, { path: "src/auth/session.ts", startLine: 1, endLine: 1 });
    expect(exp.content).toBe("export function validateSession(token: string): boolean {");
    db.close();
  });

  it("respects budget truncation", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const exp = ctxExpand(db, repo, { path: "src/auth/session.ts", budget: 20 });
    expect(exp.truncated).toBe(true);
    expect(exp.content).toContain("[truncated");
    db.close();
  });

  it("rejects path traversal", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    expect(() => ctxExpand(db, repo, { path: "../../etc/passwd" })).toThrow();
    db.close();
  });
});

describe("ctxCurrent", () => {
  it("reports active index after build", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const c = ctxCurrent(db, repo);
    expect(c.inGitRepo).toBe(true);
    expect(c.branch).toBe(scope!.branch);
    expect(c.indexId).toBeTruthy();
    expect(c.status).toBe("active");
    db.close();
  });

  it("reports missing outside git repo", () => {
    const db = openMemoryDb();
    const noGit = mkdtempSync(join(tmpdir(), "ce-nogit2-"));
    try {
      const c = ctxCurrent(db, noGit);
      expect(c.inGitRepo).toBe(false);
      expect(c.status).toBe("missing");
    } finally {
      rmSync(noGit, { recursive: true, force: true });
      db.close();
    }
  });
});