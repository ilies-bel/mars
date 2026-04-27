#!/usr/bin/env bash
# Install `mars` on PATH as a symlink to the dev shim, so `mars <args>` runs
# the live TypeScript source directly via Bun. Pairs with mars-dev.
#
# Usage:   framework/scripts/install-dev.sh
# Override target dir:   MARS_BIN_DIR=/somewhere/bin framework/scripts/install-dev.sh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
SHIM="$SCRIPT_DIR/mars-dev"
BIN_DIR="${MARS_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/mars"

log() { printf '\033[1;34m[mars-dev]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[mars-dev]\033[0m %s\n' "$*" >&2; }

if [ ! -x "$SHIM" ]; then
  err "shim not found or not executable: $SHIM"
  exit 1
fi

mkdir -p "$BIN_DIR"

if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  current="$(readlink "$TARGET" 2>/dev/null || true)"
  if [ "$current" != "$SHIM" ]; then
    log "replacing existing $TARGET (was: ${current:-<not a symlink>})"
  fi
fi

ln -sf "$SHIM" "$TARGET"
log "linked $TARGET -> $SHIM"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    log "note: $BIN_DIR is not on your PATH"
    log "add this to your shell profile:"
    printf '\n  export PATH="%s:$PATH"\n\n' "$BIN_DIR"
    ;;
esac

log "done — \`mars <args>\` now runs cli/main.ts live"
