import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveImport } from "../src/graph/resolve.js";

import { extractEdges, insertEdges } from "../src/graph/edges.js";
import { openMemoryDb } from "../src/db/db.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resolveImport", () => {
  it("resolves relative spec to known file", () => {
    const known = new Set(["src/auth/session.ts", "src/util/util.ts"]);
    expect(resolveImport("src/auth/auth.ts", "./session", known)).toBe("src/auth/session.ts");
  });
  it("tries extensions", () => {
    const known = new Set(["src/auth/session.ts"]);
    expect(resolveImport("src/auth/auth.ts", "./session.ts", known)).toBe("src/auth/session.ts");
  });
  it("returns null for bare/non-relative spec", () => {
    expect(resolveImport("src/a.ts", "react", new Set())).toBeNull();
  });
  it("returns null when unresolved", () => {
    expect(resolveImport("src/a.ts", "./missing", new Set())).toBeNull();
  });
});

describe("extractEdges", () => {
  it("emits imports edge for resolved relative import", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-edge-"));
    try {
      mkdirSync(join(dir, "src", "auth"), { recursive: true });
      writeFileSync(join(dir, "src", "auth", "session.ts"), "export function v() {}\n");
      writeFileSync(join(dir, "src", "auth", "auth.ts"), "import { v } from './session';\n");
      const known = new Set(["src/auth/session.ts", "src/auth/auth.ts"]);
      const edges = extractEdges("src/auth/auth.ts", "typescript",
        "import { v } from './session';\n", dir, known);
      const imp = edges.find((e) => e.type === "imports");
      expect(imp).toBeDefined();
      expect(imp!.toPath).toBe("src/auth/session.ts");
      expect(imp!.confidence).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unresolved import has toPath null + confidence 0", () => {
    const edges = extractEdges("src/a.ts", "typescript", "import { x } from './nope';\n", "/tmp", new Set());
    const imp = edges.find((e) => e.type === "imports");
    expect(imp).toBeDefined();
    expect(imp!.toPath).toBeNull();
  });
});

describe("insertEdges", () => {
  it("skips unresolved imports", () => {
    const db = openMemoryDb();
    const scope = { repoRoot: "/r", worktreePath: "/r", branch: "main", headSha: "a".repeat(40), dirtyFiles: [], detached: false };
    const { id } = getOrCreateIndex(db, scope);
    const edges = [
      { fromPath: "a.ts", toPath: "b.ts", fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9 },
      { fromPath: "a.ts", toPath: null, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0 },
    ];
    insertEdges(db, id, edges);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM edges WHERE index_id = ?").get(id) as { c: number };
    expect(rows.c).toBe(1); // only resolved
    db.close();
  });
});

describe("indexer edge integration", () => {
  let repo: string;
  let scope: GitScope | null;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ce-edgeidx-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
    mkdirSync(join(repo, "src", "auth"), { recursive: true });
    writeFileSync(join(repo, "src", "auth", "session.ts"), "export function validateSession() { return true; }\n");
    writeFileSync(join(repo, "src", "auth", "auth.ts"), "import { validateSession } from './session';\nexport const ok = validateSession();\n");
    execSync("git add -A && git commit -q -m init", { cwd: repo });
    scope = detectScope(repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("builds imports edge auth.ts → session.ts", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const imp = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND type = 'imports' AND from_path = ?",
    ).get(r.indexId, "src/auth/auth.ts") as { to_path: string } | undefined;
    expect(imp?.to_path).toBe("src/auth/session.ts");
    db.close();
  });

  it("builds defines + belongs_to edges", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const defines = db.prepare(
      "SELECT COUNT(*) AS c FROM edges WHERE index_id = ? AND type = 'defines'",
    ).get(r.indexId) as { c: number };
    expect(defines.c).toBeGreaterThan(0);
    db.close();
  });

  it("builds exports edge for exported symbol", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const exports = db.prepare(
      "SELECT COUNT(*) AS c FROM edges WHERE index_id = ? AND type = 'exports'",
    ).get(r.indexId) as { c: number };
    expect(exports.c).toBeGreaterThan(0);
    db.close();
  });
});
describe("resolveImport TS .js→.ts substitution", () => {
  it("resolves './identity.js' to 'src/index/identity.ts'", () => {
    const known = new Set(["src/index/identity.ts", "src/index/manager.ts"]);
    expect(resolveImport("src/index/manager.ts", "./identity.js", known)).toBe("src/index/identity.ts");
  });
  it("resolves './session' (no ext) to './session.ts'", () => {
    const known = new Set(["src/auth/session.ts"]);
    expect(resolveImport("src/auth/auth.ts", "./session", known)).toBe("src/auth/session.ts");
  });
  it("resolves './session.ts' directly", () => {
    const known = new Set(["src/auth/session.ts"]);
    expect(resolveImport("src/auth/auth.ts", "./session.ts", known)).toBe("src/auth/session.ts");
  });
  it("still returns null for bare specifiers", () => {
    expect(resolveImport("src/a.ts", "react", new Set())).toBeNull();
  });
});
