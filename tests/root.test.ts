import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCwdArg, resolveCwd, isUsableCwd } from "../src/runtime/root.js";
import { resolveReal } from "../src/util/paths.js";

describe("parseCwdArg", () => {
  it("strips --cwd <value> and --cwd=<value>", () => {
    expect(parseCwdArg(["--cwd", "/a", "search", "x"])).toEqual({ cwd: "/a", args: ["search", "x"] });
    expect(parseCwdArg(["--cwd=/b", "index"])).toEqual({ cwd: "/b", args: ["index"] });
    expect(parseCwdArg(["index"])).toEqual({ cwd: undefined, args: ["index"] });
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
