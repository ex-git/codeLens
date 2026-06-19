import { relative, isAbsolute, posix } from "node:path";
import { realpathSync, existsSync } from "node:fs";

/**
 * Path normalization (Design Decision #11):
 *   - Store paths as POSIX internally (forward slashes).
 *   - Resolve symlinks to real paths at index time.
 *   - Case-preserving (no lowercasing).
 *   - Repo-relative for storage; reject traversal outside repo root.
 */

/** Convert any OS path to POSIX forward-slash form (always replaces backslashes, even on POSIX hosts). */
export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Resolve symlinks to the real path; returns POSIX. Falls back to input if unreachable. */
export function resolveReal(p: string): string {
  try {
    return toPosix(realpathSync(p));
  } catch {
    // Symlink target missing or not a symlink — normalize the literal path.
    return toPosix(isAbsolute(p) ? p : resolveReal(".") + "/" + toPosix(p));
  }
}

/**
 * Return the POSIX repo-relative path for `absOrRel` under `root`.
 * Throws PathOutsideRepo if the resolved path escapes root.
 */
export function repoRelative(root: string, absOrRel: string): string {
  const rootReal = resolveReal(root);
  const abs = isAbsolute(absOrRel) ? absOrRel : posix.join(rootReal, absOrRel);
  const targetReal = resolveReal(abs);
  if (!targetReal.startsWith(rootReal + "/") && targetReal !== rootReal) {
    throw new PathOutsideRepo(targetReal, rootReal);
  }
  const rel = relative(rootReal, targetReal);
  return toPosix(rel);
}

/** True if `absOrRel` resolves inside `root`. */
export function isInsideRepo(root: string, absOrRel: string): boolean {
  try {
    repoRelative(root, absOrRel);
    return true;
  } catch {
    return false;
  }
}

/** Assert a path is inside the repo; throw PathOutsideRepo otherwise. */
export function assertInsideRepo(root: string, absOrRel: string): void {
  repoRelative(root, absOrRel); // throws on escape
}

export class PathOutsideRepo extends Error {
  constructor(public path: string, public root: string) {
    super(`path "${path}" escapes repo root "${root}"`);
    this.name = "PathOutsideRepo";
  }
}

/** True if a repo-relative path exists on disk under root. */
export function existsRelative(root: string, rel: string): boolean {
  const full = posix.join(resolveReal(root), rel);
  return existsSync(full);
}