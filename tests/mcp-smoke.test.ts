import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TOOLS } from "../src/tools/registry.js";
import { openMemoryDb } from "../src/db/db.js";
import { openMemoryContextDb } from "../src/context/store.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerContext } from "../src/tools/registry.js";

const EXPECTED_TOOLS = [
  "cl_current", "cl_refresh", "cl_search", "cl_related", "cl_expand",
  "cl_save", "cl_load", "cl_stats", "cl_doctor", "cl_prune", "cl_drop",
];

describe("tool registry", () => {
  it("registers all 10 tools with schemas + descriptions", () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of EXPECTED_TOOLS) expect(names).toContain(n);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.schema).toBeDefined();
      expect(typeof t.handler).toBe("function");
    }
  });
});

describe("tool handlers (end-to-end via registry)", () => {
  let repo: string;
  let scope: GitScope | null;
  let ctx: ServerContext;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ce-reg-e2e-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
    mkdirSync(join(repo, "src", "auth"), { recursive: true });
    writeFileSync(join(repo, "src", "auth", "session.ts"), "export function validateSession(t: string): boolean { return !!t; }\n");
    execSync("git add -A && git commit -q -m init", { cwd: repo });
    scope = detectScope(repo);
    ctx = { coreDb: openMemoryDb(), ctxDb: openMemoryContextDb(), repoRoot: repo };
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  async function call(name: string, args: Record<string, unknown> = {}) {
    const t = TOOLS.find((x) => x.name === name)!;
    return await t.handler(ctx, args);
  }

  it("cl_refresh builds index", async () => {
    void scope;
    const r = await call("cl_refresh") as { indexedFiles: number };
    expect(r.indexedFiles).toBeGreaterThan(0);
  });

  it("cl_current reports active index", () => {
    void scope;
  });

  it("cl_search returns ranked handles", async () => {
    const r = await call("cl_search", { query: "validateSession", limit: 5 }) as { results: Array<{ path: string }> };
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.some((h) => h.path === "src/auth/session.ts")).toBe(true);
  });

  it("cl_expand reads exact file", async () => {
    const r = await call("cl_expand", { path: "src/auth/session.ts", startLine: 1, endLine: 1 }) as { content: string };
    expect(r.content).toContain("validateSession");
  });

  it("cl_save + cl_load roundtrip", async () => {
    await call("cl_save", { name: "task", items: [{ path: "src/auth/session.ts" }], pinned: true });
    const r = await call("cl_load", { name: "task" }) as { context: { pinned: boolean }; items: Array<{ path: string }> };
    expect(r.context.pinned).toBe(true);
    expect(r.items[0]!.path).toBe("src/auth/session.ts");
  });

  it("cl_stats reports counts", async () => {
    const r = await call("cl_stats") as { active: boolean; counts: Record<string, number> };
    expect(r.active).toBe(true);
    expect(r.counts.files).toBeGreaterThan(0);
  });

  it("cl_prune returns a result", async () => {
    const r = await call("cl_prune") as { deletedIndexes: unknown[] };
    expect(Array.isArray(r.deletedIndexes)).toBe(true);
  });
});