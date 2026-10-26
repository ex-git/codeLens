import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkInstall, checkSqlite, installationRecovery } from "../src/runtime/install-check.js";

const requireModule = createRequire(import.meta.url);

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock("node:module"); });

describe("installation checks", () => {
  it("tests SQLite FTS5 and every registered grammar without opening user databases", () => {
    const report = checkInstall();
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(13); // Node, SQLite, parser runtime, ten grammars.
    expect(report.checks.every(check => check.ok)).toBe(true);
  });

  it("reports a missing SQLite binding while still checking parsers", () => {
    const report = checkInstall(name => {
      if (name === "better-sqlite3") throw new Error("Could not locate the bindings file");
      return requireModule(name);
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.package === "better-sqlite3")).toMatchObject({ ok: false, error: "Could not locate the bindings file" });
    expect(report.checks.find(check => check.package === "tree-sitter-python")?.ok).toBe(true);
  });

  it("closes the temporary database even when FTS5 fails", () => {
    const close = vi.fn();
    const result = checkSqlite(() => class {
      close = close;
      exec() { throw new Error("no such module: fts5"); }
    });
    expect(result.ok).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports missing parser runtime and skips dependent parsing", () => {
    const report = checkInstall(name => {
      if (name === "tree-sitter") throw new Error("NODE_MODULE_VERSION mismatch");
      return requireModule(name);
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.package === "tree-sitter")).toMatchObject({ ok: false, error: "NODE_MODULE_VERSION mismatch" });
    expect(report.checks.filter(check => check.skipped)).toHaveLength(10);
  });

  it("detects incompatible grammars, not just successful require calls", () => {
    const report = checkInstall(name => name === "tree-sitter-python" ? {} : requireModule(name));
    expect(report.ok).toBe(false);
    expect(report.checks.find(check => check.package === "tree-sitter-python")?.ok).toBe(false);
    expect(report.checks.find(check => check.package === "tree-sitter-javascript")?.ok).toBe(true);
  });

  it("provides reviewed package-scoped recovery without blanket approval", () => {
    const recovery = installationRecovery();
    expect(recovery.commands.join("\n")).toContain("npm install-scripts ls");
    expect(recovery.commands.join("\n")).toContain("npm install-scripts approve better-sqlite3 tree-sitter");
    expect(recovery.commands.join("\n")).not.toContain("--all");
    expect(recovery.commands.join("\n")).not.toContain("config set");
  });
});

describe("startup boundary", () => {
  function fixture(blocked: string) {
    const root = mkdtempSync(join(tmpdir(), "cl-install space-"));
    const hook = join(root, "block.cjs");
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = spawnSync("git", ["init", "-q"], { cwd: repo });
    expect(git.status).toBe(0);
    writeFileSync(join(repo, "example.ts"), "export function helloNativeFallback() { return true; }\n");
    writeFileSync(hook, `const Module = require('node:module'); const original = Module._load;
Module._load = function(name, ...args) {
  if (name === ${JSON.stringify(blocked)}) throw new Error('simulated unavailable native binding');
  return original.call(this, name, ...args);
};`);
    const run = (...args: string[]) => spawnSync(process.execPath, ["--require", hook, "--import", "tsx", resolve("src/server.ts"), "--cwd", repo, ...args], {
      cwd: process.cwd(), encoding: "utf8", timeout: 20000,
      env: { ...process.env, HOME: root, USERPROFILE: root },
    });
    return { root, run };
  }

  it("reports SQLite failure before application imports without writing MCP stdout", () => {
    const { root, run } = fixture("better-sqlite3");
    try {
      const startup = run("--smoke");
      expect(startup.status).toBe(1);
      expect(startup.stdout).toBe("");
      expect(startup.stderr).toContain("npm install-scripts approve");
      expect(startup.stderr).not.toContain("at Module.");
      const diagnostic = run("--check-install");
      expect(diagnostic.status).toBe(1);
      expect(JSON.parse(diagnostic.stdout).checks.find((check: { package: string }) => check.package === "better-sqlite3").ok).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("still indexes and searches text with a missing parser runtime", () => {
    const { root, run } = fixture("tree-sitter");
    try {
      const index = run("index");
      expect(index.status, index.stderr).toBe(0);
      expect(index.stderr).toContain("text-only");
      const search = run("search", "helloNativeFallback");
      expect(search.status, search.stderr).toBe(0);
      expect(search.stdout).toContain("example.ts:");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("parser fallback", () => {
  it("imports and indexes text when the native parser runtime cannot load", async () => {
    vi.doMock("node:module", () => ({
      createRequire: () => (name: string) => {
        if (name === "tree-sitter") throw new Error("missing native parser");
        return requireModule(name);
      },
    }));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const grammars = await import("../src/graph/grammars.js");
    expect(grammars.makeParser("typescript")).toBeNull();
    expect(grammars.isSupported("typescript")).toBe(false);
    expect(grammars.parseFile("javascript", "export const x = 1;")).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]?.[0])).toContain("text-only");
  });

  it("warns once for a broken grammar while other languages keep working", async () => {
    vi.doMock("node:module", () => ({
      createRequire: () => (name: string) => {
        if (name === "tree-sitter-python") throw new Error("missing Python grammar");
        return requireModule(name);
      },
    }));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const grammars = await import("../src/graph/grammars.js");
    expect(grammars.parseFile("python", "x = 1")).toBeNull();
    expect(grammars.parseFile("python", "x = 2")).toBeNull();
    expect(grammars.parseFile("javascript", "const x = 1;")).not.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
