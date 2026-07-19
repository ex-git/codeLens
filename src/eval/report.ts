import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EvalAggregate,
  EvalArmName,
  EvalArtifacts,
  EvalObservation,
  EvalResult,
  EvalTask,
  EvalTaskRun,
} from "./types.js";

export function evaluateObservation(
  task: EvalTask,
  arm: EvalArmName,
  observation: EvalObservation,
  limit: number,
): EvalTaskRun {
  const foundPaths = observation.foundPaths.slice(0, limit);
  const expected = new Set(task.expectedPaths);
  const hitCount = foundPaths.filter((path) => expected.has(path)).length;
  const firstRank = foundPaths.findIndex((path) => expected.has(path));
  return {
    taskId: task.id,
    arm,
    foundPaths,
    recallAtK: expected.size === 0 ? 0 : hitCount / expected.size,
    reciprocalRank: firstRank < 0 ? 0 : 1 / (firstRank + 1),
    precisionAtK: limit <= 0 ? 0 : hitCount / limit,
    success: hitCount > 0,
    toolCalls: observation.toolCalls,
    bytesServed: observation.bytesServed,
    bytesRead: observation.bytesRead,
    elapsedMs: observation.elapsedMs,
    ...(observation.error ? { error: observation.error } : {}),
  };
}

export function aggregateRuns(runs: EvalTaskRun[]): EvalAggregate {
  if (runs.length === 0) {
    return {
      taskCount: 0,
      successRate: 0,
      recallAtK: 0,
      mrr: 0,
      precisionAtK: 0,
      medianElapsedMs: 0,
      p95ElapsedMs: 0,
      totalToolCalls: 0,
      totalBytesServed: 0,
      totalBytesRead: 0,
    };
  }
  const elapsed = runs.map((run) => run.elapsedMs);
  return {
    taskCount: runs.length,
    successRate: average(runs.map((run) => run.success ? 1 : 0)),
    recallAtK: average(runs.map((run) => run.recallAtK)),
    mrr: average(runs.map((run) => run.reciprocalRank)),
    precisionAtK: average(runs.map((run) => run.precisionAtK)),
    medianElapsedMs: percentile(elapsed, 50),
    p95ElapsedMs: percentile(elapsed, 95),
    totalToolCalls: runs.reduce((sum, run) => sum + run.toolCalls, 0),
    totalBytesServed: runs.reduce((sum, run) => sum + run.bytesServed, 0),
    totalBytesRead: runs.reduce((sum, run) => sum + run.bytesRead, 0),
  };
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
  writeFileSync(result.artifacts.tasksJson, JSON.stringify({ seed: result.options.seed, tasks }, null, 2) + "\n");
  writeFileSync(result.artifacts.resultsJson, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(result.artifacts.reportMarkdown, markdownReport(result));
}

export function consoleSummary(result: EvalResult): string {
  const lines = [
    "CodeLens Repository Evaluation",
    "",
    `Repository: ${result.repository.root}`,
    `Commit: ${result.repository.headSha}`,
    `Files: ${result.repository.totalFiles}`,
    `Result: ${result.pass ? "PASS" : "FAIL"}`,
  ];
  for (const scale of result.scales) {
    lines.push("", `Scale: ${scale.label} (${scale.indexedFiles} files, ${scale.tasks.length} tasks)`);
    lines.push("  Arm       Recall@K   MRR      Success   p50 latency   Served");
    for (const arm of ["full", "lexical", "fts", "rg"] as EvalArmName[]) {
      const metric = scale.aggregates[arm];
      if (!metric) continue;
      lines.push(
        `  ${arm.padEnd(10)} ${pct(metric.recallAtK).padStart(8)}   ${metric.mrr.toFixed(3).padStart(5)}   ${pct(metric.successRate).padStart(8)}   ${`${metric.medianElapsedMs.toFixed(1)}ms`.padStart(11)}   ${formatBytes(metric.totalBytesServed).padStart(7)}`,
      );
    }
  }
  if (result.freshness.enabled) {
    lines.push("", `Freshness: ${result.freshness.passed ? "PASS" : result.freshness.attempted ? "FAIL" : "SKIPPED"}`);
  }
  if (result.thresholdFailures.length > 0) {
    lines.push("", "Threshold failures:", ...result.thresholdFailures.map((failure) => `  - ${failure}`));
  }
  if (result.skipped.length > 0) {
    lines.push("", "Skipped/limited coverage:", ...result.skipped.map((item) => `  - ${item}`));
  }
  lines.push("", `Reports: ${result.artifacts.directory}`);
  return lines.join("\n");
}

function markdownReport(result: EvalResult): string {
  const lines = [
    "# CodeLens Repository Evaluation",
    "",
    `- **Repository:** \`${result.repository.root}\``,
    `- **Commit:** \`${result.repository.headSha}\``,
    `- **Files:** ${result.repository.totalFiles}`,
    `- **Seed:** ${result.options.seed}`,
    `- **Repeats:** ${result.options.repeats}`,
    `- **Result:** **${result.pass ? "PASS" : "FAIL"}**`,
    "",
  ];
  for (const scale of result.scales) {
    lines.push(`## Scale: ${scale.label}`, "");
    lines.push(`Indexed ${scale.indexedFiles} files and ${scale.totalChunks} chunks in ${scale.indexMs.toFixed(1)} ms.`, "");
    lines.push("| Arm | Tasks | Recall@K | MRR | Precision@K | Success | p50 | p95 | Served | Read |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const arm of ["full", "lexical", "fts", "rg"] as EvalArmName[]) {
      const metric = scale.aggregates[arm];
      if (!metric) continue;
      lines.push(`| ${arm} | ${metric.taskCount} | ${pct(metric.recallAtK)} | ${metric.mrr.toFixed(3)} | ${pct(metric.precisionAtK)} | ${pct(metric.successRate)} | ${metric.medianElapsedMs.toFixed(1)} ms | ${metric.p95ElapsedMs.toFixed(1)} ms | ${formatBytes(metric.totalBytesServed)} | ${formatBytes(metric.totalBytesRead)} |`);
    }
    lines.push("");
  }
  lines.push("## Freshness", "", result.freshness.enabled
    ? (result.freshness.attempted ? `**${result.freshness.passed ? "PASS" : "FAIL"}** — edit visible: ${result.freshness.modifiedVisible ?? false}; deletion removed: ${result.freshness.deletedRemoved ?? false}.` : `Skipped: ${result.freshness.skippedReason ?? "not attempted"}.`)
    : "Disabled.", "");
  if (result.thresholdFailures.length > 0) lines.push("## Threshold Failures", "", ...result.thresholdFailures.map((failure) => `- ${failure}`), "");
  if (result.skipped.length > 0) lines.push("## Skipped or Limited Coverage", "", ...result.skipped.map((item) => `- ${item}`), "");
  lines.push("## Limitations", "", "This deterministic suite evaluates retrieval, graph surfacing, freshness, and efficiency. It does not run or grade an LLM and automatically generated labels may not capture every valid implementation location.", "");
  return lines.join("\n") + "\n";
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

function pct(value: number): string { return `${(value * 100).toFixed(1)}%`; }

function formatBytes(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}
