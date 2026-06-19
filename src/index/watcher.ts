import { watch, type FSWatcher } from "node:fs";
import { resolveReal, toPosix } from "../util/paths.js";
import { relative, posix } from "node:path";

/**
 * File watcher (Gap #6).
 *
 * Maintains a set of repo-relative POSIX paths that changed since the last
 * consume(), via recursive fs.watch where supported. Used by ensureFreshIndex
 * to skip re-scanning during quiet periods (the main per-query cost) while
 * still catching edits promptly.
 *
 * Platform note: recursive fs.watch is supported on macOS and Windows. On
 * Linux it falls back to a non-recursive watch of the repo root only — callers
 * must not rely on completeness; ensureFreshIndex periodically does a full
 * scan as a safety net (FULL_SCAN_INTERVAL_MS) so missed changes are caught.
 *
 * Always non-fatal: if watching fails (unsupported FS, permissions), the
 * watcher stays empty and the tool falls back to full-scan-per-query (the
 * original behavior).
 */

export class FileWatcher {
  private repoRoot: string;
  private watcher: FSWatcher | null = null;
  readonly dirty = new Set<string>();
  private started = false;

  constructor(repoRoot: string) {
    this.repoRoot = resolveReal(repoRoot);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.watcher = watch(this.repoRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const abs = posix.join(this.repoRoot, toPosix(filename));
        try {
          const rel = toPosix(relative(this.repoRoot, abs));
          if (rel && !rel.startsWith("..")) this.dirty.add(rel);
        } catch { /* ignore */ }
      });
      this.watcher.on("error", () => { /* stay silent; full-scan fallback covers us */ });
    } catch {
      this.watcher = null; // unsupported → degrade to full-scan
    }
  }

  stop(): void {
    try { this.watcher?.close(); } catch { /* ignore */ }
    this.watcher = null;
    this.started = false;
  }

  /** True if the watcher is active (may still be partial on Linux). */
  get active(): boolean {
    return this.watcher !== null;
  }

  /** Snapshot + clear the dirty set. Returns repo-relative POSIX paths. */
  consume(): string[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  /** Mark a path dirty manually (e.g. after an in-process index write). */
  markDirty(rel: string): void {
    this.dirty.add(rel);
  }
}