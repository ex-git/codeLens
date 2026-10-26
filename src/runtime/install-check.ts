import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type Parser from "tree-sitter";
import { GRAMMARS } from "../graph/grammars.js";

type ModuleLoader = (name: string) => unknown;
const requireModule: ModuleLoader = createRequire(import.meta.url);
const NATIVE_PACKAGES = ["better-sqlite3", "tree-sitter", ...new Set(Object.values(GRAMMARS).map(spec => spec.package))];

export interface DependencyCheck {
  package: string;
  ok: boolean;
  language?: string;
  error?: string;
  skipped?: boolean;
}

function failure(pkg: string, error: unknown): DependencyCheck {
  return { package: pkg, ok: false, error: error instanceof Error ? error.message : String(error) };
}

/** Exercise FTS5 without opening, migrating, or deleting any user database. */
export function checkSqlite(load: ModuleLoader = requireModule): DependencyCheck {
  let db: Database.Database | undefined;
  try {
    const Sqlite = load("better-sqlite3") as typeof Database;
    db = new Sqlite(":memory:");
    db.exec("CREATE VIRTUAL TABLE install_check USING fts5(content); INSERT INTO install_check VALUES ('codelens');");
    const row = db.prepare("SELECT count(*) AS n FROM install_check WHERE install_check MATCH 'codelens'").get() as { n: number };
    if (row.n !== 1) throw new Error("SQLite FTS5 query failed");
    return { package: "better-sqlite3", ok: true };
  } catch (error) {
    return failure("better-sqlite3", error);
  } finally {
    try { db?.close(); } catch { /* The capability failure above is the primary diagnostic. */ }
  }
}

/** Locate the consuming npm project, not a dependency's own package.json. */
export function installationRecovery() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  let project: string | null = existsSync(join(dir, "package.json")) ? dir : null;
  for (let parent = dir; dirname(parent) !== parent; parent = dirname(parent)) {
    if (basename(parent) === "node_modules") {
      const consumer = dirname(parent);
      project = existsSync(join(consumer, "package.json")) ? consumer : null;
    }
  }
  return {
    cwd: project,
    commands: project ? [
      "npm install-scripts ls",
      `npm install-scripts approve ${NATIVE_PACKAGES.join(" ")}`,
      `npm rebuild ${NATIVE_PACKAGES.join(" ")}`,
    ] : [
      `npm install --global --legacy-peer-deps --allow-scripts=${NATIVE_PACKAGES.join(",")} @fodx/codelens`,
    ],
    note: "Review package scripts before approval. Commands are suggestions, never run automatically. For npm without install-scripts, use npm rebuild after checking ignore-scripts. For global npm/npx installs use a reviewed --allow-scripts package list at install time. If rebuild fails, use a supported Node LTS version and install Python/C++ build tools. Restart CodeLens after repair.",
  };
}

/** Strict installation verification; all registered languages must parse successfully. */
export function checkInstall(load: ModuleLoader = requireModule) {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 5);
  const checks: DependencyCheck[] = [
    { package: "node", ok: nodeOk, ...(!nodeOk ? { error: "Node.js >= 22.5.0 is required" } : {}) },
    checkSqlite(load),
  ];
  let ParserClass: typeof Parser | undefined;
  try {
    ParserClass = load("tree-sitter") as typeof Parser;
    new ParserClass();
    checks.push({ package: "tree-sitter", ok: true });
  } catch (error) {
    checks.push(failure("tree-sitter", error));
    ParserClass = undefined;
  }
  for (const [language, spec] of Object.entries(GRAMMARS)) {
    if (!ParserClass) {
      checks.push({ package: spec.package, language, ok: false, skipped: true, error: "tree-sitter runtime unavailable" });
      continue;
    }
    try {
      const loaded = load(spec.package) as Record<string, unknown>;
      const grammar = spec.exportName ? loaded[spec.exportName] : loaded;
      const parser = new ParserClass();
      (parser as unknown as { setLanguage: (l: unknown) => void }).setLanguage(grammar);
      const tree = parser.parse(spec.sample);
      if (!tree || tree.rootNode.hasError) throw new Error(`Could not parse the ${language} installation sample`);
      checks.push({ package: spec.package, language, ok: true });
    } catch (error) {
      checks.push({ ...failure(spec.package, error), language });
    }
  }
  return {
    ok: checks.every(check => check.ok),
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    checks,
    recovery: installationRecovery(),
  };
}

export function formatInstallationFailure(check: DependencyCheck): string {
  const recovery = installationRecovery();
  return [
    `codelens: ${check.package} is unavailable: ${check.error ?? "dependency check failed"}`,
    `Node ${process.versions.node}; ${process.platform}/${process.arch}. Run codelens --check-install for the full report.`,
    recovery.cwd ? `In npm project ${JSON.stringify(recovery.cwd)}, review scripts before running:` : "For global npm installs, review scripts before reinstalling:",
    ...recovery.commands,
    recovery.note,
  ].join("\n");
}
