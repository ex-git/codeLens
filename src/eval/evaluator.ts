import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, lstatSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../db/db.js";
import { detectScope, type GitScope } from "../git/scope.js";
import { indexFile } from "../index/fts.js";
import { getOrCreateIndex } from "../index/manager.js";
import { ensureFreshIndex } from "../index/reindex.js";
import { scanFiles, type ScannedFile } from "../index/scanner.js";
import { setPendingPaths } from "../index/staleness.js";
import { ctxImpact } from "../tools/impact.js";
import { ctxSearch, type SearchWeights } from "../tools/search.js";
import { isInsideRepo, resolveReal } from "../util/paths.js";
import { runRgBaseline } from "./baseline.js";
import { aggregateRuns, artifactPaths, evaluateObservation, writeEvalArtifacts } from "./report.js";
import { generateEvalTasks, seededShuffle } from "./tasks.js";
import type {
  EvalArmName,
  EvalFreshnessResult,
  EvalObservation,
  EvalOptions,
  EvalProgressCallback,
  EvalProgressEvent,
  EvalResult,
  EvalScaleResult,
  EvalTask,
  EvalTaskRun,
} from "./types.js";

const LEXICAL_WEIGHTS: SearchWeights = {
  fts: 0.50,
  symbol: 0.22,
  graph: 0,
  code: 0.05,
  pathHit: 0.10,
  exact: 0.13,
  recency: 0,
};
const FTS_ONLY_WEIGHTS: SearchWeights = {
  fts: 1,
  symbol: 0,
  graph: 0,
  code: 0,
  pathHit: 0,
  exact: 0,
  recency: 0,
};

interface ProgressCounts {
  scale?: string;
  current?: number;
  total?: number;
}

class EvalProgressTracker {
  private activePhase = "initialization";

  constructor(
    private readonly callback: EvalProgressCallback | undefined,
    private readonly started: number,
  ) {}

  start(phase: string, message: string, counts: ProgressCounts = {}): void {
    this.activePhase = phase;
    this.emit({ phase, status: "start", message, ...counts });
  }

  update(phase: string, message: string, counts: ProgressCounts = {}): void {
    this.activePhase = phase;
    this.emit({ phase, status: "progress", message, ...counts });
  }

  complete(phase: string, message: string, counts: ProgressCounts = {}): void {
    this.emit({ phase, status: "complete", message, ...counts });
  }

  skipped(phase: string, message: string, counts: ProgressCounts = {}): void {
    this.emit({ phase, status: "skipped", message, ...counts });
  }

  error(phase: string, message: string, counts: ProgressCounts = {}): void {
    this.activePhase = phase;
    this.emit({ phase, status: "error", message, ...counts });
  }

  failure(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    this.error(this.activePhase, message);
    return new Error(`evaluation failed during ${this.activePhase}: ${message}`, { cause: error });
  }

  private emit(event: Omit<EvalProgressEvent, "elapsedMs">): void {
    try {
      this.callback?.({ ...event, elapsedMs: performance.now() - this.started });
    } catch {
      // Progress reporting must never break an evaluation.
    }
  }
}

export function defaultEvalOptions(repoRoot: string): EvalOptions {
  return {
    repoRoot,
    taskLimit: 100,
    seed: 42,
    repeats: 1,
    resultLimit: 10,
    scales: [500, 2000, "all"],
    quick: false,
    freshness: true,
    thresholds: {
      minRecallAtK: 0.6,
      minMrr: 0.5,
      minSuccessRate: 0.7,
    },
  };
}

export function quickEvalOptions(repoRoot: string): EvalOptions {
  return {
    ...defaultEvalOptions(repoRoot),
    taskLimit: 20,
    scales: [500],
    freshness: false,
    quick: true,
  };
}

export function runRepositoryEval(input: EvalOptions): EvalResult {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const progress = new EvalProgressTracker(input.onProgress, started);
  let temp: string | undefined;

  try {
    progress.start("repository", `Validating repository ${input.repoRoot}`);
    const requestedRoot = resolveReal(input.repoRoot);
    const scope = detectScope(requestedRoot);
    if (!scope) throw new Error(`not a Git repository: ${requestedRoot}`);
    const repoRoot = scope.repoRoot;
    const initialStatus = gitStatus(repoRoot);
    progress.complete("repository", `Using ${repoRoot} at ${scope.headSha.slice(0, 12)} (${scope.dirtyFiles.length} dirty files)`);

    progress.start("scan", "Scanning indexable repository files");
    const scanned = scanFiles(repoRoot);
    if (scanned.length === 0) throw new Error(`no indexable files found: ${repoRoot}`);
    progress.complete("scan", `Found ${scanned.length} indexable files`, { current: scanned.length, total: scanned.length });

    progress.start("setup", "Preparing evaluation scales and output paths");
    const outputDirectory = input.outputDir ? canonicalOutputPath(input.outputDir) : defaultOutputDirectory(repoRoot);
    if (isInsideRepo(repoRoot, outputDirectory)) throw new Error("evaluation output must be outside the target repository");
    const artifacts = artifactPaths(outputDirectory);
    temp = mkdtempSync(join(tmpdir(), "codelens-eval-"));
    const skipped: string[] = [];
    const scaleSpecs = resolveScaleSpecs(input.scales, scanned.length);
    const scales: EvalScaleResult[] = [];
    progress.complete("setup", `Prepared ${scaleSpecs.length} scale${scaleSpecs.length === 1 ? "" : "s"}: ${scaleSpecs.map((spec) => spec.label).join(", ")}`);

    for (let scaleIndex = 0; scaleIndex < scaleSpecs.length; scaleIndex++) {
      const spec = scaleSpecs[scaleIndex]!;
      const scaleCounts = { scale: spec.label, current: scaleIndex + 1, total: scaleSpecs.length };
      progress.start("scale", `Starting scale ${spec.label} with ${spec.count} files`, scaleCounts);
      const selected = selectFiles(scanned, spec.count, input.seed + scaleIndex * 1009);
      const dbPath = join(temp, `eval-${scaleIndex}.db`);
      const db = openDb(dbPath);
      try {
        progress.start("index", `Indexing ${selected.length} files for scale ${spec.label}`, { scale: spec.label, current: 0, total: selected.length });
        const indexStart = performance.now();
        const build = buildSubsetIndex(db, scope, selected, (current, total) => {
          progress.update("index", `Indexed ${current}/${total} files for scale ${spec.label}`, { scale: spec.label, current, total });
        });
        const indexMs = performance.now() - indexStart;
        progress.complete("index", `Indexed ${build.indexedFiles} files and ${build.totalChunks} chunks for scale ${spec.label} in ${formatDuration(indexMs)} (${build.skipped} skipped)`, { scale: spec.label, current: selected.length, total: selected.length });

        const inventory = selected.map((file) => file.path);
        const scaleTaskLimit = distributedLimit(input.taskLimit, scaleSpecs.length, scaleIndex);
        progress.start("tasks", `Generating up to ${scaleTaskLimit} tasks for scale ${spec.label}`, { scale: spec.label });
        const tasks = generateEvalTasks(db, build.indexId, repoRoot, inventory, scaleTaskLimit, input.seed + scaleIndex * 7919);
        progress.complete("tasks", `Generated ${tasks.length} tasks for scale ${spec.label}`, { scale: spec.label, current: tasks.length, total: scaleTaskLimit });
        if (scaleTaskLimit === 0) skipped.push(`${spec.label}: no tasks allocated because --tasks is lower than the number of scales.`);
        for (const type of ["locate", "callers", "tests", "history"] as const) {
          if (!tasks.some((task) => task.type === type)) skipped.push(`${spec.label}: no ${type} tasks were generated.`);
        }

        const expectedRuns = tasks.length * 4 * Math.max(1, input.repeats);
        progress.start("retrieval", `Running ${expectedRuns} retrieval checks for scale ${spec.label}`, { scale: spec.label, current: 0, total: expectedRuns });
        const runs = runTaskSet(db, repoRoot, tasks, input.repeats, input.resultLimit, (current, total) => {
          progress.update("retrieval", `Completed ${current}/${total} retrieval checks for scale ${spec.label}`, { scale: spec.label, current, total });
        });
        progress.complete("retrieval", `Completed ${runs.length} retrieval checks for scale ${spec.label}`, { scale: spec.label, current: runs.length, total: expectedRuns });
        if (runs.some((run) => run.arm === "rg" && run.error === "ripgrep is not installed")) {
          skipped.push("rg baseline unavailable because ripgrep is not installed.");
          progress.skipped("retrieval", "rg baseline unavailable because ripgrep is not installed", { scale: spec.label });
        }
        const aggregates = aggregateByArm(runs);
        scales.push({
          label: spec.label,
          requestedFiles: spec.requested,
          indexedFiles: build.indexedFiles,
          totalChunks: build.totalChunks,
          skippedFiles: build.skipped,
          indexMs,
          dbBytes: databaseBytes(dbPath),
          tasks,
          runs,
          aggregates,
        });
        progress.complete("scale", `Finished scale ${spec.label}: ${formatAggregateSummary(aggregates.full)}`, scaleCounts);
      } finally {
        db.close();
      }
    }

    let freshness: EvalFreshnessResult;
    if (input.freshness) {
      progress.start("freshness", "Starting detached-worktree edit/delete freshness probe");
      freshness = runFreshnessEval(repoRoot, input.seed, progress);
      const freshnessMessage = freshness.attempted
        ? `Freshness probe ${freshness.passed ? "passed" : "failed"} in ${formatDuration(freshness.elapsedMs ?? 0)}`
        : `Freshness probe skipped: ${freshness.skippedReason ?? "not attempted"}`;
      if (freshness.attempted && freshness.passed) progress.complete("freshness", freshnessMessage);
      else if (freshness.attempted) progress.error("freshness", freshnessMessage);
      else progress.skipped("freshness", freshnessMessage);
    } else {
      freshness = disabledFreshness();
      progress.skipped("freshness", "Freshness probe disabled");
    }
    if (freshness.skippedReason) skipped.push(`freshness: ${freshness.skippedReason}`);

    progress.start("thresholds", "Checking configured quality thresholds");
    const thresholdFailures = scales.flatMap((scale) => thresholdFailuresFor(scale, input));
    if (input.freshness && freshness.attempted && !freshness.passed) thresholdFailures.push("Freshness edit/delete probe failed.");
    if (initialStatus !== gitStatus(repoRoot)) thresholdFailures.push("Target repository worktree changed during evaluation.");
    progress.complete("thresholds", thresholdFailures.length === 0 ? "All configured thresholds passed" : `${thresholdFailures.length} configured threshold${thresholdFailures.length === 1 ? "" : "s"} failed`);

    const completedAt = new Date().toISOString();
    const result: EvalResult = {
      version: 1,
      repository: {
        root: repoRoot,
        branch: scope.branch,
        headSha: scope.headSha,
        dirtyFiles: scope.dirtyFiles.length,
        totalFiles: scanned.length,
      },
      options: {
        taskLimit: input.taskLimit,
        seed: input.seed,
        repeats: input.repeats,
        resultLimit: input.resultLimit,
        scales: input.scales,
        quick: input.quick,
        freshness: input.freshness,
        thresholds: input.thresholds,
      },
      startedAt,
      completedAt,
      durationMs: performance.now() - started,
      pass: scales.some((scale) => scale.tasks.length > 0) && thresholdFailures.length === 0,
      thresholdFailures,
      skipped: [...new Set(skipped)],
      scales,
      freshness,
      artifacts,
    };

    progress.start("reports", `Writing evaluation artifacts to ${artifacts.directory}`);
    writeEvalArtifacts(result);
    progress.complete("reports", `Wrote results.json, report.md, and tasks.json to ${artifacts.directory}`);
    progress.start("cleanup", "Removing temporary evaluation databases");
    rmSync(temp, { recursive: true, force: true });
    temp = undefined;
    progress.complete("cleanup", "Removed temporary evaluation databases");
    progress.complete("evaluation", `Evaluation ${result.pass ? "passed" : "failed thresholds"} in ${formatDuration(performance.now() - started)}`);
    return result;
  } catch (error) {
    throw progress.failure(error);
  } finally {
    if (temp) {
      progress.start("cleanup", "Removing temporary evaluation databases");
      try {
        rmSync(temp, { recursive: true, force: true });
        progress.complete("cleanup", "Removed temporary evaluation databases");
      } catch (error) {
        progress.error("cleanup", error instanceof Error ? error.message : String(error));
      }
    }
  }
}

function buildSubsetIndex(
  db: Database.Database,
  scope: GitScope,
  files: ScannedFile[],
  onProgress?: (current: number, total: number) => void,
): { indexId: string; indexedFiles: number; totalChunks: number; skipped: number } {
  const indexId = getOrCreateIndex(db, scope).id;
  const knownFiles = new Set(files.map((file) => file.path));
  let indexedFiles = 0;
  let totalChunks = 0;
  let skipped = 0;
  const progressInterval = Math.max(1, Math.ceil(files.length / 20));
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    try {
      const indexed = indexFile(db, indexId, scope.repoRoot, file, knownFiles);
      indexedFiles++;
      totalChunks += indexed.chunkCount;
    } catch {
      skipped++;
    }
    const current = index + 1;
    if (current === files.length || current % progressInterval === 0) onProgress?.(current, files.length);
  }
  setPendingPaths(indexId, []);
  return { indexId, indexedFiles, totalChunks, skipped };
}

function runTaskSet(
  db: Database.Database,
  repoRoot: string,
  tasks: EvalTask[],
  repeats: number,
  limit: number,
  onProgress?: (current: number, total: number) => void,
): EvalTaskRun[] {
  const runs: EvalTaskRun[] = [];
  const arms: EvalArmName[] = ["full", "lexical", "fts", "rg"];
  const total = tasks.length * arms.length * Math.max(1, repeats);
  const progressInterval = Math.max(1, Math.ceil(total / 20));
  for (let repeat = 0; repeat < Math.max(1, repeats); repeat++) {
    for (const task of tasks) {
      for (const arm of arms) {
        const observation = arm === "rg"
          ? runRgBaseline(repoRoot, task, limit)
          : runCodeLens(db, task, limit, arm);
        runs.push(evaluateObservation(task, arm, observation, limit));
        if (runs.length === total || runs.length % progressInterval === 0) onProgress?.(runs.length, total);
      }
    }
  }
  return runs;
}

function runCodeLens(
  db: Database.Database,
  task: EvalTask,
  limit: number,
  arm: Exclude<EvalArmName, "rg">,
): EvalObservation {
  const start = performance.now();
  try {
    let result: unknown;
    let foundPaths: string[];
    if (arm === "full" && (task.type === "callers" || task.type === "tests") && task.sourcePath) {
      result = ctxImpact(db, { path: task.sourcePath, depth: 2 });
      const impact = result as {
        target?: { path?: string };
        callers?: Array<{ path: string }>;
        affectedFiles?: Array<{ path: string }>;
        affectedTests?: Array<{ path: string }>;
      };
      foundPaths = [
        ...(task.type === "tests" ? (impact.affectedTests ?? []).map((item) => item.path) : []),
        ...(impact.callers ?? []).map((item) => item.path),
        ...(impact.affectedFiles ?? []).map((item) => item.path),
        impact.target?.path,
      ].filter((path): path is string => !!path);
    } else {
      const weights = arm === "lexical" ? LEXICAL_WEIGHTS : arm === "fts" ? FTS_ONLY_WEIGHTS : undefined;
      result = ctxSearch(db, task.query, { limit, snippet: "none", weights });
      foundPaths = (result as { results: Array<{ path: string }> }).results.map((item) => item.path);
    }
    foundPaths = [...new Set(foundPaths)].slice(0, limit);
    return {
      foundPaths,
      toolCalls: 1,
      bytesServed: Buffer.byteLength(JSON.stringify(result)),
      bytesRead: 0,
      elapsedMs: performance.now() - start,
    };
  } catch (error) {
    return {
      foundPaths: [],
      toolCalls: 1,
      bytesServed: 0,
      bytesRead: 0,
      elapsedMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runFreshnessEval(repoRoot: string, seed: number, progress: EvalProgressTracker): EvalFreshnessResult {
  const start = performance.now();
  const temp = resolveReal(mkdtempSync(join(tmpdir(), "codelens-eval-worktree-")));
  const worktree = join(temp, "repo");
  let db: Database.Database | null = null;
  let worktreeAdded = false;
  try {
    progress.start("freshness-worktree", "Creating detached temporary worktree");
    const added = spawnSync("git", ["worktree", "add", "--detach", "--quiet", worktree, "HEAD"], { cwd: repoRoot, encoding: "utf-8" });
    if (added.status !== 0) {
      const skippedReason = (added.stderr ?? "").trim() || "could not create temporary worktree";
      progress.skipped("freshness-worktree", skippedReason);
      return { enabled: true, attempted: false, passed: false, skippedReason };
    }
    worktreeAdded = true;
    progress.complete("freshness-worktree", `Created detached worktree at ${worktree}`);

    const scope = detectScope(worktree);
    if (!scope) {
      progress.skipped("freshness-worktree", "Temporary worktree scope detection failed");
      return { enabled: true, attempted: false, passed: false, skippedReason: "temporary worktree scope detection failed" };
    }

    progress.start("freshness-scan", "Scanning temporary worktree for a safe probe file");
    const scanned = scanFiles(worktree);
    const candidates = seededShuffle(scanned.filter(isFreshnessCandidate), seed);
    const selected = candidates.map((file) => ({ file, path: safeFreshnessPath(worktree, file) })).find((item) => item.path !== null);
    if (!selected?.path) {
      progress.skipped("freshness-scan", "No safe regular text file for freshness probe");
      return { enabled: true, attempted: false, passed: false, skippedReason: "no safe regular text file for freshness probe" };
    }
    progress.complete("freshness-scan", `Selected ${selected.file.path} from ${scanned.length} files`);

    db = openDb(join(temp, "freshness.db"));
    progress.start("freshness-index", `Building freshness index for ${scanned.length} files`, { current: 0, total: scanned.length });
    const build = buildSubsetIndex(db, scope, scanned, (current, total) => {
      progress.update("freshness-index", `Indexed ${current}/${total} freshness files`, { current, total });
    });
    progress.complete("freshness-index", `Built freshness index with ${build.indexedFiles} files and ${build.totalChunks} chunks`, { current: scanned.length, total: scanned.length });

    const token = `codelensfreshnessprobe${createHash("sha256").update(`${repoRoot}\0${seed}`).digest("hex").slice(0, 12)}`;
    progress.start("freshness-edit", `Appending probe token to ${selected.file.path}`);
    appendFreshnessProbe(selected.path, freshnessComment(selected.file.language, token));
    ensureFreshIndex(db, scope, { budgetMs: 30000 });
    const modifiedVisible = ctxSearch(db, token, { snippet: "none" }).results.some((result) => result.path === selected.file.path);
    progress.complete("freshness-edit", `Modified content ${modifiedVisible ? "became visible" : "was not found"}`);

    progress.start("freshness-delete", `Deleting probe file ${selected.file.path} in the temporary worktree`);
    rmSync(selected.path, { force: true });
    ensureFreshIndex(db, scope, { budgetMs: 30000 });
    const deletedRemoved = !ctxSearch(db, token, { snippet: "none" }).results.some((result) => result.path === selected.file.path);
    progress.complete("freshness-delete", `Deleted content ${deletedRemoved ? "was removed" : "remained searchable"}`);
    return {
      enabled: true,
      attempted: true,
      passed: modifiedVisible && deletedRemoved,
      modifiedVisible,
      deletedRemoved,
      elapsedMs: performance.now() - start,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress.error("freshness", message);
    return {
      enabled: true,
      attempted: true,
      passed: false,
      elapsedMs: performance.now() - start,
      error: message,
    };
  } finally {
    progress.start("freshness-cleanup", "Removing temporary worktree and Git metadata");
    try { db?.close(); } catch { /* cleanup verification below catches remaining state */ }
    cleanupTemporaryWorktree(repoRoot, temp, worktree, worktreeAdded);
    progress.complete("freshness-cleanup", "Removed temporary worktree and Git metadata");
  }
}

function appendFreshnessProbe(path: string, content: string): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
  try { writeSync(fd, content); } finally { closeSync(fd); }
}

function safeFreshnessPath(worktree: string, file: ScannedFile): string | null {
  const path = join(worktree, file.path);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const resolved = resolveReal(path);
    return isInsideRepo(worktree, resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function cleanupTemporaryWorktree(repoRoot: string, temp: string, worktree: string, worktreeAdded: boolean): void {
  let removalFailure: string | undefined;
  if (worktreeAdded) {
    const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: repoRoot, encoding: "utf-8" });
    if (removed.error || removed.status !== 0) removalFailure = removed.error?.message ?? ((removed.stderr ?? "").trim() || `exit ${removed.status}`);
  }
  let tempFailure: string | undefined;
  try { rmSync(temp, { recursive: true, force: true }); } catch (error) { tempFailure = error instanceof Error ? error.message : String(error); }
  if (!worktreeAdded) {
    if (tempFailure) throw new Error(`failed to remove evaluation temp directory: ${tempFailure}`);
    return;
  }
  const pruned = spawnSync("git", ["worktree", "prune", "--expire", "now"], { cwd: repoRoot, encoding: "utf-8" });
  if (pruned.error || pruned.status !== 0) {
    throw new Error(`failed to prune temporary worktree metadata: ${pruned.error?.message ?? (pruned.stderr ?? "").trim()}`);
  }
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
  if (listed.error || listed.status !== 0) throw new Error(`failed to verify temporary worktree cleanup: ${listed.error?.message ?? "git worktree list failed"}`);
  if ((listed.stdout ?? "").split(/\r?\n/).includes(`worktree ${worktree}`)) {
    throw new Error(`temporary worktree metadata remains registered${removalFailure ? ` after removal failed (${removalFailure})` : ""}: ${worktree}`);
  }
  if (tempFailure) throw new Error(`failed to remove evaluation temp directory: ${tempFailure}`);
}

function resolveScaleSpecs(scales: Array<number | "all">, total: number): Array<{ label: string; requested: number | "all"; count: number }> {
  const resolved: Array<{ label: string; requested: number | "all"; count: number }> = [];
  const seenCounts = new Set<number>();
  const requestedScales: Array<number | "all"> = scales.length > 0 ? scales : ["all"];
  for (const scale of requestedScales) {
    const count = scale === "all" ? total : Math.max(1, Math.min(total, Math.floor(scale)));
    if (seenCounts.has(count)) continue;
    seenCounts.add(count);
    resolved.push({ label: count === total ? "all" : String(count), requested: scale, count });
  }
  if (resolved.length === 0) resolved.push({ label: "all", requested: "all", count: total });
  return resolved;
}

function selectFiles(files: ScannedFile[], count: number, seed: number): ScannedFile[] {
  if (count >= files.length) return [...files].sort((a, b) => a.path.localeCompare(b.path));
  return seededShuffle(files, seed).slice(0, count).sort((a, b) => a.path.localeCompare(b.path));
}

function aggregateByArm(runs: EvalTaskRun[]): Partial<Record<EvalArmName, ReturnType<typeof aggregateRuns>>> {
  const output: Partial<Record<EvalArmName, ReturnType<typeof aggregateRuns>>> = {};
  for (const arm of ["full", "lexical", "fts", "rg"] as EvalArmName[]) {
    const armRuns = runs.filter((run) => run.arm === arm);
    if (armRuns.length > 0) output[arm] = aggregateRuns(armRuns);
  }
  return output;
}

function thresholdFailuresFor(scale: EvalScaleResult, options: EvalOptions): string[] {
  if (scale.tasks.length === 0) return [];
  const metric = scale.aggregates.full;
  if (!metric) return [`${scale.label}: full CodeLens arm produced no metrics.`];
  const failures: string[] = [];
  if (metric.recallAtK < options.thresholds.minRecallAtK) failures.push(`${scale.label}: full recall@${options.resultLimit} ${metric.recallAtK.toFixed(3)} < ${options.thresholds.minRecallAtK.toFixed(3)}`);
  if (metric.mrr < options.thresholds.minMrr) failures.push(`${scale.label}: full MRR ${metric.mrr.toFixed(3)} < ${options.thresholds.minMrr.toFixed(3)}`);
  if (metric.successRate < options.thresholds.minSuccessRate) failures.push(`${scale.label}: full success rate ${metric.successRate.toFixed(3)} < ${options.thresholds.minSuccessRate.toFixed(3)}`);
  return failures;
}

function distributedLimit(total: number, count: number, index: number): number {
  const base = Math.floor(total / count);
  return base + (index < total % count ? 1 : 0);
}

function isFreshnessCandidate(file: ScannedFile): boolean {
  if (!file.language || file.size > 512 * 1024) return false;
  const base = basename(file.path).toLowerCase();
  return !base.includes("lock") && !/(^|\/)(test|tests|__tests__)(\/|$)/i.test(file.path) && !/\.(test|spec)\./i.test(base);
}

function freshnessComment(language: string | null, token: string): string {
  if (language === "python" || language === "ruby" || language === "bash") return `\n# ${token}\n`;
  if (language === "markdown") return `\n<!-- ${token} -->\n`;
  return `\n// ${token}\n`;
}

function disabledFreshness(): EvalFreshnessResult {
  return { enabled: false, attempted: false, passed: true };
}

function databaseBytes(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function canonicalOutputPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return join(resolveReal(current), ...missing);
}

function defaultOutputDirectory(repoRoot: string): string {
  const id = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(homedir(), ".codelens", "evals", id, stamp);
}

function formatDuration(elapsedMs: number): string {
  if (elapsedMs < 1000) return `${elapsedMs.toFixed(0)}ms`;
  if (elapsedMs < 60_000) return `${(elapsedMs / 1000).toFixed(1)}s`;
  const minutes = Math.floor(elapsedMs / 60_000);
  return `${minutes}m ${((elapsedMs % 60_000) / 1000).toFixed(0)}s`;
}

function formatAggregateSummary(metric: EvalScaleResult["aggregates"]["full"]): string {
  if (!metric) return "full arm produced no metrics";
  return `full recall ${(metric.recallAtK * 100).toFixed(1)}%, MRR ${metric.mrr.toFixed(3)}, success ${(metric.successRate * 100).toFixed(1)}%`;
}

function gitStatus(repoRoot: string): string {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z"], { cwd: repoRoot, encoding: "utf-8" });
  return result.status === 0 ? result.stdout ?? "" : "";
}
