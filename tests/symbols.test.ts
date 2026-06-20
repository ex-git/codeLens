import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { extractSymbols } from "../src/graph/symbols.js";
import { getParseFileCallCountForTesting, isSupported, loadGrammar, resetParseFileCallCountForTesting } from "../src/graph/grammars.js";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("grammars", () => {
  it("typescript is supported", () => {
    expect(isSupported("typescript")).toBe(true);
  });
  it("python is supported", () => {
    expect(isSupported("python")).toBe(true);
  });
  it("unsupported returns false", () => {
    expect(isSupported("klingon")).toBe(false);
    expect(loadGrammar("klingon")).toBeNull();
  });
});

describe("extractSymbols", () => {
  it("extracts TS function + class with exported flag", () => {
    const src = "export function validate(token: string): boolean { return true; }\nclass Session {\n  get id() { return 1; }\n}\n";
    const syms = extractSymbols("a.ts", "typescript", src);
    const fn = syms.find((s) => s.name === "validate");
    expect(fn).toBeDefined();
    expect(fn!.kind).toBe("function");
    expect(fn!.exported).toBe(true);
    expect(fn!.startLine).toBe(1);
    const cls = syms.find((s) => s.name === "Session");
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe("class");
  });

  it("extracts Python def + class", () => {
    const src = "def add(a, b):\n    return a + b\n\nclass Foo:\n    def bar(self):\n        pass\n";
    const syms = extractSymbols("a.py", "python", src);
    expect(syms.find((s) => s.name === "add" && s.kind === "function")).toBeDefined();
    expect(syms.find((s) => s.name === "Foo" && s.kind === "class")).toBeDefined();
  });

  it("returns [] for unsupported language (graceful fallback)", () => {
    const syms = extractSymbols("a.txt", "plaintext", "no symbols here");
    expect(syms).toEqual([]);
  });
});

describe("indexer symbol integration", () => {
  let repo: string;
  let scope: GitScope | null;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ce-sym-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export function validateSession(t: string): boolean { return !!t; }\n");
    execSync("git add -A && git commit -q -m init", { cwd: repo });
    scope = detectScope(repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("symbols table populated after buildIndex", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const syms = db.prepare("SELECT name, kind, exported FROM symbols WHERE index_id = ?").all(r.indexId) as { name: string; kind: string; exported: number }[];
    expect(syms.find((s) => s.name === "validateSession" && s.kind === "function")).toBeDefined();
    db.close();
  });

  it("parses each eligible file once while populating symbols and edges", () => {
    const db = openMemoryDb();
    resetParseFileCallCountForTesting();
    buildIndex(db, scope!);
    expect(getParseFileCallCountForTesting()).toBe(1);
    db.close();
  });
});
