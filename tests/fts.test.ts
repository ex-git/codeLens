import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { chunkText, deleteFileFromIndex } from "../src/index/fts.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxRefresh } from "../src/tools/refresh.js";
import { detectScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-fts-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "session.ts"), "export function validateSession(token: string): boolean {\n  return token.length > 0;\n}\n");
  writeFileSync(join(repo, "src", "auth.ts"), "import { validateSession } from './session.js';\nexport const ok = validateSession('x');\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("chunkText", () => {
  it("returns one chunk for small text", () => {
    const c = chunkText("hello\nworld\n");
    expect(c.length).toBe(1);
    expect(c[0]!.startLine).toBe(1);
  });
  it("splits long text into multiple chunks", () => {
    const big = Array(300).fill("x".repeat(50)).join("\n");
    const c = chunkText(big);
    expect(c.length).toBeGreaterThan(1);
    // chunks should be line-contiguous
    expect(c[0]!.endLine).toBeLessThanOrEqual(c[1]!.startLine + 1);
  });
});

describe("indexFile + FTS", () => {
  it("indexes a file and FTS MATCH finds its content", () => {
    const db = openMemoryDb();
    const scope = detectScope(repo)!;
    const r = buildIndex(db, scope);
    expect(r.indexedFiles).toBeGreaterThanOrEqual(2);
    const hits = db
      .prepare("SELECT DISTINCT path FROM chunks_fts WHERE chunks_fts MATCH 'validateSession' AND index_id = ?")
      .all(r.indexId) as { path: string }[];
    const paths = hits.map((h) => h.path);
    expect(paths).toContain("src/session.ts");
    db.close();
  });

  it("deleteFileFromIndex removes FTS + chunks + files rows", () => {
    const db = openMemoryDb();
    const scope = detectScope(repo)!;
    const r = buildIndex(db, scope);
    deleteFileFromIndex(db, r.indexId, "src/session.ts");
    const fts = db.prepare("SELECT COUNT(*) AS c FROM chunks_fts WHERE index_id = ? AND path = ?").get(r.indexId, "src/session.ts") as { c: number };
    expect(fts.c).toBe(0);
    const f = db.prepare("SELECT COUNT(*) AS c FROM files WHERE index_id = ? AND path = ?").get(r.indexId, "src/session.ts") as { c: number };
    expect(f.c).toBe(0);
    db.close();
  });
});

describe("ctxRefresh tool", () => {
  it("returns ready status with counts", () => {
    const db = openMemoryDb();
    const scope = detectScope(repo)!;
    const r = ctxRefresh(db, scope);
    expect(r.status).toBe("ready");
    expect(r.branch).toBe(scope.branch);
    expect(r.indexedFiles).toBeGreaterThanOrEqual(2);
    db.close();
  });
});