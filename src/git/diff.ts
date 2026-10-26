import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { contentHashBuffer } from "../util/hash.js";
import { bounded } from "../graph/query.js";

export interface DiffRange { oldStart: number; oldCount: number; newStart: number; newCount: number }
export interface DiffFile {
  path: string; oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflict";
  ranges: DiffRange[]; contentHash?: string; issue?: string;
}
export interface DiffOptions { base?: string; maxFiles?: number }
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_SOURCE = 512 * 1024;

/** No shell, external diff driver, textconv, or index refresh is permitted. */
function git(root: string, args: string[]): string {
  const r = spawnSync("git", ["--literal-pathspecs", ...args], {
    cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: MAX_OUTPUT,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  if (r.error || r.status !== 0) throw new Error("Git comparison failed or exceeded its limit; verify the base revision and repository state.");
  return r.stdout;
}

/** Read only a bounded regular file inside this worktree, never a symlink target. */
function readSource(root: string, path: string): Buffer {
  const absolute = resolve(root, path), rel = relative(root, absolute);
  if (isAbsolute(path) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("unsafe-path");
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not-regular-file");
  const real = relative(root, realpathSync(absolute));
  if (real === ".." || real.startsWith(`..${sep}`)) throw new Error("unsafe-path");
  if (stat.size > MAX_SOURCE) throw new Error("oversized");
  const bytes = readFileSync(absolute);
  if (bytes.length > MAX_SOURCE) throw new Error("oversized");
  if (bytes.includes(0)) throw new Error("binary");
  return bytes;
}

function analyzeFile(root: string, baseSha: string, file: DiffFile): void {
  if (file.status === "deleted" || file.status === "conflict") return;
  try {
    const before = readSource(root, file.path);
    file.contentHash = contentHashBuffer(before);
    if (["added", "untracked", "renamed"].includes(file.status)) {
      const text = before.toString("utf8");
      const lines = text.length ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
      if (lines) file.ranges = [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines }];
    } else {
      const patch = git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=0", "--ignore-submodules=none", baseSha, "--", file.path]);
      if (/^Binary files |^GIT binary patch/m.test(patch)) { file.issue = "binary"; return; }
      file.ranges = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(m => ({
        oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
      }));
      if (file.ranges.length > 1000) { file.ranges = file.ranges.slice(0, 1000); file.issue = "hunk-limit"; }
    }
    if (contentHashBuffer(readSource(root, file.path)) !== file.contentHash) { file.ranges = []; file.issue = "changed-during-read"; }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unreadable";
    file.issue = ["unsafe-path", "not-regular-file", "oversized", "binary"].includes(reason) ? reason : "unreadable-or-diff-failed";
    file.ranges = [];
  }
}

/** Base commit to current disk contents, including non-ignored untracked files. */
export function collectDiff(repoRoot: string, opts: DiffOptions = {}) {
  const root = realpathSync(repoRoot);
  const base = opts.base ?? "HEAD";
  if (!base || base.length > 1024 || base.startsWith("-") || [...base].some(c => c.charCodeAt(0) < 32)) throw new Error("Invalid base revision");
  const baseSha = git(root, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(baseSha)) throw new Error("Base must resolve to a commit");
  const records = git(root, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", baseSha, "--"]).split("\0");
  const files = new Map<string, DiffFile>();
  for (let i = 0; i < records.length && records[i];) {
    const status = records[i++]!, first = records[i++];
    if (!first) throw new Error("Incomplete Git path record");
    const renamed = status.startsWith("R") || status.startsWith("C");
    const path = renamed ? records[i++] : first;
    if (!path) throw new Error("Incomplete Git rename record");
    files.set(path, { path, ...(renamed ? { oldPath: first } : {}), ranges: [],
      status: status === "U" ? "conflict" : status === "D" ? "deleted" : status === "A" ? "added" : renamed ? "renamed" : "modified" });
  }
  for (const path of git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
    if (!path) continue;
    const previous = files.get(path);
    // A staged deletion can coexist with newly recreated disk content.
    if (!previous || previous.status === "deleted") files.set(path, {
      path, status: "untracked", ranges: [], ...(previous ? { oldPath: path } : {}),
    });
  }
  for (const record of git(root, ["ls-files", "--unmerged", "-z"]).split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const path = record.slice(tab + 1);
    files.set(path, { path, status: "conflict", ranges: [] });
  }
  const maxFiles = bounded(opts.maxFiles, 50, 200);
  const selected = [...files.values()].sort((a, b) => a.path.localeCompare(b.path)).slice(0, maxFiles);
  const deadline = Date.now() + 10000;
  for (const file of selected) {
    if (Date.now() >= deadline) file.issue = "time-limit";
    else analyzeFile(root, baseSha, file);
  }
  return { base, baseSha, comparison: "worktree" as const, files: selected, totalFiles: files.size, omittedFiles: Math.max(0, files.size - maxFiles) };
}
