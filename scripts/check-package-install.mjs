// Exercise the shipped package in disposable consuming projects, never in the user's npm project.
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const nativePackages = Object.keys(manifest.dependencies).filter(name => name === "better-sqlite3" || name === "tree-sitter" || name.startsWith("tree-sitter-"));
const temporary = mkdtempSync(join(tmpdir(), "codelens-install space-"));

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: "utf8", timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${executable} ${args.join(" ")} failed (${result.status}): ${result.error?.message ?? ""}\n${(result.stdout + result.stderr).slice(-10000)}`);
  }
  return result;
}

function npmCli() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) return process.env.npm_execpath;
  // Only this fixed discovery command uses a Windows shell. All package paths use node + argv.
  const globalRoot = command("npm root -g", [], { shell: true }).stdout.trim();
  const cli = join(globalRoot, "npm", "bin", "npm-cli.js");
  assert.ok(existsSync(cli), "Cannot locate npm-cli.js; run this harness through npm run test:install");
  return cli;
}

try {
  assert.ok(existsSync(join(root, "build", "src", "application.js")), "Run npm run build before testing the package");
  const cli = npmCli();
  const userconfig = join(temporary, "npmrc");
  writeFileSync(userconfig, "");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_(allow_scripts|ignore_scripts|strict_allow_scripts|userconfig|cache|prefix|global)$/i.test(key)));
  Object.assign(env, {
    HOME: temporary, USERPROFILE: temporary,
    npm_config_userconfig: userconfig, npm_config_cache: join(temporary, "cache"),
    npm_config_ignore_scripts: "false", npm_config_strict_allow_scripts: "false",
  });
  const npm = (args, cwd = root) => command(process.execPath, [cli, ...args], { cwd, env });
  console.log(`Testing ${manifest.name}@${manifest.version} on Node ${process.versions.node}, ${process.platform}/${process.arch}; npm ${npm(["--version"]).stdout.trim()}`);
  npm(["install-scripts", "--help"]); // Require npm's explicit script-approval support.
  const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", temporary]).stdout)[0];
  for (const path of ["build/src/server.js", "build/src/application.js", "build/src/runtime/install-check.js", "build/src/db/schema.sql", "build/src/context/schema.sql", "adapters/pi/codelens.extension.ts"]) {
    assert.ok(packed.files.some(file => file.path === path), `Missing tarball artifact: ${path}`);
  }
  const tarball = join(temporary, packed.filename);

  function project(name, approved) {
    const cwd = join(temporary, name);
    mkdirSync(cwd);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: `install-test-${name}`, private: true, version: "1.0.0",
      dependencies: { [manifest.name]: `file:${tarball}` },
      allowScripts: Object.fromEntries(nativePackages.map(pkg => [pkg, approved])),
    }, null, 2));
    npm(["install", "--legacy-peer-deps", "--no-audit", "--no-fund"], cwd);
    return { cwd, entry: join(cwd, "node_modules", ...manifest.name.split("/"), "build", "src", "server.js") };
  }

  function diagnostic(project) {
    const result = command(process.execPath, [project.entry, "--check-install"], { cwd: project.cwd, env, allowFailure: true, timeout: 30000 });
    assert.equal(result.error, undefined, result.error?.message);
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, report.ok ? 0 : 1, result.stderr);
    assert.equal(report.checks.length, nativePackages.length + 1);
    assert.equal(realpathSync(report.recovery.cwd), realpathSync(project.cwd), "Recovery must target the consuming project");
    return report;
  }

  function smoke(project) {
    const result = command(process.execPath, [project.entry, "--smoke"], { cwd: project.cwd, env, timeout: 30000 });
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.tools.includes("cl_search"));
  }

  const blocked = project("blocked", false);
  const initial = diagnostic(blocked);
  assert.ok(initial.checks.every(check => typeof check.ok === "boolean"));
  // Some dependencies ship working prebuilds even when scripts are blocked. Do not require a false failure.
  if (!initial.checks.find(check => check.package === "better-sqlite3").ok) {
    const startup = command(process.execPath, [blocked.entry, "--smoke"], { cwd: blocked.cwd, env, allowFailure: true, timeout: 30000 });
    assert.equal(startup.status, 1);
    assert.equal(startup.stdout, "", "Failed MCP startup must not emit prose on stdout");
    assert.match(startup.stderr, /npm install-scripts approve/);
  }
  console.log(`Blocked-script installation: ${initial.checks.filter(check => check.ok).length}/${initial.checks.length} capabilities available; diagnostic exit matches report`);

  // Simulate an operator replacing the test project's explicit denials after review.
  const blockedManifest = JSON.parse(readFileSync(join(blocked.cwd, "package.json"), "utf8"));
  blockedManifest.allowScripts = {};
  writeFileSync(join(blocked.cwd, "package.json"), JSON.stringify(blockedManifest, null, 2));
  npm(["install-scripts", "approve", ...nativePackages], blocked.cwd);
  npm(["rebuild", ...nativePackages], blocked.cwd);
  const repaired = diagnostic(blocked);
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  smoke(blocked);
  console.log("Scoped approval + rebuild recovery: all capabilities and MCP smoke passed");

  const approved = project("approved", true);
  const healthy = diagnostic(approved);
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
  smoke(approved);
  console.log("Clean approved-script installation: all capabilities and MCP smoke passed");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
