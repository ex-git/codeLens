/**
 * Heuristic deny list (Design Decisions #3 + Section 16 risk 5).
 *
 * Even when a path is untracked (not gitignored), deny generated/build output
 * so it never pollutes the index. Configurable later via .contextignore.
 */

const DENY_DIRS = [
  "node_modules/",
  "build/",
  "dist/",
  "out/",
  "coverage/",
  ".cache/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  ".svelte-kit/",
  ".gradle/",
  "target/", // Rust
  "__pycache__/",
  ".venv/",
  "venv/",
  ".mypy_cache/",
  ".pytest_cache/",
];

const DENY_GLOBS = [
  /\.min\.js$/,
  /\.min\.css$/,
  /\.map$/,
  /(^|\/)vendor\//,
  /\.bundle\.[a-z]+$/,
];

/** True if a POSIX repo-relative path should be denied (excluded from indexing). */
export function shouldDeny(posixPath: string): boolean {
  if (DENY_DIRS.some((d) => posixPath.includes("/" + d)) || DENY_DIRS.some((d) => posixPath.startsWith(d))) {
    return true;
  }
  return DENY_GLOBS.some((re) => re.test(posixPath));
}