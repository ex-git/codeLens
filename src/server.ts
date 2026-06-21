#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveReal } from "./util/paths.js";
import { openDb, openMemoryDb, CorruptDb } from "./db/db.js";
import { openContextDb, openMemoryContextDb } from "./context/store.js";
import { TOOLS, type ServerContext } from "./tools/registry.js";
import { UsageTracker, openGlobalUsageDb, DISCOVERY_TOOLS, TRACKED_TOOLS, estimateSavedFromPaths, extractDiscoveryPaths } from "./obs/usage.js";
import { getActiveIndexId } from "./index/manager.js";
import { scheduleAutoPrune } from "./index/autoprune.js";
import { FileWatcher } from "./index/watcher.js";
import { cli } from "./cli.js";
import { registerWatcher } from "./index/reindex.js";
import { VERSION } from "./version.js";
import { detectScope } from "./git/scope.js";
import { parseCwdArg, resolveCwd, isUsableCwd } from "./runtime/root.js";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CodeLens MCP server (Step 24 wiring).
 *
 * Resolves the repo root from cwd, opens the core index DB and the contexts DB
 * (separate file), registers all tools from the registry, and starts the stdio
 * transport. Auto-prune runs on startup + periodic idle timer.
 */

function createServer(ctx: ServerContext, beforeTool?: () => Promise<void>): McpServer {
  const server = new McpServer({ name: "codelens", version: VERSION });

  for (const tool of TOOLS) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (args) => {
        const usage = new UsageTracker(openGlobalUsageDb());
        try {
          if (beforeTool) await beforeTool();
          const result = await tool.handler(ctx, args as Record<string, unknown>);
          const text = JSON.stringify(result);
          let savedOverride: number | undefined;
          if (DISCOVERY_TOOLS.has(tool.name)) {
            try {
              const indexId = getActiveIndexId();
              if (indexId) savedOverride = estimateSavedFromPaths(ctx.coreDb, indexId, extractDiscoveryPaths(text), Buffer.byteLength(text));
            } catch { /* fall back to flat proxy */ }
          }
          try { if (TRACKED_TOOLS.has(tool.name)) usage.record(tool.name, ctx.repoRoot, text, false, savedOverride); } catch { /* usage best-effort */ }
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          const text = `Error: ${err instanceof Error ? err.message : String(err)}`;
          try { if (TRACKED_TOOLS.has(tool.name)) usage.record(tool.name, ctx.repoRoot, text, true); } catch { /* usage best-effort */ }
          return { content: [{ type: "text" as const, text }], isError: true };
        }
      },
    );
  }
  return server;
}

function repoRootFromCwd(cwd?: string): string {
  return resolveCwd(cwd);
}

const CLI_COMMANDS = new Set(["current","index","refresh","search","related","stats","usage","doctor","install","uninstall","upgrade","version","--print-config","-v","--version","--help","-h"]);

export async function main(): Promise<void> {
  // CLI dispatch: if the first arg is a known subcommand (bare word like
  // `install` or a flag-style one like `--print-config`/`--version`), run the
  // CLI with the FULL arg list so --target/--command/--yes are preserved.
  // Otherwise start the MCP stdio server.
  const parsed = parseCwdArg(process.argv.slice(2));
  const fullArgs = parsed.args;
  const head = fullArgs[0];
  if (head && CLI_COMMANDS.has(head)) {
    const code = await cli(process.argv.slice(2));
    process.exit(code);
    return;
  }

  // Smoke mode: register tools against an in-memory context and print names.
  if (process.argv.includes("--smoke")) {
    const ctx: ServerContext = { coreDb: openMemoryDb(), ctxDb: openMemoryContextDb(), repoRoot: "/tmp" };
    const server = createServer(ctx);
    void server;
    console.log(JSON.stringify({ ok: true, tools: TOOLS.map((t) => t.name) }));
    return;
  }

  const initialRoot = repoRootFromCwd(parsed.cwd);
  const runtime = openRuntime(initialRoot);
  const ctx: ServerContext = runtime.ctx;
  let watcher = runtime.watcher;
  let stopPrune = runtime.stopPrune;
  // Only treat root resolution as settled when an explicit, usable --cwd was
  // given. If --cwd was missing/unusable (e.g. unexpanded ${workspaceFolder}),
  // we fell back to process.cwd() and should still query MCP Roots.
  let rootsChecked = isUsableCwd(parsed.cwd);
  const serverRef: { current?: McpServer } = {};

  async function switchRoot(repoRoot: string): Promise<void> {
    if (repoRoot === ctx.repoRoot) return;
    // Open the new runtime first; only tear down the old one if it succeeds, so
    // a failure (e.g. DB permission error) leaves the working root intact.
    const next = openRuntime(repoRoot);
    watcher.stop();
    stopPrune();
    ctx.coreDb.close();
    ctx.ctxDb.close();
    ctx.repoRoot = next.ctx.repoRoot;
    ctx.coreDb = next.ctx.coreDb;
    ctx.ctxDb = next.ctx.ctxDb;
    watcher = next.watcher;
    stopPrune = next.stopPrune;
  }

  async function beforeTool(): Promise<void> {
    if (rootsChecked) return;
    rootsChecked = true;
    if (!serverRef.current) return;
    const root = await rootFromMcpRoots(serverRef.current);
    if (root) await switchRoot(root);
  }

  const server = createServer(ctx, beforeTool);
  serverRef.current = server;
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function openRuntime(repoRoot: string): { ctx: ServerContext; watcher: FileWatcher; stopPrune: () => void } {
  let coreDb;
  try {
    coreDb = openDb(dbPathFor(repoRoot));
  } catch (err) {
    if (err instanceof CorruptDb) {
      // Production recovery: delete the corrupt DB file and rebuild on next refresh.
      try { rmSync(dbPathFor(repoRoot)); } catch { /* ignore */ }
      coreDb = openDb(dbPathFor(repoRoot));
    } else {
      throw err;
    }
  }
  const ctxDb = openContextDb(repoRoot);
  const stopPrune = scheduleAutoPrune(coreDb);
  const watcher = new FileWatcher(repoRoot);
  watcher.start();
  registerWatcher(watcher);
  return { ctx: { coreDb, ctxDb, repoRoot }, watcher, stopPrune };
}

async function rootFromMcpRoots(server: McpServer): Promise<string | null> {
  try {
    if (!server.server.getClientCapabilities()?.roots) return null;
    const result = await server.server.listRoots(undefined, { timeout: 1000 });
    for (const root of result.roots) {
      if (!root.uri.startsWith("file://")) continue;
      const candidate = resolveReal(fileURLToPath(root.uri));
      if (detectScope(candidate)) return candidate;
    }
  } catch {
    // Best-effort only. Fallback remains explicit --cwd or process.cwd().
  }
  return null;
}

function dbPathFor(repoRoot: string): string {
  const dir = join(homedir(), ".codelens", "indexes");
  mkdirSync(dir, { recursive: true });
  const rid = createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
  return join(dir, `index-${rid}.db`);
}

main().catch((err: unknown) => {
  console.error("codelens server error:", err);
  process.exit(1);
});