#!/usr/bin/env bash
# get-mars.sh — one-liner bootstrap installer for the mars CLI.
#
# Usage:
#   curl -sSL https://github.com/ilies-bel/mars/releases/latest/download/get-mars.sh | bash
#   GET_MARS_DRY_RUN=1 sh get-mars.sh   # resolve URLs/paths; skip network+install
#
# Supported platforms: darwin/linux × arm64/x86_64.
#
# Environment overrides (all optional):
#   GET_MARS_OS           Override detected OS     (darwin|linux)
#   GET_MARS_ARCH         Override detected arch    (arm64|x86_64)
#   GET_MARS_DRY_RUN      Set to 1 to print resolved URLs/paths and exit
#   GET_MARS_GITHUB_REPO  Override GitHub repo      (default: ilies-bel/mars)
#   GET_MARS_VERSION      Pin a specific release tag (default: latest)
#
# TODO(embedded-postgres): this script installs only the `mars` CLI
# binary. The Bun-compiled prod binaries ship without node_modules, so
# the embedded PostgreSQL server binaries (delivered to dev installs by
# the `embedded-postgres` npm platform packages) have no prod delivery
# path yet — the daemon cannot provision its per-repo PG instance from a
# bootstrap-installed binary alone. Distribution story (per-platform PG
# release assets fetched here, or a checksummed first-run download by
# the daemon) is an explicit follow-up — NOT part of the
# migrate/embedded-postgres branch. See
# orchestrator/docs/migrations/0002-sqlite-to-embedded-postgres.md §10.

set -euo pipefail

GITHUB_REPO="${GET_MARS_GITHUB_REPO:-ilies-bel/mars}"
SUPPORTED="darwin/linux × arm64/x86_64"
DRY_RUN="${GET_MARS_DRY_RUN:-0}"

# -----------------------------------------------------------------------

normalise_os() {
  case "$1" in
    Darwin|darwin) echo "darwin" ;;
    Linux|linux)   echo "linux"  ;;
    *)             echo ""       ;;
  esac
}

normalise_arch() {
  case "$1" in
    arm64|aarch64) echo "arm64"  ;;
    x86_64|amd64)  echo "x86_64" ;;
    *)             echo ""       ;;
  esac
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    echo "please install '$1' and re-run." >&2
    exit 1
  fi
}

resolve_version() {
  # Follow the /releases/latest redirect; the final URL ends in /tag/<version>.
  local final_url tag
  final_url="$(curl -sSLo /dev/null \
    -w '%{url_effective}' \
    "https://github.com/${GITHUB_REPO}/releases/latest" 2>/dev/null)" || true
  tag=""
  if [[ "$final_url" == *'/tag/'* ]]; then
    tag="${final_url##*/tag/}"
  fi
  # Fallback: GitHub REST API (no jq; sed extracts the value).
  if [[ -z "$tag" ]]; then
    tag="$(curl -sSLf \
      "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
      | grep '"tag_name"' \
      | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/' \
      | head -1)" || true
  fi
  if [[ -z "$tag" ]]; then
    echo "error: could not resolve latest version from GitHub." >&2
    echo "hint: set GET_MARS_VERSION=<tag> to install a specific version." >&2
    exit 1
  fi
  printf '%s' "$tag"
}

pick_install_dir() {
  # Primary: ~/.local/bin (no sudo required).
  local dir="$HOME/.local/bin"
  mkdir -p "$dir" 2>/dev/null || true
  if [[ -w "$dir" ]]; then
    printf '%s' "$dir"
    return
  fi
  # Fallback: /usr/local/bin only if already writable without sudo.
  if [[ -d "/usr/local/bin" && -w "/usr/local/bin" ]]; then
    printf '%s' "/usr/local/bin"
    return
  fi
  printf '%s' "$dir"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "error: neither sha256sum nor shasum found; cannot verify checksum." >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------

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

  local platform="${os}-${arch}"
  local asset_name="mars-${platform}"
  local install_dir
  install_dir="$(pick_install_dir)"
  local install_path="${install_dir}/mars"

  # --- dry-run: print resolved values and exit -------------------------
  if [[ "$DRY_RUN" == "1" ]]; then
    local dry_version="${GET_MARS_VERSION:-<latest>}"
    local dry_base="https://github.com/${GITHUB_REPO}/releases/download/${dry_version}"
    echo "platform:      ${platform}"
    echo "version:       ${dry_version}"
    echo "binary URL:    ${dry_base}/${asset_name}"
    echo "checksums URL: ${dry_base}/checksums.txt"
    echo "install path:  ${install_path}"
    exit 0
  fi

  # --- all remaining steps need curl -----------------------------------
  require_cmd curl

  # --- resolve version -------------------------------------------------
  local version
  if [[ -n "${GET_MARS_VERSION:-}" ]]; then
    version="$GET_MARS_VERSION"
  else
    version="$(resolve_version)"
  fi

  local base_url="https://github.com/${GITHUB_REPO}/releases/download/${version}"
  local binary_url="${base_url}/${asset_name}"
  local checksums_url="${base_url}/checksums.txt"

  # --- idempotence: check existing install -----------------------------
  local existing_bin=""
  if command -v mars >/dev/null 2>&1; then
    existing_bin="$(command -v mars)"
  elif [[ -x "$install_path" ]]; then
    existing_bin="$install_path"
  fi

  if [[ -n "$existing_bin" ]]; then
    local existing_ver=""
    existing_ver="$("$existing_bin" --version 2>/dev/null | head -1)" || true
    local clean_version="${version#v}"
    if [[ -n "$existing_ver" && "$existing_ver" == *"$clean_version"* ]]; then
      echo "mars ${version} is already installed at ${existing_bin} — nothing to do."
      exit 0
    fi
    if [[ -n "$existing_ver" ]]; then
      echo "upgrading mars: ${existing_ver} → ${version}"
    fi
  fi

  # --- download to temp dir --------------------------------------------
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  local tmp_binary="${tmpdir}/${asset_name}"
  local tmp_checksums="${tmpdir}/checksums.txt"

  echo "downloading mars ${version} for ${platform}..."
  if ! curl -sSLf "$binary_url" -o "$tmp_binary"; then
    echo "error: download failed: ${binary_url}" >&2
    echo "check that release ${version} exists and includes a ${asset_name} asset." >&2
    exit 1
  fi

  echo "verifying checksum..."
  if ! curl -sSLf "$checksums_url" -o "$tmp_checksums"; then
    echo "error: could not fetch checksums: ${checksums_url}" >&2
    exit 1
  fi

  # --- sha256 verification ---------------------------------------------
  local expected_digest actual_digest
  expected_digest="$(awk -v name="${asset_name}" '$2 == name {print $1; exit}' "$tmp_checksums")"
  if [[ -z "$expected_digest" ]]; then
    echo "error: no checksum entry for '${asset_name}' in checksums.txt" >&2
    exit 1
  fi

  actual_digest="$(sha256_file "$tmp_binary")"

  if [[ "$actual_digest" != "$expected_digest" ]]; then
    echo "error: sha256 mismatch for ${asset_name}" >&2
    echo "  expected: ${expected_digest}" >&2
    echo "  actual:   ${actual_digest}" >&2
    echo "aborting — the downloaded file has not been installed." >&2
    exit 1
  fi

  # --- install ---------------------------------------------------------
  cp "$tmp_binary" "$install_path"
  chmod +x "$install_path"

  echo
  echo "installed: mars ${version} → ${install_path}"

  # PATH hint if the install dir is not on PATH
  case ":${PATH}:" in
    *":${install_dir}:"*) ;;
    *)
      echo
      echo "hint: ${install_dir} is not on your PATH."
      echo "add this to your shell rc (e.g. ~/.bashrc or ~/.zshrc):"
      echo "  export PATH=\"${install_dir}:\$PATH\""
      ;;
  esac

  echo
  echo "Mars uses your existing Claude Code login — no API key or config needed."
  echo "Next: mars init  (run inside your project repo)"
}

main "$@"
