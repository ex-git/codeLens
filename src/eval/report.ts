import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EvalAggregate,
  EvalArmName,
  EvalArtifacts,
  EvalGraphTaskType,
  EvalObservation,
  EvalResult,
  EvalRetrievalArmName,
  EvalRetrievalTaskType,
  EvalScaleResult,
  EvalTask,
  EvalTaskRun,
} from "./types.js";

const RETRIEVAL_ARMS: EvalRetrievalArmName[] = ["full", "lexical", "fts", "rg"];
const BOOTSTRAP_SAMPLES = 500;

export function evaluateObservation(
  task: EvalTask,
  arm: EvalArmName,
  observation: EvalObservation,
  limit: number,
  repeat = 0,
  order = 0,
): EvalTaskRun {
  const foundPaths = [...new Set(observation.foundPaths)].slice(0, limit);
  const expected = new Set(task.expectedPaths);
  const hitCount = foundPaths.filter((path) => expected.has(path)).length;
  const firstRank = foundPaths.findIndex((path) => expected.has(path));
  return {
    taskId: task.id,
    arm,
    repeat,
    order,
    foundPaths,
    recallAtK: expected.size === 0 ? 0 : hitCount / expected.size,
    reciprocalRank: firstRank < 0 ? 0 : 1 / (firstRank + 1),
    precisionAtK: arm === "graph"
      ? (foundPaths.length === 0 ? 0 : hitCount / foundPaths.length)
      : (limit <= 0 ? 0 : hitCount / limit),
    success: hitCount > 0,
    toolCalls: observation.toolCalls,
    bytesServed: observation.bytesServed,
    elapsedMs: observation.elapsedMs,
    ...(observation.error ? { error: observation.error } : {}),
  };
}

export function aggregateRuns(runs: EvalTaskRun[], seed = 42): EvalAggregate {
  if (runs.length === 0) return emptyAggregate();
  const byTask = new Map<string, EvalTaskRun[]>();
  for (const run of runs) {
    const taskRuns = byTask.get(run.taskId) ?? [];
    taskRuns.push(run);
    byTask.set(run.taskId, taskRuns);
  }
  const taskMetrics = [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, taskRuns]) => ({
    successRate: average(taskRuns.map((run) => run.success ? 1 : 0)),
    recallAtK: average(taskRuns.map((run) => run.recallAtK)),
    mrr: average(taskRuns.map((run) => run.reciprocalRank)),
    precisionAtK: average(taskRuns.map((run) => run.precisionAtK)),
  }));
  const elapsed = runs.map((run) => run.elapsedMs);
  return {
    taskCount: taskMetrics.length,
    sampleCount: runs.length,
    successRate: average(taskMetrics.map((metric) => metric.successRate)),
    recallAtK: average(taskMetrics.map((metric) => metric.recallAtK)),
    mrr: average(taskMetrics.map((metric) => metric.mrr)),
    precisionAtK: average(taskMetrics.map((metric) => metric.precisionAtK)),
    confidence95: {
      successRate: bootstrapInterval(taskMetrics.map((metric) => metric.successRate), seed + 11),
      recallAtK: bootstrapInterval(taskMetrics.map((metric) => metric.recallAtK), seed + 23),
      mrr: bootstrapInterval(taskMetrics.map((metric) => metric.mrr), seed + 37),
      precisionAtK: bootstrapInterval(taskMetrics.map((metric) => metric.precisionAtK), seed + 41),
    },
    medianElapsedMs: percentile(elapsed, 50),
    p95ElapsedMs: percentile(elapsed, 95),
    totalToolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    totalBytesServed: runs.reduce((sum, run) => sum + run.bytesServed, 0),
  };
}

export function retrievalAggregates(
  tasks: EvalTask[],
  runs: EvalTaskRun[],
  seed: number,
): EvalScaleResult["retrieval"] {
  const output: EvalScaleResult["retrieval"] = {};
  for (const type of ["locate", "history"] as EvalRetrievalTaskType[]) {
    const ids = new Set(tasks.filter((task) => task.suite === "retrieval" && task.type === type).map((task) => task.id));
    if (ids.size === 0) continue;
    const arms: Partial<Record<EvalRetrievalArmName, EvalAggregate>> = {};
    for (let armIndex = 0; armIndex < RETRIEVAL_ARMS.length; armIndex++) {
      const arm = RETRIEVAL_ARMS[armIndex]!;
      const armRuns = runs.filter((run) => run.arm === arm && ids.has(run.taskId));
      if (armRuns.length > 0) arms[arm] = aggregateRuns(armRuns, seed + armIndex * 101 + type.length);
    }
    output[type] = arms;
  }
  return output;
}

export function graphAggregates(tasks: EvalTask[], runs: EvalTaskRun[], seed: number): EvalScaleResult["graph"] {
  const output: EvalScaleResult["graph"] = {};
  for (const type of ["callers", "tests"] as EvalGraphTaskType[]) {
    const ids = new Set(tasks.filter((task) => task.suite === "graph" && task.type === type).map((task) => task.id));
    const graphRuns = runs.filter((run) => run.arm === "graph" && ids.has(run.taskId));
    if (graphRuns.length > 0) output[type] = aggregateRuns(graphRuns, seed + type.length * 211);
  }
  return output;
}

export function artifactPaths(directory: string): EvalArtifacts {
  return {
    directory,
    resultsJson: join(directory, "results.json"),
    reportMarkdown: join(directory, "report.md"),
    tasksJson: join(directory, "tasks.json"),
  };
}

export function writeEvalArtifacts(result: EvalResult): void {
  mkdirSync(result.artifacts.directory, { recursive: true });
  const tasks = [...new Map(result.scales.flatMap((scale) => scale.tasks).map((task) => [task.id, task])).values()];
  writeFileSync(result.artifacts.tasksJson, JSON.stringify({
    version: 1,
    source: result.methodology.taskSource.source,
    independentGroundTruth: result.methodology.taskSource.independentGroundTruth,
    taskSetDigest: result.methodology.taskSetDigest,
    tasks,
  }, null, 2) + "\n");
  writeFileSync(result.artifacts.resultsJson, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(result.artifacts.reportMarkdown, markdownReport(result));
}

export function consoleSummary(result: EvalResult): string {
  const source = result.methodology.taskSource;
  const lines = [
    "CodeLens Repository Evaluation v2",
    "",
    `Repository: ${result.repository.root}`,
    `Commit: ${result.repository.headSha}`,
    `Files: ${result.repository.totalFiles}`,
    `Task source: ${source.kind === "none" ? "none (freshness-only)" : `${source.kind}${source.independentGroundTruth ? " (independent)" : " (self-evaluation; not independent)"}`}`,
    `Task-set digest: ${result.methodology.taskSetDigest.slice(0, 16)}`,
    `Result: ${result.pass ? "PASS" : "FAIL"}`,
  ];
  for (const scale of result.scales) {
    lines.push("", `Scale: ${scale.label} (${scale.indexedFiles} files, ${scale.tasks.length} frozen tasks)`);
    appendConsoleRetrieval(lines, scale);
    appendConsoleGraph(lines, scale, result.methodology.graphIndependentGroundTruth);
  }
  if (result.freshness.enabled) {
    lines.push("", `Freshness: ${result.freshness.passed ? "PASS" : result.freshness.attempted ? "FAIL" : "SKIPPED"}`);
  }
  if (result.thresholdFailures.length > 0) lines.push("", "Threshold failures:", ...result.thresholdFailures.map((failure) => `  - ${failure}`));
  if (result.skipped.length > 0) lines.push("", "Skipped/limited coverage:", ...result.skipped.map((item) => `  - ${item}`));
  lines.push("", `Reports: ${result.artifacts.directory}`);
  return lines.join("\n");
}

function appendConsoleRetrieval(lines: string[], scale: EvalScaleResult): void {
  for (const type of ["locate", "history"] as EvalRetrievalTaskType[]) {
    const metrics = scale.retrieval[type];
    if (!metrics) continue;
    lines.push("", `  Retrieval — ${type} (identical query/corpus per arm)`);
    lines.push("    Arm       Recall@K   MRR      Success   Tasks/Runs   p50");
    for (const arm of RETRIEVAL_ARMS) {
      const metric = metrics[arm];
      if (!metric) continue;
      lines.push(`    ${arm.padEnd(10)} ${pct(metric.recallAtK).padStart(8)}   ${metric.mrr.toFixed(3).padStart(5)}   ${pct(metric.successRate).padStart(8)}   ${`${metric.taskCount}/${metric.sampleCount}`.padStart(10)}   ${`${metric.medianElapsedMs.toFixed(1)}ms`.padStart(8)}`);
    }
  }
}

function appendConsoleGraph(lines: string[], scale: EvalScaleResult, independent: boolean): void {
  const entries = (["callers", "tests"] as EvalGraphTaskType[]).map((type) => [type, scale.graph[type]] as const).filter((entry) => !!entry[1]);
  if (entries.length === 0) return;
  lines.push("", `  Graph ${independent ? "accuracy" : "self-consistency (not independent ground truth)"}`);
  for (const [type, metric] of entries) lines.push(`    ${type.padEnd(8)} recall=${pct(metric!.recallAtK)} precision=${pct(metric!.precisionAtK)} success=${pct(metric!.successRate)} tasks/runs=${metric!.taskCount}/${metric!.sampleCount}`);
}

function markdownReport(result: EvalResult): string {
  const source = result.methodology.taskSource;
  const lines = [
    "# CodeLens Repository Evaluation v2",
    "",
    `- **Repository:** \`${result.repository.root}\``,
    `- **Commit:** \`${result.repository.headSha}\``,
    `- **Files:** ${result.repository.totalFiles}`,
    `- **Task source:** ${source.kind}${source.source ? ` (\`${source.source}\`)` : ""}`,
    `- **Independent ground truth:** ${source.kind === "none" ? "not applicable" : source.independentGroundTruth ? "yes" : "no"}`,
    `- **Task-set SHA-256:** \`${result.methodology.taskSetDigest}\``,
    `- **Result:** **${result.pass ? "PASS" : "FAIL"}**`,
    "",
    source.kind === "none"
      ? "No retrieval or graph tasks were run; this report contains freshness evidence only."
      : source.independentGroundTruth
        ? "Frozen task labels are declared independent of the evaluated CodeLens index."
        : "**Methodology warning:** automatically generated tasks are a CodeLens self-evaluation. Graph labels come from the evaluated index and must not support independent superiority claims.",
    "",
  ];
  for (const scale of result.scales) {
    lines.push(`## Scale: ${scale.label}`, "", `Indexed ${scale.indexedFiles} files and ${scale.totalChunks} chunks in ${scale.indexMs.toFixed(1)} ms. The same fixed task set and a nested corpus are used across tiers.`, "");
    for (const type of ["locate", "history"] as EvalRetrievalTaskType[]) {
      const metrics = scale.retrieval[type];
      if (!metrics) continue;
      lines.push(`### Retrieval: ${type}`, "", "All arms receive the same query and selected file inventory.", "");
      lines.push("| Arm | Tasks | Timing samples | Recall@K (95% CI) | MRR (95% CI) | Precision@K (95% CI) | Success (95% CI) | p50 | p95 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
      for (const arm of RETRIEVAL_ARMS) {
        const metric = metrics[arm];
        if (!metric) continue;
        lines.push(`| ${arm} | ${metric.taskCount} | ${metric.sampleCount} | ${pct(metric.recallAtK)} ${ci(metric.confidence95.recallAtK)} | ${metric.mrr.toFixed(3)} ${ci(metric.confidence95.mrr)} | ${pct(metric.precisionAtK)} ${ci(metric.confidence95.precisionAtK)} | ${pct(metric.successRate)} ${ci(metric.confidence95.successRate)} | ${metric.medianElapsedMs.toFixed(1)} ms | ${metric.p95ElapsedMs.toFixed(1)} ms |`);
      }
      lines.push("");
    }
    const graphEntries = (["callers", "tests"] as EvalGraphTaskType[]).map((type) => [type, scale.graph[type]] as const).filter((entry) => !!entry[1]);
    if (graphEntries.length > 0) {
      lines.push(`### Graph ${result.methodology.graphIndependentGroundTruth ? "accuracy" : "self-consistency"}`, "");
      if (!result.methodology.graphIndependentGroundTruth) lines.push("These labels were generated from the same CodeLens graph and are not independent accuracy evidence.", "");
      lines.push("| Type | Tasks | Timing samples | Recall@K (95% CI) | Precision@K (95% CI) | Success (95% CI) | p50 |", "|---|---:|---:|---:|---:|---:|---:|");
      for (const [type, metric] of graphEntries) lines.push(`| ${type} | ${metric!.taskCount} | ${metric!.sampleCount} | ${pct(metric!.recallAtK)} ${ci(metric!.confidence95.recallAtK)} | ${pct(metric!.precisionAtK)} ${ci(metric!.confidence95.precisionAtK)} | ${pct(metric!.successRate)} ${ci(metric!.confidence95.successRate)} | ${metric!.medianElapsedMs.toFixed(1)} ms |`);
      lines.push("");
    }
  }
  lines.push("## Freshness", "", result.freshness.enabled
    ? (result.freshness.attempted ? `**${result.freshness.passed ? "PASS" : "FAIL"}** — edit visible: ${result.freshness.modifiedVisible ?? false}; deletion removed: ${result.freshness.deletedRemoved ?? false}.` : `Skipped: ${result.freshness.skippedReason ?? "not attempted"}.`)
    : "Disabled.", "");
  if (result.thresholdFailures.length > 0) lines.push("## Threshold Failures", "", ...result.thresholdFailures.map((failure) => `- ${failure}`), "");
  if (result.skipped.length > 0) lines.push("## Skipped or Limited Coverage", "", ...result.skipped.map((item) => `- ${item}`), "");
  const methodologyFooter = result.scales.length > 0
    ? "Repeats are timing samples; task counts and confidence intervals use unique tasks. This suite does not run or grade an LLM."
    : "This suite does not run or grade an LLM.";
  lines.push("## Methodology", "", ...result.methodology.notes.map((note) => `- ${note}`), "", methodologyFooter, "");
  return lines.join("\n") + "\n";
}

function bootstrapInterval(values: number[], seed: number): { low: number; high: number } {
  if (values.length === 0) return { low: 0, high: 0 };
  if (values.length === 1) return { low: values[0]!, high: values[0]! };
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const means: number[] = [];
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(next() * values.length)]!;
    means.push(sum / values.length);
  }
  return { low: percentile(means, 2.5), high: percentile(means, 97.5) };
}

function emptyAggregate(): EvalAggregate {
  const zero = { low: 0, high: 0 };
  return {
    taskCount: 0,
    sampleCount: 0,
    successRate: 0,
    recallAtK: 0,
    mrr: 0,
    precisionAtK: 0,
    confidence95: { successRate: zero, recallAtK: zero, mrr: zero, precisionAtK: zero },
    medianElapsedMs: 0,
    p95ElapsedMs: 0,
    totalToolCalls: 0,
    totalBytesServed: 0,
  };
}

function average(values: number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[index] ?? 0;
}
function pct(value: number): string { return `${(value * 100).toFixed(1)}%`; }
function ci(value: { low: number; high: number }): string { return `[${value.low.toFixed(3)}, ${value.high.toFixed(3)}]`; }
