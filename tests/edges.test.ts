import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveImport, resolvePythonImport } from "../src/graph/resolve.js";

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

describe("resolvePythonImport", () => {
  const known = new Set([
    "base.py",
    "app/base.py",
    "app/services/auth.py",
    "app/utils.py",
    "pkg/models/__init__.py",
  ]);

  it("resolves relative Python modules", () => {
    expect(resolvePythonImport("app/services/auth.py", "..utils", known)).toBe("app/utils.py");
    expect(resolvePythonImport("app/services/auth.py", "..base", known)).toBe("app/base.py");
  });

  it("resolves exact repo-root Python modules and packages", () => {
    expect(resolvePythonImport("app/services/auth.py", "pkg.models", known)).toBe("pkg/models/__init__.py");
  });

  it("prefers a package over a same-named module", () => {
    const collision = new Set(["pkg.py", "pkg/__init__.py"]);
    expect(resolvePythonImport("app/services/auth.py", "pkg", collision)).toBe("pkg/__init__.py");
  });

  it("does not guess external, source-root, or over-climbed modules", () => {
    expect(resolvePythonImport("app/services/auth.py", "requests", known)).toBeNull();
    expect(resolvePythonImport("app/services/auth.py", "utils", known)).toBeNull();
    expect(resolvePythonImport("app/services/auth.py", "...base", known)).toBeNull();
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

  it("emits alias-aware Python imports, calls, and inheritance edges", () => {
    const source = [
      "from .utils import helper as h",
      "from pkg.base import Base as Parent",
      "from pkg.generic import Generic",
      "import pkg.tools as tools",
      "",
      "class Child(Parent, Generic[int]):",
      "    def run(self):",
      "        h()",
      "        h()",
      "        tools.work()",
      "",
    ].join("\n");
    const known = new Set([
      "app/service.py",
      "app/utils.py",
      "pkg/base.py",
      "pkg/generic.py",
      "pkg/tools/__init__.py",
    ]);
    const edges = extractEdges("app/service.py", "python", source, "/tmp", known);

    expect(edges.filter((e) => e.type === "imports").map((e) => e.toPath).sort()).toEqual([
      "app/utils.py",
      "pkg/base.py",
      "pkg/generic.py",
      "pkg/tools/__init__.py",
    ]);
    expect(edges.filter((e) => e.type === "calls").map((e) => e.toPath).sort()).toEqual([
      "app/utils.py",
      "pkg/tools/__init__.py",
    ]);
    expect(edges.find((e) => e.type === "calls" && e.toPath === "app/utils.py")?.toSymbol).toBe("helper");
    expect(edges.filter((e) => e.type === "inherits")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromPath: "app/service.py",
        toPath: "pkg/base.py",
        fromSymbol: "Child",
        toSymbol: "Base",
      }),
      expect.objectContaining({
        fromPath: "app/service.py",
        toPath: "pkg/generic.py",
        fromSymbol: "Child",
        toSymbol: "Generic",
      }),
    ]));
  });

  it("suppresses ambiguous package attributes with same-named submodules", () => {
    const known = new Set(["app/service.py", "pkg/__init__.py", "pkg/sub.py"]);
    const edges = extractEdges(
      "app/service.py", "python", "from pkg import sub\nsub.run()\n", "/tmp", known,
    );
    expect(edges.find((e) => e.type === "imports")).toMatchObject({ toPath: "pkg/__init__.py" });
    expect(edges.some((e) => e.type === "calls")).toBe(false);
  });

  it("does not apply from-import ambiguity to plain package imports", () => {
    const known = new Set(["app/service.py", "foo/__init__.py", "foo/foo.py"]);
    const edges = extractEdges(
      "app/service.py", "python", "import foo\nfoo.run()\n", "/tmp", known,
    );
    expect(edges.find((e) => e.type === "calls")).toMatchObject({
      toPath: "foo/__init__.py",
      toSymbol: "run",
    });
  });

  it("keeps distinct unaliased dotted imports sharing a root", () => {
    const known = new Set(["app/service.py", "pkg/foo.py", "pkg/bar.py"]);
    const edges = extractEdges(
      "app/service.py", "python",
      "import pkg.foo, pkg.bar\npkg.foo.run()\npkg.bar.run()\n", "/tmp", known,
    );
    expect(edges.filter((e) => e.type === "calls").map((e) => e.toPath).sort()).toEqual([
      "pkg/bar.py",
      "pkg/foo.py",
    ]);
  });

  it("resolves bindings at each use and suppresses shadowed calls", () => {
    const known = new Set(["app/service.py", "a.py", "b.py"]);
    const ordered = extractEdges(
      "app/service.py", "python", "from a import run\nrun()\nfrom b import run\n", "/tmp", known,
    );
    const parameterShadow = extractEdges(
      "app/service.py", "python", "from a import run\ndef f(run):\n    return run()\n", "/tmp", known,
    );
    const assignmentShadow = extractEdges(
      "app/service.py", "python", "from a import run\nrun = lambda: None\nrun()\n", "/tmp", known,
    );
    const unresolvedRebind = extractEdges(
      "app/service.py", "python", "from a import run\nfrom external import run\nrun()\n", "/tmp", known,
    );
    const unresolvedBase = extractEdges(
      "app/service.py", "python", "from a import Base\nfrom external import Base\nclass Child(Base):\n    pass\n", "/tmp", known,
    );
    expect(ordered.filter((e) => e.type === "calls").map((e) => e.toPath)).toEqual(["a.py"]);
    expect(parameterShadow.some((e) => e.type === "calls")).toBe(false);
    expect(assignmentShadow.some((e) => e.type === "calls")).toBe(false);
    expect(unresolvedRebind.some((e) => e.type === "calls")).toBe(false);
    expect(unresolvedBase.some((e) => e.type === "inherits")).toBe(false);
  });

  it("suppresses comprehension, with-as, and except-as shadowed calls", () => {
    const known = new Set(["app/service.py", "a.py"]);
    const sources = [
      "from a import f\n[f() for f in xs]\n",
      "from a import f\nwith resource as f:\n    f()\n",
      "from a import f\ntry:\n    pass\nexcept Error as f:\n    f()\n",
    ];
    for (const source of sources) {
      const edges = extractEdges("app/service.py", "python", source, "/tmp", known);
      expect(edges.some((e) => e.type === "calls")).toBe(false);
    }
  });

  it("requires the full module path for unaliased dotted imports", () => {
    const known = new Set(["app/service.py", "pkg/tools.py"]);
    const safe = extractEdges(
      "app/service.py", "python", "import pkg.tools\npkg.tools.run()\n", "/tmp", known,
    );
    const unsafe = extractEdges(
      "app/service.py", "python", "import pkg.tools\npkg.other()\n", "/tmp", known,
    );
    expect(safe.find((e) => e.type === "calls")).toMatchObject({ toPath: "pkg/tools.py", toSymbol: "run" });
    expect(unsafe.some((e) => e.type === "calls")).toBe(false);
  });

  it("does not emit Python calls or inheritance for unresolved imports", () => {
    const source = "from external.lib import Base, run\nclass Child(Base):\n    pass\nrun()\n";
    const edges = extractEdges("app/service.py", "python", source, "/tmp", new Set(["app/service.py"]));
    expect(edges.find((e) => e.type === "imports")).toMatchObject({ toPath: null, confidence: 0 });
    expect(edges.some((e) => e.type === "calls" || e.type === "inherits")).toBe(false);
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

  it("builds a calls edge auth.ts → session.ts", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const call = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND type = 'calls' AND from_path = ?",
    ).get(r.indexId, "src/auth/auth.ts") as { to_path: string } | undefined;
    expect(call?.to_path).toBe("src/auth/session.ts");
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
