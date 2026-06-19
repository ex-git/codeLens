import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

/**
 * Upgrade check + perform (mirrors codegraph's `upgrade --check` / `upgrade`).
 *
 * Detects the app install dir (the repo root that contains package.json and
 * is a git checkout), then:
 *   - `checkUpgrade()`: git fetch + compare HEAD vs origin/main (or the tag of
 *     the latest release) and report whether an update is available.
 *   - `performUpgrade()`: git pull + npm install + npm run build.
 *
 * If not installed from a git checkout (e.g. a future npm-global install), it
 * reports accordingly and suggests `npm i -g codelens`.
 */

function appRoot(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // build/src/upgrade.js → repo root (../../package.json); src/upgrade.ts → ../package.json
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
      join(process.cwd(), "package.json"),
    ];
    for (const cand of candidates) {
      if (existsSync(cand)) return dirname(cand);
    }
  } catch { /* ignore */ }
  return null;
}

function git(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf-8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

export interface UpgradeStatus {
  upToDate: boolean;
  message: string;
  local?: string;
  remote?: string;
}

export async function checkUpgrade(): Promise<UpgradeStatus> {
  const root = appRoot();
  if (!root) return { upToDate: true, message: `codelens ${VERSION} (not a git checkout; use \`npm i -g codelens\` to upgrade if installed via npm)` };
  if (!existsSync(join(root, ".git"))) return { upToDate: true, message: `codelens ${VERSION} (installed without git; re-run your installer to update)` };

  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "main";
  const fetch = git(root, ["fetch", "--quiet", "origin", branch]);
  if (!fetch.ok) return { upToDate: true, message: `codelens ${VERSION} (could not fetch upstream: ${fetch.stderr || "unknown"})` };
  const local = git(root, ["rev-parse", "HEAD"]).stdout.slice(0, 12);
  const remote = git(root, ["rev-parse", `origin/${branch}`]).stdout.slice(0, 12);
  if (local === remote) return { upToDate: true, message: `codelens ${VERSION} is up to date (${local}).` };
  const behind = git(root, ["rev-list", "--count", `HEAD..origin/${branch}`]).stdout;
  return { upToDate: false, message: `codelens ${VERSION}: update available (${behind} commit(s) behind origin/${branch}). Run \`codelens upgrade\` to update.`, local, remote };
}

export interface UpgradeResult { ok: boolean; message: string }

export async function performUpgrade(_version?: string): Promise<UpgradeResult> {
  const root = appRoot();
  if (!root) return { ok: false, message: "could not locate the install dir; re-run the installer script." };
  if (!existsSync(join(root, ".git"))) return { ok: false, message: "not a git checkout; re-run the installer script to update." };

  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout || "main";
  const pull = git(root, ["pull", "--ff-only", "origin", branch]);
  if (!pull.ok) return { ok: false, message: `git pull failed: ${pull.stderr || pull.stdout}` };

  const inst = spawnSync("npm", ["install", "--legacy-peer-deps"], { cwd: root, encoding: "utf-8" });
  if (inst.status !== 0) return { ok: false, message: `npm install failed: ${(inst.stderr ?? inst.stdout ?? "").slice(-500)}` };
  const build = spawnSync("npm", ["run", "build"], { cwd: root, encoding: "utf-8" });
  if (build.status !== 0) return { ok: false, message: `npm run build failed: ${(build.stderr ?? build.stdout ?? "").slice(-500)}` };

  return { ok: true, message: `upgraded to ${VERSION} (pulled origin/${branch}, rebuilt). Restart your agent(s) to pick up changes.` };
}