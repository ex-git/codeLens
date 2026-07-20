import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, extname } from "node:path";
import type Database from "better-sqlite3";
import { splitIdentifiers } from "../search/identifiers.js";
import type { EvalSuiteName, EvalTask, EvalTaskType } from "./types.js";

interface SymbolRow {
  name: string;
  path: string;
  kind: string;
  exported: number;
}

interface EdgeRow {
  fromPath: string;
  toPath: string;
}

const QUERY_STOP_WORDS = new Set(["index", "main", "default", "value", "data", "type", "item", "result"]);
const GENERIC_MODULE_STEMS = new Set(["index", "main", "default", "mod", "module"]);
const CONTAINER_DIRECTORIES = new Set(["src", "app", "apps", "components", "features", "hooks", "lib", "libs", "packages", "routes", "utils"]);

export function generateEvalTasks(
  db: Database.Database,
  indexId: string,
  repoRoot: string,
  inventory: string[],
  limit: number,
  seed: number,
  suites: EvalSuiteName[],
): EvalTask[] {
  const knownFiles = new Set(inventory);
  const symbols = db.prepare(
    `SELECT name, path, kind, exported
     FROM symbols
     WHERE index_id = ?
     ORDER BY exported DESC, path ASC, start_line ASC`,
  ).all(indexId) as SymbolRow[];

  const buckets: Record<EvalTaskType, EvalTask[]> = {
    locate: suites.includes("retrieval") ? locateTasks(symbols) : [],
    history: suites.includes("retrieval") ? historyTasks(repoRoot, knownFiles) : [],
    callers: suites.includes("graph") ? relationshipTasks(db, indexId, "callers") : [],
    tests: suites.includes("graph") ? relationshipTasks(db, indexId, "tests") : [],
  };
  const types = (["locate", "callers", "tests", "history"] as EvalTaskType[]).filter((type) => buckets[type].length > 0);
  for (let i = 0; i < types.length; i++) {
    const type = types[i]!;
    buckets[type] = seededShuffle(buckets[type], seed + i * 9973);
  }

  const selected: EvalTask[] = [];
  let cursor = 0;
  while (selected.length < limit) {
    let added = false;
    for (const type of types) {
      const task = buckets[type][cursor];
      if (!task) continue;
      selected.push(task);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
    cursor++;
  }
  return selected;
}

function locateTasks(symbols: SymbolRow[]): EvalTask[] {
  const seen = new Set<string>();
  const tasks: EvalTask[] = [];
  for (const row of symbols) {
    if (!row.exported || isGeneratedPath(row.path)) continue;
    const query = symbolQuery(row.name, row.path);
    if (!query || query.toLowerCase() === row.name.toLowerCase()) continue;
    const key = `${query}\0${row.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({
      id: taskId("locate", query, [row.path]),
      suite: "retrieval",
      type: "locate",
      query,
      expectedPaths: [row.path],
      confidence: 1,
      contributesToThresholds: true,
      symbol: row.name,
      origin: `exported ${row.kind}`,
      groundTruth: { kind: "auto-index", independent: false },
    });
  }
  return tasks;
}

function relationshipTasks(db: Database.Database, indexId: string, type: "callers" | "tests"): EvalTask[] {
  const edgeTypes = type === "callers" ? ["imports", "calls", "references"] : ["tests"];
  const placeholders = edgeTypes.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT from_path AS fromPath, to_path AS toPath
     FROM edges
     WHERE index_id = ? AND type IN (${placeholders})
       AND from_path IS NOT NULL AND to_path IS NOT NULL
       AND from_path != to_path
     ORDER BY to_path, from_path`,
  ).all(indexId, ...edgeTypes) as EdgeRow[];

  const expectedByTarget = new Map<string, Set<string>>();
  for (const row of rows) {
    let paths = expectedByTarget.get(row.toPath);
    if (!paths) { paths = new Set(); expectedByTarget.set(row.toPath, paths); }
    paths.add(row.fromPath);
  }
  const tasks: EvalTask[] = [];
  for (const [targetPath, expected] of expectedByTarget) {
    const expectedPaths = [...expected].sort();
    if (expectedPaths.length === 0) continue;
    const module = moduleSubject(targetPath);
    const query = type === "tests" ? `tests for ${module}` : `callers of ${module}`;
    tasks.push({
      id: taskId(type, query, expectedPaths),
      suite: "graph",
      type,
      query,
      targetPath,
      expectedPaths: expectedPaths.slice(0, 20),
      confidence: type === "tests" ? 0.9 : 0.85,
      contributesToThresholds: false,
      origin: type === "tests" ? "CodeLens file tests edge" : "CodeLens file import/call/reference edge",
      groundTruth: { kind: "auto-index", independent: false },
    });
  }
  return tasks;
}

function historyTasks(repoRoot: string, knownFiles: Set<string>): EvalTask[] {
  const result = spawnSync(
    "git",
    ["log", "-n", "100", "--pretty=format:---CODELENS-COMMIT---%H\t%s", "--name-only"],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return [];
  const tasks: EvalTask[] = [];
  for (const block of (result.stdout ?? "").split("---CODELENS-COMMIT---").slice(1)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const header = lines.shift();
    if (!header) continue;
    const tab = header.indexOf("\t");
    if (tab < 0) continue;
    const sha = header.slice(0, tab);
    const subject = header.slice(tab + 1).trim();
    if (!usableHistorySubject(subject)) continue;
    const expectedPaths = [...new Set(lines.filter((path) => knownFiles.has(path)))].slice(0, 12);
    if (expectedPaths.length === 0 || expectedPaths.some((path) => subject.toLowerCase().includes(basename(path).toLowerCase()))) continue;
    tasks.push({
      id: taskId("history", subject, expectedPaths),
      suite: "retrieval",
      type: "history",
      query: subject,
      expectedPaths,
      confidence: 0.7,
      contributesToThresholds: false,
      origin: `git commit ${sha.slice(0, 12)}`,
      groundTruth: { kind: "git-history", independent: true },
    });
  }
  return tasks;
}

function usableHistorySubject(subject: string): boolean {
  if (subject.length < 10 || subject.length > 160) return false;
  return !/^(merge|release|chore\b|bump\b|v?\d+\.\d+\.\d+)/i.test(subject);
}

function symbolQuery(name: string, path: string): string {
  const parts = splitIdentifiers(name, { minTokenLength: 3, maxTokens: 5 })
    .filter((part) => !QUERY_STOP_WORDS.has(part));
  if (parts.length >= 2) return parts.slice(0, 4).join(" ");
  const pathParts = fileStem(path).split(/[^a-z0-9]+/i).filter((part) => part.length >= 3);
  const combined = [...new Set([...parts, ...pathParts])].filter((part) => !QUERY_STOP_WORDS.has(part.toLowerCase()));
  return combined.length >= 2 ? combined.slice(0, 4).join(" ") : "";
}

function humanize(value: string): string {
  const split = splitIdentifiers(value, { minTokenLength: 2, maxTokens: 5 });
  return split.length > 0 ? split.join(" ") : value.replace(/[_-]+/g, " ");
}

function moduleSubject(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const leaf = fileStem(parts.at(-1) ?? path);
  const directories = parts.slice(0, -1).reverse().map((part) => fileStem(part));
  const context = directories.find((part) => !CONTAINER_DIRECTORIES.has(part.toLowerCase())) ?? directories[0];
  const raw = GENERIC_MODULE_STEMS.has(leaf.toLowerCase()) ? (context ?? leaf) : [context, leaf].filter(Boolean).join(" ");
  const tokens = raw.split(/[^A-Za-z0-9_]+/).filter(Boolean).flatMap((part) => {
    const split = splitIdentifiers(part, { minTokenLength: 2, maxTokens: 8 });
    return split.length > 0 ? split : [part.toLowerCase()];
  });
  const unique = [...new Map(tokens.map((token) => [token.toLowerCase(), token])).values()];
  return unique.slice(0, 8).join(" ") || humanize(leaf);
}

function fileStem(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return (ext ? base.slice(0, -ext.length) : base).replace(/[._-]+/g, " ");
}

function isGeneratedPath(path: string): boolean {
  return /(^|\/)(generated|vendor)(\/|$)/i.test(path) || /\.(generated|gen)\.[^.]+$/i.test(path);
}

function taskId(type: string, query: string, paths: string[]): string {
  return `${type}-${createHash("sha256").update(`${query}\0${paths.join("\0")}`).digest("hex").slice(0, 12)}`;
}

export function seededShuffle<T>(values: T[], seed: number): T[] {
  const out = [...values];
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
