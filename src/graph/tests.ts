import { posix, basename, dirname } from "node:path";

/**
 * Test heuristics (Step 15).
 *
 * Infers test-to-source relationships from filename/path conventions:
 *   foo.test.ts   → foo.ts
 *   foo.spec.ts   → foo.ts
 *   __tests__/foo.test.ts → ../foo.ts (or same-dir foo.ts)
 *   tests/foo.ts  → ../src/foo.ts (best-effort)
 *   foo_test.go   → foo.go
 *   test_foo.py   → foo.py
 * Returns candidate target paths; only emitted as a `tests` edge if the
 * target exists in the indexed file set (no wrong edges).
 */

const TEST_SUFFIXES = [/\.test\.[a-z]+$/i, /\.spec\.[a-z]+$/i, /_test\.[a-z]+$/i, /\.test$/i, /\.spec$/i];
const TEST_PREFIXES = [/^test_/i];
const TEST_DIRS = ["__tests__", "tests", "test", "__test__"];

/** Is this path a test file by name? */
export function isTestFile(path: string): boolean {
  const base = basename(path);
  if (TEST_SUFFIXES.some((re) => re.test(base))) return true;
  if (TEST_PREFIXES.some((re) => re.test(base))) return true;
  const dir = dirname(path);
  return TEST_DIRS.some((d) => dir.split("/").includes(d));
}

/** Map a test file to candidate source file paths (repo-relative POSIX). */
export function inferTestTargets(testPath: string): string[] {
  const base = basename(testPath);
  const dir = dirname(testPath);
  const candidates = new Set<string>();

  // Strip test suffix: foo.test.ts → foo.ts
  for (const re of TEST_SUFFIXES) {
    if (re.test(base)) {
      const stripped = base.replace(re, "");
      // Re-add a likely source extension: foo.test.ts → foo.ts
      const ext = extOf(base);
      candidates.add(posix.join(dir, stripped + (ext ? "." + ext : "")));
      candidates.add(posix.join(dir, stripped));
    }
  }
  // Strip test prefix: test_foo.py → foo.py
  for (const re of TEST_PREFIXES) {
    if (re.test(base)) {
      const stripped = base.replace(re, "");
      candidates.add(posix.join(dir, stripped));
    }
  }
  // __tests__/foo.test.ts → ../foo.ts  and  ../src/foo.ts
  const segs = dir.split("/");
  if (segs.includes("__tests__") || segs.includes("tests") || segs.includes("test")) {
    const base2 = base.replace(/\.test\.|\.spec\.|_test\./, ".");
    const stripped = base2.replace(/\.[a-z]+$/, "");
    const ext = extOf(base);
    const parent = segs.slice(0, -1).join("/");
    candidates.add(posix.join(parent, stripped + (ext ? "." + ext : "")));
    candidates.add(posix.join(parent, "src", stripped + (ext ? "." + ext : "")));
  }

  return [...candidates];
}

function extOf(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1]! : "";
}

/**
 * Given the set of indexed files, return the source paths this test file
 * likely tests (only those present in the file set).
 */
export function resolveTestTargets(testPath: string, knownFiles: Set<string>): string[] {
  return inferTestTargets(testPath).filter((p) => knownFiles.has(p));
}