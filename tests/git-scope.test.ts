import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { detectScope, listDirty } from "../src/git/scope.js";
import { resolveReal } from "../src/util/paths.js";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function gitInit(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t.t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
}

describe("detectScope", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "ce-git-"));
    gitInit(repo);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    execSync("git add -A && git commit -q -m init", { cwd: repo });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it("detects repo root, branch, head", () => {
    const s = detectScope(repo);
    expect(s).not.toBeNull();
    expect(s!.repoRoot).toBe(resolveReal(repo));
    expect(["main", "master"]).toContain(s!.branch);
    expect(s!.headSha.length).toBe(40);
    expect(s!.detached).toBe(false);
  });

  it("reports dirty files after editing", () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
    const s = detectScope(repo);
    expect(s!.dirtyFiles.length).toBeGreaterThanOrEqual(2);
    expect(s!.dirtyFiles).toContain("a.ts");
    expect(s!.dirtyFiles).toContain("b.ts");
  });

  it("returns null outside a git repo", () => {
    const noGit = mkdtempSync(join(tmpdir(), "ce-nogit-"));
    try {
      expect(detectScope(noGit)).toBeNull();
    } finally {
      rmSync(noGit, { recursive: true, force: true });
    }
  });

  it("handles detached HEAD", () => {
    const head = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf-8" }).trim();
    execSync(`git checkout -q --detach ${head}`, { cwd: repo });
    try {
      const s = detectScope(repo);
      expect(s!.detached).toBe(true);
      expect(s!.branch).toBe("DETACHED");
    } finally {
      execSync("git checkout -q -", { cwd: repo });
    }
  });
});

describe("listDirty", () => {
  it("lists untracked + modified, excludes ignored", () => {
    const repo = mkdtempSync(join(tmpdir(), "ce-dirty-"));
    try {
      gitInit(repo);
      writeFileSync(join(repo, "keep.ts"), "x");
      writeFileSync(join(repo, ".gitignore"), "ignoreme.txt\n");
      writeFileSync(join(repo, "ignoreme.txt"), "ignored");
      execSync("git add -A && git commit -q -m init", { cwd: repo });
      writeFileSync(join(repo, "new.ts"), "y");
      writeFileSync(join(repo, "ignoreme.txt"), "still ignored");
      const dirty = listDirty(repo);
      expect(dirty).toContain("new.ts");
      expect(dirty).not.toContain("ignoreme.txt");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("parses porcelain-z rename records without treating the old path as a new record", () => {
    const repo = mkdtempSync(join(tmpdir(), "ce-rename-"));
    try {
      gitInit(repo);
      writeFileSync(join(repo, "oldname.ts"), "x");
      execSync("git add -A && git commit -q -m init", { cwd: repo });
      renameSync(join(repo, "oldname.ts"), join(repo, "newname.ts"));
      execSync("git add -A", { cwd: repo });
      expect(listDirty(repo)).toEqual(["newname.ts"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});