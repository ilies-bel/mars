#!/usr/bin/env bash
# get-mars.sh — one-liner bootstrap installer for the mars CLI.
#
# Slice 1 of 5: detect the host OS and CPU architecture, print a normalised
# platform token (e.g. darwin-arm64), and refuse unsupported combinations
# before any network activity. Subsequent slices will add download,
# checksum verification, and install-to-PATH.
#
# Supported platforms: darwin/linux × arm64/x86_64.
#
# For testing, the detected OS and arch can be overridden via the
# GET_MARS_OS and GET_MARS_ARCH environment variables; without them the
# script falls back to `uname -s` and `uname -m`.

set -euo pipefail

SUPPORTED="darwin/linux × arm64/x86_64"

normalise_os() {
  case "$1" in
    Darwin|darwin)   echo "darwin" ;;
    Linux|linux)     echo "linux" ;;
    *)               echo "" ;;
  esac
}

normalise_arch() {
  case "$1" in
    arm64|aarch64)   echo "arm64" ;;
    x86_64|amd64)    echo "x86_64" ;;
    *)               echo "" ;;
  esac
}

main() {
  local os_raw arch_raw os arch
  os_raw="${GET_MARS_OS:-$(uname -s)}"
  arch_raw="${GET_MARS_ARCH:-$(uname -m)}"
  os="$(normalise_os "$os_raw")"
  arch="$(normalise_arch "$arch_raw")"

  if [[ -z "$os" || -z "$arch" ]]; then
    echo "error: unsupported platform: ${os_raw}/${arch_raw}" >&2
    echo "supported: ${SUPPORTED}" >&2
    exit 1
  fi

  echo "${os}-${arch}"
}

main "$@"
