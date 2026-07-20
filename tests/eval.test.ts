import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRgBaseline } from "../src/eval/baseline.js";
import { defaultEvalOptions, quickEvalOptions, runRepositoryEval } from "../src/eval/evaluator.js";
import { aggregateRuns, evaluateObservation } from "../src/eval/report.js";
import type { EvalProgressEvent, EvalTask, EvalTaskFile } from "../src/eval/types.js";

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

function frozenTaskFile(overrides: Partial<EvalTaskFile> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "codelens-eval-tasks-"));
  cleanup.push(dir);
  const path = join(dir, "tasks.json");
  const file: EvalTaskFile = {
    version: 1,
    source: "reviewed fixture",
    independentGroundTruth: true,
    tasks: [
      {
        id: "locate-session",
        suite: "retrieval",
        type: "locate",
        query: "validate session token",
        expectedPaths: ["src/auth/session.ts"],
        confidence: 1,
      },
      {
        id: "callers-session",
        suite: "graph",
        type: "callers",
        query: "callers of auth session",
        targetPath: "src/auth/session.ts",
        expectedPaths: ["src/routes/login.ts", "src/routes/logout.ts", "tests/session.test.ts"],
        confidence: 1,
      },
    ],
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(file, null, 2));
  return path;
}

function zeroThresholds() {
  return { minRecallAtK: 0, minMrr: 0, minSuccessRate: 0, minGraphPrecision: 0 };
}

function metricTask(): EvalTask {
  return {
    id: "task",
    suite: "retrieval",
    type: "locate",
    query: "session validation",
    expectedPaths: ["src/auth.ts", "src/session.ts"],
    confidence: 1,
    contributesToThresholds: true,
    origin: "test",
    groundTruth: { kind: "frozen-reviewed", independent: true },
  };
}

describe("repository evaluator v2", () => {
  it("keeps quick mode bounded and declares suite defaults", () => {
    expect(quickEvalOptions("/tmp/repo")).toMatchObject({ scales: [500], suites: ["retrieval", "graph"] });
    expect(defaultEvalOptions("/tmp/repo")).toMatchObject({ scales: [500, 2000, "all"], suites: ["retrieval", "graph", "freshness"] });
  });

  it("runs automatic self-evaluation deterministically and writes v2 artifacts", () => {
    const repo = fixtureRepo();
    const outputA = mkdtempSync(join(tmpdir(), "codelens-eval-output-a-"));
    const outputB = mkdtempSync(join(tmpdir(), "codelens-eval-output-b-"));
    cleanup.push(outputA, outputB);
    const before = gitStatus(repo);
    const progress: EvalProgressEvent[] = [];
    const options = {
      ...quickEvalOptions(repo),
      outputDir: outputA,
      taskLimit: 12,
      thresholds: zeroThresholds(),
      onProgress: (event: EvalProgressEvent) => progress.push(event),
    };
    const first = runRepositoryEval(options);
    const second = runRepositoryEval({ ...options, repoRoot: join(repo, "src"), outputDir: outputB });

    expect(first.version).toBe(2);
    expect(first.methodology.taskSource).toEqual({ kind: "automatic-self-evaluation", independentGroundTruth: false });
    expect(first.methodology.retrievalComparable).toBe(true);
    expect(first.methodology.graphIndependentGroundTruth).toBe(false);
    expect(first.scales[0]!.tasks.map((task) => task.id)).toEqual(second.scales[0]!.tasks.map((task) => task.id));
    expect(first.methodology.taskSetDigest).toBe(second.methodology.taskSetDigest);
    expect(first.scales[0]!.retrieval.locate?.full?.taskCount).toBeGreaterThan(0);
    expect(first.scales[0]!.graph.callers?.taskCount).toBeGreaterThan(0);
    expect(existsSync(first.artifacts.resultsJson)).toBe(true);
    expect(JSON.parse(readFileSync(first.artifacts.resultsJson, "utf-8")).version).toBe(2);
    expect(readFileSync(first.artifacts.reportMarkdown, "utf-8")).toContain("self-evaluation");
    expect(gitStatus(repo)).toBe(before);
    expect(progress.some((event) => event.phase === "retrieval" && event.status === "complete")).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: "evaluation", status: "complete" });
  });

  it("runs automatic graph self-consistency only at its label-generating tier", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-auto-scales-"));
    cleanup.push(output);
    const result = runRepositoryEval({
      ...defaultEvalOptions(repo),
      outputDir: output,
      suites: ["retrieval", "graph"],
      scales: [6, "all"],
      taskLimit: 100,
      thresholds: zeroThresholds(),
    });
    expect(result.scales).toHaveLength(2);
    expect(result.scales[0]!.runs.some((run) => run.arm === "graph")).toBe(true);
    expect(result.scales[1]!.runs.some((run) => run.arm === "graph")).toBe(false);
    expect(result.skipped.some((item) => item.includes("label-generating smallest tier"))).toBe(true);
  });

  it("loads independent frozen tasks once and reuses them across nested scales", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-frozen-"));
    const replayOutput = mkdtempSync(join(tmpdir(), "codelens-eval-output-replay-"));
    cleanup.push(output, replayOutput);
    const result = runRepositoryEval({
      ...defaultEvalOptions(repo),
      outputDir: output,
      taskFile: frozenTaskFile(),
      suites: ["retrieval", "graph"],
      scales: [4, "all"],
      repeats: 2,
      thresholds: zeroThresholds(),
    });

    expect(result.methodology.taskSource).toMatchObject({ kind: "frozen-task-file", independentGroundTruth: true, source: "reviewed fixture" });
    expect(result.methodology.graphIndependentGroundTruth).toBe(true);
    expect(result.scales.map((scale) => scale.label)).toEqual(["4", "all"]);
    expect(result.scales[0]!.tasks).toEqual(result.scales[1]!.tasks);
    for (const scale of result.scales) {
      expect(scale.tasks.map((task) => task.id)).toEqual(["locate-session", "callers-session"]);
      expect(scale.tasks.every((task) => task.contributesToThresholds)).toBe(true);
      expect(scale.runs.filter((run) => run.arm !== "graph")).toHaveLength(8);
      expect(scale.runs.filter((run) => run.arm === "graph")).toHaveLength(2);
      expect(scale.retrieval.locate?.full).toMatchObject({ taskCount: 1, sampleCount: 2 });
      expect(scale.graph.callers).toMatchObject({ taskCount: 1, sampleCount: 2, recallAtK: 1, precisionAtK: 1, successRate: 1 });
    }
    const replay = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: replayOutput,
      taskFile: result.artifacts.tasksJson,
      suites: ["retrieval", "graph"],
      thresholds: zeroThresholds(),
    });
    expect(replay.methodology.taskSetDigest).toBe(result.methodology.taskSetDigest);
  });

  it("rejects malformed, duplicate, and missing frozen task paths", () => {
    const repo = fixtureRepo();
    const malformed = frozenTaskFile({ tasks: [{
      id: "bad",
      suite: "graph",
      type: "callers",
      query: "bad graph task",
      expectedPaths: ["src/auth/session.ts"],
    }] });
    expect(() => runRepositoryEval({ ...quickEvalOptions(repo), taskFile: malformed })).toThrow(/targetPath is required/);

    const duplicate = frozenTaskFile({ tasks: [
      { id: "same", suite: "retrieval", type: "locate", query: "one", expectedPaths: ["src/auth/session.ts"] },
      { id: "same", suite: "retrieval", type: "locate", query: "two", expectedPaths: ["src/auth/session.ts"] },
    ] });
    expect(() => runRepositoryEval({ ...quickEvalOptions(repo), taskFile: duplicate })).toThrow(/duplicate task id/);

    const missing = frozenTaskFile({ tasks: [
      { id: "missing", suite: "retrieval", type: "locate", query: "missing", expectedPaths: ["src/does-not-exist.ts"] },
    ] });
    expect(() => runRepositoryEval({ ...quickEvalOptions(repo), taskFile: missing })).toThrow(/missing or not indexable/);

    const unreviewedGraphGate = frozenTaskFile({
      independentGroundTruth: false,
      tasks: [{
        id: "unreviewed-graph",
        suite: "graph",
        type: "callers",
        query: "callers",
        targetPath: "src/auth/session.ts",
        expectedPaths: ["src/routes/login.ts"],
        contributesToThresholds: true,
      }],
    });
    expect(() => runRepositoryEval({ ...quickEvalOptions(repo), taskFile: unreviewedGraphGate })).toThrow(/requires independentGroundTruth/);
  });

  it("restricts rg to the selected inventory", () => {
    const repo = fixtureRepo();
    const task = { ...metricTask(), query: "widget" };
    const onlySession = runRgBaseline(repo, task, 10, ["src/auth/session.ts"]);
    const withWidget = runRgBaseline(repo, task, 10, ["src/auth/session.ts", "src/widgets/index.ts"]);
    expect(onlySession.foundPaths).toEqual([]);
    expect(withWidget.foundPaths).toEqual(["src/widgets/index.ts"]);
  });

  it("counterbalances arm order and treats repeats as timing samples", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-repeats-"));
    cleanup.push(output);
    const result = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: output,
      taskFile: frozenTaskFile({ tasks: [
        { id: "one", suite: "retrieval", type: "locate", query: "validate session", expectedPaths: ["src/auth/session.ts"] },
        { id: "two", suite: "retrieval", type: "locate", query: "login route", expectedPaths: ["src/routes/login.ts"] },
        { id: "history-one", suite: "retrieval", type: "history", query: "add session authentication", expectedPaths: ["src/auth/session.ts"] },
      ] }),
      suites: ["retrieval"],
      repeats: 2,
      thresholds: zeroThresholds(),
    });
    const scale = result.scales[0]!;
    expect(scale.retrieval.locate?.full).toMatchObject({ taskCount: 2, sampleCount: 4 });
    const firstOrders = scale.runs.filter((run) => run.taskId === "one").map((run) => `${run.repeat}:${run.arm}:${run.order}`);
    const historyOrders = scale.runs.filter((run) => run.taskId === "history-one").map((run) => `${run.repeat}:${run.arm}:${run.order}`);
    expect(firstOrders).toContain("0:full:0");
    expect(firstOrders).toContain("1:lexical:0");
    expect(historyOrders).toContain("0:full:0");
    expect(historyOrders).toContain("1:lexical:0");
  });

  it("applies recall, precision, and success thresholds to reviewed graph labels", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-graph-thresholds-"));
    cleanup.push(output);
    const tasks = frozenTaskFile({ tasks: [{
      id: "incorrect-callers",
      suite: "graph",
      type: "callers",
      query: "callers of auth session",
      targetPath: "src/auth/session.ts",
      expectedPaths: ["src/widgets/index.ts"],
      confidence: 1,
    }] });
    const result = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: output,
      taskFile: tasks,
      suites: ["graph"],
      thresholds: { minRecallAtK: 1, minMrr: 1, minSuccessRate: 1, minGraphPrecision: 1 },
    });
    expect(result.pass).toBe(false);
    expect(result.thresholdFailures.some((failure) => failure.includes("graph recall"))).toBe(true);
    expect(result.thresholdFailures.some((failure) => failure.includes("graph precision"))).toBe(true);
    expect(result.thresholdFailures.some((failure) => failure.includes("graph success"))).toBe(true);
  });

  it("excludes low-confidence tasks from pass/fail thresholds", () => {
    const repo = fixtureRepo();
    const informationalOutput = mkdtempSync(join(tmpdir(), "codelens-eval-output-informational-"));
    const gatedOutput = mkdtempSync(join(tmpdir(), "codelens-eval-output-gated-"));
    cleanup.push(informationalOutput, gatedOutput);
    const lowConfidence = frozenTaskFile({ tasks: [{
      id: "informational",
      suite: "retrieval",
      type: "history",
      query: "terms that cannot possibly retrieve the expected implementation",
      expectedPaths: ["src/auth/session.ts"],
      confidence: 0.7,
    }] });
    const informational = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: informationalOutput,
      taskFile: lowConfidence,
      suites: ["retrieval"],
      thresholds: { minRecallAtK: 1, minMrr: 1, minSuccessRate: 1, minGraphPrecision: 1 },
    });
    expect(informational.pass).toBe(true);
    expect(informational.thresholdFailures).toEqual([]);

    const highConfidence = frozenTaskFile({ tasks: [{
      id: "eligible",
      suite: "retrieval",
      type: "locate",
      query: "terms that cannot possibly retrieve the expected implementation",
      expectedPaths: ["src/auth/session.ts"],
      confidence: 1,
    }] });
    const gated = runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: gatedOutput,
      taskFile: highConfidence,
      suites: ["retrieval"],
      thresholds: { minRecallAtK: 1, minMrr: 1, minSuccessRate: 1, minGraphPrecision: 1 },
    });
    expect(gated.pass).toBe(false);
    expect(gated.thresholdFailures.every((failure) => failure.includes("locate"))).toBe(true);
  });

  it("runs edit/delete freshness as an independent suite", () => {
    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-freshness-"));
    cleanup.push(output);
    const before = gitStatus(repo);
    const worktreesBefore = gitWorktrees(repo);
    const result = runRepositoryEval({ ...defaultEvalOptions(repo), outputDir: output, suites: ["freshness"] });
    expect(result.scales).toEqual([]);
    expect(result.methodology.taskSource).toEqual({ kind: "none", independentGroundTruth: true });
    expect(result.freshness).toMatchObject({ attempted: true, modifiedVisible: true, deletedRemoved: true, passed: true });
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
    const result = runRepositoryEval({ ...defaultEvalOptions(repo), outputDir: output, suites: ["freshness"] });
    expect(result.freshness.attempted).toBe(false);
    expect(result.freshness.skippedReason).toMatch(/no safe regular text file/);
    expect(readFileSync(outsideFile, "utf-8")).toBe(original);
    expect(gitWorktrees(repo).match(/^worktree /gm)).toHaveLength(1);
  });

  it("calculates unique-task metrics and deterministic confidence intervals", () => {
    const task = metricTask();
    const first = evaluateObservation(task, "full", {
      foundPaths: ["src/other.ts", "src/session.ts", "src/session.ts"],
      toolCalls: 1,
      bytesServed: 100,
      elapsedMs: 10,
    }, 5, 0, 0);
    const second = { ...first, repeat: 1, elapsedMs: 20 };
    expect(first).toMatchObject({ recallAtK: 0.5, reciprocalRank: 0.5, precisionAtK: 0.2, success: true });
    const aggregate = aggregateRuns([first, second], 42);
    expect(aggregate).toMatchObject({ taskCount: 1, sampleCount: 2, recallAtK: 0.5, mrr: 0.5, totalBytesServed: 200 });
    expect(aggregate.confidence95.recallAtK).toEqual({ low: 0.5, high: 0.5 });
    expect(aggregate.confidence95.precisionAtK).toEqual({ low: 0.2, high: 0.2 });
  });

  it("reports the active phase and ignores progress callback failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "codelens-eval-not-git-"));
    const progress: EvalProgressEvent[] = [];
    cleanup.push(dir);
    expect(() => runRepositoryEval({ ...quickEvalOptions(dir), onProgress: (event) => progress.push(event) })).toThrow(/evaluation failed during repository/);
    expect(progress.at(-1)).toMatchObject({ phase: "repository", status: "error" });

    const repo = fixtureRepo();
    const output = mkdtempSync(join(tmpdir(), "codelens-eval-output-progress-"));
    cleanup.push(output);
    expect(() => runRepositoryEval({
      ...quickEvalOptions(repo),
      outputDir: output,
      taskLimit: 1,
      thresholds: zeroThresholds(),
      onProgress: () => { throw new Error("progress sink failed"); },
    })).not.toThrow();
  });
});
