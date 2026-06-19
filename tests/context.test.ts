import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryContextDb, saveContext, loadContext, listContexts, deleteContext } from "../src/context/store.js";
import { ctxSave, ctxLoad, ctxListContexts, ctxDeleteContext } from "../src/tools/save.js";
import { dropCoreTables, checkIntegrity } from "../src/index/recovery.js";
import { openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/repo/ctx-test";

describe("saved context store", () => {
  it("save + load roundtrip", () => {
    const db = openMemoryContextDb();
    saveContext(db, REPO, "auth-investigation", [
      { handle: "h1", path: "src/auth/session.ts" },
      { path: "src/auth/auth.ts", symbol_id: "sym1" },
    ], { notes: "wip", pinned: true });
    const { context, items } = loadContext(db, REPO, "auth-investigation");
    expect(context).not.toBeNull();
    expect(context!.pinned).toBe(true);
    expect(context!.notes).toBe("wip");
    expect(items.length).toBe(2);
    db.close();
  });

  it("list + delete", () => {
    const db = openMemoryContextDb();
    saveContext(db, REPO, "a", [{ path: "a.ts" }]);
    saveContext(db, REPO, "b", [{ path: "b.ts" }]);
    expect(listContexts(db, REPO).length).toBe(2);
    expect(deleteContext(db, REPO, "a")).toBe(true);
    expect(listContexts(db, REPO).length).toBe(1);
    db.close();
  });

  it("re-save same name overwrites items", () => {
    const db = openMemoryContextDb();
    saveContext(db, REPO, "x", [{ path: "a.ts" }]);
    saveContext(db, REPO, "x", [{ path: "b.ts" }]);
    const { items } = loadContext(db, REPO, "x");
    expect(items.length).toBe(1);
    expect(items[0]!.path).toBe("b.ts");
    db.close();
  });
});

describe("cl_save/cl_load tools", () => {
  it("roundtrip via tool wrappers", () => {
    const db = openMemoryContextDb();
    const r = ctxSave(db, REPO, "task1", [{ handle: "h", path: "p.ts" }], { pinned: true });
    expect(r.pinned).toBe(true);
    expect(r.itemCount).toBe(1);
    const { context, items } = ctxLoad(db, REPO, "task1");
    expect(context!.name).toBe("task1");
    expect(items[0]!.path).toBe("p.ts");
    expect(ctxListContexts(db, REPO).length).toBe(1);
    expect(ctxDeleteContext(db, REPO, "task1")).toBe(true);
    expect(ctxListContexts(db, REPO).length).toBe(0);
    db.close();
  });
});

describe("saved contexts survive core-index rebuild", () => {
  let repo: string;
  let scope: GitScope | null;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ce-survive-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    execSync("git add -A && git commit -q -m init", { cwd: repo });
    scope = detectScope(repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("core rebuild (dropCoreTables) leaves saved contexts intact", () => {
    const core = openMemoryDb();
    const ctx = openMemoryContextDb();
    buildIndex(core, scope!);
    ctxSave(ctx, repo, "important", [{ path: "src/a.ts" }], { pinned: true });

    // Simulate corruption recovery: drop core tables + integrity check.
    dropCoreTables(core);
    expect(checkIntegrity(core).ok).toBe(true);

    // Saved contexts in the separate DB are untouched.
    const { context, items } = ctxLoad(ctx, repo, "important");
    expect(context).not.toBeNull();
    expect(context!.pinned).toBe(true);
    expect(items[0]!.path).toBe("src/a.ts");
    core.close();
    ctx.close();
  });
});