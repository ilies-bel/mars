#!/usr/bin/env bash
# Mars Framework installer.
# Usage: curl -fsSL https://raw.githubusercontent.com/ilies-bel/mars-framework/main/install.sh | bash
set -euo pipefail

REPO_URL="https://github.com/ilies-bel/mars-framework.git"
INSTALL_DIR="${MARS_HOME:-$HOME/.mars}"
BIN_DIR="${MARS_BIN_DIR:-$HOME/.local/bin}"
BRANCH="${MARS_BRANCH:-main}"

log() { printf '\033[1;34m[mars]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[mars]\033[0m %s\n' "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing required command: $1"
    return 1
  fi
}

require_cmd git
require_cmd curl

# Bun is required for build/run. Install if missing.
if ! command -v bun >/dev/null 2>&1; then
  log "bun not found — installing via https://bun.sh/install"
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  err "bun installation did not put 'bun' on PATH; add \$HOME/.bun/bin to PATH and retry"
  exit 1
fi

# Clone or update the repo.
if [ -d "$INSTALL_DIR/.git" ]; then
  log "updating existing checkout at $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --depth=1 origin "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  log "cloning $REPO_URL into $INSTALL_DIR"
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# Install deps and build the standalone binary.
log "installing dependencies"
(cd "$INSTALL_DIR/framework" && bun install --frozen-lockfile)

log "building mars binary"
(cd "$INSTALL_DIR/framework" && bun run release:binary)

BUILT_BIN="$INSTALL_DIR/framework/dist/mars"
if [ ! -x "$BUILT_BIN" ]; then
  err "build did not produce $BUILT_BIN"
  exit 1
fi

mkdir -p "$BIN_DIR"
ln -sf "$BUILT_BIN" "$BIN_DIR/mars"
log "linked $BIN_DIR/mars -> $BUILT_BIN"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    log "note: $BIN_DIR is not on your PATH"
    log "add this to your shell profile:"
    printf '\n  export PATH="%s:$PATH"\n\n' "$BIN_DIR"
    ;;
esac

log "done — run 'mars --version' to verify"
