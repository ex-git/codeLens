import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { EvalGraphTaskType, EvalTask, EvalTaskFile, EvalTaskSource } from "./types.js";

export interface LoadedEvalTasks {
  tasks: EvalTask[];
  source: EvalTaskSource;
}

export function loadEvalTaskFile(path: string): LoadedEvalTasks {
  const absolute = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf-8"));
  } catch (error) {
    throw new Error(`could not read --tasks-file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.independentGroundTruth !== "boolean" || !Array.isArray(parsed.tasks)) {
    throw new Error("--tasks-file must contain { version: 1, independentGroundTruth: boolean, tasks: [...] }");
  }

  const file = parsed as unknown as EvalTaskFile;
  if (file.tasks.length > 10_000) throw new Error("--tasks-file may contain at most 10000 tasks");
  const seen = new Set<string>();
  const tasks = file.tasks.map((raw, index): EvalTask => {
    const label = `tasks[${index}]`;
    if (!isRecord(raw)) throw new Error(`${label} must be an object`);
    const id = requiredString(raw.id, `${label}.id`, 200);
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error(`${label}.id may contain letters, numbers, '.', '_', ':', and '-' only`);
    if (seen.has(id)) throw new Error(`duplicate task id: ${id}`);
    seen.add(id);
    if (raw.suite !== "retrieval" && raw.suite !== "graph") throw new Error(`${label}.suite must be retrieval or graph`);
    if (!isTaskType(raw.type)) throw new Error(`${label}.type is invalid`);
    if (raw.suite === "retrieval" && raw.type !== "locate" && raw.type !== "history") {
      throw new Error(`${label}: retrieval suite supports locate/history tasks only`);
    }
    if (raw.suite === "graph" && raw.type !== "callers" && raw.type !== "tests") {
      throw new Error(`${label}: graph suite supports callers/tests tasks only`);
    }
    const query = requiredString(raw.query, `${label}.query`, 1000);
    if (!Array.isArray(raw.expectedPaths) || raw.expectedPaths.length === 0) {
      throw new Error(`${label}.expectedPaths must be a non-empty array`);
    }
    if (raw.expectedPaths.length > 1_000) throw new Error(`${label}.expectedPaths may contain at most 1000 paths`);
    const expectedPaths = [...new Set(raw.expectedPaths.map((value, pathIndex) =>
      normalizeRepoPath(requiredString(value, `${label}.expectedPaths[${pathIndex}]`, 4096), `${label}.expectedPaths[${pathIndex}]`),
    ))];
    const targetPath = raw.targetPath === undefined
      ? undefined
      : normalizeRepoPath(requiredString(raw.targetPath, `${label}.targetPath`, 4096), `${label}.targetPath`);
    if (raw.suite === "graph" && !targetPath) throw new Error(`${label}.targetPath is required for graph tasks`);
    const confidence = raw.confidence === undefined ? 1 : Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error(`${label}.confidence must be between 0 and 1`);
    }
    const contributesToThresholds = raw.contributesToThresholds === undefined
      ? file.independentGroundTruth && confidence >= 0.9
      : raw.contributesToThresholds;
    if (typeof contributesToThresholds !== "boolean") throw new Error(`${label}.contributesToThresholds must be boolean`);
    if (raw.suite === "graph" && contributesToThresholds && !file.independentGroundTruth) {
      throw new Error(`${label}.contributesToThresholds requires independentGroundTruth: true for graph tasks`);
    }
    return {
      id,
      suite: raw.suite,
      type: raw.type,
      query,
      ...(targetPath ? { targetPath } : {}),
      expectedPaths,
      confidence,
      contributesToThresholds,
      origin: typeof raw.origin === "string" && raw.origin.trim() ? raw.origin.trim().replace(/\s+/g, " ").slice(0, 500) : "frozen task file",
      groundTruth: {
        kind: file.independentGroundTruth ? "frozen-reviewed" : "frozen-unreviewed",
        independent: file.independentGroundTruth,
      },
    };
  });
  if (tasks.length === 0) throw new Error("--tasks-file contains no tasks");

  return {
    tasks,
    source: {
      kind: "frozen-task-file",
      independentGroundTruth: file.independentGroundTruth,
      source: normalizeSource(file.source, basename(absolute)),
    },
  };
}

export function requiredTaskPaths(tasks: EvalTask[]): Set<string> {
  const paths = new Set<string>();
  for (const task of tasks) {
    for (const path of task.expectedPaths) paths.add(path);
    if (task.suite === "graph" && task.targetPath) paths.add(task.targetPath);
  }
  return paths;
}

function normalizeRepoPath(value: string, label: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || parts.some((part) => part === ".." || part === "." || part === "")) {
    throw new Error(`${label} must be a repo-relative path without '..'`);
  }
  return normalized;
}

function normalizeSource(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/\s+/g, " ").replace(/[`<>]/g, "").slice(0, 200);
}

function requiredString(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > maximum) throw new Error(`${label} must be at most ${maximum} characters`);
  return trimmed;
}

function isTaskType(value: unknown): value is EvalTask["type"] {
  return value === "locate" || value === "history" || value === "callers" || value === "tests";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGraphTaskType(type: EvalTask["type"]): type is EvalGraphTaskType {
  return type === "callers" || type === "tests";
}
