import { posix, join } from "node:path";
import { existsSync, statSync } from "node:fs";

/**
 * Import resolution (Step 14).
 *
 * Resolves a relative import spec to a candidate repo-relative file path,
 * trying extension substitution (incl. TS ESM `.js`→`.ts`), extension
 * fallbacks, and index files. Returns null if unresolved (no edge — better to
 * emit no edge than a wrong one).
 */

const EXT_FALLBACKS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".py", ".go", ".rs", ".java", ".rb", ".php", ".c", ".cpp"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.py", "__init__.py"];

// TS ESM convention: `import x from "./foo.js"` resolves to `./foo.ts`.
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx", ".d.ts", ".mts", ".cts"],
  ".jsx": [".tsx", ".d.ts"],
  ".mjs": [".mts", ".ts"],
  ".cjs": [".cts", ".ts"],
};

function isRelative(spec: string): boolean {
  return spec.startsWith("./") || spec.startsWith("../") || spec.startsWith(".");
}

/** Ordered candidate repo-relative paths to try for a resolved target. */
function* candidates(target: string): Generator<string> {
  yield target;
  // TS extension substitution: "./foo.js" → "./foo.ts" etc.
  for (const [jsExt, tsExts] of Object.entries(JS_TO_TS)) {
    if (target.endsWith(jsExt)) {
      const stem = target.slice(0, -jsExt.length);
      for (const ts of tsExts) yield stem + ts;
    }
  }
  // Append fallback extensions (only when target has no extension, to avoid
  // producing "./foo.js.ts").
  if (posix.extname(target) === "") {
    for (const ext of EXT_FALLBACKS) yield target + ext;
  }
  // Directory + index files.
  for (const idx of INDEX_FILES) yield posix.join(target, idx);
}

/** Resolve a relative import from `fromPath` (repo-relative POSIX) to a repo-relative target path. */
export function resolveImport(fromPath: string, spec: string, knownFiles: Set<string>): string | null {
  if (!isRelative(spec)) return null; // bare specifier (npm/builtin) — not a repo file
  const base = posix.dirname(fromPath);
  const target = posix.normalize(posix.join(base, spec));
  for (const cand of candidates(target)) if (knownFiles.has(cand)) return cand;
  return null;
}

/** Filesystem-backed resolution when knownFiles is incomplete. */
export function resolveImportFs(repoRoot: string, fromPath: string, spec: string): string | null {
  if (!isRelative(spec)) return null;
  const base = posix.dirname(fromPath);
  const target = posix.normalize(posix.join(base, spec));
  for (const cand of candidates(target)) {
    const abs = join(repoRoot, cand);
    if (existsSync(abs) && statSync(abs).isFile()) return cand;
  }
  return null;
}

/** Convert a Python dotted/relative module name to a repo-relative module stem. */
function pythonModuleTarget(fromPath: string, spec: string): string | null {
  const match = /^(\.*)(.*)$/.exec(spec);
  if (!match) return null;
  const level = match[1]!.length;
  const moduleName = match[2]!;
  const packageParts = posix.dirname(fromPath).split("/").filter((part) => part && part !== ".");
  if (level > packageParts.length) return null;
  let base = level > 0 ? posix.dirname(fromPath) : "";
  for (let i = 1; i < level; i++) base = posix.dirname(base);
  const modulePath = moduleName.split(".").filter(Boolean).join("/");
  const target = posix.normalize(posix.join(base, modulePath));
  return target === "." ? "" : target;
}

/** Exact file/package candidates for a Python module stem. */
function* pythonCandidates(target: string): Generator<string> {
  yield posix.join(target, "__init__.py");
  if (target) yield `${target}.py`;
}

/** Resolve a Python module only when its exact repo-local file/package is known. */
export function resolvePythonImport(fromPath: string, spec: string, knownFiles: Set<string>): string | null {
  const target = pythonModuleTarget(fromPath, spec);
  if (target === null) return null;
  for (const cand of pythonCandidates(target)) if (knownFiles.has(cand)) return cand;
  return null;
}

/** Filesystem-backed exact Python module resolution. */
export function resolvePythonImportFs(repoRoot: string, fromPath: string, spec: string): string | null {
  const target = pythonModuleTarget(fromPath, spec);
  if (target === null) return null;
  for (const cand of pythonCandidates(target)) {
    const abs = join(repoRoot, cand);
    if (existsSync(abs) && statSync(abs).isFile()) return cand;
  }
  return null;
}