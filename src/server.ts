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
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CodeLens MCP server (Step 24 wiring).
 *
 * Resolves the repo root from cwd, opens the core index DB and the contexts DB
 * (separate file), registers all 10 tools from the registry, and starts the
 * stdio transport. Auto-prune runs on startup + periodic idle timer.
 */

function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "codelens", version: VERSION });

  for (const tool of TOOLS) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (args) => {
        const usage = new UsageTracker(openGlobalUsageDb());
        try {
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

function repoRootFromCwd(): string {
  return resolveReal(process.cwd());
}

const CLI_COMMANDS = new Set(["current","index","refresh","search","related","stats","usage","doctor","install","uninstall","upgrade","version","--print-config","-v","--version","--help","-h"]);

export async function main(): Promise<void> {
  // CLI dispatch: if the first arg is a known subcommand (bare word like
  // `install` or a flag-style one like `--print-config`/`--version`), run the
  // CLI with the FULL arg list so --target/--command/--yes are preserved.
  // Otherwise start the MCP stdio server.
  const fullArgs = process.argv.slice(2);
  const head = fullArgs[0];
  if (head && CLI_COMMANDS.has(head)) {
    const code = await cli(fullArgs);
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

  const repoRoot = repoRootFromCwd();
  let coreDb;
  try {
    coreDb = openDb(dbPathFor(repoRoot));
  } catch (err) {
    if (err instanceof CorruptDb) {
      // Production recovery: delete the corrupt DB file and rebuild on next refresh.
      const { rmSync } = await import("node:fs");
      try { rmSync(dbPathFor(repoRoot)); } catch { /* ignore */ }
      coreDb = openDb(dbPathFor(repoRoot));
    } else {
      throw err;
    }
  }
  const ctxDb = openContextDb(repoRoot);
  const ctx: ServerContext = { coreDb, ctxDb, repoRoot };
  scheduleAutoPrune(coreDb);
  const watcher = new FileWatcher(repoRoot);
  watcher.start();
  registerWatcher(watcher);

  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
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