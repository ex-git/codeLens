import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateRuns, evaluateObservation } from "../src/eval/report.js";
import { defaultEvalOptions, quickEvalOptions, runRepositoryEval } from "../src/eval/evaluator.js";
import type { EvalProgressEvent, EvalTask } from "../src/eval/types.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "codelens-eval-test-"));
  cleanup.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "eval@example.test"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Eval Test"], { cwd: repo });
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  mkdirSync(join(repo, "src", "routes"), { recursive: true });
  mkdirSync(join(repo, "src", "widgets"), { recursive: true });
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "session.ts"), `export function validateSessionToken(token: string): boolean {\n  return token.length > 0;\n}\n`);
  writeFileSync(join(repo, "src", "routes", "login.ts"), `import { validateSessionToken } from "../auth/session.js";\nexport function loginRoute(token: string): boolean {\n  return validateSessionToken(token);\n}\n`);
  writeFileSync(join(repo, "tests", "session.test.ts"), `import { validateSessionToken } from "../src/auth/session.js";\ntest("valid session", () => validateSessionToken("x"));\n`);
  writeFileSync(join(repo, "src", "widgets", "index.ts"), `export default () => "widget";\n`);
  writeFileSync(join(repo, "src", "useWidget.ts"), `import widget from "./widgets/index.js";\nexport const renderedWidget = widget();\n`);
  writeFileSync(join(repo, "src", "widgets", "index.test.ts"), `import widget from "./index.js";\ntest("widget", () => widget());\n`);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "add session validation flow"], { cwd: repo });
  writeFileSync(join(repo, "src", "routes", "logout.ts"), `import { validateSessionToken } from "../auth/session.js";\nexport const logoutRoute = validateSessionToken;\n`);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "support logout session checks"], { cwd: repo });
  return repo;
}

function gitStatus(repo: string): string {
  return execFileSync("git", ["status", "--porcelain=v1"], { cwd: repo, encoding: "utf-8" });
}

function gitWorktrees(repo: string): string {
  return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf-8" });
}

describe("repository evaluator", () => {
  it("keeps quick mode bounded while full defaults retain all-file coverage", () => {
    expect(quickEvalOptions("/tmp/repo").scales).toEqual([500]);
    expect(defaultEvalOptions("/tmp/repo").scales).toEqual([500, 2000, "all"]);
  });

  it("runs deterministically, writes reports, and leaves the target unchanged", () => {
    const repo = fixtureRepo();
    const outputA = mkdtempSync(join(tmpdir(), "codelens-eval-output-a-"));
    const outputB = mkdtempSync(join(tmpdir(), "codelens-eval-output-b-"));
    cleanup.push(outputA, outputB);
    const before = gitStatus(repo);
    const progress: EvalProgressEvent[] = [];
    const optionsA = {
      ...quickEvalOptions(repo),
      outputDir: outputA,
      taskLimit: 12,
      thresholds: { minRecallAtK: 0, minMrr: 0, minSuccessRate: 0 },
      onProgress: (event: EvalProgressEvent) => progress.push(event),
    };
    const first = runRepositoryEval(optionsA);
    const second = runRepositoryEval({ ...optionsA, repoRoot: join(repo, "src"), outputDir: outputB });

    expect(first.scales).toHaveLength(1);
    expect(first.scales[0]!.tasks.length).toBeGreaterThan(0);
    expect(second.repository.root).toBe(first.repository.root);
    expect(first.scales[0]!.tasks.map((task) => task.id)).toEqual(second.scales[0]!.tasks.map((task) => task.id));
    expect(first.scales[0]!.aggregates.full?.taskCount).toBeGreaterThan(0);
    expect(first.scales[0]!.aggregates.lexical?.taskCount).toBeGreaterThan(0);
    expect(first.scales[0]!.aggregates.fts?.taskCount).toBeGreaterThan(0);
    expect(first.scales[0]!.aggregates.rg?.taskCount).toBeGreaterThan(0);
    expect(existsSync(first.artifacts.resultsJson)).toBe(true);
    expect(existsSync(first.artifacts.reportMarkdown)).toBe(true);
    expect(existsSync(first.artifacts.tasksJson)).toBe(true);
    expect(JSON.parse(readFileSync(first.artifacts.resultsJson, "utf-8")).version).toBe(1);
    expect(readFileSync(first.artifacts.reportMarkdown, "utf-8")).toContain("CodeLens Repository Evaluation");
    expect(gitStatus(repo)).toBe(before);
    expect(progress.some((event) => event.phase === "scan" && event.status === "complete")).toBe(true);
    expect(progress.some((event) => event.phase === "index" && event.status === "progress")).toBe(true);
    expect(progress.some((event) => event.phase === "retrieval" && event.status === "complete")).toBe(true);
    expect(progress.some((event) => event.phase === "reports" && event.status === "complete")).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: "evaluation", status: "complete" });
  });

  it("uses module paths for relationship tasks with anonymous index exports", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-module-tasks-"));
    cleanup.push(output);
    const result = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: output,
      taskLimit: 100,
      thresholds: { minRecallAtK: 0, minMrr: 0, minSuccessRate: 0 },
    });
    const scale = result.scales[0]!;
    const relationshipTasks = scale.tasks.filter((task) =>
      (task.type === "callers" || task.type === "tests") && task.sourcePath === "src/widgets/index.ts",
    );
    expect(relationshipTasks.map((task) => task.type).sort()).toEqual(["callers", "tests"]);
    expect(relationshipTasks.every((task) => task.symbol === undefined)).toBe(true);
    expect(relationshipTasks.map((task) => task.query).sort()).toEqual(["callers of widgets", "tests for widgets"]);
    expect(relationshipTasks.every((task) => task.origin.startsWith("direct file "))).toBe(true);
    const taskIds = new Set(relationshipTasks.map((task) => task.id));
    const fullRuns = scale.runs.filter((run) => run.arm === "full" && taskIds.has(run.taskId));
    expect(fullRuns).toHaveLength(2);
    expect(fullRuns.every((run) => run.success)).toBe(true);
  });

  it("supports scale tiers, repeats, ablations, and threshold failures", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-scales-"));
    cleanup.push(output);
    const result = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: output,
      taskLimit: 8,
      repeats: 2,
      scales: [2, "all"],
      thresholds: { minRecallAtK: 1.1, minMrr: 1.1, minSuccessRate: 1.1 },
    });
    expect(result.scales.map((scale) => scale.label)).toEqual(["2", "all"]);
    expect(result.scales.reduce((total, scale) => total + scale.tasks.length, 0)).toBeLessThanOrEqual(8);
    for (const scale of result.scales) {
      expect(scale.runs.length).toBe(scale.tasks.length * 4 * 2);
      expect(scale.aggregates.full).toBeDefined();
      expect(scale.aggregates.lexical).toBeDefined();
      expect(scale.aggregates.fts).toBeDefined();
      expect(scale.aggregates.rg).toBeDefined();
    }
    expect(result.pass).toBe(false);
    expect(result.thresholdFailures.length).toBeGreaterThan(0);
  });

  it("runs edit/delete freshness probes in a temporary worktree", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-freshness-"));
    cleanup.push(output);
    const before = gitStatus(repo);
    const worktreesBefore = gitWorktrees(repo);
    const result = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: output,
      taskLimit: 4,
      freshness: true,
      thresholds: { minRecallAtK: 0, minMrr: 0, minSuccessRate: 0 },
    });
    expect(result.freshness.attempted).toBe(true);
    expect(result.freshness.modifiedVisible).toBe(true);
    expect(result.freshness.deletedRemoved).toBe(true);
    expect(result.freshness.passed).toBe(true);
    expect(gitStatus(repo)).toBe(before);
    expect(gitWorktrees(repo)).toBe(worktreesBefore);
  });

  it("never mutates a tracked symlink during freshness evaluation", () => {
    const repo = mkdtempSync(join(tmpdir(), "codelens-eval-symlink-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "codelens-eval-symlink-target-"));
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-symlink-"));
    cleanup.push(repo, outside, output);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "eval@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Eval Test"], { cwd: repo });
    const outsideFile = join(outside, "outside.ts");
    const original = "export function externalSessionValidator(): boolean { return true; }\n";
    writeFileSync(outsideFile, original);
    symlinkSync(outsideFile, join(repo, "linked.ts"));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "add linked source"], { cwd: repo });

    const result = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: output,
      taskLimit: 2,
      freshness: true,
      thresholds: { minRecallAtK: 0, minMrr: 0, minSuccessRate: 0 },
    });
    expect(result.freshness.attempted).toBe(false);
    expect(result.freshness.skippedReason).toMatch(/no safe regular text file/);
    expect(readFileSync(outsideFile, "utf-8")).toBe(original);
    expect(gitWorktrees(repo).match(/^worktree /gm)).toHaveLength(1);
  });

  it("calculates recall, reciprocal rank, precision, and aggregates", () => {
    const task: EvalTask = {
      id: "task",
      type: "locate",
      query: "session validation",
      expectedPaths: ["src/auth.ts", "src/session.ts"],
      confidence: 1,
      origin: "test",
    };
    const run = evaluateObservation(task, "full", {
      foundPaths: ["src/other.ts", "src/session.ts"],
      toolCalls: 1,
      bytesServed: 100,
      bytesRead: 0,
      elapsedMs: 10,
    }, 5);
    expect(run.recallAtK).toBe(0.5);
    expect(run.reciprocalRank).toBe(0.5);
    expect(run.precisionAtK).toBe(0.2);
    expect(run.success).toBe(true);
    const aggregate = aggregateRuns([run]);
    expect(aggregate.recallAtK).toBe(0.5);
    expect(aggregate.mrr).toBe(0.5);
    expect(aggregate.totalBytesServed).toBe(100);
  });

  it("reports the active phase when evaluation fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "codelens-eval-not-git-"));
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-"));
    const progress: EvalProgressEvent[] = [];
    cleanup.push(dir, output);
    expect(() => runRepositoryEval({
      ...quickEvalOptions(dir),
      outputDir: output,
      onProgress: (event) => progress.push(event),
    })).toThrow(/evaluation failed during repository: not a Git repository/);
    expect(progress.at(-1)).toMatchObject({ phase: "repository", status: "error" });
  });

  it("ignores exceptions thrown by progress callbacks", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-progress-callback-"));
    cleanup.push(output);
    expect(() => runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: output,
      taskLimit: 1,
      thresholds: { minRecallAtK: 0, minMrr: 0, minSuccessRate: 0 },
      onProgress: () => { throw new Error("progress sink failed"); },
    })).not.toThrow();
  });
});
