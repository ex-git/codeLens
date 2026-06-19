import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveReal, repoRelative } from "../util/paths.js";
import { getActiveIndexId } from "../index/manager.js";
import { dedent } from "../search/snippet.js";

/**
 * cl_expand (Step 8): return exact current local file content by path/range.
 *
 * Reads from disk — never returns stale stored text. Budget-caps tokens
 * (approx 4 chars/token). Resolves the path against the repo root and rejects
 * traversal.
 */

export interface ExpandResult {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  truncated: boolean;
  chars: number;
}

const DEFAULT_BUDGET = 4000; // ~1000 tokens

export function ctxExpand(
  db: Database.Database,
  repoRoot: string,
  opts: { path?: string; handle?: string; startLine?: number; endLine?: number; budget?: number },
): ExpandResult {
  const indexId = getActiveIndexId();
  if (!indexId) throw new Error("no active index — call cl_refresh first");
  void db;

  let path: string;
  let startLine: number | undefined = opts.startLine;
  let endLine: number | undefined = opts.endLine;

  if (opts.handle) {
    // Resolve handle → chunk row to get path + range.
    const row = db
      .prepare("SELECT path, start_line, end_line FROM chunks WHERE id = ? AND index_id = ?")
      .get(opts.handle, indexId) as { path: string; start_line: number; end_line: number } | undefined;
    if (!row) throw new Error(`handle not found in current index: ${opts.handle}`);
    path = row.path;
    if (startLine === undefined) startLine = row.start_line;
    if (endLine === undefined) endLine = row.end_line;
  } else if (opts.path) {
    // Normalize the path to repo-relative POSIX; throws on traversal.
    path = repoRelative(repoRoot, opts.path);
  } else {
    throw new Error("cl_expand requires path or handle");
  }
  // (path is set in both branches above; TS needs a definite assignment)
  path = path!;

  const root = resolveReal(repoRoot);
  const abs = join(root, path);
  // Security: ensure resolved path stays inside repo.
  repoRelative(repoRoot, abs);

  const text = readFileSync(abs, "utf-8");
  const lines = text.split("\n");
  const s = Math.max(1, startLine ?? 1);
  const e = Math.min(lines.length, endLine ?? lines.length);
  const slice = lines.slice(s - 1, e).join("\n");

  const budget = opts.budget ?? DEFAULT_BUDGET;
  const truncated = slice.length > budget;
  const trimmed = truncated ? slice.slice(0, budget) + "\n…[truncated — increase budget]" : slice;
  // Dedent (strip common leading whitespace) for compact agent reading. Use
  // raw read for exact bytes when editing — line numbers stay accurate.
  const content = dedent(trimmed);
  return { path, startLine: s, endLine: e, content, truncated, chars: content.length };
}