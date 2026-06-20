import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db/db.js";
import { detectScope } from "../src/git/scope.js";
import { buildIndex } from "../src/index/indexer.js";
import { ctxSearch } from "../src/tools/search.js";

interface QualityQuery {
  query: string;
  expectedPath: string;
  category: string;
  note?: string;
}

interface QueryMetric extends QualityQuery {
  rank: number | null;
  reciprocalRank: number;
  top1: boolean;
  foundAt5: boolean;
  latencyMs: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const QUERY_PATH = join(HERE, "quality-queries.json");
const K = 5;

function ms(ns: bigint): number {
  return Number(ns) / 1e6;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function readQueries(): QualityQuery[] {
  const parsed = JSON.parse(readFileSync(QUERY_PATH, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("quality-queries.json must be an array");
  return parsed.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`query ${i} must be an object`);
    const q = item as Record<string, unknown>;
    if (typeof q.query !== "string" || typeof q.expectedPath !== "string" || typeof q.category !== "string") {
      throw new Error(`query ${i} must include query, expectedPath, and category strings`);
    }
    return {
      query: q.query,
      expectedPath: q.expectedPath,
      category: q.category,
      note: typeof q.note === "string" ? q.note : undefined,
    };
  });
}

function writeRepo(root: string): void {
  execSync("git init -q", { cwd: root });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: root });
  const files: Record<string, string> = {
    "src/auth/session.ts": `/** Token validation helpers for auth sessions. */
export function validateSession(token: string): boolean {
  return token.length > 0;
}

export class SessionStore {
  refreshSession(userId: string): string {
    return userId + ":session";
  }
}
`,
    "src/users/profile.ts": `export interface UserProfile {
  user_id: string;
  display_name: string;
}

export function load_user_profile(user_id: string): UserProfile {
  return { user_id, display_name: user_id.toUpperCase() };
}
`,
    "src/payments/processor.ts": `export class PaymentProcessor {
  processPayment(amountCents: number): boolean {
    return amountCents > 0;
  }
}
`,
    "src/config/constants.ts": `export const MAX_SESSION_LEN = 4096;
export const DEFAULT_TIMEOUT_MS = 2500;
`,
    "src/network/retry.ts": `/** Retry policy for timeout errors from the network layer. */
export function retryWithTimeoutPolicy(attempts: number): number {
  return Math.min(attempts, 3);
}
`,
    "src/notifications/notifier.ts": `export function sendNotifierMessage(quotedToken: string): string {
  return "notifier:" + quotedToken;
}
`,
    "src/server/request.ts": `export function requestHandler(path: string): Response {
  return new Response(path);
}
`,
    "src/cache/cleanup.ts": `export function cleanupCacheEntries(entries: string[]): string[] {
  return entries.filter((entry) => entry.length > 0);
}
`,
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  execSync("git add -A && git commit -q -m init", { cwd: root });
}

function main(): void {
  const queries = readQueries();
  const repo = mkdtempSync(join(tmpdir(), "ce-quality-"));
  try {
    writeRepo(repo);
    const scope = detectScope(repo);
    if (!scope) throw new Error("failed to detect fixture git scope");
    const db = openDb(join(repo, "quality.db"));
    try {
      const indexStart = process.hrtime.bigint();
      const build = buildIndex(db, scope);
      const indexTotalMs = ms(process.hrtime.bigint() - indexStart);

      const perQuery: QueryMetric[] = [];
      for (const q of queries) {
        const start = process.hrtime.bigint();
        const result = ctxSearch(db, q.query, { scope, limit: K, snippet: "none" });
        const latencyMs = ms(process.hrtime.bigint() - start);
        const rankIndex = result.results.findIndex((r) => r.path === q.expectedPath);
        const rank = rankIndex === -1 ? null : rankIndex + 1;
        perQuery.push({
          ...q,
          rank,
          reciprocalRank: rank === null ? 0 : 1 / rank,
          top1: rank === 1,
          foundAt5: rank !== null && rank <= K,
          latencyMs,
        });
      }

      const searchLatencies = perQuery.map((q) => q.latencyMs);
      const recallAt5 = perQuery.filter((q) => q.foundAt5).length / perQuery.length;
      const top1 = perQuery.filter((q) => q.top1).length / perQuery.length;
      const mrr = perQuery.reduce((sum, q) => sum + q.reciprocalRank, 0) / perQuery.length;
      const noRegression = perQuery.filter((q) => q.category === "no-regression");
      const identifierHeavy = perQuery.filter((q) => ["camelCase", "snake_case", "PascalCase", "ALL_CAPS"].includes(q.category));
      const metrics = {
        indexTotalMs,
        indexedFiles: build.indexedFiles,
        totalChunks: build.totalChunks,
        skipped: build.skipped,
        recallAt5,
        mrr,
        top1,
        noRegressionTop1: noRegression.length === 0 ? 0 : noRegression.filter((q) => q.top1).length / noRegression.length,
        identifierRecallAt5: identifierHeavy.length === 0 ? 0 : identifierHeavy.filter((q) => q.foundAt5).length / identifierHeavy.length,
        qualitySearchP50Ms: percentile(searchLatencies, 50),
        qualitySearchP95Ms: percentile(searchLatencies, 95),
      };
      console.log(JSON.stringify({ fixture: "bench/quality-queries.json", k: K, metrics, perQuery }, null, 2));
    } finally {
      db.close();
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

main();
