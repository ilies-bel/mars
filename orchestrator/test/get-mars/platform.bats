#!/usr/bin/env bats
#
# Behavioural spec for get-mars.sh platform detection (Slice 1).
#
# These tests exercise the bootstrap installer purely through its public
# interface: invoking the script with simulated host platforms (via the
# GET_MARS_OS / GET_MARS_ARCH overrides) and asserting on stdout, stderr
# and exit status. Nothing here couples to the script's internals, so the
# spec survives later slices that add download / checksum / install.

setup() {
  # get-mars.sh lives at the worktree root; this test file lives at
  # orchestrator/test/get-mars/, i.e. three directories down.
  SCRIPT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/get-mars.sh"
  [ -f "$SCRIPT" ] || {
    echo "get-mars.sh not found at $SCRIPT" >&2
    return 1
  }

  # A sandbox PATH whose curl/wget stubs record any invocation. If the
  # script reaches out to the network on a path it shouldn't, the marker
  # file appears and the assertion fails.
  STUB_DIR="$BATS_TEST_TMPDIR/bin"
  NET_MARKER="$BATS_TEST_TMPDIR/network-was-called"
  mkdir -p "$STUB_DIR"
  for tool in curl wget; do
    cat > "$STUB_DIR/$tool" <<EOF
#!/usr/bin/env bash
echo "$tool \$*" >> "$NET_MARKER"
exit 0
EOF
    chmod +x "$STUB_DIR/$tool"
  done
}

run_platform() {
  local os="$1" arch="$2"
  GET_MARS_OS="$os" GET_MARS_ARCH="$arch" \
    PATH="$STUB_DIR:$PATH" \
    run bash "$SCRIPT"
}

# --- Supported platforms: token printed, exit 0 ----------------------------

@test "darwin/arm64 resolves to darwin-arm64 and exits 0" {
  run_platform Darwin arm64
  [ "$status" -eq 0 ]
  [ "$output" = "darwin-arm64" ]
}

@test "darwin/x86_64 resolves to darwin-x86_64 and exits 0" {
  run_platform Darwin x86_64
  [ "$status" -eq 0 ]
  [ "$output" = "darwin-x86_64" ]
}

@test "linux/arm64 resolves to linux-arm64 and exits 0" {
  run_platform Linux arm64
  [ "$status" -eq 0 ]
  [ "$output" = "linux-arm64" ]
}

@test "linux/x86_64 resolves to linux-x86_64 and exits 0" {
  run_platform Linux x86_64
  [ "$status" -eq 0 ]
  [ "$output" = "linux-x86_64" ]
}

@test "uname-style architecture aliases normalise (aarch64 -> arm64, amd64 -> x86_64)" {
  run_platform Linux aarch64
  [ "$status" -eq 0 ]
  [ "$output" = "linux-arm64" ]

  run_platform Linux amd64
  [ "$status" -eq 0 ]
  [ "$output" = "linux-x86_64" ]
}

# --- Unsupported OS: aborts, names the pair, exit non-zero -----------------

@test "unsupported OS aborts non-zero and names the detected OS/arch" {
  run_platform Windows arm64
  [ "$status" -ne 0 ]
  [[ "$output" == *"Windows"* ]]
  [[ "$output" == *"arm64"* ]]
}

@test "unsupported OS abort does not touch the network" {
  run_platform Windows arm64
  [ "$status" -ne 0 ]
  [ ! -f "$NET_MARKER" ]
}

# --- Unsupported arch: aborts, names the pair, exit non-zero ---------------

@test "unsupported arch aborts non-zero and names the detected OS/arch" {
  run_platform Darwin riscv64
  [ "$status" -ne 0 ]
  [[ "$output" == *"Darwin"* ]]
  [[ "$output" == *"riscv64"* ]]
}

@test "unsupported arch abort does not touch the network" {
  run_platform Darwin riscv64
  [ "$status" -ne 0 ]
  [ ! -f "$NET_MARKER" ]
}

# --- Harness: every supported pair + multiple unsupported pairs ------------

@test "all four supported pairs each print their token and exit 0" {
  for pair in "Darwin arm64 darwin-arm64" \
              "Darwin x86_64 darwin-x86_64" \
              "Linux arm64 linux-arm64" \
              "Linux x86_64 linux-x86_64"; do
    set -- $pair
    run_platform "$1" "$2"
    [ "$status" -eq 0 ]
    [ "$output" = "$3" ]
  done
}

@test "multiple unsupported pairs each abort non-zero without network" {
  for pair in "Windows x86_64" \
              "Darwin mips" \
              "Solaris sparc"; do
    set -- $pair
    run_platform "$1" "$2"
    [ "$status" -ne 0 ]
    [[ "$output" == *"$1"* ]]
    [[ "$output" == *"$2"* ]]
    [ ! -f "$NET_MARKER" ]
  done
}
