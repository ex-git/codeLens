import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRootVersion } from "../src/upgrade.js";
import { VERSION } from "../src/version.js";

describe("readRootVersion", () => {
  it("reads version from a root package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-upg-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
      expect(readRootVersion(dir)).toBe("9.9.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the running VERSION when package.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-upg2-"));
    try {
      expect(readRootVersion(dir)).toBe(VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
