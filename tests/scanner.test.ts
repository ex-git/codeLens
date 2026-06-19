import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { scanFiles, isBinary, MAX_FILE_BYTES } from "../src/index/scanner.js";
import { shouldDeny } from "../src/index/deny.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function gitInit(dir: string): void {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t.t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
}

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-scan-"));
  gitInit(repo);
  // tracked source
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
  // untracked (should be indexed)
  writeFileSync(join(repo, "src", "untracked.ts"), "export const u = 1;\n");
  // gitignored (should be excluded)
  writeFileSync(join(repo, ".gitignore"), "ignored.ts\nbuild/\n");
  writeFileSync(join(repo, "ignored.ts"), "ignored");
  // build output untracked — heuristic deny excludes it
  mkdirSync(join(repo, "build"), { recursive: true });
  writeFileSync(join(repo, "build", "out.js"), "var x=1;");
  // large file (>5MB) excluded
  const big = Buffer.alloc(MAX_FILE_BYTES + 1024, 0x61); // 'a' bytes
  writeFileSync(join(repo, "big.txt"), big);
  // binary file excluded
  const bin = Buffer.alloc(1024, 0);
  writeFileSync(join(repo, "bin.dat"), bin);
  execSync("git add -A && git commit -q -m init", { cwd: repo });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("shouldDeny", () => {
  it("denies build/dist/out/coverage dirs", () => {
    expect(shouldDeny("build/out.js")).toBe(true);
    expect(shouldDeny("dist/x.js")).toBe(true);
    expect(shouldDeny("coverage/index.html")).toBe(true);
  });
  it("allows normal source", () => {
    expect(shouldDeny("src/a.ts")).toBe(false);
  });
  it("denies minified + vendor", () => {
    expect(shouldDeny("lib/x.min.js")).toBe(true);
    expect(shouldDeny("vendor/lib.js")).toBe(true);
  });
});

describe("isBinary", () => {
  it("detects NUL-containing file", () => {
    const f = join(repo, "bin.dat");
    expect(isBinary(f)).toBe(true);
  });
  it("text file is not binary", () => {
    const f = join(repo, "src", "a.ts");
    expect(isBinary(f)).toBe(false);
  });
});

describe("scanFiles", () => {
  it("includes tracked + untracked source", () => {
    const files = scanFiles(repo).map((f) => f.path);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
    expect(files).toContain("src/untracked.ts");
  });
  it("excludes gitignored files", () => {
    const files = scanFiles(repo).map((f) => f.path);
    expect(files).not.toContain("ignored.ts");
  });
  it("excludes build/ even when untracked (heuristic deny)", () => {
    const files = scanFiles(repo).map((f) => f.path);
    expect(files).not.toContain("build/out.js");
  });
  it("excludes files >5MB", () => {
    const files = scanFiles(repo).map((f) => f.path);
    expect(files).not.toContain("big.txt");
  });
  it("excludes binary files", () => {
    const files = scanFiles(repo).map((f) => f.path);
    expect(files).not.toContain("bin.dat");
  });
  it("infers language by extension", () => {
    const ts = scanFiles(repo).find((f) => f.path === "src/a.ts");
    expect(ts?.language).toBe("typescript");
  });
});
describe("walkDir .gitignore honoring (non-git dir)", () => {
  it("excludes files matched by nested .gitignore even without git", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-nogitwalk-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "logs"), { recursive: true });
      writeFileSync(join(dir, "src", "keep.ts"), "x");
      writeFileSync(join(dir, "src", "secret.env"), "x");
      writeFileSync(join(dir, "src", ".gitignore"), "*.env\n");
      writeFileSync(join(dir, "logs", "app.log"), "x");
      writeFileSync(join(dir, ".gitignore"), "logs/\n");
      const files = scanFiles(dir).map((f) => f.path);
      expect(files).toContain("src/keep.ts");
      expect(files).not.toContain("src/secret.env"); // nested .gitignore
      expect(files.some((p) => p.startsWith("logs/"))).toBe(false); // root .gitignore
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
