import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDb } from "../src/db/db.js";
import { detectScope } from "../src/git/scope.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxExplore } from "../src/tools/explore.js";
import { ctxImpact } from "../src/tools/impact.js";
import { ctxSearch } from "../src/tools/search.js";

interface EvalTask {
  id: string;
  intent: "locate" | "explore" | "impact";
  query: string;
  expectedPath: string;
  symbol?: string;
  path?: string;
  rawTerms: string[];
}

interface ArmMetric {
  success: boolean;
  toolCalls: number;
  bytesServed: number;
  bytesRead: number;
  elapsedMs: number;
  foundPaths: string[];
}

interface TaskMetric extends EvalTask {
  codelens: ArmMetric;
  raw: ArmMetric;
}

const TASKS: EvalTask[] = [
  {
    id: "locate-session-validation",
    intent: "locate",
    query: "session validation",
    expectedPath: "src/auth/session.ts",
    rawTerms: ["session", "validation", "validateSession"],
  },
  {
    id: "explore-login-flow",
    intent: "explore",
    query: "login session flow",
    expectedPath: "src/routes/login.ts",
    rawTerms: ["login", "session", "validateSession"],
  },
  {
    id: "impact-session-validator",
    intent: "impact",
    query: "validateSession impact",
    symbol: "validateSession",
    path: "src/auth/session.ts",
    expectedPath: "src/routes/login.ts",
    rawTerms: ["validateSession"],
  },
];

function now(): bigint { return process.hrtime.bigint(); }
function ms(ns: bigint): number { return Number(ns) / 1e6; }

function writeRepo(root: string): void {
  execSync("git init -q", { cwd: root });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: root });
  const files: Record<string, string> = {
    "src/auth/session.ts": `/** Token validation helpers for login sessions. */
export function validateSession(token: string): boolean {
  return token.length > 0;
}

export function renewSession(userId: string): string {
  return userId + ":session";
}
`,
    "src/routes/login.ts": `import { validateSession, renewSession } from '../auth/session';

export function loginRoute(token: string, userId: string): string | null {
  if (!validateSession(token)) return null;
  return renewSession(userId);
}
`,
    "src/routes/logout.ts": `import { validateSession } from '../auth/session';
export function logoutRoute(token: string): boolean {
  return validateSession(token);
}
`,
    "tests/session.test.ts": `import { validateSession } from '../src/auth/session';
test('validateSession', () => validateSession('token'));
`,
    "src/users/profile.ts": `export function loadUserProfile(userId: string): string {
  return userId.toUpperCase();
}
`,
    "docs/auth.md": `# Auth flow

Login routes validate the session token before renewing the session.
`,
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execSync("git add -A && git commit -q -m init", { cwd: root });
}

function walkFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name.endsWith(".db") || name.endsWith(".db-wal") || name.endsWith(".db-shm")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(root, full));
    else out.push(full.slice(root.length + 1));
  }
  return out.sort();
}

function rawScan(root: string, task: EvalTask): ArmMetric {
  const start = now();
  const found = new Set<string>();
  let bytesRead = 0;
  let toolCalls = 0;
  for (const path of walkFiles(root)) {
    const text = readFileSync(join(root, path), "utf-8");
    bytesRead += Buffer.byteLength(text);
    toolCalls++;
    const lower = text.toLowerCase() + "\n" + path.toLowerCase();
    if (task.rawTerms.some((term) => lower.includes(term.toLowerCase()))) found.add(path);
  }
  const foundPaths = [...found];
  const bytesServed = Buffer.byteLength(JSON.stringify({ foundPaths }), "utf-8");
  return {
    success: foundPaths.includes(task.expectedPath),
    toolCalls,
    bytesServed,
    bytesRead,
    elapsedMs: ms(now() - start),
    foundPaths,
  };
}

function codelensRun(db: Parameters<typeof ctxSearch>[0], task: EvalTask): ArmMetric {
  const start = now();
  let result: unknown;
  let foundPaths: string[];
  const toolCalls = 1;
  if (task.intent === "impact") {
    result = ctxImpact(db, { symbol: task.symbol, path: task.path, depth: 2 });
    const impact = result as { target?: { path?: string }; callers?: Array<{ path: string }>; affectedFiles?: Array<{ path: string }>; affectedTests?: Array<{ path: string }> };
    foundPaths = [impact.target?.path, ...(impact.callers ?? []).map((x) => x.path), ...(impact.affectedFiles ?? []).map((x) => x.path), ...(impact.affectedTests ?? []).map((x) => x.path)].filter((p): p is string => !!p);
  } else if (task.intent === "explore") {
    result = ctxExplore(db, task.query, { limit: 6, snippet: "headline", relatedDepth: 1 });
    const explore = result as { files?: Array<{ path: string }>; related?: Array<{ path: string; sourcePath: string }> };
    foundPaths = [...(explore.files ?? []).map((x) => x.path), ...(explore.related ?? []).flatMap((x) => [x.sourcePath, x.path])];
  } else {
    result = ctxSearch(db, task.query, { limit: 5, snippet: "none" });
    const search = result as { results?: Array<{ path: string }> };
    foundPaths = (search.results ?? []).map((x) => x.path);
  }
  foundPaths = [...new Set(foundPaths)];
  const text = JSON.stringify(result);
  return {
    success: foundPaths.includes(task.expectedPath),
    toolCalls,
    bytesServed: Buffer.byteLength(text, "utf-8"),
    bytesRead: 0,
    elapsedMs: ms(now() - start),
    foundPaths,
  };
}

function main(): void {
  const repo = mkdtempSync(join(tmpdir(), "ce-agent-eval-"));
  try {
    writeRepo(repo);
    const scope = detectScope(repo);
    if (!scope) throw new Error("failed to detect fixture git scope");
    const db = openDb(join(repo, "agent-eval.db"));
    try {
      const indexStart = now();
      const build = buildIndex(db, scope);
      const indexMs = ms(now() - indexStart);
      const tasks: TaskMetric[] = TASKS.map((task) => ({ ...task, codelens: codelensRun(db, task), raw: rawScan(repo, task) }));
      const pass = tasks.every((task) => task.codelens.success && task.raw.success);
      const totals = tasks.reduce((acc, task) => {
        acc.codelensToolCalls += task.codelens.toolCalls;
        acc.rawToolCalls += task.raw.toolCalls;
        acc.codelensBytesServed += task.codelens.bytesServed;
        acc.rawBytesRead += task.raw.bytesRead;
        return acc;
      }, { codelensToolCalls: 0, rawToolCalls: 0, codelensBytesServed: 0, rawBytesRead: 0 });
      const output = {
        fixture: "generated-auth-flow",
        index: { indexedFiles: build.indexedFiles, totalChunks: build.totalChunks, skipped: build.skipped, indexMs },
        pass,
        totals,
        savings: {
          toolCallReduction: totals.rawToolCalls === 0 ? 0 : 1 - totals.codelensToolCalls / totals.rawToolCalls,
          contextByteReduction: totals.rawBytesRead === 0 ? 0 : 1 - totals.codelensBytesServed / totals.rawBytesRead,
        },
        tasks,
      };
      console.log(JSON.stringify(output, null, 2));
      if (!pass) process.exitCode = 1;
    } finally {
      db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

main();
