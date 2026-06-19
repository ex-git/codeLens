import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { runInstall, runUninstall, printConfig, HOSTS } from "../src/installer/agents.js";
import { INSTRUCTIONS_START, INSTRUCTIONS_END } from "../src/installer/agents.js";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let origHome: string;
let fakeHome: string;

beforeAll(() => {
  origHome = process.env.HOME!;
  fakeHome = mkdtempSync(join(tmpdir(), "ce-installer-"));
  process.env.HOME = fakeHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

beforeEach(() => {
  // wipe home between tests for determinism
  rmSync(fakeHome, { recursive: true, force: true });
  mkdirSync(fakeHome, { recursive: true });
});

const CMD = "/home/u/.local/bin/codelens";

describe("installer: claude (JSON mcpServers)", () => {
  it("apply writes mcpServers entry to ~/.claude.json", () => {
    const r = runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: false });
    expect(r.configured.find((c) => c.host === "claude")?.wrote).toBe(true);
    const cfg = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf-8"));
    expect(cfg.mcpServers["codelens"]).toEqual({ command: CMD, args: [] });
  });
  it("apply is idempotent (already=true, no rewrite)", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: false });
    const r = runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: false });
    expect(r.configured.find((c) => c.host === "claude")?.already).toBe(true);
  });
  it("apply updates when command changes", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: false });
    runInstall({ serverCommand: "/new/path", location: "global", target: ["claude"], instructions: false });
    const cfg = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf-8"));
    expect(cfg.mcpServers["codelens"].command).toBe("/new/path");
  });
  it("remove deletes the entry", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: false });
    const r = runUninstall({ location: "global", target: ["claude"], instructions: false });
    expect(r.configured.find((c) => c.host === "claude")?.wrote).toBe(true);
    const cfg = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf-8"));
    expect(cfg.mcpServers["codelens"]).toBeUndefined();
  });
  it("preserves other existing mcpServers entries", () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: { "other-tool": { command: "x" } } }));
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: false });
    const cfg = JSON.parse(readFileSync(join(fakeHome, ".claude.json"), "utf-8"));
    expect(cfg.mcpServers["other-tool"]).toEqual({ command: "x" });
    expect(cfg.mcpServers["codelens"]).toBeDefined();
  });
});

describe("installer: instructions (marker-fenced)", () => {
  it("writes a marker-fenced block to CLAUDE.md and is idempotent", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: true });
    const p = join(fakeHome, ".claude", "CLAUDE.md");
    const content = readFileSync(p, "utf-8");
    expect(content).toContain(INSTRUCTIONS_START);
    expect(content).toContain(INSTRUCTIONS_END);
    // re-run → no duplicate block
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: true });
    const again = readFileSync(p, "utf-8");
    expect(again.split(INSTRUCTIONS_START).length - 1).toBe(1);
  });
  it("uninstall removes the block and leaves existing content", () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    writeFileSync(join(fakeHome, ".claude", "CLAUDE.md"), "My notes\n\n");
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: true });
    runUninstall({ location: "global", target: ["claude"], instructions: true });
    const content = readFileSync(join(fakeHome, ".claude", "CLAUDE.md"), "utf-8");
    expect(content).not.toContain(INSTRUCTIONS_START);
    expect(content).toContain("My notes");
  });
});

describe("installer: opencode (mcp object)", () => {
  it("writes under mcp with type/command/enabled", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["opencode"], instructions: false });
    const p = join(fakeHome, ".config", "opencode", "opencode.json");
    const cfg = JSON.parse(readFileSync(p, "utf-8"));
    expect(cfg.mcp["codelens"]).toEqual({ type: "local", command: [CMD], enabled: true });
  });

  it("does not overwrite an invalid existing JSON config", () => {
    const p = join(fakeHome, ".config", "opencode", "opencode.json");
    mkdirSync(join(fakeHome, ".config", "opencode"), { recursive: true });
    writeFileSync(p, "{ invalid json\n");
    expect(() => runInstall({ serverCommand: CMD, location: "global", target: ["opencode"], instructions: false })).toThrow(/Could not parse JSON config/);
    expect(readFileSync(p, "utf-8")).toBe("{ invalid json\n");
  });
});

describe("installer: codex (TOML)", () => {
  it("writes a [mcp_servers.codelens] block", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["codex"], instructions: false });
    const p = join(fakeHome, ".codex", "config.toml");
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("[mcp_servers.codelens]");
    expect(content).toContain(`command = "${CMD}"`);
  });
  it("replaces (not duplicates) on re-apply", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["codex"], instructions: false });
    runInstall({ serverCommand: "/new", location: "global", target: ["codex"], instructions: false });
    const content = readFileSync(join(fakeHome, ".codex", "config.toml"), "utf-8");
    expect(content.match(/\[mcp_servers\.codelens\]/g)?.length).toBe(1);
    expect(content).toContain(`command = "/new"`);
  });
  it("removes the block on uninstall", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["codex"], instructions: false });
    runUninstall({ location: "global", target: ["codex"], instructions: false });
    const content = readFileSync(join(fakeHome, ".codex", "config.toml"), "utf-8");
    expect(content).not.toContain("[mcp_servers.codelens]");
  });
});

describe("installer: target resolution + print-config", () => {
  it("target=all configures every writable host", () => {
    const r = runInstall({ serverCommand: CMD, location: "global", target: "all", instructions: false });
    const ids = r.configured.map((c) => c.host);
    expect(ids).toContain("claude");
    expect(ids).toContain("cursor");
    expect(ids).toContain("gemini");
    expect(ids).toContain("opencode");
    expect(ids).toContain("codex");
    // pi is print-config-only → skipped
    expect(r.skipped.some((s) => s.startsWith("pi"))).toBe(true);
  });
  it("target=auto only touches detected hosts (claude present)", () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    const r = runInstall({ serverCommand: CMD, location: "global", target: "auto", instructions: false });
    expect(r.configured.map((c) => c.host)).toContain("claude");
    expect(existsSync(join(fakeHome, ".cursor", "mcp.json"))).toBe(false); // cursor not detected
  });
  it("printConfig returns a snippet for each host", () => {
    for (const h of HOSTS) {
      const out = printConfig(h.id, CMD);
      expect(out).not.toBeNull();
    }
  });
});
describe("installer: cursor routing rule (.mdc)", () => {
  it("writes a dedicated codelens.mdc with frontmatter", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["cursor"], instructions: true });
    const p = join(fakeHome, ".cursor", "rules", "codelens.mdc");
    const content = readFileSync(p, "utf-8");
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("cl_search");
  });
  it("reinstall is idempotent (already=true)", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["cursor"], instructions: true });
    const r = runInstall({ serverCommand: CMD, location: "global", target: ["cursor"], instructions: true });
    expect(r.instructions.find((i) => i.host === "cursor")).toBeDefined();
  });
  it("uninstall deletes the .mdc file", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["cursor"], instructions: true });
    const p = join(fakeHome, ".cursor", "rules", "codelens.mdc");
    runUninstall({ location: "global", target: ["cursor"], instructions: true });
    expect(existsSync(p)).toBe(false);
  });
});

describe("installer: codex routing (AGENTS.md)", () => {
  it("writes a marker-fenced routing block to ~/.codex/AGENTS.md", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["codex"], instructions: true });
    const p = join(fakeHome, ".codex", "AGENTS.md");
    const content = readFileSync(p, "utf-8");
    expect(content).toContain(INSTRUCTIONS_START);
    expect(content).toContain("cl_search");
  });
  it("uninstall removes the block", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["codex"], instructions: true });
    const p = join(fakeHome, ".codex", "AGENTS.md");
    runUninstall({ location: "global", target: ["codex"], instructions: true });
    expect(readFileSync(p, "utf-8")).not.toContain(INSTRUCTIONS_START);
  });
});

describe("installer: claude slash commands", () => {
  it("writes codelens-* command .md files to ~/.claude/commands", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: false });
    const dir = join(fakeHome, ".claude", "commands");
    const usage = readFileSync(join(dir, "codelens-usage.md"), "utf-8");
    expect(usage).toContain("cl_usage");
    expect(existsSync(join(dir, "codelens-search.md"))).toBe(true);
    expect(existsSync(join(dir, "codelens-doctor.md"))).toBe(true);
    expect(existsSync(join(dir, "codelens-stats.md"))).toBe(true);
    // search command uses $ARGUMENTS
    expect(readFileSync(join(dir, "codelens-search.md"), "utf-8")).toContain("$ARGUMENTS");
  });
  it("uninstall removes the command files", () => {
    runInstall({ serverCommand: CMD, location: "global", target: ["claude"], instructions: false });
    const dir = join(fakeHome, ".claude", "commands");
    runUninstall({ location: "global", target: ["claude"], instructions: false });
    expect(existsSync(join(dir, "codelens-usage.md"))).toBe(false);
  });
  it("only claude gets command files (cursor/opencode have none)", () => {
    const r = runInstall({ serverCommand: CMD, location: "global", target: "all", instructions: false });
    expect(r.commands.map((c) => c.host)).toEqual(["claude"]);
  });
});
