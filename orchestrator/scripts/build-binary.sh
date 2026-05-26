#!/usr/bin/env bash
# build-binary.sh <os> <arch>
#
# Compile a standalone single-file mars binary for the given target using
# Bun's compile mode (bun build --compile). The binary embeds the Bun
# runtime; no separate Bun installation is needed to run the output.
#
# Supported targets:
#   darwin  arm64 | x64
#   linux   arm64 | x64
#
# Usage:
#   bash scripts/build-binary.sh darwin arm64
#   npm run build:binary -- linux x64
set -euo pipefail

OS="${1:-}"
ARCH="${2:-}"

SUPPORTED_PAIRS="darwin/arm64, darwin/x64, linux/arm64, linux/x64"

# Validate the (os, arch) pair before doing any work.
case "$OS/$ARCH" in
  darwin/arm64|darwin/x64|linux/arm64|linux/x64) ;;
  *)
    echo "Error: unsupported target '${OS}/${ARCH}'." >&2
    echo "Supported pairs: ${SUPPORTED_PAIRS}" >&2
    exit 1
    ;;
esac

OUTFILE="mars-${OS}-${ARCH}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Inline the current version constant so the compiled binary doesn't need
# package.json at runtime.
node "${SCRIPT_DIR}/sync-version.mjs"

# Compile to a single-file standalone executable.
# @duckdb/node-api ships native .node addons that cannot be embedded in the
# Bun binary; mark them external so Bun emits a clean bundle.  The CLI only
# reaches the DuckDB code-path when a repo context is available, so the
# binary still works for --help / version on a plain checkout.
bun build \
  --compile \
  --target="bun-${OS}-${ARCH}" \
  --outfile="${PACKAGE_DIR}/${OUTFILE}" \
  --external='@duckdb/node-api' \
  --external='react-devtools-core' \
  "${PACKAGE_DIR}/src/cli.ts"

echo "Built: ${OUTFILE}"
