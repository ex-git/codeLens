import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cli } from "../src/cli.js";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let origCwd: string;
let origHome: string | undefined;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-cli-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export function validateSession(t: string): boolean { return !!t; }\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  origCwd = process.cwd();
  origHome = process.env.HOME;
  process.chdir(repo);
});
afterAll(() => {
  process.chdir(origCwd);
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  rmSync(repo, { recursive: true, force: true });
});

describe("cli", () => {
  it("doctor exits 0 and reports node + better-sqlite3", async () => {
    const code = await cli(["doctor"]);
    expect(code).toBe(0);
  });

  it("index builds and returns indexedFiles", async () => {
    const code = await cli(["index"]);
    expect(code).toBe(0);
  });

  it("search returns ranked results (exit 0)", async () => {
    const code = await cli(["search", "validateSession"]);
    expect(code).toBe(0);
  });

  it("stats returns counts", async () => {
    const code = await cli(["stats"]);
    expect(code).toBe(0);
  });

  it("unknown command exits 1", async () => {
    const code = await cli(["bogus"]);
    expect(code).toBe(1);
  });

  it("--help prints usage and exits 0", async () => {
    const code = await cli(["--help"]);
    expect(code).toBe(0);
  });

  it("global --cwd runs repo commands from another process cwd", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ce-cli-outside-"));
    const before = process.cwd();
    try {
      process.chdir(outside);
      const code = await cli(["--cwd", repo, "index"]);
      expect(code).toBe(0);
    } finally {
      process.chdir(before);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("install accepts documented --location=local form", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ce-cli-home-"));
    process.env.HOME = fakeHome;
    try {
      const code = await cli(["install", "--target=opencode", "--location=local", "--command", "/tmp/codelens", "--yes"]);
      expect(code).toBe(0);
      expect(existsSync(join(repo, "opencode.json"))).toBe(true);
      expect(existsSync(join(fakeHome, ".config", "opencode", "opencode.json"))).toBe(false);
      const cfg = JSON.parse(readFileSync(join(repo, "opencode.json"), "utf-8"));
      expect(cfg.mcp.codelens.command).toEqual(["/tmp/codelens", "--cwd", process.cwd(), "--auto-index", "missing"]);
    } finally {
      rmSync(join(repo, "opencode.json"), { force: true });
      rmSync(join(repo, "AGENTS.md"), { force: true });
      rmSync(fakeHome, { recursive: true, force: true });
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });

  it("install can disable auto-index", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "ce-cli-home-noauto-"));
    process.env.HOME = fakeHome;
    try {
      const code = await cli(["install", "--target=cursor", "--command", "/tmp/codelens", "--auto-index", "never", "--yes"]);
      expect(code).toBe(0);
      const cfg = JSON.parse(readFileSync(join(fakeHome, ".cursor", "mcp.json"), "utf-8"));
      expect(cfg.mcpServers.codelens.args).toEqual(["--cwd", "${workspaceFolder}"]);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });

});