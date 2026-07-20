import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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

  it("eval --help exits 0 without opening a repository DB", async () => {
    expect(await cli(["eval", "--help"])).toBe(0);
  });

  it("eval runs one-command quick evaluation and writes reports outside the target", async () => {
    const output = mkdtempSync(join(tmpdir(), "ce-cli-eval-output-"));
    const before = execSync("git status --porcelain=v1", { cwd: repo, encoding: "utf-8" });
    try {
      const code = await cli([
        "eval", "--tasks", "4", repo, "--quick", "--no-freshness", "--output", output,
        "--min-recall", "0", "--min-mrr", "0", "--min-success", "0",
      ]);
      expect(code).toBe(0);
      expect(existsSync(join(output, "results.json"))).toBe(true);
      expect(existsSync(join(output, "report.md"))).toBe(true);
      expect(existsSync(join(output, "tasks.json"))).toBe(true);
      expect(execSync("git status --porcelain=v1", { cwd: repo, encoding: "utf-8" })).toBe(before);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("eval writes progress to stderr while keeping --json stdout parseable", async () => {
    const output = mkdtempSync(join(tmpdir(), "ce-cli-eval-json-output-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value) => stdout.push(String(value)));
    const errorSpy = vi.spyOn(console, "error").mockImplementation((value) => stderr.push(String(value)));
    try {
      const code = await cli([
        "eval", repo, "--quick", "--tasks", "1", "--no-freshness", "--json", "--output", output,
        "--min-recall", "0", "--min-mrr", "0", "--min-success", "0",
      ]);
      expect(code).toBe(0);
      expect(JSON.parse(stdout.join("\n")).version).toBe(2);
      expect(stderr.some((line) => line.includes("START") && line.includes("scan:"))).toBe(true);
      expect(stderr.some((line) => line.includes("PROGRESS") && line.includes("index:"))).toBe(true);
      expect(stderr.some((line) => line.includes("COMPLETE") && line.includes("evaluation:"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("eval accepts frozen task files and suite selection", async () => {
    const temp = mkdtempSync(join(tmpdir(), "ce-cli-eval-frozen-"));
    const output = join(temp, "output");
    const tasks = join(temp, "tasks.json");
    writeFileSync(tasks, JSON.stringify({
      version: 1,
      source: "cli fixture",
      independentGroundTruth: true,
      tasks: [{
        id: "locate-a",
        suite: "retrieval",
        type: "locate",
        query: "validate session",
        expectedPaths: ["src/a.ts"],
      }],
    }));
    try {
      const code = await cli([
        "eval", repo, "--quick", "--tasks-file", tasks, "--suite", "retrieval", "--output", output,
        "--min-recall", "0", "--min-mrr", "0", "--min-success", "0",
      ]);
      expect(code).toBe(0);
      const result = JSON.parse(readFileSync(join(output, "results.json"), "utf-8"));
      expect(result.methodology.taskSource).toMatchObject({ kind: "frozen-task-file", independentGroundTruth: true, source: "cli fixture" });
      expect(result.options.suites).toEqual(["retrieval"]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("eval rejects an output directory inside the target repository", async () => {
    expect(await cli(["eval", repo, "--quick", "--output", join(repo, "eval-output")])).toBe(1);
  });

  it("eval rejects extra positional arguments", async () => {
    expect(await cli(["eval", repo, "unexpected"])).toBe(1);
  });

  it("eval rejects unsafe or unbounded numeric options", async () => {
    expect(await cli(["eval", repo, "--repeats", "999999999999999999999"])).toBe(1);
    expect(await cli(["eval", repo, "--repeats", "101"])).toBe(1);
    expect(await cli(["eval", repo, "--tasks", "10001"])).toBe(1);
    expect(await cli(["eval", repo, "--limit", "1001"])).toBe(1);
    expect(await cli(["eval", repo, "--scales", "10000001"])).toBe(1);
    expect(await cli(["eval", repo, "--min-recall", "1.1"])).toBe(1);
    expect(await cli(["eval", repo, "--min-graph-precision", "1.1"])).toBe(1);
    expect(await cli(["eval", repo, "--suite", "retrieval,unknown"])).toBe(1);
    expect(await cli(["eval", repo, "--tasks-file", join(repo, "missing-tasks.json")])).toBe(1);
  });

});