/**
 * CodeLens — Pi Coding Agent extension.
 *
 * Bridges the CodeLens MCP server (stdio) into Pi by spawning it as a
 * long-lived child, performing the MCP handshake (initialize → tools/list),
 * and registering each tool with `pi.registerTool`. Each tool's `execute()`
 * forwards to `tools/call`. No external deps — pure child_process + JSON-RPC
 * over stdio line frames.
 *
 * Install: copy/symlink this file to ~/.pi/agent/extensions/codelens.ts
 * (Pi auto-discovers global extensions there; `/reload` hot-reloads it).
 *
 * The server script path resolves from (in order): CODELENS_SERVER env,
 * the launcher on PATH (~/.local/bin/codelens → handled below by exec'ing
 * node directly), or the build next to this repo. We exec `node <server.js>`
 * to avoid depending on the launcher being on PATH inside Pi's spawn env.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SERVER_PATH_FILE = join(homedir(), ".codelens", "server-path");

/** A resolved server spec: either `node <server.js>` or a direct launcher. */
interface ServerSpec { command: string; args: string[] }

/** Wrap a .js path with the current node binary; otherwise treat as a launcher. */
function specFor(path: string): ServerSpec {
  return path.endsWith(".js") || path.endsWith(".mjs")
    ? { command: process.execPath, args: [path] }
    : { command: path, args: [] };
}

function resolveServer(): ServerSpec | null {
  // 1. Installer-written absolute path (~/.codelens/server-path).
  try {
    if (existsSync(SERVER_PATH_FILE)) {
      const p = readFileSync(SERVER_PATH_FILE, "utf-8").trim();
      if (p && existsSync(p)) return specFor(p);
    }
  } catch { /* ignore */ }
  // 2. Env override.
  if (process.env.CODELENS_SERVER) {
    const p = process.env.CODELENS_SERVER;
    if (existsSync(p)) return specFor(p);
  }
  // 3. install.sh default location.
  const appBuild = join(homedir(), ".codelens", "app", "build", "src", "server.js");
  if (existsSync(appBuild)) return specFor(appBuild);
  // 4. Dev: extension lives at <repo>/adapters/pi/ → <repo>/build/src/server.js.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const dev = join(here, "..", "..", "..", "build", "src", "server.js");
    if (existsSync(dev)) return specFor(dev);
  } catch { /* ignore */ }
  return null;
}

// ── Minimal MCP stdio JSON-RPC client ────────────────────────

interface JsonRpcResponse { id?: number; result?: unknown; error?: { message: string }; }
interface ToolDef { name: string; description?: string; inputSchema?: Record<string, unknown>; }
interface PiCommandContext { ui: { notify(message: string, level?: string): void } }
interface PiExtensionAPI {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute(id: string, params: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
  }): void;
  registerCommand(name: string, command: { description: string; handler(args: string, ctx: PiCommandContext): Promise<void> | void }): void;
  on(name: string, handler: (event: { systemPrompt?: string; systemPromptOptions?: { cwd?: string } }) => Promise<unknown> | unknown): void;
}

class McpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  private buffer = "";

  start(spec: ServerSpec, cwd?: string): void {
    this.proc = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
      cwd,
    });
    this.proc.stdout!.setEncoding("utf-8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* not a JSON-RPC response line */ }
      }
    });
  }

  private request(method: string, params: unknown, timeoutMs = 30000): Promise<unknown> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); });
      this.proc!.stdin!.write(frame);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pi-codelens-bridge", version: "1.0.0" },
    });
    this.proc!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }

  async listTools(): Promise<ToolDef[]> {
    const r = (await this.request("tools/list", {})) as { tools?: ToolDef[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const r = (await this.request("tools/call", { name, arguments: args }, 120000)) as { content?: Array<{ type: string; text: string }>; isError?: boolean };
    return { content: r.content ?? [], isError: r.isError };
  }

  shutdown(): void {
    try { this.proc?.stdin?.end(); } catch { /* ignore */ }
    try { this.proc?.kill("SIGTERM"); } catch { /* ignore */ }
    this.proc = null;
  }
}

// ── Routing instructions injected into Pi's system prompt ─────
// Tells the LLM to prefer the cl_* tools over raw grep/find/read for code
// discovery. Only injected once the bridge has registered the tools.
const ROUTING = `
## CodeLens (code context index) — routing

A local branch-scoped code index is available via these tools:
- cl_current  — repo/branch/index status (call if unsure whether the index is ready)
- cl_search   — ranked semantic+lexical search → compact handles (path + line range + score)
- cl_explore  — one-call grouped search + previews + relationship map for broad orientation
- cl_related  — graph neighbors of a file/symbol (imports/importers/tests/callers)
- cl_impact   — callers/callees/affected files/tests before edits
- cl_map      — per-file symbol outline (repo map) for quick orientation
- cl_expand   — exact current file content by path/range (reads disk, never stale)

Prefer cl_* for discovery when:
- you don't know the exact name/string (semantic or conceptual search)
- you need broad orientation, relationships (importers, tests, callers), blast radius, or a quick outline
- the repo is large or unfamiliar, or you'd otherwise grep + read many files
- branch-scoped correctness matters (results won't leak across branches)

Raw grep/find/read is fine (or better) when:
- you already know an exact string/symbol/path
- you're reading or editing a single known file
- the repo is tiny or familiar

If a result has stale:true or freshness:"partial", read that file directly before relying on indexed snippets/edges.
Always use cl_expand or a raw read for the exact file you're about to edit.
After \`git checkout\`, results auto-scope to the new branch; call cl_current to
confirm. You do NOT need the user's permission to use these tools.`;

// ── Extension entry ──────────────────────────────────────────

export default function (pi: PiExtensionAPI) {
  const spec = resolveServer();
  if (!spec) {
    process.stderr.write(`[codelens] server not found. Run \`codelens install\` (writes ~/.codelens/server-path), or set CODELENS_SERVER=<path>/build/src/server.js, or run install.sh.\n`);
    return;
  }

  const serverSpec = spec;

  // Mutable bridge holder. Tools' execute() closures reference `client` and
  // `bridged` directly, so reassigning them on a project switch re-points every
  // tool at the new server child (no re-registration needed).
  let client: McpStdioClient | null = null;
  let bridged = false;
  let currentCwd = process.cwd();
  let toolsRegistered = false;

  async function boot(cwd: string): Promise<void> {
    try { client?.shutdown(); } catch { /* ignore */ }
    const c = new McpStdioClient();
    c.start(serverSpec, cwd); // spawn the server with cwd = the current project
    await c.initialize();
    const tools = await c.listTools();
    if (!toolsRegistered) {
      for (const tool of tools) {
        pi.registerTool({
          name: tool.name,
          label: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
          async execute(_id, params) {
            if (!client) throw new Error("codelens bridge not ready");
            const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>);
            const text = (result.content ?? []).filter((x) => x?.type === "text").map((x) => x.text).join("\n");
            if (result.isError) throw new Error(text || `${tool.name} returned an error`);
            return { content: [{ type: "text", text }], details: {} };
          },
        });
      }
      toolsRegistered = true;
    }
    client = c;
    currentCwd = cwd;
    bridged = true;
  }

  boot(currentCwd).catch((err: unknown) => {
    process.stderr.write(`[codelens] MCP bridge failed: ${err instanceof Error ? err.message : String(err)}\n`);
    bridged = false;
  });

  // Each turn: if Pi's cwd changed (project switch), respawn the server into
  // the new project so cl_search queries the right repo. Then inject routing.
  pi.on("before_agent_start", async (event: { systemPrompt?: string; systemPromptOptions?: { cwd?: string } }) => {
    const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
    if (bridged && cwd && cwd !== currentCwd) {
      try { await boot(cwd); } catch { /* keep old bridge on respawn failure */ }
    }
    if (!bridged) return {};
    const base = event.systemPrompt ?? "";
    if (base.includes("CodeLens (code context index)")) return {};
    return { systemPrompt: base + "\n" + ROUTING };
  });

  // ── Slash commands (discoverable via `/`) ────────────────────
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    if (!client || !bridged) return "codelens bridge not ready yet — wait a moment or /reload.";
    const r = await client.callTool(name, args);
    return (r.content ?? []).filter((c) => c?.type === "text").map((c) => c.text).join("\n");
  };
  const fmtBytes = (n: number) => (n < 1024 ? `${n}B` : n < 1048576 ? `${(n/1024).toFixed(1)}KB` : `${(n/1048576).toFixed(2)}MB`);

  pi.registerCommand("codelens-usage", {
    description: "Show codelens tool usage stats (global, across repos)",
    handler: async (_args, ctx) => {
      const text = await call("cl_usage");
      try {
        const u = JSON.parse(text);
        const t = u.totals ?? { calls: 0, bytes_served: 0, bytes_saved: 0 };
        const lines: string[] = [];
        lines.push(`cl_* usage (global) — calls: ${t.calls} | served: ${fmtBytes(t.bytes_served)} | saved(est): ${fmtBytes(t.bytes_saved)}`);
        lines.push("Per tool:");
        for (const row of (u.perTool ?? [])) lines.push(`  ${row.tool.padEnd(14)} calls=${row.calls}  served=${fmtBytes(row.bytes_served)}  saved=${fmtBytes(row.bytes_saved)}`);
        if (!(u.perTool ?? []).length) lines.push("  (no calls recorded yet)");
        lines.push("Per repo:");
        for (const r of (u.perRepo ?? [])) lines.push(`  ${r.repo_id.slice(0,8)}  calls=${r.calls}  saved=${fmtBytes(r.bytes_saved)}`);
        if (!(u.perRepo ?? []).length) lines.push("  (none)");
        ctx.ui.notify(lines.join("\n"), "info");
      } catch { ctx.ui.notify(text.slice(0, 800), "info"); }
    },
  });

  pi.registerCommand("codelens-stats", {
    description: "Show current index statistics (file/symbol/chunk/edge counts)",
    handler: async (_args, ctx) => { ctx.ui.notify((await call("cl_stats")).slice(0, 800), "info"); },
  });

  pi.registerCommand("codelens-doctor", {
    description: "Run a codelens health check",
    handler: async (_args, ctx) => { ctx.ui.notify((await call("cl_doctor")).slice(0, 800), "info"); },
  });

  pi.registerCommand("codelens-search", {
    description: "Search the current branch index: /codelens-search <query>",
    handler: async (args, ctx) => {
      const query = (args ?? "").trim();
      if (!query) { ctx.ui.notify("Usage: /codelens-search <query>", "warn"); return; }
      const text = await call("cl_search", { query, limit: 5 });
      try {
        const r = JSON.parse(text);
        const lines = (r.results ?? []).map((h: { score: number; path: string; lines: string; why?: string }) =>
          `${h.score.toFixed(3)}  ${h.path}:${h.lines}  [${h.why ?? ""}]`);
        ctx.ui.notify(lines.length ? lines.join("\n") : "no results", "info");
      } catch { ctx.ui.notify(text.slice(0, 800), "info"); }
    },
  });

  // Clean up the child on Pi shutdown.
  pi.on("shutdown", () => { try { client?.shutdown(); } catch { /* ignore */ } });
}
