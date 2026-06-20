import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { openMemoryDb } from "../src/db/db.js";
import { diffFiles, contentChanged } from "../src/index/freshness.js";
import { CHUNKER_VERSION } from "../src/index/fts.js";
import { buildIndex } from "../src/index/indexer.js";
import { scanFiles, type ScannedFile } from "../src/index/scanner.js";
import { detectScope } from "../src/git/scope.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let scope: ReturnType<typeof detectScope>;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-fresh-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  scope = detectScope(repo);
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function reindex(db: ReturnType<typeof openMemoryDb>): { indexId: string } {
  const r = buildIndex(db, scope!);
  return { indexId: r.indexId };
}

describe("diffFiles", () => {
  it("all unchanged when nothing changed", () => {
    const db = openMemoryDb();
    const { indexId } = reindex(db);
    const scanned = scanFiles(repo);
    const d = diffFiles(db, indexId, scanned, repo);
    expect(d.changed).toHaveLength(0);
    expect(d.newFiles).toHaveLength(0);
    expect(d.deleted).toHaveLength(0);
    expect(d.unchanged.length).toBe(scanned.length);
    db.close();
  });

  it("detects new file", () => {
    const db = openMemoryDb();
    const { indexId } = reindex(db);
    writeFileSync(join(repo, "src", "c.ts"), "export const c = 1;\n");
    const d = diffFiles(db, indexId, scanFiles(repo), repo);
    expect(d.newFiles.map((f) => f.path)).toContain("src/c.ts");
    rmSync(join(repo, "src", "c.ts"));
    db.close();
  });

  it("detects changed file (size differs)", () => {
    const db = openMemoryDb();
    const { indexId } = reindex(db);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\nexport const a2 = 2;\n"); // bigger
    const d = diffFiles(db, indexId, scanFiles(repo), repo);
    expect(d.changed.map((f) => f.path)).toContain("src/a.ts");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n"); // restore
    db.close();
  });

  it("detects changed file (mtime differs, same size)", () => {
    const db = openMemoryDb();
    const { indexId } = reindex(db);
    // Rewrite same content but bump mtime.
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
    const now = Date.now() / 1000 + 1000;
    utimesSync(join(repo, "src", "b.ts"), now, now);
    const d = diffFiles(db, indexId, scanFiles(repo), repo);
    expect(d.changed.map((f) => f.path)).toContain("src/b.ts");
    db.close();
  });

  it("detects deleted file", () => {
    const db = openMemoryDb();
    const { indexId } = reindex(db);
    rmSync(join(repo, "src", "b.ts"));
    const d = diffFiles(db, indexId, scanFiles(repo), repo);
    expect(d.deleted.map((f) => f.path)).toContain("src/b.ts");
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n"); // restore
    db.close();
  });

  it("detects unchanged file with any stale chunker version", () => {
    const db = openMemoryDb();
    const { indexId } = reindex(db);
    expect(
      db.prepare("SELECT DISTINCT chunker_version FROM chunks WHERE index_id = ? AND path = ?")
        .all(indexId, "src/a.ts"),
    ).toEqual([{ chunker_version: CHUNKER_VERSION }]);
    db.prepare(
      `UPDATE chunks SET chunker_version = NULL
       WHERE id = (SELECT id FROM chunks WHERE index_id = ? AND path = ? LIMIT 1)`,
    ).run(indexId, "src/a.ts");

    const d = diffFiles(db, indexId, scanFiles(repo), repo);
    expect(d.changed.map((f) => f.path)).toContain("src/a.ts");
    expect(d.unchanged.map((f) => f.path)).not.toContain("src/a.ts");
    db.close();
  });
});

describe("contentChanged", () => {
  it("returns false when content matches stored hash", () => {
    const db = openMemoryDb();
    const { indexId } = reindex(db);
    const stored = db.prepare("SELECT content_hash FROM files WHERE index_id = ? AND path = ?").get(indexId, "src/a.ts") as { content_hash: string };
    const f: ScannedFile = scanFiles(repo).find((x) => x.path === "src/a.ts")!;
    expect(contentChanged(repo, f, stored.content_hash)).toBe(false);
    db.close();
  });

  it("returns true when content differs", () => {
    const db = openMemoryDb();
    const { indexId } = reindex(db);
    const stored = db.prepare("SELECT content_hash FROM files WHERE index_id = ? AND path = ?").get(indexId, "src/a.ts") as { content_hash: string };
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 999;\n");
    const f: ScannedFile = scanFiles(repo).find((x) => x.path === "src/a.ts")!;
    expect(contentChanged(repo, f, stored.content_hash)).toBe(true);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n"); // restore
    db.close();
  });
});