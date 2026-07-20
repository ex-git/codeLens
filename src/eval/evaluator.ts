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
import { DEFAULT_WEIGHTS } from "../search/rank.js";
import { ctxSearch, type SearchWeights } from "../tools/search.js";
import { isInsideRepo, resolveReal } from "../util/paths.js";
import { runRgBaseline } from "./baseline.js";
import {
  aggregateRuns,
  artifactPaths,
  evaluateObservation,
  graphAggregates,
  retrievalAggregates,
  writeEvalArtifacts,
} from "./report.js";
import { loadEvalTaskFile, requiredTaskPaths } from "./task-file.js";
import { generateEvalTasks, seededShuffle } from "./tasks.js";
import type {
  EvalFreshnessResult,
  EvalGraphTaskType,
  EvalObservation,
  EvalOptions,
  EvalProgressCallback,
  EvalProgressEvent,
  EvalResult,
  EvalRetrievalArmName,
  EvalRetrievalTaskType,
  EvalScaleResult,
  EvalSuiteName,
  EvalTask,
  EvalTaskRun,
  EvalTaskSource,
} from "./types.js";

const RETRIEVAL_ARMS: EvalRetrievalArmName[] = ["full", "lexical", "fts", "rg"];
const NON_GRAPH_WEIGHT = 1 - DEFAULT_WEIGHTS.graph;
const LEXICAL_WEIGHTS: SearchWeights = {
  fts: DEFAULT_WEIGHTS.fts / NON_GRAPH_WEIGHT,
  symbol: DEFAULT_WEIGHTS.symbol / NON_GRAPH_WEIGHT,
  graph: 0,
  code: DEFAULT_WEIGHTS.code / NON_GRAPH_WEIGHT,
  pathHit: DEFAULT_WEIGHTS.pathHit / NON_GRAPH_WEIGHT,
  exact: DEFAULT_WEIGHTS.exact / NON_GRAPH_WEIGHT,
  recency: DEFAULT_WEIGHTS.recency,
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
    try { this.callback?.({ ...event, elapsedMs: performance.now() - this.started }); } catch { /* progress is best-effort */ }
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
    suites: ["retrieval", "graph", "freshness"],
    quick: false,
    thresholds: {
      minRecallAtK: 0.6,
      minMrr: 0.5,
      minSuccessRate: 0.7,
      minGraphPrecision: 0.5,
    },
  };
}

export function quickEvalOptions(repoRoot: string): EvalOptions {
  return {
    ...defaultEvalOptions(repoRoot),
    taskLimit: 20,
    scales: [500],
    suites: ["retrieval", "graph"],
    quick: true,
  };
}

export function runRepositoryEval(input: EvalOptions): EvalResult {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const progress = new EvalProgressTracker(input.onProgress, started);
  let temp: string | undefined;

  try {
    const suites = normalizeSuites(input.suites);
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

    progress.start("setup", "Preparing frozen tasks, nested scales, and output paths");
    const outputDirectory = input.outputDir ? canonicalOutputPath(input.outputDir) : defaultOutputDirectory(repoRoot);
    if (isInsideRepo(repoRoot, outputDirectory)) throw new Error("evaluation output must be outside the target repository");
    const artifacts = artifactPaths(outputDirectory);
    const loaded = input.taskFile ? loadEvalTaskFile(input.taskFile) : undefined;
    let frozenTasks = (loaded?.tasks ?? []).filter((task) => suites.includes(task.suite));
    const taskSuites = suites.filter((suite): suite is "retrieval" | "graph" => suite === "retrieval" || suite === "graph");
    const taskSource: EvalTaskSource = taskSuites.length === 0
      ? { kind: "none", independentGroundTruth: true }
      : loaded?.source ?? { kind: "automatic-self-evaluation", independentGroundTruth: false };
    const scaleSpecs = taskSuites.length > 0 ? resolveScaleSpecs(input.scales, scanned.length) : [];
    const required = loaded ? requiredTaskPaths(frozenTasks) : new Set<string>();
    ensureRequiredPaths(scanned, required);
    if (scaleSpecs.length > 0 && required.size > scaleSpecs[0]!.count) {
      throw new Error(`smallest scale (${scaleSpecs[0]!.count}) cannot contain ${required.size} required task paths`);
    }
    const orderedFiles = nestedFileOrder(scanned, required, input.seed);
    temp = mkdtempSync(join(tmpdir(), "codelens-eval-"));
    const skipped: string[] = [];
    const scales: EvalScaleResult[] = [];
    progress.complete("setup", `Prepared ${scaleSpecs.length} nested scale${scaleSpecs.length === 1 ? "" : "s"}${loaded ? ` from frozen tasks (${taskSource.source ?? "task file"})` : " from automatic self-evaluation"}`);

    for (let scaleIndex = 0; scaleIndex < scaleSpecs.length; scaleIndex++) {
      const spec = scaleSpecs[scaleIndex]!;
      const scaleCounts = { scale: spec.label, current: scaleIndex + 1, total: scaleSpecs.length };
      progress.start("scale", `Starting scale ${spec.label} with ${spec.count} files`, scaleCounts);
      const selected = orderedFiles.slice(0, spec.count).sort((a, b) => a.path.localeCompare(b.path));
      const inventory = selected.map((file) => file.path);
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

        if (!loaded && scaleIndex === 0) {
          progress.start("tasks", `Generating up to ${input.taskLimit} automatic self-evaluation tasks`, { scale: spec.label });
          frozenTasks = generateEvalTasks(db, build.indexId, repoRoot, inventory, input.taskLimit, input.seed, suites);
          progress.complete("tasks", `Froze ${frozenTasks.length} tasks for every scale`, { scale: spec.label, current: frozenTasks.length, total: input.taskLimit });
        }
        const tasks = frozenTasks;
        for (const suite of taskSuites) {
          if (!tasks.some((task) => task.suite === suite)) skipped.push(`${suite}: no tasks were available.`);
        }

        const retrievalTasks = tasks.filter((task) => task.suite === "retrieval");
        const graphTasks = tasks.filter((task) => task.suite === "graph" && (loaded !== undefined || scaleIndex === 0));
        if (!loaded && scaleIndex > 0 && tasks.some((task) => task.suite === "graph")) {
          skipped.push("automatic graph self-consistency runs only at the label-generating smallest tier; frozen independent graph tasks may run across every tier.");
        }
        const runs: EvalTaskRun[] = [];
        if (retrievalTasks.length > 0) {
          const total = retrievalTasks.length * RETRIEVAL_ARMS.length * Math.max(1, input.repeats);
          progress.start("retrieval", `Running ${total} counterbalanced retrieval checks for scale ${spec.label}`, { scale: spec.label, current: 0, total });
          runs.push(...runRetrievalTaskSet(db, repoRoot, inventory, retrievalTasks, input.repeats, input.resultLimit, (current) => {
            progress.update("retrieval", `Completed ${current}/${total} retrieval checks for scale ${spec.label}`, { scale: spec.label, current, total });
          }));
          progress.complete("retrieval", `Completed ${total} retrieval checks for scale ${spec.label}`, { scale: spec.label, current: total, total });
        }
        if (graphTasks.length > 0) {
          const total = graphTasks.length * Math.max(1, input.repeats);
          progress.start("graph", `Running ${total} known-target graph checks for scale ${spec.label}`, { scale: spec.label, current: 0, total });
          runs.push(...runGraphTaskSet(db, graphTasks, input.repeats, input.resultLimit, (current) => {
            progress.update("graph", `Completed ${current}/${total} graph checks for scale ${spec.label}`, { scale: spec.label, current, total });
          }));
          progress.complete("graph", `Completed ${total} graph checks for scale ${spec.label}`, { scale: spec.label, current: total, total });
        }
        if (runs.some((run) => run.arm === "rg" && run.error === "ripgrep is not installed")) skipped.push("rg baseline unavailable because ripgrep is not installed.");

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
          retrieval: retrievalAggregates(tasks, runs, input.seed + scaleIndex * 1009),
          graph: graphAggregates(tasks, runs, input.seed + scaleIndex * 2003),
        });
        progress.complete("scale", `Finished scale ${spec.label}: ${retrievalTasks.length} retrieval and ${graphTasks.length} graph tasks`, scaleCounts);
      } finally {
        db.close();
      }
    }

    let freshness: EvalFreshnessResult;
    if (suites.includes("freshness")) {
      progress.start("freshness", "Starting detached-worktree edit/delete freshness probe");
      freshness = runFreshnessEval(repoRoot, input.seed, progress);
      const message = freshness.attempted
        ? `Freshness probe ${freshness.passed ? "passed" : "failed"} in ${formatDuration(freshness.elapsedMs ?? 0)}`
        : `Freshness probe skipped: ${freshness.skippedReason ?? "not attempted"}`;
      if (freshness.attempted && freshness.passed) progress.complete("freshness", message);
      else if (freshness.attempted) progress.error("freshness", message);
      else progress.skipped("freshness", message);
    } else {
      freshness = disabledFreshness();
      progress.skipped("freshness", "Freshness suite disabled");
    }
    if (freshness.skippedReason) skipped.push(`freshness: ${freshness.skippedReason}`);

    progress.start("thresholds", "Checking quality thresholds on eligible task types");
    const hasThresholdEligibleRetrieval = frozenTasks.some((task) => task.suite === "retrieval" && task.contributesToThresholds);
    const hasThresholdEligibleGraph = frozenTasks.some((task) => task.suite === "graph" && task.groundTruth.independent && task.contributesToThresholds);
    if (suites.includes("retrieval") && !hasThresholdEligibleRetrieval) {
      skipped.push("no threshold-eligible retrieval tasks; retrieval quality is informational only.");
    }
    if (suites.includes("graph") && !hasThresholdEligibleGraph) {
      skipped.push("no independently labeled threshold-eligible graph tasks; graph self-consistency is informational only.");
    }
    const thresholdFailures = scales.flatMap((scale) => thresholdFailuresFor(scale, input));
    for (const scale of scales) {
      const executionErrors = new Set(scale.runs.filter((run) => run.error).map((run) => `${run.arm}: ${run.error}`));
      for (const error of executionErrors) thresholdFailures.push(`${scale.label}: evaluation arm error — ${error}`);
    }
    if (suites.includes("freshness") && freshness.attempted && !freshness.passed) thresholdFailures.push("Freshness edit/delete probe failed.");
    if (initialStatus !== gitStatus(repoRoot)) thresholdFailures.push("Target repository worktree changed during evaluation.");
    progress.complete("thresholds", thresholdFailures.length === 0 ? "All applicable thresholds passed" : `${thresholdFailures.length} threshold${thresholdFailures.length === 1 ? "" : "s"} failed`);

    const graphTasks = frozenTasks.filter((task) => task.suite === "graph");
    const graphIndependentGroundTruth = graphTasks.length > 0 && graphTasks.every((task) => task.groundTruth.independent);
    const hasTaskEvidence = taskSuites.length === 0 || scales.some((scale) => scale.runs.length > 0);
    const hasFreshnessEvidence = !suites.includes("freshness") || freshness.attempted || !!freshness.skippedReason;
    const result: EvalResult = {
      version: 2,
      methodology: {
        taskSource,
        taskSetDigest: taskSetDigest(frozenTasks),
        retrievalComparable: true,
        graphIndependentGroundTruth,
        repeatsAreTimingSamples: true,
        scaleTasksFrozen: true,
        notes: methodologyNotes(taskSource, suites, graphTasks.length > 0, graphIndependentGroundTruth),
      },
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
        suites,
        quick: input.quick,
        thresholds: input.thresholds,
      },
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      pass: hasTaskEvidence && hasFreshnessEvidence && thresholdFailures.length === 0,
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

function runRetrievalTaskSet(
  db: Database.Database,
  repoRoot: string,
  inventory: string[],
  tasks: EvalTask[],
  repeats: number,
  limit: number,
  onProgress?: (current: number) => void,
): EvalTaskRun[] {
  const repeatCount = Math.max(1, repeats);
  if (tasks[0]) {
    for (const arm of RETRIEVAL_ARMS) runRetrievalArm(db, repoRoot, inventory, tasks[0], limit, arm);
  }
  const runs: EvalTaskRun[] = [];
  const nextTypeOffset = new Map<string, number>();
  const typeOffsets = tasks.map((task) => {
    const offset = nextTypeOffset.get(task.type) ?? 0;
    nextTypeOffset.set(task.type, offset + 1);
    return offset;
  });
  for (let repeat = 0; repeat < repeatCount; repeat++) {
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex]!;
      const offset = (typeOffsets[taskIndex]! + repeat) % RETRIEVAL_ARMS.length;
      const orderedArms = [...RETRIEVAL_ARMS.slice(offset), ...RETRIEVAL_ARMS.slice(0, offset)];
      for (let order = 0; order < orderedArms.length; order++) {
        const arm = orderedArms[order]!;
        const observation = runRetrievalArm(db, repoRoot, inventory, task, limit, arm);
        runs.push(evaluateObservation(task, arm, observation, limit, repeat, order));
        onProgress?.(runs.length);
      }
    }
  }
  return runs;
}

function runGraphTaskSet(
  db: Database.Database,
  tasks: EvalTask[],
  repeats: number,
  limit: number,
  onProgress?: (current: number) => void,
): EvalTaskRun[] {
  if (tasks[0]) runGraphArm(db, tasks[0], limit);
  const runs: EvalTaskRun[] = [];
  for (let repeat = 0; repeat < Math.max(1, repeats); repeat++) {
    for (const task of tasks) {
      const observation = runGraphArm(db, task, limit);
      runs.push(evaluateObservation(task, "graph", observation, limit, repeat, 0));
      onProgress?.(runs.length);
    }
  }
  return runs;
}

function runRetrievalArm(
  db: Database.Database,
  repoRoot: string,
  inventory: string[],
  task: EvalTask,
  limit: number,
  arm: EvalRetrievalArmName,
): EvalObservation {
  if (arm === "rg") return runRgBaseline(repoRoot, task, limit, inventory);
  const start = performance.now();
  try {
    const weights = arm === "lexical" ? LEXICAL_WEIGHTS : arm === "fts" ? FTS_ONLY_WEIGHTS : undefined;
    const foundPaths: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let toolCalls = 0;
    let bytesServed = 0;
    // ctxSearch ranks chunks. Page through its bounded candidate set so every
    // retrieval arm is scored on up to K unique files, matching rg's unit.
    for (let page = 0; page < 4 && foundPaths.length < limit; page++) {
      const result = ctxSearch(db, task.query, { limit, cursor, snippet: "none", weights });
      toolCalls++;
      bytesServed += Buffer.byteLength(JSON.stringify(result));
      for (const item of result.results) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        foundPaths.push(item.path);
        if (foundPaths.length >= limit) break;
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return {
      foundPaths,
      toolCalls,
      bytesServed,
      elapsedMs: performance.now() - start,
    };
  } catch (error) {
    return failedObservation(start, error);
  }
}

function runGraphArm(db: Database.Database, task: EvalTask, limit: number): EvalObservation {
  const start = performance.now();
  try {
    if (!task.targetPath || (task.type !== "callers" && task.type !== "tests")) throw new Error("graph task requires callers/tests type and targetPath");
    const result = ctxImpact(db, { path: task.targetPath, depth: 1, includeTests: true });
    const paths = task.type === "tests" ? result.affectedTests.map((item) => item.path) : result.callers.map((item) => item.path);
    return {
      foundPaths: [...new Set(paths)].slice(0, limit),
      toolCalls: 1,
      bytesServed: Buffer.byteLength(JSON.stringify(result)),
      elapsedMs: performance.now() - start,
    };
  } catch (error) {
    return failedObservation(start, error);
  }
}

function failedObservation(start: number, error: unknown): EvalObservation {
  return {
    foundPaths: [],
    toolCalls: 1,
    bytesServed: 0,
    elapsedMs: performance.now() - start,
    error: error instanceof Error ? error.message : String(error),
  };
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
    if (!scope) return { enabled: true, attempted: false, passed: false, skippedReason: "temporary worktree scope detection failed" };

    progress.start("freshness-scan", "Scanning temporary worktree for a safe probe file");
    const scanned = scanFiles(worktree);
    const candidates = seededShuffle(scanned.filter(isFreshnessCandidate), seed);
    const selected = candidates.map((file) => ({ file, path: safeFreshnessPath(worktree, file) })).find((item) => item.path !== null);
    if (!selected?.path) return { enabled: true, attempted: false, passed: false, skippedReason: "no safe regular text file for freshness probe" };
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
    return { enabled: true, attempted: true, passed: modifiedVisible && deletedRemoved, modifiedVisible, deletedRemoved, elapsedMs: performance.now() - start };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress.error("freshness", message);
    return { enabled: true, attempted: true, passed: false, elapsedMs: performance.now() - start, error: message };
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
  if (pruned.error || pruned.status !== 0) throw new Error(`failed to prune temporary worktree metadata: ${pruned.error?.message ?? (pruned.stderr ?? "").trim()}`);
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
  if (listed.error || listed.status !== 0) throw new Error(`failed to verify temporary worktree cleanup: ${listed.error?.message ?? "git worktree list failed"}`);
  if ((listed.stdout ?? "").split(/\r?\n/).includes(`worktree ${worktree}`)) {
    throw new Error(`temporary worktree metadata remains registered${removalFailure ? ` after removal failed (${removalFailure})` : ""}: ${worktree}`);
  }
  if (tempFailure) throw new Error(`failed to remove evaluation temp directory: ${tempFailure}`);
}

function normalizeSuites(suites: EvalSuiteName[]): EvalSuiteName[] {
  const normalized = [...new Set(suites)];
  if (normalized.length === 0) throw new Error("at least one evaluation suite is required");
  for (const suite of normalized) {
    if (suite !== "retrieval" && suite !== "graph" && suite !== "freshness") throw new Error(`unknown evaluation suite: ${suite}`);
  }
  return normalized;
}

function resolveScaleSpecs(scales: Array<number | "all">, total: number): Array<{ label: string; requested: number | "all"; count: number }> {
  const byCount = new Map<number, number | "all">();
  for (const scale of scales.length > 0 ? scales : ["all"] as const) {
    const count = scale === "all" ? total : Math.max(1, Math.min(total, Math.floor(scale)));
    if (!byCount.has(count) || scale === "all") byCount.set(count, scale);
  }
  return [...byCount.entries()].sort(([a], [b]) => a - b).map(([count, requested]) => ({
    label: count === total ? "all" : String(count),
    requested,
    count,
  }));
}

function nestedFileOrder(files: ScannedFile[], requiredPaths: Set<string>, seed: number): ScannedFile[] {
  const required: ScannedFile[] = [];
  const remainder: ScannedFile[] = [];
  for (const file of files) (requiredPaths.has(file.path) ? required : remainder).push(file);
  required.sort((a, b) => a.path.localeCompare(b.path));
  return [...required, ...seededShuffle(remainder, seed)];
}

function ensureRequiredPaths(files: ScannedFile[], required: Set<string>): void {
  const known = new Set(files.map((file) => file.path));
  const missing = [...required].filter((path) => !known.has(path));
  if (missing.length > 0) throw new Error(`task paths are missing or not indexable: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5} more)` : ""}`);
}

function thresholdFailuresFor(scale: EvalScaleResult, options: EvalOptions): string[] {
  const failures: string[] = [];
  for (const type of ["locate", "history"] as EvalRetrievalTaskType[]) {
    const eligible = new Set(scale.tasks.filter((task) => task.suite === "retrieval" && task.type === type && task.contributesToThresholds).map((task) => task.id));
    if (eligible.size === 0) continue;
    const runs = scale.runs.filter((run) => run.arm === "full" && eligible.has(run.taskId));
    const metric = aggregateRuns(runs, options.seed + type.length * 313);
    if (metric.recallAtK < options.thresholds.minRecallAtK) failures.push(`${scale.label}/${type}: full recall@${options.resultLimit} ${metric.recallAtK.toFixed(3)} < ${options.thresholds.minRecallAtK.toFixed(3)}`);
    if (metric.mrr < options.thresholds.minMrr) failures.push(`${scale.label}/${type}: full MRR ${metric.mrr.toFixed(3)} < ${options.thresholds.minMrr.toFixed(3)}`);
    if (metric.successRate < options.thresholds.minSuccessRate) failures.push(`${scale.label}/${type}: full success rate ${metric.successRate.toFixed(3)} < ${options.thresholds.minSuccessRate.toFixed(3)}`);
  }
  for (const type of ["callers", "tests"] as EvalGraphTaskType[]) {
    const eligible = new Set(scale.tasks.filter((task) => task.suite === "graph" && task.type === type && task.groundTruth.independent && task.contributesToThresholds).map((task) => task.id));
    if (eligible.size === 0) continue;
    const runs = scale.runs.filter((run) => run.arm === "graph" && eligible.has(run.taskId));
    const metric = aggregateRuns(runs, options.seed + type.length * 419);
    if (metric.recallAtK < options.thresholds.minRecallAtK) failures.push(`${scale.label}/${type}: graph recall@${options.resultLimit} ${metric.recallAtK.toFixed(3)} < ${options.thresholds.minRecallAtK.toFixed(3)}`);
    if (metric.precisionAtK < options.thresholds.minGraphPrecision) failures.push(`${scale.label}/${type}: graph precision@${options.resultLimit} ${metric.precisionAtK.toFixed(3)} < ${options.thresholds.minGraphPrecision.toFixed(3)}`);
    if (metric.successRate < options.thresholds.minSuccessRate) failures.push(`${scale.label}/${type}: graph success rate ${metric.successRate.toFixed(3)} < ${options.thresholds.minSuccessRate.toFixed(3)}`);
  }
  return failures;
}

function methodologyNotes(taskSource: EvalTaskSource, suites: EvalSuiteName[], hasGraph: boolean, graphIndependent: boolean): string[] {
  const notes: string[] = [];
  const hasTaskSuite = suites.includes("retrieval") || suites.includes("graph");
  if (suites.includes("retrieval")) {
    notes.push(
      "Retrieval arms receive identical natural-language queries and the same selected file inventory; chunk-ranked CodeLens pages are deduplicated to the same file-level top-K unit as rg, and the lexical ablation removes only graph weight before proportionally renormalizing the remaining default weights.",
      "The rg arm is a deterministic OR-term file-match heuristic with path-term tie-breaking; it is not a native ranked-search system.",
      "Retrieval arm order is deterministically counterbalanced and one warmup per arm is discarded before timing.",
      "Latency is end-to-end and environment-specific; rg measurements include process startup while CodeLens arms run in-process.",
    );
  }
  if (hasTaskSuite) {
    notes.push(
      "Scale tiers are nested and reuse one fixed task set; larger tiers add distractor files rather than changing labels.",
      "Repeats are timing samples; unique tasks determine quality metrics and confidence intervals.",
      "Low-confidence tasks may be reported but only tasks marked contributesToThresholds affect pass/fail.",
    );
  }
  if (taskSource.kind === "automatic-self-evaluation") notes.push("Automatic tasks are a self-evaluation and are not independent benchmark ground truth; automatic graph self-consistency runs only at the label-generating smallest tier.");
  if (hasGraph) notes.push(graphIndependent
    ? "Graph labels are declared independent by the frozen task file."
    : "Graph labels come from the evaluated CodeLens index and measure self-consistency only.");
  if (suites.includes("freshness")) notes.push("Freshness mutations run only in a detached temporary worktree and cleanup is verified.");
  return notes;
}

function taskSetDigest(tasks: EvalTask[]): string {
  const canonical = tasks.map((task) => ({
    id: task.id,
    suite: task.suite,
    type: task.type,
    query: task.query,
    targetPath: task.targetPath,
    expectedPaths: task.expectedPaths,
    confidence: task.confidence,
    contributesToThresholds: task.contributesToThresholds,
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
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

function disabledFreshness(): EvalFreshnessResult { return { enabled: false, attempted: false, passed: true }; }
function databaseBytes(path: string): number { try { return statSync(path).size; } catch { return 0; } }
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
function gitStatus(repoRoot: string): string {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z"], { cwd: repoRoot, encoding: "utf-8" });
  return result.status === 0 ? result.stdout ?? "" : "";
}
