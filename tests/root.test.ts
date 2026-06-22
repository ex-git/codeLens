import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCwdArg, resolveCwd, isUsableCwd } from "../src/runtime/root.js";
import { resolveReal } from "../src/util/paths.js";

describe("parseCwdArg", () => {
  it("strips --cwd <value> and --cwd=<value>", () => {
    expect(parseCwdArg(["--cwd", "/a", "search", "x"])).toEqual({ cwd: "/a", autoIndex: undefined, args: ["search", "x"] });
    expect(parseCwdArg(["--cwd=/b", "index"])).toEqual({ cwd: "/b", autoIndex: undefined, args: ["index"] });
    expect(parseCwdArg(["index"])).toEqual({ cwd: undefined, autoIndex: undefined, args: ["index"] });
  });

  it("strips --auto-index <mode> and --auto-index=<mode>", () => {
    expect(parseCwdArg(["--auto-index", "missing", "index"])).toEqual({ cwd: undefined, autoIndex: "missing", args: ["index"] });
    expect(parseCwdArg(["--cwd=/repo", "--auto-index=never"])).toEqual({ cwd: "/repo", autoIndex: "never", args: [] });
  });
});

describe("isUsableCwd", () => {
  it("rejects missing, templated, and non-existent paths", () => {
    expect(isUsableCwd(undefined)).toBe(false);
    expect(isUsableCwd("${workspaceFolder}")).toBe(false);
    expect(isUsableCwd("/path/that/does/not/exist/xyz")).toBe(false);
  });

  it("accepts an existing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-root-"));
    try {
      expect(isUsableCwd(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveCwd", () => {
  it("uses an existing cwd and falls back otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-root2-"));
    const fallback = mkdtempSync(join(tmpdir(), "ce-fallback-"));
    try {
      expect(resolveCwd(dir, fallback)).toBe(resolveReal(dir));
      expect(resolveCwd("${workspaceFolder}", fallback)).toBe(resolveReal(fallback));
      expect(resolveCwd(undefined, fallback)).toBe(resolveReal(fallback));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fallback, { recursive: true, force: true });
    }
  });
});
