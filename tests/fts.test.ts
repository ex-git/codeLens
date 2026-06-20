import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { CHUNKER_NAMES, CHUNKER_VERSION, chunkStructured, chunkText, deleteFileFromIndex, type TextChunk } from "../src/index/fts.js";
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

function coveredLines(chunks: TextChunk[]): Set<number> {
  const out = new Set<number>();
  for (const chunk of chunks) {
    for (let line = chunk.startLine; line <= chunk.endLine; line++) out.add(line);
  }
  return out;
}

describe("chunkText", () => {
  it("returns one chunk for small text", () => {
    const c = chunkText("hello\nworld\n");
    expect(c.length).toBe(1);
    expect(c[0]!.startLine).toBe(1);
  });

  it("splits long text into multiple overlapping chunks", () => {
    const big = Array(300).fill("x".repeat(50)).join("\n");
    const c = chunkText(big);
    expect(c.length).toBeGreaterThan(1);
    expect(c[1]!.startLine).toBeLessThanOrEqual(c[0]!.endLine);
  });

  it("can split without overlap when requested", () => {
    const big = Array(20).fill("x".repeat(20)).join("\n");
    const c = chunkText(big, { maxChars: 80, overlapChars: 0 });
    expect(c.length).toBeGreaterThan(1);
    expect(c[1]!.startLine).toBe(c[0]!.endLine + 1);
  });
});

describe("chunkStructured", () => {
  it("emits outermost symbol chunks and gap chunks", () => {
    const text = [
      "import { dep } from './dep';",
      "",
      "export class Service {",
      "  run() { return dep; }",
      "}",
      "",
      "export function helper() {",
      "  return 1;",
      "}",
    ].join("\n");
    const chunks = chunkStructured(text, [
      { name: "Service", kind: "class", startLine: 3, endLine: 5, exported: true },
      { name: "run", kind: "method", startLine: 4, endLine: 4, exported: false },
      { name: "helper", kind: "function", startLine: 7, endLine: 9, exported: true },
    ])!;

    expect(chunks.map((c) => [c.startLine, c.endLine, c.symbolName ?? "gap"])).toEqual([
      [1, 2, "gap"],
      [3, 5, "Service"],
      [6, 6, "gap"],
      [7, 9, "helper"],
    ]);
  });

  it("attaches an immediately preceding comment block to the symbol", () => {
    const text = [
      "import { dep } from './dep';",
      "/**",
      " * Validates the session.",
      " */",
      "export function validateSession() {",
      "  return dep;",
      "}",
    ].join("\n");
    const chunks = chunkStructured(text, [
      { name: "validateSession", kind: "function", startLine: 5, endLine: 7, exported: true },
    ])!;

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 1 });
    expect(chunks[0]).not.toHaveProperty("symbolName");
    expect(chunks[1]).toMatchObject({ startLine: 2, endLine: 7, symbolName: "validateSession" });
    expect(chunks[1]!.content).toContain("Validates the session");
  });

  it("keeps comments separated by a blank line as gap content", () => {
    const text = [
      "// file header",
      "",
      "export function run() {",
      "  return 1;",
      "}",
    ].join("\n");
    const chunks = chunkStructured(text, [
      { name: "run", kind: "function", startLine: 3, endLine: 5, exported: true },
    ])!;

    expect(chunks.map((c) => [c.startLine, c.endLine, c.symbolName ?? "gap"])).toEqual([
      [1, 2, "gap"],
      [3, 5, "run"],
    ]);
  });

  it("splits oversized symbols with symbol metadata on each split", () => {
    const text = [
      "export function big() {",
      ...Array(12).fill("  const value = 'abcdefghijklmnopqrstuvwxyz';"),
      "}",
    ].join("\n");
    const chunks = chunkStructured(text, [
      { name: "big", kind: "function", startLine: 1, endLine: 14, exported: true },
    ], { maxChars: 120, overlapChars: 20 })!;

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.symbolName === "big")).toBe(true);
    expect(chunks[1]!.startLine).toBeLessThanOrEqual(chunks[0]!.endLine);
  });

  it("is equivalent to chunkText when no symbols are available", () => {
    const text = Array(30).fill("plain text line").join("\n");
    expect(chunkStructured(text, [], { maxChars: 80 })).toEqual(chunkText(text, { maxChars: 80 }));
  });

  it("normalizes bad ranges while preserving complete line coverage", () => {
    const text = [
      "const one = 1;",
      "export function ok() {",
      "  return one;",
      "}",
      "const two = 2;",
    ].join("\n");
    const chunks = chunkStructured(text, [
      { name: "bad", kind: "function", startLine: 0, endLine: 100, exported: false },
      { name: "ok", kind: "function", startLine: 2, endLine: 10, exported: true },
      { name: "nested", kind: "function", startLine: 3, endLine: 3, exported: false },
    ], { maxChars: 1000, overlapChars: 0 })!;

    expect(chunks).toEqual([
      { startLine: 1, endLine: 1, content: "const one = 1;" },
      {
        startLine: 2,
        endLine: 5,
        content: "export function ok() {\n  return one;\n}\nconst two = 2;",
        symbolName: "ok",
        symbolKind: "function",
        symbolRangeKey: "2:5:function:ok",
      },
    ]);
    const lines = coveredLines(chunks);
    expect([...lines].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns null above the structural byte cap so callers can fall back", () => {
    const text = "export function huge() { return 1; }";
    expect(chunkStructured(text, [
      { name: "huge", kind: "function", startLine: 1, endLine: 1, exported: true },
    ], { maxBytes: 10 })).toBeNull();
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

  it("sets symbol_id and structural chunker metadata for symbol chunks", () => {
    const db = openMemoryDb();
    const scope = detectScope(repo)!;
    const r = buildIndex(db, scope);
    const rows = db.prepare(
      `SELECT c.symbol_id AS symbolId, c.chunker, c.chunker_version AS chunkerVersion, s.name AS symbolName
       FROM chunks c
       LEFT JOIN symbols s ON s.id = c.symbol_id
       WHERE c.index_id = ? AND c.path = ?
       ORDER BY c.start_line`,
    ).all(r.indexId, "src/session.ts") as { symbolId: string | null; chunker: string; chunkerVersion: number; symbolName: string | null }[];

    const structural = rows.find((row) => row.chunker === CHUNKER_NAMES.structural);
    expect(structural).toMatchObject({
      chunker: CHUNKER_NAMES.structural,
      chunkerVersion: CHUNKER_VERSION,
      symbolName: "validateSession",
    });
    expect(structural!.symbolId).toBeTruthy();
    db.close();
  });

  it("falls back to line chunks and skips parser-dependent extraction above the byte cap", () => {
    const hugePath = join(repo, "src", "huge.ts");
    writeFileSync(hugePath, `export function hugeGenerated() { return 1; }\n${"x".repeat(513 * 1024)}\n`);
    const db = openMemoryDb();
    const scope = detectScope(repo)!;
    const r = buildIndex(db, scope);
    const symbolCount = db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE index_id = ? AND path = ?").get(r.indexId, "src/huge.ts") as { c: number };
    const chunkers = db.prepare("SELECT DISTINCT chunker FROM chunks WHERE index_id = ? AND path = ?").all(r.indexId, "src/huge.ts") as { chunker: string }[];

    expect(symbolCount.c).toBe(0);
    expect(chunkers).toEqual([{ chunker: CHUNKER_NAMES.line }]);
    db.close();
    rmSync(hugePath);
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

  it("removes rows for files deleted since the previous full refresh", () => {
    const db = openMemoryDb();
    const transient = join(repo, "src", "gone.ts");
    writeFileSync(transient, "export const goneToken = 1;\n");
    const scope = detectScope(repo)!;
    const first = ctxRefresh(db, scope);
    expect(db.prepare("SELECT COUNT(*) AS c FROM files WHERE index_id = ? AND path = ?").get(first.indexId, "src/gone.ts")).toMatchObject({ c: 1 });
    rmSync(transient);
    const second = ctxRefresh(db, scope);
    expect(second.indexId).toBe(first.indexId);
    expect(db.prepare("SELECT COUNT(*) AS c FROM files WHERE index_id = ? AND path = ?").get(first.indexId, "src/gone.ts")).toMatchObject({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM chunks_fts WHERE index_id = ? AND path = ?").get(first.indexId, "src/gone.ts")).toMatchObject({ c: 0 });
    db.close();
  });
});