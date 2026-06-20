import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ensureFreshIndex } from "../src/index/reindex.js";
import { ctxSearch } from "../src/tools/search.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: GitScope | null;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-reindex-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("ensureFreshIndex", () => {
  it("no-op when nothing changed (pending=0)", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    const r = ensureFreshIndex(db, scope!);
    expect(r.refreshed).toBe(0);
    expect(r.deleted).toBe(0);
    expect(r.pending).toBe(0);
    db.close();
  });

  it("reindexes modified file → new content visible in search", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    // Before: no 'newFunc' in index
    const before = ctxSearch(db, "newFunc");
    expect(before.results.length).toBe(0);
    // Modify file to add a new function
    writeFileSync(join(repo, "src", "a.ts"), "export function newFunc() { return 42; }\n");
    const r = ensureFreshIndex(db, scope!);
    expect(r.refreshed).toBeGreaterThanOrEqual(1);
    const after = ctxSearch(db, "newFunc");
    expect(after.results.length).toBeGreaterThan(0);
    db.close();
  });

  it("drops deleted file from index", () => {
    const db = openMemoryDb();
    writeFileSync(join(repo, "src", "gone.ts"), "export function goneFunc() {}\n");
    buildIndex(db, scope!);
    expect(ctxSearch(db, "goneFunc").results.length).toBeGreaterThan(0);
    rmSync(join(repo, "src", "gone.ts"));
    const r = ensureFreshIndex(db, scope!);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(ctxSearch(db, "goneFunc").results.length).toBe(0);
    db.close();
  });

  it("budget exceeded → pending reported, freshness partial", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    // Add many files to exceed a tiny budget.
    for (let i = 0; i < 20; i++) {
      writeFileSync(join(repo, "src", `f${i}.ts`), `export const f${i} = ${i};\n`);
    }
    const r = ensureFreshIndex(db, scope!, { budgetMs: 0 });
    expect(r.pending).toBeGreaterThan(0);
    db.close();
    // cleanup
    for (let i = 0; i < 20; i++) rmSync(join(repo, "src", `f${i}.ts`));
  });

  it("ctxSearch with scope auto-refreshes and surfaces partial freshness", () => {
    const db = openMemoryDb();
    buildIndex(db, scope!);
    writeFileSync(join(repo, "src", "late.ts"), "export const late = 1;\n");
    // Use a 0ms budget to force partial
    const r = ctxSearch(db, "a", { scope: scope!, refreshBudgetMs: 0 });
    expect(r.freshness).toBe("partial");
    expect(r.pendingFiles).toBeGreaterThan(0);
    db.close();
    rmSync(join(repo, "src", "late.ts"));
  });
});

describe("ensureFreshIndex GDScript classNameMap propagation", () => {
  let gdRepo: string;
  let gdScope: GitScope | null;

  beforeAll(() => {
    gdRepo = mkdtempSync(join(tmpdir(), "ce-gd-reindex-"));
    execSync("git init -q", { cwd: gdRepo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: gdRepo });
    mkdirSync(join(gdRepo, "scripts"), { recursive: true });

    // player.gd extends Character — but Character class doesn't exist yet
    writeFileSync(
      join(gdRepo, "scripts", "player.gd"),
      `extends Character

func take_damage(amount):
  pass
`,
    );
    execSync("git add -A && git commit -q -m init", { cwd: gdRepo });
    gdScope = detectScope(gdRepo);
  });

  afterAll(() => rmSync(gdRepo, { recursive: true, force: true }));

  it("add class_name file → existing extends file get resolved edge", () => {
    const db = openMemoryDb();
    buildIndex(db, gdScope!);

    // Before: player.gd has no imports edge (Character unresolved)
    const before = db.prepare(
      "SELECT count(*) as c FROM edges WHERE index_id = ? AND from_path = 'scripts/player.gd' AND type = 'imports'",
    ).get(db.prepare("SELECT id FROM indexes ORDER BY rowid DESC LIMIT 1").get().id) as { c: number };
    expect(before.c).toBe(0);

    // Add character.gd with class_name Character
    writeFileSync(
      join(gdRepo, "scripts", "character.gd"),
      `class_name Character
extends Node2D

func take_damage(amount):
  pass
`,
    );

    // Incremental reindex — only character.gd is new, player.gd unchanged
    const r = ensureFreshIndex(db, gdScope!);
    expect(r.refreshed).toBeGreaterThanOrEqual(1);

    // After: player.gd should have imports edge → character.gd
    const idx = db.prepare("SELECT id FROM indexes ORDER BY rowid DESC LIMIT 1").get().id;
    const edge = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND from_path = 'scripts/player.gd' AND type = 'imports'",
    ).get(idx) as { to_path: string } | undefined;
    expect(edge?.to_path).toBe("scripts/character.gd");
    db.close();
  });

  it("remove class_name file → existing extends file lose stale edge", () => {
    const db = openMemoryDb();
    buildIndex(db, gdScope!);

    // Verify edge exists after full build
    const idx = db.prepare("SELECT id FROM indexes ORDER BY rowid DESC LIMIT 1").get().id;
    const edge = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND from_path = 'scripts/player.gd' AND type = 'imports'",
    ).get(idx) as { to_path: string } | undefined;
    expect(edge?.to_path).toBe("scripts/character.gd");

    // Delete character.gd — player.gd unchanged
    rmSync(join(gdRepo, "scripts", "character.gd"));

    // Incremental reindex
    const r = ensureFreshIndex(db, gdScope!);
    expect(r.deleted).toBeGreaterThanOrEqual(1);

    // After: player.gd should NOT have imports edge to character.gd
    const idx2 = db.prepare("SELECT id FROM indexes ORDER BY rowid DESC LIMIT 1").get().id;
    const stale = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND from_path = 'scripts/player.gd' AND type = 'imports' AND to_path = 'scripts/character.gd'",
    ).get(idx2) as { to_path: string } | undefined;
    expect(stale).toBeUndefined();
    db.close();
  });
});