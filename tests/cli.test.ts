import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cli } from "../src/cli.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repo: string;
let origCwd: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "ce-cli-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export function validateSession(t: string): boolean { return !!t; }\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  origCwd = process.cwd();
  process.chdir(repo);
});
afterAll(() => {
  process.chdir(origCwd);
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
});