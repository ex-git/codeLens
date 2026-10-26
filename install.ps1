# CodeLens standalone installer for Windows (PowerShell).
#
#   irm https://raw.githubusercontent.com/ex-git/codeLens/main/install.ps1 | iex
#
# Requirements: Node.js >= 22.5 (https://nodejs.org/) and git.
# Upgrade:  codelens upgrade
# Uninstall: remove ~\.codelens and the launcher; then `codelens uninstall`.
$ErrorActionPreference = 'Stop'

# ErrorActionPreference alone does not catch nonzero native-command exits.
function Assert-NativeSuccess([string]$Operation) {
  if ($LASTEXITCODE -ne 0) {
    throw "codelens: $Operation failed (exit $LASTEXITCODE). Review the output above; no success is reported."
  }
}

$repo = if ($env:CODELENS_REPO) { $env:CODELENS_REPO } else { 'https://github.com/ex-git/codeLens.git' }
$installDir = if ($env:CODELENS_DIR) { $env:CODELENS_DIR } else { Join-Path $HOME '.codelens\app' }
$binDir = if ($env:CODELENS_BIN_DIR) { $env:CODELENS_BIN_DIR } else { Join-Path $HOME '.local\bin' }
$target = if ($env:CODELENS_TARGET) { $env:CODELENS_TARGET } else { 'auto' }

if ($args -contains '--uninstall') {
  Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
  Remove-Item -Force (Join-Path $binDir 'codelens.cmd') -ErrorAction SilentlyContinue
  Write-Host "CodeLens uninstalled."
  exit 0
}

# 1. Require Node >= 22.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "codelens: Node.js >= 22.5 required. Install from https://nodejs.org/ and re-run."
}
$nodeVersion = node -p 'process.versions.node'
Assert-NativeSuccess 'Node version check'
$nodeVersionParts = $nodeVersion.Split('.') | ForEach-Object { [int]$_ }
if (($nodeVersionParts[0] -lt 22) -or (($nodeVersionParts[0] -eq 22) -and ($nodeVersionParts[1] -lt 5))) {
  throw "codelens: Node >= 22.5 required (found $(node -v))."
}

# 2. Clone/update + build.
Write-Host "Installing CodeLens from $repo ..."
if (Test-Path (Join-Path $installDir '.git')) {
  git -C $installDir pull --ff-only
  Assert-NativeSuccess 'git pull'
} else {
  if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
  New-Item -ItemType Directory -Force -Path (Split-Path $installDir) | Out-Null
  git clone --depth 1 $repo $installDir
  Assert-NativeSuccess 'git clone'
}
Write-Host "Installing dependencies..."
npm install --prefix $installDir --legacy-peer-deps --no-audit --no-fund
Assert-NativeSuccess 'npm install'
Write-Host "Building..."
npm run build --prefix $installDir
Assert-NativeSuccess 'npm run build'
Write-Host "Verifying SQLite FTS5 and language parsers..."
node (Join-Path $installDir 'build\src\server.js') --check-install
Assert-NativeSuccess 'installation verification (run codelens --check-install for recovery steps)'

# 3. Launcher (.cmd) on PATH.
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$cmd = Join-Path $binDir 'codelens.cmd'
@"
@echo off
node "$installDir\build\src\server.js" %*
"@ | Set-Content -Path $cmd -Encoding ASCII
Write-Host "Linked $cmd"

# 4. Wire agents.
Write-Host "Wiring agents (target=$target)..."
& $cmd install --target $target --yes
Assert-NativeSuccess 'agent configuration'

# 5. PATH.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $binDir) {
  [Environment]::SetEnvironmentVariable('Path', "$binDir;$userPath", 'User')
  Write-Host "Added $binDir to your PATH (restart your terminal to pick it up)."
}
Write-Host ""
Write-Host "Done. Run: codelens --help   |   Upgrade: codelens upgrade --check"