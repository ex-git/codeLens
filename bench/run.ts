/**
 * Indexing and retrieval performance gates.
 *
 * Generates disposable 100-file and 2,000-file TypeScript repositories.
 * Measures cold indexing, search p50/p95, related p50, and incremental writes.
 * Also checks SQL preparation counts, 4,000-function extraction, and endpoint
 * lookups in a 100,000-edge sparse graph. Repeated hot-path timings use medians.
 *
 * Exits non-zero on budget breach. Writes JSON to stdout and
 * bench/results/results.json.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { openDb, openMemoryDb } from "../src/db/db.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxSearch } from "../src/tools/search.js";
import { ctxRelated } from "../src/tools/related.js";
import { detectScope } from "../src/git/scope.js";
import { ensureFreshIndex, registerWatcher } from "../src/index/reindex.js";
import { extractEdges } from "../src/graph/edges.js";
import { getOrCreateIndex } from "../src/index/manager.js";
import { walkGraph } from "../src/graph/query.js";
import { ctxDiff } from "../src/tools/diff.js";
import { ctxTour } from "../src/tools/tour.js";
import { FileWatcher } from "../src/index/watcher.js";
import { openMemoryContextDb } from "../src/context/store.js";
import { TOOLS } from "../src/tools/registry.js";
import type { SearchResult } from "../src/tools/search.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGETS = {
  searchP50Ms: 50,
  searchP95Ms: 150, // p95 allowed headroom over p50
  smallColdMs: 3000,
  reindexPerFileMs: 20,
  largeColdMs: 10000, // ~2000-file repo cold index (eager; lazy indexing is future work)
  largeCoreSearchP50Ms: 50,
  largeColdPrepareCount: 64,
  denseEdgeExtractionP50Ms: 1000,
  sparseGraphP50Ms: 2,
  diffP50Ms: 5000, // 50 bounded per-file Git patch reads; includes process startup.
  tourP50Ms: 100,
  diffPrepareCount: 1500,
  diffBytes: 262144,
  tourBytes: 32768,
  requestSearchP50Ms: 500, // Includes one six-process scope detection, not transport.
  quietFreshnessScans: 1, // Allow one periodic reconciliation, not one per request.
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

function sparseGraphBenchmark(): { metrics: Record<string, number>; failures: string[] } {
  const db = openMemoryDb();
  try {
    const { id } = getOrCreateIndex(db, { repoRoot: "/benchmark", worktreePath: "/benchmark", branch: "main", headSha: "a", dirtyFiles: [], detached: false });
    const insert = db.prepare(`INSERT INTO edges (id, index_id, from_id, to_id, from_path, to_path, type, confidence, from_symbol, to_symbol, source_start_line, source_end_line, method)
      VALUES (?, ?, ?, ?, ?, ?, 'calls', 0.8, 'source', 'target', 1, 1, 'ast')`);
    db.transaction(() => {
      for (let i = 0; i < 100000; i++) insert.run(`e${i}`, id, `source${i}`, `target${i}`, `src/source${i}.ts`, `src/target${i}.ts`);
    })();
    const metrics: Record<string, number> = {}, failures: string[] = [];
    for (const mode of ["path", "id"] as const) for (const direction of ["out", "in", "both"] as const) {
      const start = direction === "in" ? "target0" : "source0";
      const times: number[] = [];
      for (let i = 0; i < 25; i++) {
        const begin = process.hrtime.bigint();
        const result = walkGraph(db, id, `src/${start}.ts`, { symbolId: mode === "id" ? start : undefined, direction, depth: 1, types: ["calls", "inherits"] });
        times.push(ms(process.hrtime.bigint() - begin));
        const expectedPath = direction === "in" ? "src/source0.ts" : "src/target0.ts";
        if (result.results.length !== 1 || result.results[0]!.path !== expectedPath || result.truncated) throw new Error(`invalid sparse graph result: ${mode}/${direction}`);
      }
      const name = `sparse${mode === "path" ? "File" : "Symbol"}${direction[0]!.toUpperCase() + direction.slice(1)}P50Ms`;
      const p50 = percentile(times, 50);
      metrics[name] = p50;
      if (p50 > BUDGETS.sparseGraphP50Ms) failures.push(`${name} ${p50.toFixed(2)}ms > ${BUDGETS.sparseGraphP50Ms}ms`);
    }
    return { metrics, failures };
  } finally { db.close(); }
}

function workflowBenchmark(): { metrics: Record<string, number>; failures: string[] } {
  const root = mkdtempSync(join(tmpdir(), "cl-bench-workflows-")), db = openMemoryDb();
  try {
    makeRepo(root, 300);
    const scope = detectScope(root)!;
    buildIndex(db, scope);
    for (let i = 0; i < 60; i++) writeFileSync(join(root, "src", `m${i}.ts`),
      `import { f${i + 1} } from './m${i + 1}';\nexport function f${i}(x: number): number { return x + ${i + 1}; }\n`);
    ensureFreshIndex(db, scope, { budgetMs: 10000 });
    const diffTimes: number[] = [], tourTimes: number[] = [];
    let diffBytes = 0, tourBytes = 0, diffPrepareCount = 0;
    for (let sample = 0; sample < 3; sample++) {
      const originalPrepare = db.prepare;
      let prepares = 0;
      db.prepare = ((sql: string) => { prepares++; return originalPrepare.call(db, sql); }) as typeof db.prepare;
      try {
        const begin = process.hrtime.bigint(), diff = ctxDiff(db, root);
        diffTimes.push(ms(process.hrtime.bigint() - begin));
        diffBytes = Math.max(diffBytes, Buffer.byteLength(JSON.stringify(diff)));
        diffPrepareCount = Math.max(diffPrepareCount, prepares);
        if (diff.files.length !== 50 || diff.targets.length !== 20 || diff.omitted.files !== 10 || !diff.truncated || !diff.targets.every(t => t.symbolId)) throw new Error("invalid bounded diff benchmark result");
      } finally { db.prepare = originalPrepare; }
      const begin = process.hrtime.bigint(), tour = ctxTour(db, { start: "src/m0.ts" });
      tourTimes.push(ms(process.hrtime.bigint() - begin));
      tourBytes = Math.max(tourBytes, Buffer.byteLength(JSON.stringify(tour)));
      if (tour.stops.length !== 4 || tour.stops[0]!.path !== "src/m0.ts" || tour.stops.slice(1).some(s => !s.chain.length || s.reason.anchor !== "src/m0.ts")) throw new Error("invalid sparse tour benchmark result");
    }
    const metrics = { diffP50Ms: percentile(diffTimes, 50), tourP50Ms: percentile(tourTimes, 50), diffPrepareCount, diffBytes, tourBytes };
    const failures = Object.entries(metrics).filter(([key, value]) => value > BUDGETS[key as keyof typeof metrics]).map(([key, value]) => `${key} ${value.toFixed(2)} > ${BUDGETS[key as keyof typeof metrics]}`);
    return { metrics, failures };
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

async function requestBenchmark(): Promise<{ metrics: Record<string, number>; failures: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "cl-bench-request-")), db = openMemoryDb(), ctxDb = openMemoryContextDb();
  const watcher = new FileWatcher(root);
  try {
    makeRepo(root, 100);
    const scope = detectScope(root)!; buildIndex(db, scope);
    watcher.start();
    if (!watcher.active) throw new Error("request benchmark requires a working file watcher");
    registerWatcher(watcher);
    await new Promise(resolve => setTimeout(resolve, 100));
    ensureFreshIndex(db, scope); watcher.consume();
    const search = TOOLS.find(tool => tool.name === "cl_search")!;
    const nativePrepare = db.prepare;
    let scans = 0;
    db.prepare = ((sql: string) => {
      if (sql.startsWith("SELECT id, path, size, mtime_ms, content_hash FROM files")) scans++;
      return nativePrepare.call(db, sql);
    }) as typeof db.prepare;
    const times: number[] = [];
    try {
      for (let i = 0; i < 5; i++) {
        const begin = process.hrtime.bigint();
        const requestScope = detectScope(root);
        const result = await search.handler({ coreDb: db, ctxDb, repoRoot: root, requestScope }, { query: `f${i} number` }) as SearchResult;
        times.push(ms(process.hrtime.bigint() - begin));
        if (!result.count || result.freshness !== "fresh") throw new Error("invalid request search result");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { db.prepare = nativePrepare; }
    const metrics = { requestSearchP50Ms: percentile(times, 50), quietFreshnessScans: scans };
    const failures = Object.entries(metrics).filter(([key, value]) => value > BUDGETS[key as keyof typeof metrics]).map(([key, value]) => `${key} ${value.toFixed(2)} > ${BUDGETS[key as keyof typeof metrics]}`);
    return { metrics, failures };
  } finally { registerWatcher(null); watcher.stop(); db.close(); ctxDb.close(); rmSync(root, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  const results: Record<string, unknown> = { budgets: BUDGETS, metrics: {}, pass: true, failures: [] };

  // Small repo cold index.
  const small = mkdtempSync(join(tmpdir(), "ce-bench-small-"));
  let smallScope: ReturnType<typeof detectScope>;
  try {
    makeRepo(small, 100);
    smallScope = detectScope(small)!;
    const smallDb = openDb(join(small, "bench-small.db"));
    const t0 = process.hrtime.bigint();
    const smallBuild = buildIndex(smallDb, smallScope);
    if (smallBuild.indexedFiles !== 100 || smallBuild.skipped !== 0) throw new Error("small cold build lost fixture files");
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
    let prepareCount = 0;
    const originalPrepare = largeDb.prepare;
    largeDb.prepare = ((sql: string) => {
      prepareCount++;
      return originalPrepare.call(largeDb, sql);
    }) as typeof largeDb.prepare;
    const lt0 = process.hrtime.bigint();
    try {
      const largeBuild = buildIndex(largeDb, largeScope);
      if (largeBuild.indexedFiles !== 2000 || largeBuild.skipped !== 0) throw new Error("large cold build lost fixture files");
    } finally { largeDb.prepare = originalPrepare; }
    const largeColdMs = ms(process.hrtime.bigint() - lt0);
    (results.metrics as Record<string, unknown>).largeColdPrepareCount = prepareCount;
    if (prepareCount > BUDGETS.largeColdPrepareCount) {
      results.pass = false;
      (results.failures as string[]).push(`large cold prepares ${prepareCount} > ${BUDGETS.largeColdPrepareCount}`);
    }
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
    // Many declarations in one file expose repeated linear symbol scans.
    const denseSource = "import { f0 } from './m0';\n" + Array.from({ length: 4000 }, (_, i) => `export function entry${i}() { f0(); }\n`).join("");
    const denseTimes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const start = process.hrtime.bigint();
      const edges = extractEdges("src/dense.ts", "typescript", denseSource, large, new Set(["src/dense.ts", "src/m0.ts"]));
      denseTimes.push(ms(process.hrtime.bigint() - start));
      if (edges.length !== 4001) {
        results.pass = false;
        (results.failures as string[]).push(`dense extraction returned ${edges.length} edges, expected 4001`);
      }
    }
    const denseP50 = percentile(denseTimes, 50);
    (results.metrics as Record<string, unknown>).denseEdgeExtractionP50Ms = denseP50;
    if (denseP50 > BUDGETS.denseEdgeExtractionP50Ms) {
      results.pass = false;
      (results.failures as string[]).push(`dense extraction p50 ${denseP50.toFixed(1)}ms > ${BUDGETS.denseEdgeExtractionP50Ms}ms`);
    }
    largeDb.close();
  } finally {
    rmSync(large, { recursive: true, force: true });
  }

  const sparse = sparseGraphBenchmark();
  Object.assign(results.metrics as Record<string, unknown>, sparse.metrics);
  if (sparse.failures.length) {
    results.pass = false;
    (results.failures as string[]).push(...sparse.failures);
  }

  const workflows = workflowBenchmark();
  Object.assign(results.metrics as Record<string, unknown>, workflows.metrics);
  if (workflows.failures.length) {
    results.pass = false;
    (results.failures as string[]).push(...workflows.failures);
  }

  const requests = await requestBenchmark();
  Object.assign(results.metrics as Record<string, unknown>, requests.metrics);
  if (requests.failures.length) {
    results.pass = false;
    (results.failures as string[]).push(...requests.failures);
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
main().catch(error => { console.error(error); process.exitCode = 1; });