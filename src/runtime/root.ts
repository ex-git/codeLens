import { existsSync } from "node:fs";
import { resolveReal } from "../util/paths.js";

export interface ParsedCwdArgs {
  cwd?: string;
  autoIndex?: string;
  args: string[];
}

/** Strip global --cwd and --auto-index options before CLI/MCP dispatch. */
export function parseCwdArg(args: string[]): ParsedCwdArgs {
  const rest: string[] = [];
  let cwd: string | undefined;
  let autoIndex: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--cwd") {
      cwd = args[++i];
    } else if (arg.startsWith("--cwd=")) {
      cwd = arg.slice("--cwd=".length);
    } else if (arg === "--auto-index") {
      autoIndex = args[++i];
    } else if (arg.startsWith("--auto-index=")) {
      autoIndex = arg.slice("--auto-index=".length);
    } else {
      rest.push(arg);
    }
  }
  return { cwd, autoIndex, args: rest };
}

/** True when an explicit --cwd value is usable (exists and not an unexpanded template). */
export function isUsableCwd(cwd: string | undefined): boolean {
  return !!cwd && !cwd.includes("${") && existsSync(cwd);
}

/** Resolve a user/client-provided cwd, falling back when a host leaves template variables unexpanded. */
export function resolveCwd(cwd: string | undefined, fallback = process.cwd()): string {
  if (!isUsableCwd(cwd)) return resolveReal(fallback);
  return resolveReal(cwd!);
}
