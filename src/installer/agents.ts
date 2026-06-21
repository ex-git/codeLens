import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { VERSION } from "../version.js";

/**
 * Agent/IDE wiring (installs the CodeLens MCP server config into each
 * detected host). Mirrors the codegraph `codegraph install` two-part design:
 * the bootstrap install.sh puts the binary on PATH; this module connects it to
 * the agents/IDEs the user actually runs.
 *
 * Design:
 *   - JSON hosts (claude/cursor/gemini): idempotent upsert of a stable-named
 *     `codelens` entry under `mcpServers` (or the host's equivalent).
 *     Removal = delete that key. No marker comments (JSON has none).
 *   - opencode: writes under `mcp` with a `{type:"local", command:[...], enabled:true}` shape.
 *   - codex: TOML `[mcp_servers.codelens]` block, replaced via regex marker.
 *   - Instructions (CLAUDE.md/AGENTS.md/GEMINI.md): marker-fenced routing block.
 *   - `--print-config <id>` dumps the snippet for any host (incl. pi/vscode we
 *     don't auto-write) so users can paste into anything we don't handle.
 *
 * All file writes are read-modify-write and idempotent. Tests cover round-trips.
 */

export type Location = "global" | "local";
export type TargetSpec = "auto" | "all" | "none" | string[];

/**
 * Args that attach the server to the workspace. Cursor (and VS Code family)
 * expand `${workspaceFolder}` in BOTH global and local mcp.json, so Cursor gets
 * it at any location for a one-shot attach. Other hosts have no portable
 * workspace variable: local installs pin the concrete workspace root (the dir
 * the local config is written into = process.cwd() at install time), while
 * global installs return [] and rely on MCP Roots (a single global config must
 * not pin one repo).
 */
function workspaceCwdArgs(hostId: string, loc?: Location): string[] {
  if (hostId === "cursor") return ["--cwd", "${workspaceFolder}"];
  if (loc !== "local") return [];
  return ["--cwd", process.cwd()];
}

export interface HostAdapter {
  id: string;
  name: string;
  /** Path to the host's MCP config file for the given scope, or null if N/A. */
  configPath(loc: Location): string | null;
  /** Path to the host's instructions file, or null if it has none. */
  instructionsPath(loc: Location): string | null;
  /** If true, instructions are a dedicated file we own (write whole file / delete). */
  dedicatedInstructions?: boolean;
  /** Full content for a dedicated instructions file (when dedicatedInstructions is true). */
  instructionsContent?(): string;
  /** True if the host appears installed (config dir / app present). */
  detect(): boolean;
  /** Build the MCP server entry value to store. */
  buildEntry(serverCommand: string, loc?: Location): unknown;
  /** Apply the entry to the host config (idempotent). Returns write info. */
  apply(serverCommand: string, loc: Location): ApplyResult;
  /** Remove our entry from the host config. */
  remove(loc: Location): ApplyResult;
  /** Config key/section name we own (for removal). */
  readonly entryKey: string;
  /** Optional slash-command files this host supports (name -> prompt content). */
  commandsFiles?(): { name: string; content: string }[];
  /** Directory to write command files for the given scope, or null. */
  commandsDir?(loc: Location): string | null;
}

export interface ApplyResult {
  wrote: boolean;     // whether a file was modified
  path: string;       // config path touched
  already?: boolean;  // entry already present and unchanged
}

const INSTRUCTIONS_START = `<!-- codelens routing start (managed by \`codelens install\`) -->`;
const INSTRUCTIONS_END = `<!-- codelens routing end -->`;
const CODEX_START = `# codelens routing start (managed by \`codelens install\`)`;
const CODEX_END = `# codelens routing end`;
const INSTRUCTIONS_BODY = `# CodeLens routing

Prefer the codelens MCP tools (\`cl_search\`, \`cl_explore\`, \`cl_related\`,
\`cl_impact\`, \`cl_expand\`, \`cl_map\`, \`cl_save\`, \`cl_load\`) for code
discovery — they keep context lean and are branch-scoped.

Use codelens when:
- you don't know the exact name/string (semantic or conceptual search)
- you need broad orientation in one call (\`cl_explore\`)
- you need relationships (importers, tests, callers), blast radius before edits (\`cl_impact\`), or a file outline
- the repo is large or unfamiliar, or you'd otherwise grep + read many files

Raw \`grep\`/\`find\`/\`read\` is fine when:
- you already know an exact string/symbol/path
- you're reading or editing a single known file
- the repo is tiny or familiar

If a result has \`stale:true\` or \`freshness:"partial"\`, read that file directly before relying on indexed snippets/edges.
If \`cl_current.inGitRepo\` is false or the repo path is not this workspace, CodeLens isn't attached: tell the user to restart the IDE after upgrading (the global Cursor config attaches via \`\${workspaceFolder}\`), or run \`codelens install --target cursor --yes\`; do not silently fall back to raw find/grep.
Always use \`cl_expand\` or a raw read for the exact file you're about to edit.
Results are scoped to the current branch; call \`cl_current\` after a
\`git checkout\`. See \`docs/routing.md\`. Remove with: \`codelens uninstall\`.`;

// ── JSON helpers ──────────────────────────────────────────────

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not parse JSON config at ${path}: ${msg}`);
  }
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Shared JSON-mcpServers apply/remove ───────────────────────

function jsonApply(path: string, serversKey: string, entryKey: string, entry: unknown): ApplyResult {
  const cfg = existsSync(path) ? readJson(path) : {};
  const servers = (cfg[serversKey] ?? {}) as Record<string, unknown>;
  if (deepEqualJson(servers[entryKey], entry)) {
    return { wrote: false, path, already: true };
  }
  servers[entryKey] = entry;
  cfg[serversKey] = servers;
  writeJson(path, cfg);
  return { wrote: true, path };
}

function jsonRemove(path: string, serversKey: string, entryKey: string): ApplyResult {
  if (!existsSync(path)) return { wrote: false, path };
  const cfg = readJson(path);
  const servers = (cfg[serversKey] ?? {}) as Record<string, unknown>;
  if (!(entryKey in servers)) return { wrote: false, path, already: true };
  delete servers[entryKey];
  cfg[serversKey] = servers;
  writeJson(path, cfg);
  return { wrote: true, path };
}

// ── Instructions (marker-fenced) ───────────────────────────────

function writeInstructions(path: string | null): ApplyResult {
  if (!path) return { wrote: false, path: "" };
  let existing = "";
  try { existing = readFileSync(path, "utf-8"); } catch { /* none */ }
  const block = `${INSTRUCTIONS_START}\n${INSTRUCTIONS_BODY}\n${INSTRUCTIONS_END}\n`;
  const startIdx = existing.indexOf(INSTRUCTIONS_START);
  if (startIdx >= 0) {
    const endIdx = existing.indexOf(INSTRUCTIONS_END, startIdx);
    if (endIdx >= 0) {
      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + INSTRUCTIONS_END.length);
      const rebuilt = before + block.trimEnd() + after;
      if (rebuilt === existing) return { wrote: false, path, already: true };
      writeFileSync(path, rebuilt, "utf-8");
      return { wrote: true, path };
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, existing + (existing.endsWith("\n") || existing === "" ? "" : "\n") + block, "utf-8");
  return { wrote: true, path };
}

function removeInstructions(path: string | null): ApplyResult {
  if (!path || !existsSync(path)) return { wrote: false, path: path ?? "" };
  const existing = readFileSync(path, "utf-8");
  const startIdx = existing.indexOf(INSTRUCTIONS_START);
  if (startIdx < 0) return { wrote: false, path, already: true };
  const endIdx = existing.indexOf(INSTRUCTIONS_END, startIdx);
  if (endIdx < 0) return { wrote: false, path };
  const rebuilt = (existing.slice(0, startIdx) + existing.slice(endIdx + INSTRUCTIONS_END.length)).replace(/\n{3,}/g, "\n\n");
  writeFileSync(path, rebuilt, "utf-8");
  return { wrote: true, path };
}


/** Write a dedicated instructions file we own (Cursor .mdc). Overwrites. */
function writeDedicatedInstructions(path: string, content: string): ApplyResult {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (existsSync(path) && readFileSync(path, "utf-8") === content) return { wrote: false, path, already: true };
  } catch { /* ignore */ }
  writeFileSync(path, content, "utf-8");
  return { wrote: true, path };
}

/** Delete a dedicated instructions file we own. */
function removeDedicatedInstructions(path: string): ApplyResult {
  if (!existsSync(path)) return { wrote: false, path, already: true };
  try { rmSync(path); return { wrote: true, path }; } catch { return { wrote: false, path }; }
}

/** Write a host's slash-command files (owned by us, namespaced codelens-*). */
function writeCommandFiles(dir: string, files: { name: string; content: string }[]): ApplyResult[] {
  mkdirSync(dir, { recursive: true });
  return files.map((f) => writeDedicatedInstructions(join(dir, f.name), f.content));
}

/** Remove our namespaced command files from a dir. */
function removeCommandFiles(dir: string, names: string[]): ApplyResult[] {
  return names.map((n) => {
    const path = join(dir, n);
    if (!existsSync(path)) return { wrote: false, path, already: true };
    try { rmSync(path); return { wrote: true, path }; } catch { return { wrote: false, path }; }
  });
}

// ── Host adapters ─────────────────────────────────────────────


class ClaudeCodeTarget implements HostAdapter {
  readonly id = "claude";
  readonly name = "Claude Code";
  readonly entryKey = "codelens";
  configPath(loc: Location): string {
    return loc === "global" ? join(homedir(), ".claude.json") : join(process.cwd(), ".mcp.json");
  }
  instructionsPath(loc: Location): string {
    return loc === "global" ? join(homedir(), ".claude", "CLAUDE.md") : join(process.cwd(), "CLAUDE.md");
  }
  detect(): boolean {
    return existsSync(join(homedir(), ".claude.json")) || existsSync(join(homedir(), ".claude"));
  }
  buildEntry(cmd: string, loc?: Location): unknown {
    return { command: cmd, args: workspaceCwdArgs(this.id, loc) };
  }
  apply(cmd: string, loc: Location): ApplyResult { return jsonApply(this.configPath(loc), "mcpServers", this.entryKey, this.buildEntry(cmd, loc)); }
  remove(loc: Location): ApplyResult { return jsonRemove(this.configPath(loc), "mcpServers", this.entryKey); }
  commandsDir(loc: Location): string {
    return loc === "global" ? join(homedir(), ".claude", "commands") : join(process.cwd(), ".claude", "commands");
  }
  commandsFiles(): { name: string; content: string }[] {
    return [
      { name: "codelens-usage.md", content: "Call the `cl_usage` MCP tool and report the per-tool call counts, bytes served, and estimated context bytes saved." },
      { name: "codelens-stats.md", content: "Call the `cl_stats` MCP tool and report the current index statistics (files/symbols/chunks/edges)." },
      { name: "codelens-doctor.md", content: "Call the `cl_doctor` MCP tool and report the health check results." },
      { name: "codelens-search.md", content: "Call the `cl_search` MCP tool with query: $ARGUMENTS (limit 5). Show the ranked handles." },
      { name: "codelens-explore.md", content: "Call the `cl_explore` MCP tool with query: $ARGUMENTS (limit 8). Summarize grouped files and relationships." },
      { name: "codelens-impact.md", content: "Call the `cl_impact` MCP tool for symbol/path: $ARGUMENTS. Summarize callers, callees, affected files, and affected tests." },
      { name: "codelens-refresh.md", content: "Call the `cl_refresh` MCP tool to build/update the current branch index, then report the result." },
    ];
  }
}

class CursorTarget implements HostAdapter {
  readonly id = "cursor";
  readonly name = "Cursor";
  readonly entryKey = "codelens";
  dedicatedInstructions = true;
  configPath(loc: Location): string {
    return loc === "global" ? join(homedir(), ".cursor", "mcp.json") : join(process.cwd(), ".cursor", "mcp.json");
  }
  instructionsPath(loc: Location): string {
    return loc === "global" ? join(homedir(), ".cursor", "rules", "codelens.mdc") : join(process.cwd(), ".cursor", "rules", "codelens.mdc");
  }
  instructionsContent(): string {
    return `---
description: Route code discovery to codelens tools
globs: "**/*"
alwaysApply: true
---

` + INSTRUCTIONS_BODY;
  }
  detect(): boolean { return existsSync(join(homedir(), ".cursor")); }
  buildEntry(cmd: string, loc?: Location): unknown { return { command: cmd, args: workspaceCwdArgs(this.id, loc) }; }
  apply(cmd: string, loc: Location): ApplyResult { return jsonApply(this.configPath(loc), "mcpServers", this.entryKey, this.buildEntry(cmd, loc)); }
  remove(loc: Location): ApplyResult { return jsonRemove(this.configPath(loc), "mcpServers", this.entryKey); }
}

class GeminiTarget implements HostAdapter {
  readonly id = "gemini";
  readonly name = "Gemini CLI";
  readonly entryKey = "codelens";
  configPath(loc: Location): string {
    return loc === "global" ? join(homedir(), ".gemini", "settings.json") : join(process.cwd(), ".gemini", "settings.json");
  }
  instructionsPath(loc: Location): string {
    return loc === "global" ? join(homedir(), ".gemini", "GEMINI.md") : join(process.cwd(), "GEMINI.md");
  }
  detect(): boolean { return existsSync(join(homedir(), ".gemini")); }
  buildEntry(cmd: string, loc?: Location): unknown { return { command: cmd, args: workspaceCwdArgs(this.id, loc) }; }
  apply(cmd: string, loc: Location): ApplyResult { return jsonApply(this.configPath(loc), "mcpServers", this.entryKey, this.buildEntry(cmd, loc)); }
  remove(loc: Location): ApplyResult { return jsonRemove(this.configPath(loc), "mcpServers", this.entryKey); }
}

class OpencodeTarget implements HostAdapter {
  readonly id = "opencode";
  readonly name = "opencode";
  readonly entryKey = "codelens";
  configPath(loc: Location): string {
    const base = loc === "global" ? join(homedir(), ".config", "opencode", "opencode.json") : join(process.cwd(), "opencode.json");
    return base;
  }
  instructionsPath(loc: Location): string {
    return loc === "global" ? join(homedir(), ".config", "opencode", "AGENTS.md") : join(process.cwd(), "AGENTS.md");
  }
  detect(): boolean { return existsSync(join(homedir(), ".config", "opencode")) || existsSync(join(process.cwd(), "opencode.json")); }
  buildEntry(cmd: string, loc?: Location): unknown {
    return { type: "local", command: [cmd, ...workspaceCwdArgs(this.id, loc)], enabled: true };
  }
  apply(cmd: string, loc: Location): ApplyResult {
    // opencode uses a "mcp" object whose values are {type, command, enabled}.
    const path = this.configPath(loc);
    const cfg = existsSync(path) ? readJson(path) : {};
    const mcp = (cfg["mcp"] ?? {}) as Record<string, unknown>;
    const entry = this.buildEntry(cmd, loc);
    if (deepEqualJson(mcp[this.entryKey], entry)) return { wrote: false, path, already: true };
    mcp[this.entryKey] = entry;
    cfg["mcp"] = mcp;
    writeJson(path, cfg);
    return { wrote: true, path };
  }
  remove(loc: Location): ApplyResult {
    const path = this.configPath(loc);
    if (!existsSync(path)) return { wrote: false, path };
    const cfg = readJson(path);
    const mcp = (cfg["mcp"] ?? {}) as Record<string, unknown>;
    if (!(this.entryKey in mcp)) return { wrote: false, path, already: true };
    delete mcp[this.entryKey];
    cfg["mcp"] = mcp;
    writeJson(path, cfg);
    return { wrote: true, path };
  }
}

class CodexTarget implements HostAdapter {
  readonly id = "codex";
  readonly name = "Codex CLI";
  readonly entryKey = "codelens";
  configPath(loc: Location): string {
    return loc === "global" ? join(homedir(), ".codex", "config.toml") : join(process.cwd(), ".codex", "config.toml");
  }
  instructionsPath(loc: Location): string {
    // Codex reads AGENTS.md from the project up to home. Global is best-effort
    // (~/.codex/AGENTS.md); --location=local writes ./AGENTS.md (definitely read).
    return loc === "global" ? join(homedir(), ".codex", "AGENTS.md") : join(process.cwd(), "AGENTS.md");
  }
  detect(): boolean { return existsSync(join(homedir(), ".codex")); }
  buildEntry(_cmd: string): unknown { return null; } // TOML; use tomlBlock()
  tomlBlock(cmd: string, loc?: Location): string {
    const args = workspaceCwdArgs(this.id, loc);
    return `${CODEX_START}\n[mcp_servers.codelens]\ncommand = "${cmd.replace(/"/g, '\\"')}"\nargs = ${JSON.stringify(args)}\n${CODEX_END}`;
  }
  apply(cmd: string, loc: Location): ApplyResult {
    const path = this.configPath(loc);
    mkdirSync(dirname(path), { recursive: true });
    let existing = "";
    try { existing = readFileSync(path, "utf-8"); } catch { /* none */ }
    const block = this.tomlBlock(cmd, loc);
    const startIdx = existing.indexOf(CODEX_START);
    if (startIdx >= 0) {
      const endIdx = existing.indexOf(CODEX_END, startIdx);
      const end = endIdx >= 0 ? endIdx + CODEX_END.length : existing.length;
      const rebuilt = existing.slice(0, startIdx) + block + existing.slice(end);
      if (rebuilt === existing) return { wrote: false, path, already: true };
      writeFileSync(path, rebuilt, "utf-8");
      return { wrote: true, path };
    }
    const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(path, existing + sep + block + "\n", "utf-8");
    return { wrote: true, path };
  }
  remove(loc: Location): ApplyResult {
    const path = this.configPath(loc);
    if (!existsSync(path)) return { wrote: false, path };
    const existing = readFileSync(path, "utf-8");
    const startIdx = existing.indexOf(CODEX_START);
    if (startIdx < 0) return { wrote: false, path, already: true };
    const endIdx = existing.indexOf(CODEX_END, startIdx);
    const end = endIdx >= 0 ? endIdx + CODEX_END.length : existing.length;
    const rebuilt = (existing.slice(0, startIdx) + existing.slice(end)).replace(/\n{3,}/g, "\n\n");
    writeFileSync(path, rebuilt, "utf-8");
    return { wrote: true, path };
  }
}

// Print-only hosts (we don't auto-write; --print-config dumps the snippet).
class PiTarget implements HostAdapter {
  readonly id = "pi";
  readonly name = "Pi Coding Agent";
  readonly entryKey = "codelens";
  configPath(): string | null { return null; }
  instructionsPath(): string | null { return null; }
  detect(): boolean { return existsSync(join(homedir(), ".pi")); }
  buildEntry(cmd: string): unknown { return { type: "mcp", command: cmd, args: [] as string[] }; }
  apply(): ApplyResult { return { wrote: false, path: "" }; }
  remove(): ApplyResult { return { wrote: false, path: "" }; }
}

export const HOSTS: HostAdapter[] = [
  new ClaudeCodeTarget(),
  new CursorTarget(),
  new GeminiTarget(),
  new OpencodeTarget(),
  new CodexTarget(),
  new PiTarget(),
];

export function getHost(id: string): HostAdapter | undefined {
  return HOSTS.find((h) => h.id === id);
}

// ── Orchestration ─────────────────────────────────────────────

export interface InstallOptions {
  serverCommand: string;     // absolute path to the launcher/binary
  location: Location;
  target: TargetSpec; // host ids
  instructions?: boolean;     // also write routing instructions (default true)
  yes?: boolean;             // non-interactive
  dryRun?: boolean;
}

export interface InstallReport {
  configured: { host: string; path: string; wrote: boolean; already?: boolean }[];
  instructions: { host: string; path: string; wrote: boolean }[];
  commands: { host: string; wrote: number; already: number }[];
  skipped: string[];
  serverCommand: string;
}

/** Write the absolute server path so the Pi extension (and other launchers)
 * can find the server without env or relative-path guessing. */
export function writeServerPath(serverCommand: string): void {
  try {
    const dir = join(homedir(), ".codelens");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "server-path"), serverCommand + "\n", "utf-8");
  } catch { /* best-effort */ }
}

export function runInstall(opts: InstallOptions): InstallReport {
  writeServerPath(opts.serverCommand);
  const report: InstallReport = { configured: [], instructions: [], commands: [], skipped: [], serverCommand: opts.serverCommand };
  const targets = resolveTargets(opts.target);
  for (const h of HOSTS) {
    if (!targets.includes(h.id)) continue;
    if (h.id === "pi" || h.configPath(opts.location) === null) { report.skipped.push(`${h.id} (print-config only)`); continue; }
    const r = h.apply(opts.serverCommand, opts.location);
    report.configured.push({ host: h.id, path: r.path, wrote: r.wrote, already: r.already });
    if (opts.instructions !== false) {
      const ip = h.instructionsPath(opts.location);
      if (ip) {
        const ir = h.dedicatedInstructions && h.instructionsContent
          ? writeDedicatedInstructions(ip, h.instructionsContent())
          : writeInstructions(ip);
        if (ir.wrote || ir.already) report.instructions.push({ host: h.id, path: ip, wrote: ir.wrote });
      }
    }
    if (h.commandsFiles && h.commandsDir) {
      const dir = h.commandsDir(opts.location);
      if (dir) {
        const files = h.commandsFiles();
        const results = writeCommandFiles(dir, files);
        const wrote = results.filter((r) => r.wrote).length;
        const already = results.filter((r) => r.already).length;
        if (wrote || already) report.commands.push({ host: h.id, wrote, already });
      }
    }
  }
  return report;
}

export function runUninstall(opts: { location: Location; target: TargetSpec; instructions?: boolean }): InstallReport {
  const report: InstallReport = { configured: [], instructions: [], commands: [], skipped: [], serverCommand: "" };
  const targets = resolveTargets(opts.target);
  for (const h of HOSTS) {
    if (!targets.includes(h.id)) continue;
    if (h.configPath(opts.location) === null) { report.skipped.push(`${h.id} (print-config only)`); continue; }
    const r = h.remove(opts.location);
    report.configured.push({ host: h.id, path: r.path, wrote: r.wrote, already: r.already });
    if (opts.instructions !== false) {
      const ip = h.instructionsPath(opts.location);
      if (ip) {
        const ir = h.dedicatedInstructions
          ? removeDedicatedInstructions(ip)
          : removeInstructions(ip);
        if (ir.wrote) report.instructions.push({ host: h.id, path: ip, wrote: ir.wrote });
      }
    }
    if (h.commandsFiles && h.commandsDir) {
      const dir = h.commandsDir(opts.location);
      if (dir) {
        const names = h.commandsFiles().map((f) => f.name);
        const results = removeCommandFiles(dir, names);
        const wrote = results.filter((r) => r.wrote).length;
        if (wrote) report.commands.push({ host: h.id, wrote, already: 0 });
      }
    }
  }
  return report;
}

function resolveTargets(target: TargetSpec): string[] {
  if (target === "all") return HOSTS.map((h) => h.id);
  if (target === "none") return [];
  if (target === "auto") return HOSTS.filter((h) => h.detect()).map((h) => h.id);
  return target as string[];
}

/** Print the MCP config snippet for a host (no file writes). */
export function printConfig(hostId: string, serverCommand: string, loc: Location = "global"): string | null {
  const h = getHost(hostId);
  if (!h) return null;
  if (h.id === "codex") return (h as unknown as CodexTarget).tomlBlock(serverCommand, loc);
  if (h.id === "pi") {
    return `# Pi supports MCP via a TS extension bridge. Add an MCP extension manifest\n# (see adapters/pi/extension.json) pointing at: ${serverCommand}`;
  }
  const entry = h.buildEntry(serverCommand, loc);
  const key = h.id === "opencode" ? "mcp" : "mcpServers";
  const cfg = { [key]: { [h.entryKey]: entry } };
  return `${h.configPath(loc)}:\n${JSON.stringify(cfg, null, 2)}`;
}

export { VERSION, writeInstructions, removeInstructions, INSTRUCTIONS_START, INSTRUCTIONS_END, readJson };