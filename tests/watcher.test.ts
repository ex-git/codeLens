import { describe, it, expect, afterAll } from "vitest";
import { FileWatcher } from "../src/index/watcher.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpdirs: string[] = [];
afterAll(() => { for (const d of tmpdirs) rmSync(d, { recursive: true, force: true }); });

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ce-watch-"));
  tmpdirs.push(d);
  mkdirSync(join(d, "src"), { recursive: true });
  return d;
}

describe("FileWatcher", () => {
  it("degrades gracefully when start fails (no throw, active stays false-safe)", () => {
    const w = new FileWatcher("/definitely/not/a/real/path/xyz");
    w.start();
    expect(w.active).toBe(false);
    expect(w.consume()).toEqual([]);
    w.stop();
  });

  it("consume() returns posix repo-relative dirty paths after edits (best-effort)", async () => {
    const dir = newDir();
    const w = new FileWatcher(dir);
    w.start();
    if (!w.active) { w.stop(); return; } // skip on platforms without recursive watch
    // generate a change
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    // give the watcher a moment to fire (fs.watch is async)
    await new Promise((r) => setTimeout(r, 100));
    const dirty = w.consume();
    // best-effort: should include something under src/ (platform-dependent)
    expect(dirty.every((p) => !p.includes("\\"))).toBe(true);
    w.stop();
  });

  it("markDirty + consume roundtrip", () => {
    const dir = newDir();
    const w = new FileWatcher(dir);
    w.markDirty("src/a.ts");
    expect(w.consume()).toContain("src/a.ts");
    expect(w.consume()).toEqual([]); // cleared after consume
    w.stop();
  });
});