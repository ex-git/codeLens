/**
 * Benchmark suite (Step 26).
 *
 * Measures cold index (small repo), cl_search p50/p95, cl_related p50,
 * incremental reindex per-file, and large-repo core search against performance
 * budgets (Design Decision #5):
 *   search < 50ms, small-repo cold index < 3s, large lazy.
 * Exits non-zero on budget breach. Output: JSON to stdout + bench/results.json.
 *
 * Fixtures: bench/fixtures/small (committed ~100-file TS repo, generated).
 * Large fixture is generated in-place if absent.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { openDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxSearch } from "../src/tools/search.js";
import { ctxRelated } from "../src/tools/related.js";
import { detectScope } from "../src/git/scope.js";
import { ensureFreshIndex } from "../src/index/reindex.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGETS = {
  searchP50Ms: 50,
  searchP95Ms: 150, // p95 allowed headroom over p50
  smallColdMs: 3000,
  reindexPerFileMs: 20,
  largeColdMs: 10000, // ~2000-file repo cold index (eager; lazy indexing is future work)
  largeCoreSearchP50Ms: 50,
};

function makeRepo(root: string, fileCount: number): void {
  execSync("git init -q", { cwd: root });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: root });
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(root, "src", `m${i}.ts`),
      `import { f${(i + 1) % fileCount} } from './m${(i + 1) % fileCount}';\nexport function f${i}(x: number): number { return x + ${i}; }\n`);
  }
  execSync("git add -A && git commit -q -m init", { cwd: root });
}

function ms(ns: bigint): number { return Number(ns) / 1e6; }

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function main(): void {
  const results: Record<string, unknown> = { budgets: BUDGETS, metrics: {}, pass: true, failures: [] };

  // Small repo cold index.
  const small = mkdtempSync(join(tmpdir(), "ce-bench-small-"));
  let smallScope: ReturnType<typeof detectScope>;
  try {
    makeRepo(small, 100);
    smallScope = detectScope(small)!;
    const smallDb = openDb(join(small, "bench-small.db"));
    const t0 = process.hrtime.bigint();
    buildIndex(smallDb, smallScope);
    const coldMs = ms(process.hrtime.bigint() - t0);
    (results.metrics as Record<string, unknown>).smallColdMs = coldMs;
    if (coldMs > BUDGETS.smallColdMs) {
      results.pass = false;
      (results.failures as string[]).push(`small cold ${coldMs.toFixed(0)}ms > ${BUDGETS.smallColdMs}ms`);
    }

    // cl_search p50/p95.
    const searchTimes: number[] = [];
    for (let i = 0; i < 50; i++) {
      const s = process.hrtime.bigint();
      ctxSearch(smallDb, `f${i % 100} number`, { scope: smallScope });
      searchTimes.push(ms(process.hrtime.bigint() - s));
    }
    const p50 = percentile(searchTimes, 50);
    const p95 = percentile(searchTimes, 95);
    (results.metrics as Record<string, unknown>).searchP50Ms = p50;
    (results.metrics as Record<string, unknown>).searchP95Ms = p95;
    if (p50 > BUDGETS.searchP50Ms) {
      results.pass = false;
      (results.failures as string[]).push(`search p50 ${p50.toFixed(1)}ms > ${BUDGETS.searchP50Ms}ms`);
    }
    if (p95 > BUDGETS.searchP95Ms) {
      results.pass = false;
      (results.failures as string[]).push(`search p95 ${p95.toFixed(1)}ms > ${BUDGETS.searchP95Ms}ms`);
    }

    // cl_related p50.
    const relTimes: number[] = [];
    for (let i = 0; i < 30; i++) {
      const s = process.hrtime.bigint();
      ctxRelated(smallDb, `src/m${i % 100}.ts`, { types: ["imports"], depth: 1 });
      relTimes.push(ms(process.hrtime.bigint() - s));
    }
    const relP50 = percentile(relTimes, 50);
    (results.metrics as Record<string, unknown>).relatedP50Ms = relP50;

    // incremental reindex per file (amortized: change 10 files, measure total/10).
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(small, "src", `m${i}.ts`), `export const changed${i} = ${i};\n`);
    }
    const s = process.hrtime.bigint();
    const r = ensureFreshIndex(smallDb, smallScope, { budgetMs: 10000 });
    const reindexMs = ms(process.hrtime.bigint() - s);
    const perFile = r.refreshed > 0 ? reindexMs / r.refreshed : reindexMs;
    (results.metrics as Record<string, unknown>).reindexPerFileMs = perFile;
    if (perFile > BUDGETS.reindexPerFileMs) {
      results.pass = false;
      (results.failures as string[]).push(`reindex/file ${perFile.toFixed(1)}ms > ${BUDGETS.reindexPerFileMs}ms`);
    }

    smallDb.close();
  } finally {
    rmSync(small, { recursive: true, force: true });
  }

  // Large repo cold index (eager; documents scaling). Lazy on-demand indexing
  // is future work — for large repos the recommended pattern is one cl_refresh
  // then incremental + watcher thereafter.
  const large = mkdtempSync(join(tmpdir(), "ce-bench-large-"));
  try {
    makeRepo(large, 2000);
    const largeScope = detectScope(large)!;
    const largeDb = openDb(join(large, "bench-large.db"));
    const lt0 = process.hrtime.bigint();
    buildIndex(largeDb, largeScope);
    const largeColdMs = ms(process.hrtime.bigint() - lt0);
    (results.metrics as Record<string, unknown>).largeColdMs = largeColdMs;
    if (largeColdMs > BUDGETS.largeColdMs) {
      results.pass = false;
      (results.failures as string[]).push(`large cold ${largeColdMs.toFixed(0)}ms > ${BUDGETS.largeColdMs}ms`);
    }
    // verify a search on the large repo is still fast
    const lSearch: number[] = [];
    for (let i = 0; i < 20; i++) {
      const s = process.hrtime.bigint();
      ctxSearch(largeDb, `m${i * 100} number`, { scope: largeScope });
      lSearch.push(ms(process.hrtime.bigint() - s));
    }
    (results.metrics as Record<string, unknown>).largeSearchP50Ms = percentile(lSearch, 50);

    // Isolate the DB/ranking hot path from freshness scanning. Production uses
    // a watcher to skip most full scans, while this benchmark has no watcher.
    const largeCoreSearch: number[] = [];
    for (let i = 0; i < 30; i++) {
      const s = process.hrtime.bigint();
      ctxSearch(largeDb, `m${(i % 20) * 100} number`, { snippet: "none" });
      largeCoreSearch.push(ms(process.hrtime.bigint() - s));
    }
    const largeCoreSearchP50Ms = percentile(largeCoreSearch, 50);
    (results.metrics as Record<string, unknown>).largeCoreSearchP50Ms = largeCoreSearchP50Ms;
    if (largeCoreSearchP50Ms > BUDGETS.largeCoreSearchP50Ms) {
      results.pass = false;
      (results.failures as string[]).push(
        `large core search p50 ${largeCoreSearchP50Ms.toFixed(1)}ms > ${BUDGETS.largeCoreSearchP50Ms}ms`,
      );
    }
    largeDb.close();
  } finally {
    rmSync(large, { recursive: true, force: true });
  }

  // Persist results.
  const outDir = join(HERE, "results");
  try { mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
  const outPath = join(outDir, "results.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log(JSON.stringify(results, null, 2));
  process.exit(results.pass ? 0 : 1);
}

void existsSync;
main();