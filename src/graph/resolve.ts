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

/**
 * Godot `res://` path resolution.
 *
 * Strips `res://` prefix and treats remainder as repo-relative path.
 * Tries exact match, then common Godot extensions, then filesystem.
 * Returns null if unresolved (no edge — better than wrong edge).
 */
const GODOT_RESOURCE_EXTS = [".gd", ".tscn", ".tres", ".res", ".import", ".gltf", ".glb", ".png", ".svg", ".wav", ".ogg", ".mp3"];

export function resolveGodotPath(resPath: string, repoRoot: string, knownFiles: Set<string>): string | null {
  if (!resPath.startsWith("res://")) return null;
  const rel = resPath.slice(6); // strip "res://"
  // Try exact match
  if (knownFiles.has(rel)) return rel;
  // Try filesystem
  const abs = join(repoRoot, rel);
  if (existsSync(abs) && statSync(abs).isFile()) return rel;
  // Try appending common Godot extensions (for bare script refs)
  if (posix.extname(rel) === "") {
    for (const ext of GODOT_RESOURCE_EXTS) {
      const cand = rel + ext;
      if (knownFiles.has(cand)) return cand;
      const a = join(repoRoot, cand);
      if (existsSync(a) && statSync(a).isFile()) return cand;
    }
  }
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
