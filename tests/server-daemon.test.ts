import { describe, expect, it, beforeAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonPaths } from "../src/runtime/daemon.js";
import { resolveReal } from "../src/util/paths.js";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

function makeRepo(): { repo: string; realRepo: string; cleanup: () => void } {
  const repo = mkdtempSync(join(tmpdir(), "ce-daemon-repo-"));
  execSync("git init -q", { cwd: repo });
  execSync("git config user.email t@t.t && git config user.name t && git config maintenance.auto false && git config gc.auto 0", { cwd: repo });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "session.ts"), "export const session = true;\n");
  execSync("git add -A && git commit -q -m init", { cwd: repo });
  return { repo, realRepo: resolveReal(repo), cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

class JsonLineClient {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, (response: JsonRpcResponse) => void>();

  constructor(private socket: Socket) {
    this.socket.setEncoding("utf-8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 5_000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        if (response.error) reject(new Error(response.error.message));
        else resolve(response.result);
      });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.socket.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  close(): void {
    this.socket.destroy();
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

function waitForDaemon(socketPath: string, child: ChildProcess, stderr: () => string): Promise<Socket> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      if (child.exitCode !== null) {
        reject(new Error(`daemon exited early (${child.exitCode}): ${stderr()}`));
        return;
      }
      const socket = createConnection(socketPath);
      socket.once("connect", () => resolve(socket));
      socket.once("error", (err) => {
        socket.destroy();
        if (Date.now() - start > 10_000) reject(err);
        else setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit in time")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("daemon MCP socket mode", () => {
  beforeAll(() => {
    execSync("npm run build", { stdio: "ignore" });
  }, 30_000);

  it("serves tools with one setup scope per request and observes branch switches", async () => {
    const { repo, realRepo, cleanup } = makeRepo();
    const fakeHome = mkdtempSync(join(tmpdir(), "ce-daemon-home-"));
    const paths = daemonPaths(realRepo, { home: fakeHome });
    const serverJs = join(process.cwd(), "build", "src", "server.js");
    let stderr = "";
    const daemon = spawn(process.execPath, [serverJs, "--cwd", realRepo, "--auto-index", "never", "--daemon"], {
      cwd: tmpdir(),
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, HOME: fakeHome, GIT_TRACE2_EVENT: join(fakeHome, "git-trace.jsonl") },
    });
    daemon.stderr?.setEncoding("utf-8");
    daemon.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    let client: JsonLineClient | null = null;
    try {
      const socket = await waitForDaemon(paths.socketPath, daemon, () => stderr);
      client = new JsonLineClient(socket);
      await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "daemon-test", version: "1.0.0" },
      });
      client.notify("notifications/initialized");
      const tools = await client.request("tools/list", {}) as { tools?: Array<{ name: string }> };
      expect(tools.tools?.map((tool) => tool.name)).toContain("cl_search");
      await client.request("tools/call", { name: "cl_refresh", arguments: {} });
      const invoke = async (name: string, args: Record<string, unknown> = {}, quiet = false) => {
        const trace = join(fakeHome, "git-trace.jsonl"), offset = readFileSync(trace, "utf8").length;
        const response = await client!.request("tools/call", { name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
        const starts = readFileSync(trace, "utf8").slice(offset).trim().split("\n").filter(Boolean)
          .map(line => JSON.parse(line) as { event?: string; argv?: string[] }).filter(row => row.event === "start");
        expect(starts.filter(row => row.argv?.includes("--show-toplevel"))).toHaveLength(1);
        if (quiet) expect(starts.filter(row => row.argv?.includes("ls-files"))).toHaveLength(0);
        return response;
      };
      const current = await invoke("cl_current");
      expect(JSON.parse(current.content[0]!.text).repo).toBe(realRepo);
      const search = await invoke("cl_search", { query: "session" });
      expect(JSON.parse(search.content[0]!.text).count).toBeGreaterThan(0);
      await invoke("cl_search", { query: "session" }, true);
      expect((await invoke("cl_diff", { base: "does-not-exist" })).isError).toBe(true);
      execSync("git checkout -qb request-next", { cwd: repo });
      const next = await invoke("cl_current");
      expect(JSON.parse(next.content[0]!.text).branch).toBe("request-next");
      writeFileSync(join(repo, "src", "session.ts"), "export const replacementSession = true;\n");
      const edited = await invoke("cl_search", { query: "replacementSession" });
      expect(JSON.parse(edited.content[0]!.text).count).toBeGreaterThan(0);
    } finally {
      client?.close();
      daemon.kill("SIGTERM");
      await waitForExit(daemon);
      expect(existsSync(paths.metadataPath)).toBe(false);
      expect(existsSync(paths.lockDir)).toBe(false);
      cleanup();
      rmSync(fakeHome, { recursive: true, force: true });
      void repo;
    }
  }, 30_000);

  it("shuts down after the configured idle timeout", async () => {
    const { repo, realRepo, cleanup } = makeRepo();
    const fakeHome = mkdtempSync(join(tmpdir(), "ce-daemon-idle-home-"));
    const paths = daemonPaths(realRepo, { home: fakeHome });
    const serverJs = join(process.cwd(), "build", "src", "server.js");
    let stderr = "";
    const daemon = spawn(process.execPath, [serverJs, "--cwd", realRepo, "--auto-index", "never", "--daemon"], {
      cwd: tmpdir(),
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, HOME: fakeHome, CODELENS_DAEMON_IDLE_MS: "1000" },
    });
    daemon.stderr?.setEncoding("utf-8");
    daemon.stderr?.on("data", (chunk: string) => { stderr += chunk; });

    let client: JsonLineClient | null = null;
    try {
      const socket = await waitForDaemon(paths.socketPath, daemon, () => stderr);
      client = new JsonLineClient(socket);
      await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "daemon-idle-test", version: "1.0.0" },
      });
      client.notify("notifications/initialized");
      client.close();
      await waitForExit(daemon);
      expect(existsSync(paths.metadataPath)).toBe(false);
      expect(existsSync(paths.lockDir)).toBe(false);
    } finally {
      client?.close();
      daemon.kill("SIGTERM");
      cleanup();
      rmSync(fakeHome, { recursive: true, force: true });
      void repo;
    }
  }, 30_000);
});
