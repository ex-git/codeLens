import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_STALE_MS = 30_000;

export interface DaemonPaths {
  key: string;
  dir: string;
  lockDir: string;
  metadataPath: string;
  socketPath: string;
}

export interface DaemonMetadata {
  key: string;
  repoRoot: string;
  pid: number;
  startedAt: number;
  heartbeatAt: number;
  socketPath: string;
}

export interface DaemonLock {
  paths: DaemonPaths;
  metadata: DaemonMetadata;
  heartbeat(): void;
  release(): void;
}

export interface DaemonTimingOptions {
  now?: () => number;
  staleMs?: number;
}

export interface DaemonSocketServer {
  activeConnections(): number;
  close(): Promise<void>;
}

export interface DaemonSocketServerOptions {
  idleMs?: number;
  onIdle?: () => void | Promise<void>;
}

export interface ConnectOrStartDaemonOptions {
  autoIndex?: string;
  env?: NodeJS.ProcessEnv;
  serverJs: string;
  timeoutMs?: number;
}

export interface ShutdownDaemonsOptions {
  home?: string;
  pollMs?: number;
  signal?: NodeJS.Signals;
  timeoutMs?: number;
}

export interface ShutdownDaemonsResult {
  scanned: number;
  signaled: number;
  stopped: number;
  staleCleaned: number;
  skippedCurrent: number;
  failed: number;
}

function nowMs(opts?: DaemonTimingOptions): number {
  return opts?.now?.() ?? Date.now();
}

/** Stable daemon key: one daemon per real repo/worktree path. */
export function daemonKey(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 32);
}

function daemonRoot(home?: string): string {
  return join(home ?? homedir(), ".codelens", "daemons");
}

function daemonPathsForKey(key: string, home?: string): DaemonPaths {
  const dir = join(daemonRoot(home), key);
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\codelens-${key}`
    : join(dir, "daemon.sock");
  return {
    key,
    dir,
    lockDir: join(dir, "lock"),
    metadataPath: join(dir, "daemon.json"),
    socketPath,
  };
}

/** Runtime coordination files for a repo/worktree daemon. */
export function daemonPaths(repoRoot: string, opts?: { home?: string }): DaemonPaths {
  return daemonPathsForKey(daemonKey(repoRoot), opts?.home);
}

export function readDaemonMetadata(paths: DaemonPaths): DaemonMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.metadataPath, "utf-8")) as Partial<DaemonMetadata>;
    if (parsed.key !== paths.key) return null;
    if (typeof parsed.repoRoot !== "string" || typeof parsed.socketPath !== "string") return null;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "number" || typeof parsed.heartbeatAt !== "number") return null;
    return {
      key: parsed.key,
      repoRoot: parsed.repoRoot,
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      heartbeatAt: parsed.heartbeatAt,
      socketPath: parsed.socketPath,
    };
  } catch {
    return null;
  }
}

export function writeDaemonMetadata(paths: DaemonPaths, metadata: DaemonMetadata): void {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function isDaemonStale(paths: DaemonPaths, opts?: DaemonTimingOptions): boolean {
  const metadata = readDaemonMetadata(paths);
  if (!metadata) return true;
  if (!isProcessAlive(metadata.pid)) return true;
  return nowMs(opts) - metadata.heartbeatAt > (opts?.staleMs ?? DEFAULT_STALE_MS);
}

export function cleanupDaemonState(paths: DaemonPaths): void {
  if (process.platform !== "win32") rmSync(paths.socketPath, { force: true });
  rmSync(paths.metadataPath, { force: true });
  rmSync(paths.lockDir, { recursive: true, force: true });
}

export function cleanupStaleDaemon(paths: DaemonPaths, opts?: DaemonTimingOptions): boolean {
  if (!isDaemonStale(paths, opts)) return false;
  cleanupDaemonState(paths);
  return true;
}

function createMetadata(repoRoot: string, paths: DaemonPaths, pid: number, at: number): DaemonMetadata {
  return {
    key: paths.key,
    repoRoot,
    pid,
    startedAt: at,
    heartbeatAt: at,
    socketPath: paths.socketPath,
  };
}

function tryAcquireLock(repoRoot: string, paths: DaemonPaths, opts?: DaemonTimingOptions & { pid?: number }): DaemonLock | null {
  try {
    mkdirSync(paths.dir, { recursive: true });
    mkdirSync(paths.lockDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw err;
  }

  const metadata = createMetadata(repoRoot, paths, opts?.pid ?? process.pid, nowMs(opts));
  writeDaemonMetadata(paths, metadata);
  return {
    paths,
    metadata,
    heartbeat: () => {
      metadata.heartbeatAt = Date.now();
      writeDaemonMetadata(paths, metadata);
    },
    release: () => cleanupDaemonState(paths),
  };
}

/** Acquire daemon ownership, reclaiming stale owner state once if needed. */
export function acquireDaemonLock(repoRoot: string, opts?: DaemonTimingOptions & { home?: string; pid?: number }): DaemonLock | null {
  const paths = daemonPaths(repoRoot, opts);
  const first = tryAcquireLock(repoRoot, paths, opts);
  if (first) return first;
  if (!cleanupStaleDaemon(paths, opts)) return null;
  return tryAcquireLock(repoRoot, paths, opts);
}

function listDaemonPathEntries(home?: string): DaemonPaths[] {
  try {
    return readdirSync(daemonRoot(home), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => daemonPathsForKey(entry.name, home));
  } catch {
    return [];
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !isProcessAlive(pid);
}

/** Best-effort shutdown/cleanup for all known CodeLens daemon state. */
export async function shutdownAllDaemons(opts?: ShutdownDaemonsOptions): Promise<ShutdownDaemonsResult> {
  const result: ShutdownDaemonsResult = { scanned: 0, signaled: 0, stopped: 0, staleCleaned: 0, skippedCurrent: 0, failed: 0 };
  const timeoutMs = opts?.timeoutMs ?? 2_000;
  const pollMs = opts?.pollMs ?? 100;
  const signal = opts?.signal ?? "SIGTERM";

  for (const paths of listDaemonPathEntries(opts?.home)) {
    result.scanned++;
    const metadata = readDaemonMetadata(paths);
    if (!metadata || !isProcessAlive(metadata.pid)) {
      cleanupDaemonState(paths);
      result.staleCleaned++;
      continue;
    }
    if (metadata.pid === process.pid) {
      result.skippedCurrent++;
      continue;
    }

    try {
      process.kill(metadata.pid, signal);
      result.signaled++;
    } catch {
      if (!isProcessAlive(metadata.pid)) {
        cleanupDaemonState(paths);
        result.staleCleaned++;
      } else {
        result.failed++;
      }
      continue;
    }

    if (await waitForProcessExit(metadata.pid, timeoutMs, pollMs)) {
      cleanupDaemonState(paths);
      result.stopped++;
    } else {
      result.failed++;
    }
  }
  return result;
}

/** Listen for local daemon clients on the repo/worktree socket. */
export async function startDaemonSocketServer(
  paths: DaemonPaths,
  onConnection: (socket: Socket) => void | Promise<void>,
  opts?: DaemonSocketServerOptions,
): Promise<DaemonSocketServer> {
  if (process.platform !== "win32") rmSync(paths.socketPath, { force: true });
  mkdirSync(paths.dir, { recursive: true });

  const sockets = new Set<Socket>();
  let idleTimer: NodeJS.Timeout | null = null;
  const clearIdleTimer = () => {
    if (!idleTimer) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  };
  const scheduleIdle = () => {
    if (!opts?.onIdle || sockets.size > 0) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void Promise.resolve(opts.onIdle?.()).catch(() => { /* ignore idle hook errors */ });
    }, opts.idleMs ?? 30_000);
  };

  const server = createServer((socket) => {
    clearIdleTimer();
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      scheduleIdle();
    });
    void Promise.resolve(onConnection(socket)).catch(() => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(paths.socketPath);
  });

  scheduleIdle();

  return {
    activeConnections: () => sockets.size,
    close: () => new Promise<void>((resolve, reject) => {
      clearIdleTimer();
      for (const socket of sockets) socket.destroy();
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  };
}

function connectDaemonSocket(paths: DaemonPaths): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(paths.socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

async function waitForDaemonSocket(paths: DaemonPaths, timeoutMs: number): Promise<Socket> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      return await connectDaemonSocket(paths);
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`timed out waiting for daemon socket ${paths.socketPath}`);
}

/** Connect to an existing daemon, or spawn one and wait for its socket. */
export async function connectOrStartDaemon(repoRoot: string, opts: ConnectOrStartDaemonOptions): Promise<Socket> {
  const paths = daemonPaths(repoRoot);
  try {
    return await connectDaemonSocket(paths);
  } catch {
    // No reachable daemon yet; check for stale owner state below.
  }
  cleanupStaleDaemon(paths);
  try {
    return await connectDaemonSocket(paths);
  } catch {
    // Still no reachable daemon; spawn below.
  }

  const args = [opts.serverJs, "--cwd", repoRoot, "--daemon"];
  if (opts.autoIndex) args.splice(3, 0, "--auto-index", opts.autoIndex);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: opts.env ?? process.env,
  });
  child.unref();
  return await waitForDaemonSocket(paths, opts.timeoutMs ?? 10_000);
}
