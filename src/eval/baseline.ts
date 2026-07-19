import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { queryTokens } from "../search/query.js";
import type { EvalObservation, EvalTask } from "./types.js";

const STOP_WORDS = new Set(["a", "an", "and", "change", "find", "for", "from", "impact", "in", "of", "on", "the", "to"]);

export function runRgBaseline(repoRoot: string, task: EvalTask, limit: number): EvalObservation {
  const start = performance.now();
  const terms = queryTokens(task.query)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  const uniqueTerms = [...new Set(terms)].slice(0, 8);
  if (uniqueTerms.length === 0) {
    return emptyObservation(start, "query has no usable rg terms");
  }
  const pattern = uniqueTerms.map(escapeRegex).join("|");
  const args = [
    "-l", "-i", "--hidden", "--max-count", "1",
    "--glob", "!.git/**", "--glob", "!node_modules/**", "--glob", "!build/**",
    "--glob", "!dist/**", "--glob", "!coverage/**", "--", pattern, ".",
  ];
  const result = spawnSync("rg", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return emptyObservation(start, code === "ENOENT" ? "ripgrep is not installed" : result.error.message);
  }
  if (result.status !== 0 && result.status !== 1) {
    return emptyObservation(start, (result.stderr ?? "").trim() || `rg exited ${result.status}`);
  }
  const rawPaths = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((path) => path.replace(/^\.\//, "").replaceAll("\\", "/").trim())
    .filter(Boolean);
  const foundPaths = rankPaths(rawPaths, uniqueTerms).slice(0, limit);
  let bytesRead = 0;
  for (const path of foundPaths) {
    try { bytesRead += statSync(join(repoRoot, path)).size; } catch { /* best-effort */ }
  }
  return {
    foundPaths,
    toolCalls: 1,
    bytesServed: Buffer.byteLength(JSON.stringify({ foundPaths })),
    bytesRead,
    elapsedMs: performance.now() - start,
  };
}

function rankPaths(paths: string[], terms: string[]): string[] {
  return [...new Set(paths)].sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aScore = terms.reduce((score, term) => score + (aLower.includes(term) ? 1 : 0), 0);
    const bScore = terms.reduce((score, term) => score + (bLower.includes(term) ? 1 : 0), 0);
    return bScore - aScore || a.localeCompare(b);
  });
}

function emptyObservation(start: number, error: string): EvalObservation {
  return {
    foundPaths: [],
    toolCalls: 1,
    bytesServed: 0,
    bytesRead: 0,
    elapsedMs: performance.now() - start,
    error,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
