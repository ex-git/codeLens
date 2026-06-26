import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDaemonLock,
  cleanupDaemonState,
  cleanupStaleDaemon,
  daemonKey,
  daemonPaths,
  isDaemonStale,
  readDaemonMetadata,
  shutdownAllDaemons,
  writeDaemonMetadata,
  type DaemonPaths,
} from "../src/runtime/daemon.js";

const tmpdirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ce-daemon-home-"));
  tmpdirs.push(dir);
  return dir;
}

function staleFixture(paths: DaemonPaths, repoRoot: string, heartbeatAt: number): void {
  mkdirSync(paths.lockDir, { recursive: true });
  writeDaemonMetadata(paths, {
    key: paths.key,
    repoRoot,
    pid: process.pid,
    startedAt: heartbeatAt,
    heartbeatAt,
    socketPath: paths.socketPath,
  });
}

function writeMetadataForPid(paths: DaemonPaths, repoRoot: string, pid: number): void {
  mkdirSync(paths.lockDir, { recursive: true });
  writeDaemonMetadata(paths, {
    key: paths.key,
    repoRoot,
    pid,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    socketPath: paths.socketPath,
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit in time")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("daemon coordination primitives", () => {
  it("derives stable per-repo paths under the configured home", () => {
    const home = tempHome();
    const repo = "/tmp/example-repo";
    const a = daemonPaths(repo, { home });
    const b = daemonPaths(repo, { home });
    expect(a.key).toBe(daemonKey(repo));
    expect(a).toEqual(b);
    expect(a.dir).toContain(join(home, ".codelens", "daemons"));
    expect(a.metadataPath).toBe(join(a.dir, "daemon.json"));
    if (process.platform !== "win32") expect(a.socketPath).toBe(join(a.dir, "daemon.sock"));
  });

  it("acquires one live lock and blocks a second owner", () => {
    const home = tempHome();
    const repo = "/tmp/single-owner";
    const first = acquireDaemonLock(repo, { home });
    expect(first).not.toBeNull();
    const second = acquireDaemonLock(repo, { home });
    expect(second).toBeNull();

    const metadata = readDaemonMetadata(daemonPaths(repo, { home }));
    expect(metadata?.pid).toBe(process.pid);
    first?.release();
  });

  it("reclaims stale heartbeat state", () => {
    const home = tempHome();
    const repo = "/tmp/stale-owner";
    const paths = daemonPaths(repo, { home });
    staleFixture(paths, repo, 1_000);
    expect(isDaemonStale(paths, { now: () => 40_000, staleMs: 1_000 })).toBe(true);

    const lock = acquireDaemonLock(repo, { home, now: () => 40_000, staleMs: 1_000 });
    expect(lock).not.toBeNull();
    expect(readDaemonMetadata(paths)?.heartbeatAt).toBe(40_000);
    lock?.release();
  });

  it("cleans broken lock state with missing metadata", () => {
    const home = tempHome();
    const repo = "/tmp/broken-owner";
    const paths = daemonPaths(repo, { home });
    mkdirSync(paths.lockDir, { recursive: true });
    writeFileSync(paths.metadataPath, "not json\n", "utf-8");

    expect(cleanupStaleDaemon(paths)).toBe(true);
    expect(existsSync(paths.lockDir)).toBe(false);
    expect(readDaemonMetadata(paths)).toBeNull();
  });

  it("does not clean a fresh live owner", () => {
    const home = tempHome();
    const repo = "/tmp/live-owner";
    const lock = acquireDaemonLock(repo, { home, now: () => 10_000 });
    expect(lock).not.toBeNull();
    const paths = daemonPaths(repo, { home });

    expect(isDaemonStale(paths, { now: () => 10_500, staleMs: 5_000 })).toBe(false);
    expect(cleanupStaleDaemon(paths, { now: () => 10_500, staleMs: 5_000 })).toBe(false);
    expect(existsSync(paths.lockDir)).toBe(true);
    cleanupDaemonState(paths);
  });

  it("shutdownAllDaemons cleans stale daemon state", async () => {
    const home = tempHome();
    const repo = "/tmp/stale-shutdown";
    const paths = daemonPaths(repo, { home });
    writeMetadataForPid(paths, repo, -1);

    const result = await shutdownAllDaemons({ home, timeoutMs: 50, pollMs: 5 });

    expect(result).toMatchObject({ scanned: 1, staleCleaned: 1, failed: 0 });
    expect(existsSync(paths.lockDir)).toBe(false);
    expect(readDaemonMetadata(paths)).toBeNull();
  });

  it("shutdownAllDaemons terminates a live daemon pid and cleans state", async () => {
    const home = tempHome();
    const repo = "/tmp/live-shutdown";
    const paths = daemonPaths(repo, { home });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    if (!child.pid) throw new Error("child pid missing");
    writeMetadataForPid(paths, repo, child.pid);

    const result = await shutdownAllDaemons({ home, timeoutMs: 3_000, pollMs: 25 });
    await waitForExit(child);

    expect(result.scanned).toBe(1);
    expect(result.signaled).toBe(1);
    expect(result.stopped).toBe(1);
    expect(result.failed).toBe(0);
    expect(existsSync(paths.lockDir)).toBe(false);
    expect(readDaemonMetadata(paths)).toBeNull();
  });
});
