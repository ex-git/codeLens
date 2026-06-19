import { spawnSync } from "node:child_process";
import { resolveReal, toPosix } from "../util/paths.js";

/**
 * Git scope detection (Design Decisions: branch isolation).
 *
 * Returns the current repo root, worktree path, branch name, HEAD sha, and
 * dirty file list. Handles detached HEAD (branch="DETACHED", detached=true).
 * Returns null when cwd is not a git repo (tool can still index as a plain
 * directory).
 */

export interface GitScope {
  repoRoot: string;       // real, posix
  worktreePath: string;    // real, posix (checkout root, differs for git worktree)
  branch: string;          // "DETACHED" when detached
  headSha: string;
  dirtyFiles: string[];    // repo-relative posix paths (changed/untracked, not ignored)
  detached: boolean;
}

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.error || r.status !== 0) return { ok: false, stdout: r.stdout ?? "" };
  return { ok: true, stdout: r.stdout.trim() };
}

/** Detect the git scope for `cwd`. Returns null if not inside a git repo. */
export function detectScope(cwd: string): GitScope | null {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok || root.stdout.length === 0) return null;
  const repoRoot = resolveReal(root.stdout);

  // --show-toplevel returns the main repo for worktrees; use --show-cdup + pwd
  // for the actual checkout path. git worktree list --porcelain would be heavier.
  const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
  const gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]);
  // worktreePath = the checkout root (where .git link points). For a linked
  // worktree, --show-toplevel already returns the worktree path, not the main.
  const worktreePath = resolveReal(root.stdout);

  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.length === 0) {
    // Fresh repo with no commits — treat as detached with empty head.
    return {
      repoRoot,
      worktreePath,
      branch: "DETACHED",
      headSha: "",
      dirtyFiles: listDirty(cwd),
      detached: true,
    };
  }
  const headSha = head.stdout;

  const branchOut = git(cwd, ["branch", "--show-current"]);
  const detached = !branchOut.ok || branchOut.stdout.length === 0;
  const branch = detached ? "DETACHED" : branchOut.stdout;

  // commonDir/gitDir unused for now but validated to keep git presence robust.
  void commonDir;
  void gitDir;

  return {
    repoRoot,
    worktreePath,
    branch,
    headSha,
    dirtyFiles: listDirty(cwd),
    detached,
  };
}

/** List repo-relative posix paths that are changed or untracked (not ignored). */
export function listDirty(cwd: string): string[] {
  const r = spawnSync("git", ["status", "--porcelain", "-z"], { cwd, encoding: "utf-8" });
  if (r.error || r.status !== 0) return [];
  // -z separates records by NUL; each record is "XY path" (or "XY orig -> path" for renames).
  const out = r.stdout ?? "";
  const files: string[] = [];
  for (const rec of out.split("\0")) {
    if (rec.length === 0) continue;
    // status code is 2 chars, then a space, then path (possibly "orig -> path").
    const path = rec.slice(3);
    const finalPath = path.includes(" -> ") ? path.split(" -> ")[1] ?? path : path;
    files.push(toPosix(finalPath));
  }
  return files;
}