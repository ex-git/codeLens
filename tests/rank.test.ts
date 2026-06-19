import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rank, normalize, DEFAULT_WEIGHTS } from "../src/search/rank.js";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxSearch } from "../src/tools/search.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("normalize", () => {
  it("maps values to 0-1", () => {
    expect(normalize([0, 5, 10])).toEqual([0, 0.5, 1]);
  });
  it("constant values → all 1", () => {
    expect(normalize([3, 3, 3])).toEqual([1, 1, 1]);
  });
});

describe("rank", () => {
  it("FTS+symbol outranks FTS-only", () => {
    const a = { path: "a.ts", startLine: 1, endLine: 2, fts: 0.8, symbol: 1, graph: 0, recency: 0 };
    const b = { path: "b.ts", startLine: 1, endLine: 2, fts: 0.8, symbol: 0, graph: 0, recency: 0 };
    const r = rank([a, b]);
    expect(r[0]!.path).toBe("a.ts");
  });
  it("graph signal boosts when present", () => {
    const a = { path: "a.ts", startLine: 1, endLine: 2, fts: 0.5, symbol: 0, graph: 1, recency: 0 };
    const b = { path: "b.ts", startLine: 1, endLine: 2, fts: 0.5, symbol: 0, graph: 0, recency: 0 };
    const r = rank([a, b]);
    expect(r[0]!.path).toBe("a.ts");
  });
  it("absent signals re-normalize weights, still returns results", () => {
    const a = { path: "a.ts", startLine: 1, endLine: 2, fts: 0.5 };
    const r = rank([a]);
    expect(r.length).toBe(1);
    expect(r[0]!.score).toBeGreaterThan(0);
  });
  it("why lists contributing signals", () => {
    const r = rank([{ path: "a.ts", startLine: 1, endLine: 2, fts: 0.5, symbol: 1, graph: 1, recency: 0 }]);
    expect(r[0]!.why).toEqual(expect.arrayContaining(["fts", "symbol", "graph"]));
  });
});

describe("ctxSearch integration", () => {
  let repo: string;
  let scope: GitScope | null;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ce-rank-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
    mkdirSync(join(repo, "src", "auth"), { recursive: true });
    writeFileSync(join(repo, "src", "auth", "session.ts"), "export function validateSession(token: string): boolean { return !!token; }\n");
    writeFileSync(join(repo, "src", "auth", "auth.ts"), "import { validateSession } from './session';\nexport const ok = validateSession('x');\n");
    execSync("git add -A && git commit -q -m init", { cwd: repo });
    scope = detectScope(repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("returns ranked handles with why", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ctxSearch(db, "validateSession");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0]!.score).toBeGreaterThan(0);
    expect(r.results[0]!.why).toBeDefined();
    db.close();
  });

  it("weights sum to 1 by default", () => {
    const sum = DEFAULT_WEIGHTS.fts + DEFAULT_WEIGHTS.symbol + DEFAULT_WEIGHTS.graph + DEFAULT_WEIGHTS.code + DEFAULT_WEIGHTS.recency;
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });
});
describe("contentType: code boost + filter", () => {
  it("rank gives code a modest boost over prose at equal signals", () => {
    const code = { path: "a.ts", startLine: 1, endLine: 2, fts: 0.5, symbol: 0, graph: 0, code: 1, recency: 0 };
    const prose = { path: "a.md", startLine: 1, endLine: 2, fts: 0.5, symbol: 0, graph: 0, code: 0, recency: 0 };
    const r = rank([code, prose]);
    expect(r[0]!.path).toBe("a.ts");
  });
  it("a strongly-matching doc still outranks a weakly-matching code file", () => {
    const code = { path: "a.ts", startLine: 1, endLine: 2, fts: 0.1, symbol: 0, graph: 0, code: 1, recency: 0 };
    const prose = { path: "a.md", startLine: 1, endLine: 2, fts: 1.0, symbol: 1, graph: 0, code: 0, recency: 0 };
    const r = rank([code, prose]);
    expect(r[0]!.path).toBe("a.md");
  });
});

describe("cl_search related preview", () => {
  let rrepo: string; let rscope: GitScope | null;
  beforeAll(() => {
    rrepo = mkdtempSync(join(tmpdir(), "ce-related-"));
    execSync("git init -q", { cwd: rrepo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: rrepo });
    mkdirSync(join(rrepo, "src", "auth"), { recursive: true });
    writeFileSync(join(rrepo, "src", "auth", "session.ts"), "export function validateSession(t: string): boolean { return !!t; }\n");
    writeFileSync(join(rrepo, "src", "auth", "auth.ts"), "import { validateSession } from './session';\nexport const ok = validateSession('x');\n");
    execSync("git add -A && git commit -q -m init", { cwd: rrepo });
    rscope = detectScope(rrepo);
  });
  afterAll(() => rmSync(rrepo, { recursive: true, force: true }));

  it("related:true returns graph neighbors of the top result", () => {
    const db = openMemoryDb();
    buildIndex(db, rscope!);
    const r = ctxSearch(db, "validateSession", { related: true });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.related!.length).toBeGreaterThan(0);
    // the two files are connected (auth.ts imports session.ts); the top result's
    // neighbors should include the other file regardless of which ranked first.
    expect(r.related!.some((n) => n.path.includes("auth.ts") || n.path.includes("session.ts"))).toBe(true);
    db.close();
  });
  it("without related, no related field", () => {
    const db = openMemoryDb();
    buildIndex(db, rscope!);
    expect(ctxSearch(db, "validateSession").related).toBeUndefined();
    db.close();
  });
});
