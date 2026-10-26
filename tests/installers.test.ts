import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const shellAvailable = process.platform !== "win32";
const powershellAvailable = process.platform === "win32" && spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" }).status === 0;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cl-installer space-"));
  const source = join(root, "source");
  const bin = join(root, "bin");
  const mocks = join(root, "mocks");
  mkdirSync(join(source, ".git"), { recursive: true });
  mkdirSync(mocks);
  const journal = join(root, "journal");
  const env = { ...process.env, CODELENS_SOURCE: source, CODELENS_DIR: source, CODELENS_BIN_DIR: bin, CODELENS_TARGET: "none", INSTALL_TEST_JOURNAL: journal };
  return { root, source, bin, mocks, journal, env };
}

describe.skipIf(!shellAvailable)("shell installer verification", () => {
  for (const failure of ["install", "build", "check", "none"]) {
    it(`handles ${failure} failure without false success`, () => {
      const f = fixture();
      try {
        writeFileSync(join(f.mocks, "node"), `#!/bin/sh
case "$1" in -e) exit 0;; esac
case "$*" in *--check-install*) echo check >> "$INSTALL_TEST_JOURNAL"; [ "$INSTALL_TEST_FAIL" != check ] || { echo 'native check failed; review npm install-scripts ls' >&2; exit 9; };; esac
`, { mode: 0o755 });
        writeFileSync(join(f.mocks, "npm"), `#!/bin/sh
case "$1" in install) step=install;; *) step=build;; esac
echo "$step" >> "$INSTALL_TEST_JOURNAL"
[ "$INSTALL_TEST_FAIL" != "$step" ] || exit 9
`, { mode: 0o755 });
        const result = spawnSync("sh", [resolve("install.sh")], {
          encoding: "utf8", timeout: 10000,
          env: { ...f.env, INSTALL_TEST_FAIL: failure, PATH: f.mocks + delimiter + process.env.PATH },
        });
        const output = result.stdout + result.stderr;
        expect(result.status, output).toBe(failure === "none" ? 0 : 9);
        expect(output.includes("Done. Run:")).toBe(failure === "none");
        expect(existsSync(join(f.bin, "codelens"))).toBe(failure === "none");
        const steps = readFileSync(f.journal, "utf8").trim().split("\n");
        expect(steps).toEqual(failure === "install" ? ["install"] : failure === "build" ? ["install", "build"] : ["install", "build", "check"]);
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }
});

describe.skipIf(!powershellAvailable)("PowerShell native command verification", () => {
  // The wiring-failure case reaches launcher creation, then stops before any persistent PATH edit.
  for (const failure of ["git", "install", "build", "check", "wiring"]) {
    it(`stops on ${failure} before reporting success`, () => {
      const f = fixture();
      try {
        const script = join(f.root, "test.ps1");
        const guardedInstaller = join(f.root, "install.ps1");
        const originalInstaller = readFileSync(resolve("install.ps1"), "utf8");
        expect(originalInstaller).toContain("# 5. PATH.");
        writeFileSync(guardedInstaller, originalInstaller.replace("# 5. PATH.", "throw 'unexpectedly reached persistent PATH modification'\n# 5. PATH."));
        writeFileSync(script, `
function global:git { $global:LASTEXITCODE = if ($env:INSTALL_TEST_FAIL -eq 'git') { 9 } else { 0 } }
function global:npm {
  $step = if ($args[0] -eq 'install') { 'install' } else { 'build' }
  Add-Content $env:INSTALL_TEST_JOURNAL $step
  $global:LASTEXITCODE = if ($env:INSTALL_TEST_FAIL -eq $step) { 9 } else { 0 }
}
function global:node {
  if ($args[0] -eq '-p') { '24.0.0'; $global:LASTEXITCODE = 0; return }
  if ($args -contains '--check-install') { Add-Content $env:INSTALL_TEST_JOURNAL 'check'; $global:LASTEXITCODE = if ($env:INSTALL_TEST_FAIL -eq 'check') { 9 } else { 0 }; return }
  $global:LASTEXITCODE = 0
}
# Replace only launcher creation with a safe failing shim; never invoke real agent configuration.
function global:Set-Content {
  param($Path, $Encoding, [Parameter(ValueFromPipeline=$true)]$Value)
  process { [System.IO.File]::WriteAllText($Path, "@echo off\r\nexit /b 9\r\n") }
}
try { & $env:INSTALL_TEST_SCRIPT } catch { Write-Output $_; exit 9 }
throw 'installer unexpectedly reached persistent PATH modification'
`);
        const result = spawnSync("pwsh", ["-NoProfile", "-File", script], {
          encoding: "utf8", timeout: 15000,
          env: { ...f.env, INSTALL_TEST_FAIL: failure, INSTALL_TEST_SCRIPT: guardedInstaller },
        });
        const output = result.stdout + result.stderr;
        expect(result.status, output).toBe(9);
        expect(output).not.toContain("Done. Run:");
        expect(existsSync(join(f.bin, "codelens.cmd"))).toBe(failure === "wiring");
        if (failure === "check") expect(output).toContain("installation verification");
        if (failure === "wiring") expect(output).toContain("agent configuration");
      } finally { rmSync(f.root, { recursive: true, force: true }); }
    });
  }
});
