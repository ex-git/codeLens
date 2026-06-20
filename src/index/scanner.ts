import { spawnSync } from "node:child_process";
import { statSync, openSync, readSync, closeSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, posix } from "node:path";
import { resolveReal, toPosix } from "../util/paths.js";
import { shouldDeny } from "./deny.js";
import ignore from "ignore";

/**
 * File scanner (Design Decisions #2, #3, #11).
 *
 * Honors .gitignore via `git ls-files` (includes untracked, excludes ignored).
 * Applies heuristic deny (build/dist/out/coverage + generated patterns) even
 * for untracked files. Skips files >5MB. Skips binary files (NUL in first 8KB).
 * Returns POSIX repo-relative paths.
 */

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

export interface ScannedFile {
  path: string;       // POSIX repo-relative
  size: number;
  mtimeMs: number;
  language: string | null;
}

const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".go": "go", ".rs": "rust",
  ".java": "java", ".rb": "ruby", ".php": "php", ".c": "c", ".h": "c", ".cpp": "cpp",
  ".cc": "cpp", ".hpp": "cpp", ".cs": "csharp", ".swift": "swift", ".kt": "kotlin",
  ".scala": "scala", ".sh": "bash", ".md": "markdown", ".json": "json", ".yaml": "yaml",
  ".yml": "yaml", ".toml": "toml", ".sql": "sql", ".gd": "gdscript",
};

function inferLanguage(posixPath: string): string | null {
  const ext = posix.extname(posixPath).toLowerCase();
  return EXT_LANG[ext] ?? null;
}

/** True if file starts with a NUL byte or non-UTF8 bytes in first 8KB (binary heuristic). */
export function isBinary(absPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, 8192, 0);
    for (let i = 0; i < n; i++) {
      const b = buf[i]!;
      // NUL byte → binary. Allow common text bytes (incl. tab/cr/lf).
      if (b === 0) return true;
    }
    // Heuristic: if >10% of bytes are non-text control chars (excluding \t \n \r), treat as binary.
    let controls = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[i]!;
      if (b < 9 || (b > 13 && b < 32)) controls++;
    }
    return n > 0 && controls / n > 0.1;
  } catch {
    return true; // unreadable → treat as binary/skip
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Scan the repo at `repoRoot`. Uses `git ls-files` when inside a git repo
 * (honors .gitignore: untracked included, ignored excluded). Falls back to a
 * plain directory walk for non-git dirs.
 */
export function scanFiles(repoRoot: string): ScannedFile[] {
  const root = resolveReal(repoRoot);
  const relPaths = gitLsFiles(root) ?? walkDir(root);
  const out: ScannedFile[] = [];
  for (const rel of relPaths) {
    const p = toPosix(rel);
    if (shouldDeny(p)) continue;
    const abs = join(root, p);
    let st: { size: number; mtimeMs: number };
    try {
      const s = statSync(abs);
      if (!s.isFile()) continue;
      st = { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      continue;
    }
    if (st.size > MAX_FILE_BYTES) continue;
    if (isBinary(abs)) continue;
    out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, language: inferLanguage(p) });
  }
  return out;
}

/** `git ls-files --others --exclude-standard --cached -z` → untracked+tracked, ignored excluded. */
function gitLsFiles(root: string): string[] | null {
  const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").split("\0").filter((s) => s.length > 0);
}

/** Plain directory walk fallback for non-git dirs. Honors nested .gitignore. */
function walkDir(root: string): string[] {
  const out: string[] = [];
  // Each stack frame carries the cumulative .gitignore pattern lines from all
  // ancestor dirs (gitignore patterns without a slash match in any subdir, so
  // concatenating lines approximates git's nested semantics for the fallback).
  const stack: { dir: string; patterns: string[] }[] = [{ dir: root, patterns: [] }];
  while (stack.length) {
    const { dir: cur, patterns } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    // Inherit ancestor patterns and add this dir's .gitignore lines (if present).
    let dirPatterns = patterns;
    let dirIg = ignore().add(patterns);
    try {
      const gi = readFileSync(posix.join(cur, ".gitignore"), "utf-8");
      dirPatterns = [...patterns, ...gi.split(/\r?\n/).filter((l) => l.trim().length > 0)];
      dirIg = ignore().add(dirPatterns);
    } catch { /* no .gitignore here */ }
    for (const e of entries) {
      if (e.name === ".gitignore" || e.name.startsWith(".git")) continue;
      const full = posix.join(cur, e.name);
      const rel = toPosix(full.slice(root.length + 1));
      if (e.isDirectory()) {
        if (dirIg.ignores(rel + "/")) continue;
        stack.push({ dir: full, patterns: dirPatterns });
      } else if (e.isFile()) {
        if (dirIg.ignores(rel)) continue;
        out.push(rel);
      }
    }
  }
  return out;
}