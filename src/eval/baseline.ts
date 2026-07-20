import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { queryTokens } from "../search/query.js";
import type { EvalObservation, EvalTask } from "./types.js";

const STOP_WORDS = new Set(["a", "an", "and", "change", "find", "for", "from", "impact", "in", "of", "on", "the", "to"]);
const MAX_PATHS_PER_CALL = 256;
const MAX_PATH_ARGUMENT_BYTES = 48 * 1024;

export function runRgBaseline(repoRoot: string, task: EvalTask, limit: number, inventory: string[]): EvalObservation {
  const start = performance.now();
  const terms = queryTokens(task.query)
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term));
  const uniqueTerms = [...new Set(terms)].slice(0, 8);
  if (uniqueTerms.length === 0) return emptyObservation(start, "query has no usable rg terms");
  if (inventory.length === 0) return emptyObservation(start, "evaluation corpus is empty");

  const pattern = uniqueTerms.map(escapeRegex).join("|");
  const found = new Set<string>();
  let toolCalls = 0;
  for (const paths of pathBatches(inventory)) {
    const result = spawnSync("rg", [
      "-l", "-i", "--max-count", "1", "--no-messages", "-e", pattern, "--", ...paths,
    ], {
      cwd: repoRoot,
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    });
    toolCalls++;
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      return emptyObservation(start, code === "ENOENT" ? "ripgrep is not installed" : result.error.message, toolCalls);
    }
    if (result.status !== 0 && result.status !== 1) {
      return emptyObservation(start, (result.stderr ?? "").trim() || `rg exited ${result.status}`, toolCalls);
    }
    for (const path of (result.stdout ?? "").split(/\r?\n/)) {
      const normalized = path.replace(/^\.\//, "").replaceAll("\\", "/").trim();
      if (normalized) found.add(normalized);
    }
  }

  const foundPaths = rankPaths([...found], uniqueTerms).slice(0, limit);
  return {
    foundPaths,
    toolCalls,
    bytesServed: Buffer.byteLength(JSON.stringify({ foundPaths })),
    elapsedMs: performance.now() - start,
  };
}

function pathBatches(paths: string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const pathBytes = Buffer.byteLength(path) + 1;
    if (batch.length > 0 && (batch.length >= MAX_PATHS_PER_CALL || bytes + pathBytes > MAX_PATH_ARGUMENT_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += pathBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
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

function emptyObservation(start: number, error: string, toolCalls = 1): EvalObservation {
  return {
    foundPaths: [],
    toolCalls,
    bytesServed: 0,
    elapsedMs: performance.now() - start,
    error,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
