import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { openDb } from "./db/db.js";
import { openContextDb } from "./context/store.js";
import { detectScope } from "./git/scope.js";
import { buildIndex } from "./index/indexer.js";
import { clearAutoIndexing } from "./index/autoindex.js";
import { getActiveIndexId } from "./index/manager.js";
import { ctxSearch } from "./tools/search.js";
import { ctxRelated } from "./tools/related.js";
import { gatherStats } from "./obs/stats.js";
import { runDoctor } from "./obs/doctor.js";
import { UsageTracker, openGlobalUsageDb } from "./obs/usage.js";
import { scheduleAutoPrune } from "./index/autoprune.js";
import { runInstall, runUninstall, printConfig, HOSTS, type Location } from "./installer/agents.js";
import { VERSION } from "./version.js";
import { checkUpgrade, performUpgrade } from "./upgrade.js";
import { parseCwdArg, resolveCwd } from "./runtime/root.js";
import { defaultEvalOptions, quickEvalOptions, runRepositoryEval } from "./eval/evaluator.js";
import { consoleSummary } from "./eval/report.js";
import type { EvalOptions, EvalProgressEvent } from "./eval/types.js";
import { fileURLToPath } from "node:url";

/**
 * Minimal CLI (Gap #9): lets non-MCP users run diagnostics, build the index,
 * and query from the terminal.
 *
 * Usage:
 *   codelens current        # cl_current
 *   codelens index          # cl_refresh (build/update current branch)
 *   codelens search <query> # cl_search
 *   codelens related <path> # cl_related
 *   codelens stats          # cl_stats
 *   codelens doctor         # cl_doctor
 *   codelens (no args)      # start MCP stdio server
 */

function dbPathFor(repoRoot: string): string {
  const dir = join(homedir(), ".codelens", "indexes");
  mkdirSync(dir, { recursive: true });
  const rid = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(dir, `index-${rid}.db`);
}

function openCore(repoRoot: string) {
  try {
    return openDb(dbPathFor(repoRoot));
  } catch {
    // corrupt → remove and rebuild on next index
    try { rmSync(dbPathFor(repoRoot)); } catch { /* ignore */ }
    return openDb(dbPathFor(repoRoot));
  }
}

function ensureActiveIndex(coreDb: ReturnType<typeof openDb>, repoRoot: string): void {
  const scope = detectScope(repoRoot);
  if (!scope) throw new Error("not inside a git repo (or a directory with files)");
  if (!getActiveIndexId()) buildIndex(coreDb, scope);
}

export async function cli(args: string[]): Promise<number> {
  const parsed = parseCwdArg(args);
  args = parsed.args;
  const cmd = args[0];
  const repoRoot = resolveCwd(parsed.cwd);
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log("codelens [--cwd <path>] [current|index|search <q>|related <path>|stats|doctor|eval [repo]|install|uninstall|upgrade|version]");
    return 0;
  }
  // ── DB-free commands (no repo/index needed) ──────────────────
  if (cmd === "version" || cmd === "-v" || cmd === "--version") {
    console.log(`codelens ${VERSION}`);
    return 0;
  }
  if (cmd === "--print-config") {
    const hostId = args[1];
    const cmdExe = args[2] ?? defaultServerCommand() ?? "codelens";
    if (!hostId) { console.error("--print-config requires a host id (one of: " + HOSTS.map((h) => h.id).join(",") + ")"); return 1; }
    const out = printConfig(hostId, cmdExe);
    if (out === null) { console.error(`unknown host: ${hostId}`); return 1; }
    console.log(out);
    return 0;
  }
  if (cmd === "install") {
    const { target, location, yes, command, autoIndex: installAutoIndex } = parseInstallArgs(args.slice(1));
    const autoIndex = installAutoIndex ?? parsed.autoIndex;
    const serverCommand = command ?? defaultServerCommand();
    if (!serverCommand) { console.error("could not determine the server executable. Run install.sh first, or pass --command <path-to-launcher>."); return 1; }
    const report = runInstall({ serverCommand, location, target, yes, instructions: true, autoIndex });
    console.log(`Server command: ${serverCommand}`);
    console.log(`Configured (${report.configured.filter((c) => c.wrote).length} written, ${report.configured.filter((c) => c.already).length} already):`);
    for (const c of report.configured) console.log(`  ${c.host}: ${c.path} ${c.already ? "(already configured)" : c.wrote ? "(written)" : "(no change)"}`);
    if (report.instructions.length) console.log("Instructions written: " + report.instructions.map((i) => i.host).join(", "));
    if (report.commands.length) console.log("Slash commands written: " + report.commands.map((c) => `${c.host} (${c.wrote})`).join(", "));
    if (report.skipped.length) console.log("Skipped: " + report.skipped.join(", "));
    console.log("Restart your agent(s) for the MCP server + commands to load.");
    return 0;
  }
  if (cmd === "uninstall") {
    const { target, location } = parseInstallArgs(args.slice(1));
    const report = runUninstall({ location, target, instructions: true });
    console.log("Removed:");
    for (const c of report.configured) if (c.wrote) console.log(`  ${c.host}: ${c.path}`);
    if (!report.configured.some((c) => c.wrote)) console.log("  (nothing to remove)");
    return 0;
  }
  if (cmd === "upgrade") {
    const sub = args[1];
    if (sub === "--check") { const r = await checkUpgrade(); console.log(r.message); return r.upToDate ? 0 : 0; }
    const r = await performUpgrade(args[1]);
    console.log(r.message);
    return r.ok ? 0 : 1;
  }
  if (cmd === "eval") {
    try {
      const parsedEval = parseEvalArgs(args.slice(1), repoRoot);
      if (parsedEval.help) { console.log(EVAL_HELP); return 0; }
      parsedEval.options.onProgress = (event) => console.error(formatEvalProgress(event));
      const result = runRepositoryEval(parsedEval.options);
      console.log(parsedEval.json ? JSON.stringify(result, null, 2) : consoleSummary(result));
      return result.pass ? 0 : 2;
    } catch (error) {
      console.error(`eval failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const coreDb = openCore(repoRoot);
  const ctxDb = openContextDb(repoRoot);
  void ctxDb;
  scheduleAutoPrune(coreDb);

  try {
    switch (cmd) {
      case "current": {
        const scope = detectScope(repoRoot);
        if (!scope) { console.log(JSON.stringify({ inGitRepo: false })); break; }
        if (!getActiveIndexId()) buildIndex(coreDb, scope);
        console.log(JSON.stringify({ branch: scope.branch, headSha: scope.headSha, dirtyFiles: scope.dirtyFiles.length }, null, 2));
        break;
      }
      case "index":
      case "refresh": {
        const scope = detectScope(repoRoot);
        if (!scope) { console.error("not inside a git repo"); return 1; }
        try {
          const r = buildIndex(coreDb, scope);
          console.log(JSON.stringify(r, null, 2));
        } finally {
          if (process.env.CODELENS_AUTO_INDEX_ID) clearAutoIndexing(process.env.CODELENS_AUTO_INDEX_ID);
        }
        break;
      }
      case "search": {
        // support --type code|prose and --preview
        const typeIdx = args.indexOf("--type");
        const contentType = typeIdx >= 0 ? (args[typeIdx + 1] as "code" | "prose" | undefined) : undefined;
        const preview = args.includes("--preview");
        const queryArgs = args.slice(1).filter((a) => a !== "--type" && a !== "--preview" && a !== contentType);
        const query = queryArgs.join(" ");
        if (!query) { console.error("search requires a query"); return 1; }
        ensureActiveIndex(coreDb, repoRoot);
        const r = ctxSearch(coreDb, query, { scope: detectScope(repoRoot) ?? undefined, contentType, snippet: preview ? "headline" : undefined });
        for (const h of r.results) {
          console.log(`${h.score.toFixed(3)}  ${h.path}:${h.lines}  [${h.why}]`);
          if (preview && h.preview) console.log(`    ${h.preview}`);
        }
        break;
      }
      case "related": {
        const path = args[1];
        if (!path) { console.error("related requires a path"); return 1; }
        ensureActiveIndex(coreDb, repoRoot);
        const r = ctxRelated(coreDb, path);
        for (const h of r.results) console.log(`${h.edgeType} (${h.hops}h)  ${h.path}`);
        break;
      }
      case "stats": {
        ensureActiveIndex(coreDb, repoRoot);
        console.log(JSON.stringify(gatherStats(coreDb), null, 2));
        break;
      }
      case "usage": {
        const snap = new UsageTracker(openGlobalUsageDb()).snapshot();
        console.log(`Global usage — calls: ${snap.totals.calls}  served: ${fmt(snap.totals.bytes_served)}  saved(est): ${fmt(snap.totals.bytes_saved)}`);
        console.log("Per tool:");
        for (const t of snap.perTool) console.log(`  ${t.tool.padEnd(14)} calls=${t.calls}  served=${fmt(t.bytes_served)}  saved=${fmt(t.bytes_saved)}`);
        console.log("Per repo:");
        for (const r of snap.perRepo) console.log(`  ${r.repo_id.slice(0,8)}  calls=${r.calls}  served=${fmt(r.bytes_served)}  saved=${fmt(r.bytes_saved)}`);
        break;
      }
      case "doctor": {
        console.log(JSON.stringify(runDoctor(coreDb, repoRoot), null, 2));
        break;
      }
      default:
        console.error(`unknown command: ${cmd}`);
        return 1;
    }
    return 0;
  } finally {
    coreDb.close();
  }
}


function formatEvalProgress(event: EvalProgressEvent): string {
  const status = event.status.toUpperCase().padEnd(8);
  const elapsed = event.elapsedMs < 60_000
    ? `${(event.elapsedMs / 1000).toFixed(1)}s`
    : `${Math.floor(event.elapsedMs / 60_000)}m ${Math.floor((event.elapsedMs % 60_000) / 1000)}s`;
  return `[eval ${elapsed}] ${status} ${event.phase}: ${event.message}`;
}

function fmt(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}
function defaultServerCommand(): string | null {
  // Prefer the launcher the bootstrap installer put on PATH.
  const launcher = join(homedir(), ".local", "bin", "codelens");
  if (existsSync(launcher)) return launcher;
  // Dev fallback: the currently running server.js (only meaningful for --print-config).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const serverJs = join(here, "server.js");
    if (existsSync(serverJs)) return serverJs;
  } catch { /* ignore */ }
  return null;
}

const EVAL_HELP = `codelens eval [repo] [options]

Automatically generate retrieval tasks, compare CodeLens with ranking ablations
and a targeted rg baseline, validate freshness safely, and write scorecards.

Options:
  --quick                  20 tasks, up to 500 files, no freshness probe
  --tasks <n>              Maximum generated tasks across scales (default 100)
  --seed <n>               Deterministic sampling seed (default 42)
  --repeats <n>            Repeat every task/arm (default 1)
  --limit <n>              Results considered per task (default 10)
  --scales <list>          Comma list such as 500,2000,all
  --output <dir>           Report directory; must be outside the target repo
  --no-freshness           Skip detached-worktree edit/delete probes
  --min-recall <0..1>      Full-arm recall threshold (default 0.6)
  --min-mrr <0..1>         Full-arm MRR threshold (default 0.5)
  --min-success <0..1>     Full-arm success threshold (default 0.7)
  --json                    Print the complete JSON result
  --help                    Show this help`;

const EVAL_VALUE_OPTIONS = new Set(["--tasks", "--seed", "--repeats", "--limit", "--scales", "--output", "--min-recall", "--min-mrr", "--min-success"]);

function parseEvalArgs(args: string[], fallbackRepo: string): { options: EvalOptions; json: boolean; help: boolean } {
  const positional = findEvalRepoArg(args);
  const repoRoot = resolve(positional?.value ?? fallbackRepo);
  const quick = args.includes("--quick");
  const options = quick ? quickEvalOptions(repoRoot) : defaultEvalOptions(repoRoot);
  let json = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (i === positional?.index) continue;
    const [key, inline] = arg.split("=", 2);
    const value = inline ?? ((key && EVAL_VALUE_OPTIONS.has(key)) ? args[++i] : undefined);
    if (key === "--quick") continue;
    if (key === "--json") { json = true; continue; }
    if (key === "--help" || key === "-h") { help = true; continue; }
    if (key === "--no-freshness") { options.freshness = false; continue; }
    if (key === "--tasks") { options.taskLimit = boundedPositiveInt(value, key, 10_000); continue; }
    if (key === "--seed") { options.seed = integer(value, key); continue; }
    if (key === "--repeats") { options.repeats = boundedPositiveInt(value, key, 100); continue; }
    if (key === "--limit") { options.resultLimit = boundedPositiveInt(value, key, 1_000); continue; }
    if (key === "--scales") { options.scales = parseScales(value); continue; }
    if (key === "--output") { if (!value) throw new Error("--output requires a directory"); options.outputDir = resolve(value); continue; }
    if (key === "--min-recall") { options.thresholds.minRecallAtK = ratio(value, key); continue; }
    if (key === "--min-mrr") { options.thresholds.minMrr = ratio(value, key); continue; }
    if (key === "--min-success") { options.thresholds.minSuccessRate = ratio(value, key); continue; }
    if (arg.startsWith("-")) throw new Error(`unknown eval option: ${arg}`);
    throw new Error(`unexpected eval argument: ${arg}`);
  }
  return { options, json, help };
}

function findEvalRepoArg(args: string[]): { value: string; index: number } | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const key = arg.split("=", 1)[0]!;
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && EVAL_VALUE_OPTIONS.has(key)) i++;
      continue;
    }
    return { value: arg, index: i };
  }
  return undefined;
}

function parseScales(value: string | undefined): Array<number | "all"> {
  if (!value) throw new Error("--scales requires a comma-separated list");
  const scales = value.split(",").map((item) => item.trim()).filter(Boolean).map((item): number | "all" => {
    if (item === "all") return "all";
    return boundedPositiveInt(item, "--scales", 10_000_000);
  });
  if (scales.length === 0) throw new Error("--scales requires at least one scale");
  return scales;
}

function boundedPositiveInt(value: string | undefined, option: string, maximum: number): number {
  const parsed = integer(value, option);
  if (parsed < 1) throw new Error(`${option} must be at least 1`);
  if (parsed > maximum) throw new Error(`${option} must be at most ${maximum}`);
  return parsed;
}

function integer(value: string | undefined, option: string): number {
  if (value === undefined || !/^-?\d+$/.test(value)) throw new Error(`${option} requires an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} requires a safe integer`);
  return parsed;
}

function ratio(value: string | undefined, option: string): number {
  if (value === undefined) throw new Error(`${option} requires a number from 0 to 1`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${option} must be between 0 and 1`);
  return parsed;
}

function parseInstallArgs(args: string[]): { target: import("./installer/agents.js").TargetSpec; location: Location; yes: boolean; command?: string; args?: string[]; autoIndex?: string } {
  let target: "auto"|"all"|"none"|string[] = "auto";
  let location: Location = "global";
  let yes = false;
  let command: string | undefined;
  let autoIndex: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--target" || a.startsWith("--target=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      target = v === "all" || v === "auto" || v === "none" ? v : (v ?? "").split(",");
    }
    else if (a === "--location" || a.startsWith("--location=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      if (v === "local" || v === "global") location = v;
    }
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--command" || a.startsWith("--command=")) command = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
    else if (a === "--auto-index" || a.startsWith("--auto-index=")) autoIndex = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
    else if (a === "--args" || a.startsWith("--args=")) {
      const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      rest.push(...(v ?? "").split(" "));
    }
  }
  return { target, location, yes, command, args: rest, autoIndex };
}
