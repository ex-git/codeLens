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
import { activatePersistentIndexIfReady, hasPersistentIndex, normalizeAutoIndexMode, spawnAutoIndex } from "./index/autoindex.js";
import { computeIndexId } from "./index/identity.js";
import { cli } from "./cli.js";
import { registerWatcher } from "./index/reindex.js";
import { VERSION } from "./version.js";
import { detectScope, type GitScope } from "./git/scope.js";
import { parseCwdArg, resolveCwd, isUsableCwd } from "./runtime/root.js";
import { acquireDaemonLock, connectOrStartDaemon, startDaemonSocketServer } from "./runtime/daemon.js";
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

interface RuntimeController {
  ctx: ServerContext;
  bindServer(server: McpServer): void;
  beforeTool(): Promise<void>;
  settleRootAndTriggerAutoIndex(): Promise<void>;
  rootsSettled(): boolean;
  close(): void;
}

function createRuntimeController(
  initialRoot: string,
  opts: { rootsChecked: boolean; autoIndexMode: ReturnType<typeof normalizeAutoIndexMode> },
): RuntimeController {
  const runtime = openRuntime(initialRoot);
  const ctx: ServerContext = runtime.ctx;
  let watcher = runtime.watcher;
  let stopPrune = runtime.stopPrune;
  let rootsChecked = opts.rootsChecked;
  const serverRef: { current?: McpServer } = {};
  let autoIndexTriggeredFor: string | null = null;

  function activateReadyIndex(scope: GitScope): void {
    activatePersistentIndexIfReady(ctx.coreDb, scope);
  }

  function checkAndTriggerAutoIndex(scope: GitScope): void {
    if (!rootsChecked || opts.autoIndexMode === "never" || !ctx.repoRoot) return;

    const indexId = computeIndexId(scope);
    if (autoIndexTriggeredFor === indexId) return;
    activateReadyIndex(scope);

    const shouldIndex = opts.autoIndexMode === "always" || (opts.autoIndexMode === "missing" && !hasPersistentIndex(ctx.coreDb, scope));
    if (!shouldIndex) return;

    autoIndexTriggeredFor = indexId;
    spawnAutoIndex(ctx.repoRoot, indexId);
  }

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

  async function tryResolveMcpRoots(): Promise<void> {
    if (rootsChecked || !serverRef.current) return;
    const capabilities = serverRef.current.server.getClientCapabilities();
    if (!capabilities) return;
    rootsChecked = true;
    const root = await rootFromMcpRoots(serverRef.current);
    if (root) await switchRoot(root);
  }

  async function settleRootAndTriggerAutoIndex(): Promise<void> {
    await tryResolveMcpRoots();
    const scope = detectScope(ctx.repoRoot);
    if (!scope) return;
    activateReadyIndex(scope);
    checkAndTriggerAutoIndex(scope);
  }

  return {
    ctx,
    bindServer(server: McpServer): void { serverRef.current = server; },
    beforeTool: settleRootAndTriggerAutoIndex,
    settleRootAndTriggerAutoIndex,
    rootsSettled: () => rootsChecked,
    close: () => {
      try { watcher.stop(); } catch { /* ignore */ }
      try { registerWatcher(null); } catch { /* ignore */ }
      try { stopPrune(); } catch { /* ignore */ }
      try { ctx.coreDb.close(); } catch { /* ignore */ }
      try { ctx.ctxDb.close(); } catch { /* ignore */ }
    },
  };
}

async function startDirectMcpServer(parsed: ReturnType<typeof parseCwdArg>): Promise<void> {
  const controller = createRuntimeController(repoRootFromCwd(parsed.cwd), {
    rootsChecked: isUsableCwd(parsed.cwd),
    autoIndexMode: normalizeAutoIndexMode(parsed.autoIndex, "missing"),
  });
  const server = createServer(controller.ctx, controller.beforeTool);
  controller.bindServer(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Explicit --cwd roots (Cursor's ${workspaceFolder}) are ready immediately;
  // roots-only clients may need initialize to complete first, so retry briefly.
  void (async () => {
    for (let i = 0; i < 10; i++) {
      await controller.settleRootAndTriggerAutoIndex();
      if (controller.rootsSettled()) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
}

async function proxyStdioToDaemon(socket: NodeJS.ReadWriteStream): Promise<void> {
  await new Promise<void>((resolve) => {
    socket.once("close", resolve);
    socket.once("end", resolve);
    socket.once("error", resolve);
    process.stdin.once("end", () => socket.end());
    process.stdin.once("close", () => socket.end());
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
}

async function startProxyMcpServer(parsed: ReturnType<typeof parseCwdArg>): Promise<void> {
  const repoRoot = repoRootFromCwd(parsed.cwd);
  if (!isUsableCwd(parsed.cwd) && !detectScope(repoRoot)) {
    await startDirectMcpServer(parsed);
    return;
  }

  const socket = await connectOrStartDaemon(repoRoot, {
    autoIndex: parsed.autoIndex,
    serverJs: fileURLToPath(import.meta.url),
  });
  await proxyStdioToDaemon(socket);
}

async function startDaemon(parsed: ReturnType<typeof parseCwdArg>): Promise<void> {
  const repoRoot = repoRootFromCwd(parsed.cwd);
  const lock = acquireDaemonLock(repoRoot);
  if (!lock) throw new Error(`codelens daemon already running for ${repoRoot}`);
  const daemonLock = lock;

  const heartbeatMs = Number.parseInt(process.env.CODELENS_DAEMON_HEARTBEAT_MS ?? "5000", 10);
  const idleMs = Number.parseInt(process.env.CODELENS_DAEMON_IDLE_MS ?? "30000", 10);
  const heartbeat = setInterval(() => daemonLock.heartbeat(), Number.isFinite(heartbeatMs) ? heartbeatMs : 5000);
  const controller = createRuntimeController(repoRoot, {
    rootsChecked: true,
    autoIndexMode: normalizeAutoIndexMode(parsed.autoIndex, "missing"),
  });
  let socketServer: Awaited<ReturnType<typeof startDaemonSocketServer>> | null = null;

  async function cleanup(): Promise<void> {
    clearInterval(heartbeat);
    try { await socketServer?.close(); } catch { /* ignore */ }
    controller.close();
    daemonLock.release();
  }

  function shutdown(): void {
    void cleanup().finally(() => process.exit(0));
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.once("exit", () => { daemonLock.release(); });

  socketServer = await startDaemonSocketServer(
    daemonLock.paths,
    async (socket) => {
      const server = createServer(controller.ctx, controller.beforeTool);
      controller.bindServer(server);
      const transport = new StdioServerTransport(socket, socket);
      await server.connect(transport);
    },
    { idleMs: Number.isFinite(idleMs) ? idleMs : 30000, onIdle: shutdown },
  );

  await controller.settleRootAndTriggerAutoIndex();
}

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

  if (head === "--daemon") {
    await startDaemon(parsed);
    return;
  }

  await startProxyMcpServer(parsed);
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