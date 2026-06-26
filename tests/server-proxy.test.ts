import { describe, expect, it } from "vitest";
import { spawn, execFileSync, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonPaths, readDaemonMetadata } from "../src/runtime/daemon.js";
import { resolveReal } from "../src/util/paths.js";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

function makeRepo(): { repo: string; realRepo: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), "ce-proxy-repo-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "session.ts"), "export const session = true;\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  return { repo, realRepo: resolveReal(repo), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

class ProxyClient {
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private pending = new Map<number, (response: JsonRpcResponse) => void>();

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    this.child.stdout.setEncoding("utf-8");
    this.child.stderr.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out; stderr=${this.stderr}`));
      }, 10_000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const parsed = JSON.parse(line) as JsonRpcResponse;
      if (parsed.id !== undefined) this.pending.get(parsed.id)?.(parsed);
    }
  }
}

async function initializeAndListTools(client: ProxyClient): Promise<string[]> {
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "proxy-test", version: "1.0.0" },
  });
  client.notify("notifications/initialized");
  const result = await client.request("tools/list", {}) as { tools?: Array<{ name: string }> };
  return result.tools?.map((tool) => tool.name) ?? [];
}

function spawnProxy(serverJs: string, repoRoot: string, fakeHome: string): ProxyClient {
  const child = spawn(process.execPath, [serverJs, "--cwd", repoRoot, "--auto-index", "never"], {
    cwd: tmpdir(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: fakeHome, CODELENS_DAEMON_IDLE_MS: "10000" },
  });
  return new ProxyClient(child);
}

describe("MCP stdio proxy entrypoint", () => {
  it("keeps --smoke direct without starting a daemon", () => {
    execSync("npm run build", { stdio: "ignore" });
    const fakeHome = mkdtempSync(join(tmpdir(), "ce-proxy-smoke-home-"));
    const serverJs = join(process.cwd(), "build", "src", "server.js");
    try {
      const out = execFileSync(process.execPath, [serverJs, "--smoke"], {
        encoding: "utf-8",
        env: { ...process.env, HOME: fakeHome },
      });
      const parsed = JSON.parse(out) as { ok?: boolean; tools?: string[] };
      expect(parsed.ok).toBe(true);
      expect(parsed.tools).toContain("cl_search");
      expect(existsSync(join(fakeHome, ".codelens", "daemons"))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 30_000);

  it("shares one daemon across two default server entry processes", async () => {
    execSync("npm run build", { stdio: "ignore" });
    const { repo, realRepo, cleanup } = makeRepo();
    const fakeHome = mkdtempSync(join(tmpdir(), "ce-proxy-home-"));
    const serverJs = join(process.cwd(), "build", "src", "server.js");
    const paths = daemonPaths(realRepo, { home: fakeHome });
    const clients = [spawnProxy(serverJs, realRepo, fakeHome), spawnProxy(serverJs, realRepo, fakeHome)];

    try {
      const toolNames = await Promise.all(clients.map(initializeAndListTools));
      expect(toolNames[0]).toContain("cl_search");
      expect(toolNames[1]).toContain("cl_search");
      const metadata = readDaemonMetadata(paths);
      expect(metadata?.repoRoot).toBe(realRepo);
      expect(metadata?.pid).toBeGreaterThan(0);
      expect(existsSync(paths.metadataPath)).toBe(true);
      expect(JSON.parse(readFileSync(paths.metadataPath, "utf-8"))).toMatchObject({ pid: metadata?.pid });
    } finally {
      for (const client of clients) client.close();
      const metadata = readDaemonMetadata(paths);
      if (metadata?.pid) {
        try { process.kill(metadata.pid, "SIGTERM"); } catch { /* ignore */ }
      }
      cleanup();
      rmSync(fakeHome, { recursive: true, force: true });
      void repo;
    }
  }, 40_000);
});
