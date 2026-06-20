import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolveGodotPath } from "../src/graph/resolve.js";
import { extractEdges, insertEdges } from "../src/graph/edges.js";
import { openMemoryDb } from "../src/db/db.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { buildIndex } from "../src/index/indexer.js";
import { detectScope, type GitScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("resolveGodotPath", () => {
  it("strips res:// and resolves exact match", () => {
    const known = new Set(["scripts/weapon.gd", "animations/run.tres"]);
    expect(resolveGodotPath("res://scripts/weapon.gd", "/tmp", known)).toBe("scripts/weapon.gd");
    expect(resolveGodotPath("res://animations/run.tres", "/tmp", known)).toBe("animations/run.tres");
  });

  it("tries .gd extension for bare paths", () => {
    const known = new Set(["scripts/weapon.gd"]);
    expect(resolveGodotPath("res://scripts/weapon", "/tmp", known)).toBe("scripts/weapon.gd");
  });

  it("returns null for non-res:// paths", () => {
    expect(resolveGodotPath("usr://foo.gd", "/tmp", new Set())).toBeNull();
    expect(resolveGodotPath("foo.gd", "/tmp", new Set())).toBeNull();
  });

  it("returns null for unresolved paths", () => {
    const known = new Set(["other/file.gd"]);
    expect(resolveGodotPath("res://missing/script.gd", "/tmp", known)).toBeNull();
  });
});

describe("GDScript extractEdges — preload", () => {
  it("emits imports edge for preload(res://...)", () => {
    const known = new Set(["scripts/weapon.gd", "player.gd"]);
    const source = `extends Node2D
const weapon = preload("res://scripts/weapon.gd")
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const imp = edges.find((e) => e.type === "imports" && e.toPath === "scripts/weapon.gd");
    expect(imp).toBeDefined();
    expect(imp!.confidence).toBe(0.9);
  });

  it("emits imports edge for load(res://...)", () => {
    const known = new Set(["scripts/weapon.gd", "player.gd"]);
    const source = `extends Node2D
var weapon = load("res://scripts/weapon.gd")
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const imp = edges.find((e) => e.type === "imports" && e.toPath === "scripts/weapon.gd");
    expect(imp).toBeDefined();
  });

  it("deduplicates multiple preload of same target", () => {
    const known = new Set(["scripts/weapon.gd", "player.gd"]);
    const source = `extends Node2D
const w1 = preload("res://scripts/weapon.gd")
const w2 = preload("res://scripts/weapon.gd")
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const imps = edges.filter((e) => e.type === "imports");
    expect(imps).toHaveLength(1);
  });

  it("resolves bare res:// path with .gd extension", () => {
    const known = new Set(["scripts/weapon.gd", "player.gd"]);
    const source = `extends Node2D
const weapon = preload("res://scripts/weapon")
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const imp = edges.find((e) => e.type === "imports" && e.toPath === "scripts/weapon.gd");
    expect(imp).toBeDefined();
  });
});

describe("GDScript extractEdges — extends", () => {
  it("emits imports edge for extends with res:// path", () => {
    const known = new Set(["base/character.gd", "player.gd"]);
    const source = `extends "res://base/character.gd"
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const imp = edges.find((e) => e.type === "imports" && e.toPath === "base/character.gd");
    expect(imp).toBeDefined();
    expect(imp!.confidence).toBe(0.9);
  });

  it("no imports edge for extends ClassName (unresolved)", () => {
    const known = new Set(["player.gd"]);
    const source = `extends Node2D
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const imps = edges.filter((e) => e.type === "imports");
    expect(imps).toHaveLength(0);
  });
});

describe("GDScript extractEdges — calls", () => {
  it("emits calls edge for local function call", () => {
    const known = new Set(["player.gd"]);
    const source = `extends Node2D

func _ready():
  move_toward(10, 20)

func move_toward(x, y):
  pass
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const calls = edges.filter((e) => e.type === "calls");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toSymbol).toBe("move_toward");
    expect(calls[0]!.toPath).toBe("player.gd"); // self-reference
  });

  it("emits calls edge for method on preload'd var", () => {
    const known = new Set(["scripts/weapon.gd", "player.gd"]);
    const source = `extends Node2D
const weapon = preload("res://scripts/weapon.gd")

func _ready():
  weapon.attack()
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const calls = edges.filter((e) => e.type === "calls" && e.toPath === "scripts/weapon.gd");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toSymbol).toBe("attack");
    expect(calls[0]!.confidence).toBe(0.6);
  });

  it("does not emit calls for preload/load themselves", () => {
    const known = new Set(["scripts/weapon.gd", "player.gd"]);
    const source = `extends Node2D
const weapon = preload("res://scripts/weapon.gd")
`;
    const edges = extractEdges("player.gd", "gdscript", source, "/tmp", known);
    const calls = edges.filter((e) => e.type === "calls");
    expect(calls).toHaveLength(0);
  });
});

describe("GDScript insertEdges", () => {
  it("skips unresolved GDScript imports", () => {
    const db = openMemoryDb();
    const scope = { repoRoot: "/r", worktreePath: "/r", branch: "main", headSha: "a".repeat(40), dirtyFiles: [], detached: false };
    const { id } = getOrCreateIndex(db, scope);
    const edges = [
      { fromPath: "player.gd", toPath: "scripts/weapon.gd", fromSymbol: null, toSymbol: null, type: "imports", confidence: 0.9 },
      { fromPath: "player.gd", toPath: null, fromSymbol: null, toSymbol: null, type: "imports", confidence: 0 },
      { fromPath: "player.gd", toPath: "player.gd", fromSymbol: null, toSymbol: "move_toward", type: "calls", confidence: 0.8 },
    ];
    insertEdges(db, id, edges);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM edges WHERE index_id = ?").get(id) as { c: number };
    expect(rows.c).toBe(2); // resolved import + calls, unresolved skipped
    db.close();
  });
});

describe("GDScript indexer integration", () => {
  let repo: string;
  let scope: GitScope | null;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ce-gdedge-"));
    execSync("git init -q", { cwd: repo });
    execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
    mkdirSync(join(repo, "scripts"), { recursive: true });

    writeFileSync(join(repo, "scripts", "weapon.gd"), `extends Resource
class_name Weapon

func attack():
  pass
`);

    writeFileSync(join(repo, "scripts", "player.gd"), `extends Node2D
const weapon = preload("res://scripts/weapon.gd")

func _ready():
  weapon.attack()
  move_toward(10, 20)

func move_toward(x, y):
  pass
`);

    execSync("git add -A && git commit -q -m init", { cwd: repo });
    scope = detectScope(repo);
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("builds imports edge player.gd → weapon.gd via preload", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const imp = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND type = 'imports' AND from_path = ?",
    ).get(r.indexId, "scripts/player.gd") as { to_path: string } | undefined;
    expect(imp?.to_path).toBe("scripts/weapon.gd");
    db.close();
  });

  it("builds calls edge player.gd → player.gd for move_toward", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const call = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND type = 'calls' AND from_path = ? AND to_path = ?",
    ).get(r.indexId, "scripts/player.gd", "scripts/player.gd") as { to_path: string } | undefined;
    expect(call?.to_path).toBe("scripts/player.gd");
    db.close();
  });

  it("builds calls edge player.gd → weapon.gd for weapon.attack()", () => {
    const db = openMemoryDb();
    const r = buildIndex(db, scope!);
    const call = db.prepare(
      "SELECT to_path FROM edges WHERE index_id = ? AND type = 'calls' AND from_path = ? AND to_path = ?",
    ).get(r.indexId, "scripts/player.gd", "scripts/weapon.gd") as { to_path: string } | undefined;
    expect(call?.to_path).toBe("scripts/weapon.gd");
    db.close();
  });
});
