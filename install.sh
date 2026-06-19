#!/bin/sh
#
# CodeLens standalone installer.
#
# One command sets up everything: builds the tool, puts `codelens` on
# PATH, and wires the MCP server into your agents/IDEs (Claude Code, Cursor,
# Gemini CLI, opencode, Codex CLI). No manual config editing.
#
#   curl -fsSL https://raw.githubusercontent.com/ex-git/codeLens/main/install.sh | sh
#
# Upgrade:  codelens upgrade        (or: codelens upgrade --check)
# Uninstall: curl -fsSL .../install.sh | sh -s -- --uninstall
#
# Requirements: Node.js >= 22.5 (for the build; the launcher execs the built
# server via your system node). If Node is missing, install it first:
#   https://nodejs.org/  or  `brew install node@22`
#
# Environment:
#   CODELENS_REPO     git repo to clone   (default: auto from this script's origin)
#   CODELENS_SOURCE   local source dir to install from (skips git clone)
#   CODELENS_DIR      install location    (default: ~/.codelens/app)
#   CODELENS_BIN_DIR  launcher location   (default: ~/.local/bin)
#   CODELENS_TARGET   agents to wire: auto|all|none|csv (default: auto)
#
# Flags:
#   --local           install from this checkout (no git clone/remote needed)
#   --uninstall       remove the launcher and install dir
set -eu

REPO="${CODELENS_REPO:-https://github.com/ex-git/codeLens.git}"
INSTALL_DIR="${CODELENS_DIR:-$HOME/.codelens/app}"
BIN_DIR="${CODELENS_BIN_DIR:-$HOME/.local/bin}"
TARGET="${CODELENS_TARGET:-auto}"
LAUNCHER="$BIN_DIR/codelens"

# Resolve the directory this script lives in (empty when piped via curl|sh).
SCRIPT_DIR=""
case "${0:-}" in
  -|sh|/dev/stdin|*bash) ;;
  *)
    if [ -f "$0" ]; then
      SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
    fi
    ;;
esac

# Local-source mode: explicit (--local / CODELENS_SOURCE) or auto-detected when
# the script sits next to a codelens package.json (i.e. run from a checkout).
LOCAL_SOURCE="${CODELENS_SOURCE:-}"
FORCE_LOCAL=0
for arg in "$@"; do
  case "$arg" in
    --local) FORCE_LOCAL=1 ;;
  esac
done
if [ -z "$LOCAL_SOURCE" ] && [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  if grep -q '"name": "@fodx/codelens"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
    if [ "$FORCE_LOCAL" -eq 1 ] || [ -z "${CODELENS_REPO:-}" ]; then
      LOCAL_SOURCE="$SCRIPT_DIR"
    fi
  fi
fi

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$LAUNCHER"
  # Only delete the install dir when it is the managed one, never a local checkout.
  if [ -z "$LOCAL_SOURCE" ] || [ "$INSTALL_DIR" != "$LOCAL_SOURCE" ]; then
    rm -rf "$INSTALL_DIR"
    echo "CodeLens uninstalled (removed $INSTALL_DIR and $LAUNCHER)."
  else
    echo "CodeLens uninstalled (removed $LAUNCHER; left local source at $INSTALL_DIR)."
  fi
  echo "To remove agent configs too, run: codelens uninstall  (before deleting this script's install)"
  exit 0
fi

# 1. Require Node >= 22.5.
if ! command -v node >/dev/null 2>&1; then
  echo "codelens: Node.js is required (>= 22.5). Install it from https://nodejs.org/ and re-run." >&2
  exit 1
fi
if ! node -e 'const [M,m]=process.versions.node.split(".").map(Number); process.exit(M > 22 || (M === 22 && m >= 5) ? 0 : 1)' >/dev/null 2>&1; then
  echo "codelens: Node >= 22.5 required (found $(node -v)). Upgrade: https://nodejs.org/" >&2
  exit 1
fi

# 2. Obtain the source (local checkout or git clone) and build.
if [ -n "$LOCAL_SOURCE" ]; then
  # Build in place from the local checkout — no git remote required.
  INSTALL_DIR="$LOCAL_SOURCE"
  echo "Installing CodeLens from local source $INSTALL_DIR ..."
else
  echo "Installing CodeLens from $REPO ..."
  if [ -d "$INSTALL_DIR/.git" ]; then
    # Reconcile to remote tip: fetch + hard reset so force-pushes / history
    # rewrites (e.g. a squashed init commit) don't leave a divergent stale clone.
    git -C "$INSTALL_DIR" remote set-url origin "$REPO"
    git -C "$INSTALL_DIR" fetch --depth 1 origin
    git -C "$INSTALL_DIR" reset --hard FETCH_HEAD
    git -C "$INSTALL_DIR" clean -fd
  else
    rm -rf "$INSTALL_DIR"
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 "$REPO" "$INSTALL_DIR"
  fi
fi

echo "Installing dependencies (legacy-peer-deps for tree-sitter grammars)..."
npm install --prefix "$INSTALL_DIR" --legacy-peer-deps --no-audit --no-fund
echo "Building..."
npm run build --prefix "$INSTALL_DIR"

# 3. Install the launcher on PATH. The launcher dispatches CLI subcommands vs
# the MCP stdio server (no args → MCP server).
mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" <<EOF
#!/bin/sh
# codelens launcher — created by install.sh
exec node "$INSTALL_DIR/build/src/server.js" "\$@"
EOF
chmod +x "$LAUNCHER"
echo "Linked $LAUNCHER"

# 4. Wire agents/IDEs.
echo "Wiring agents (target=$TARGET)..."
"$LAUNCHER" install --target "$TARGET" --yes || echo "  (agent wiring skipped or partial; run \`codelens install\` to retry)"

# 5. PATH hint.
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo ""
    echo "$BIN_DIR is not on your PATH. Add it (then open a new terminal):"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
echo ""
echo "Done. Run: codelens --help   |   Upgrade: codelens upgrade --check"