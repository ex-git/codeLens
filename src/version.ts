import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Version constant. Read from package.json at module load. Resolves the repo
 * root from this module's location (build/src/ or src/ → ../../package.json),
 * falling back to cwd.
 */

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "package.json"), // build/src/ or src/ → repo root
    join(here, "..", "package.json"),
    join(process.cwd(), "package.json"),
  ];
  for (const p of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch { /* try next */ }
  }
  return "0.0.0-unknown";
}

export const VERSION: string = readVersion();