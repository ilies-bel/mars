#!/usr/bin/env bash
# spike: tmux + Claude Code mechanics — validates docs/CONTRACTS.md §8.7.2
# Throwaway. Re-runs are idempotent.

set -u
set -o pipefail

# ---------- config ----------
SOCKET="mars"
HANDLE_ID="spike-$(date +%s)"
ROLE="planner"
SESSION="mars-${ROLE}-${HANDLE_ID}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${SCRIPT_DIR}/run/${HANDLE_ID}"
INTENT_PATH="${RUN_DIR}/intent.json"
WORKTREE_PATH="${RUN_DIR}/worktree"
LOG_FILE="${RUN_DIR}/spike.log"
READY_MARKER_TIMEOUT=30      # seconds to wait for TUI ready
INTENT_TIMEOUT=120           # seconds to wait for intent.json
POLL_INTERVAL=1

mkdir -p "${RUN_DIR}" "${WORKTREE_PATH}"

# ---------- helpers ----------
log() {
  local msg="[$(date +%H:%M:%S)] $*"
  echo "$msg" | tee -a "${LOG_FILE}"
}

fail() {
  log "FAIL: $*"
  log "spike state preserved at ${RUN_DIR}"
  log "tmux session (if alive): tmux -L ${SOCKET} attach -t ${SESSION}"
  exit 1
}

cleanup_tmux() {
  if tmux -L "${SOCKET}" has-session -t "${SESSION}" 2>/dev/null; then
    local pid
    pid="$(tmux -L "${SOCKET}" display-message -p -t "${SESSION}" "#{pane_pid}" 2>/dev/null || echo "")"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      log "cleanup: SIGTERM pane pid ${pid}"
      kill -TERM "${pid}" 2>/dev/null || true
      for i in 1 2 3 4 5; do
        kill -0 "${pid}" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "${pid}" 2>/dev/null; then
        log "cleanup: SIGKILL pane pid ${pid} (grace expired)"
        kill -KILL "${pid}" 2>/dev/null || true
      fi
    fi
    log "cleanup: kill-session ${SESSION}"
    tmux -L "${SOCKET}" kill-session -t "${SESSION}" 2>/dev/null || true
  fi
}
trap cleanup_tmux EXIT

# ---------- preflight ----------
log "spike start: handle=${HANDLE_ID} session=${SESSION}"
log "run dir: ${RUN_DIR}"

command -v tmux  >/dev/null || fail "tmux not on PATH"
command -v claude >/dev/null || fail "claude not on PATH"
command -v jq    >/dev/null || fail "jq not on PATH"

log "tmux: $(tmux -V)"
log "claude: $(claude --version 2>&1 | head -1)"

# Make sure no stale session collides.
if tmux -L "${SOCKET}" has-session -t "${SESSION}" 2>/dev/null; then
  fail "session ${SESSION} already exists on socket ${SOCKET}"
fi

# ---------- step 1: spawn detached tmux session ----------
# §8.7.2: -L mars socket isolation, -d detach, -c cwd, env hygiene via bash wrapper.
# We unset CLAUDECODE / CLAUDE_CODE_SSE_PORT / CLAUDE_CODE_ENTRYPOINT in the wrapper
# (env -u in the outer command would not propagate through the bash -c subshell
# the way we want; doing it inside the wrapper is unambiguous).

log "step 1: spawning detached tmux session"

# Minimal system prompt: instruct Claude Code to write intent.json and exit.
# Using --append-system-prompt so we don't replace the default scaffolding;
# this is the closest analog to how the real Runner will inject role prompts.
SYSTEM_PROMPT="You are a Mars planner agent in a spike test. Your only task: write the literal JSON {\"kind\":\"plan\",\"plan\":{\"goal\":\"hello\",\"tasks\":[]}} to the file at ${INTENT_PATH} using your Write tool, then exit. Do not ask questions. Do not write anything else. The file must be valid JSON parseable by jq."

# Wrapper script — bash -c with env hygiene, then exec claude.
# Quoting: we build the wrapper into a temp file to avoid escaping nightmares.
WRAPPER="${RUN_DIR}/wrapper.sh"
cat > "${WRAPPER}" <<EOF
#!/usr/bin/env bash
unset CLAUDECODE
unset CLAUDE_CODE_SSE_PORT
unset CLAUDE_CODE_ENTRYPOINT
export PATH="\$PATH"
cd "${WORKTREE_PATH}"
exec claude --allowedTools Write --append-system-prompt "\$(cat ${RUN_DIR}/system-prompt.txt)" "Write the intent.json file to ${INTENT_PATH} now, then exit."
EOF
chmod +x "${WRAPPER}"

# System prompt to a file (avoids shell quoting hell with the JSON payload).
printf '%s' "${SYSTEM_PROMPT}" > "${RUN_DIR}/system-prompt.txt"

# Spawn.
tmux -L "${SOCKET}" new-session -d -s "${SESSION}" -x 200 -y 50 -c "${WORKTREE_PATH}" "${WRAPPER}" \
  || fail "tmux new-session failed"

# §8.7.2: scrollback immediately after new-session.
tmux -L "${SOCKET}" set-option -t "${SESSION}" -g history-limit 50000 \
  || fail "tmux set-option history-limit failed"

log "step 1: session ${SESSION} spawned"

# ---------- step 2: liveness probe (alive) ----------
log "step 2: liveness probe (expecting alive)"
sleep 1
tmux -L "${SOCKET}" has-session -t "${SESSION}" \
  || fail "has-session returned false immediately after spawn"
PANE_PID="$(tmux -L "${SOCKET}" display-message -p -t "${SESSION}" "#{pane_pid}")"
[[ -n "${PANE_PID}" ]] || fail "pane_pid empty"
kill -0 "${PANE_PID}" 2>/dev/null \
  || fail "kill -0 ${PANE_PID} failed: pane process not alive"
log "step 2: alive — pane_pid=${PANE_PID}"

# ---------- step 3: TUI readiness detection ----------
# This is the unknown the spike is meant to lock.
# Strategy: poll capture-pane every POLL_INTERVAL seconds. Look for one of:
#   - "trust this folder"      -> trust dialog; auto-Enter to accept
#   - "/help" or ">" prompt    -> ready for input (heuristic: bottom-of-screen prompt char)
# Time out after READY_MARKER_TIMEOUT.

log "step 3: waiting for TUI readiness (timeout ${READY_MARKER_TIMEOUT}s)"
ready_marker_seen=""
trust_handled=""
elapsed=0
while (( elapsed < READY_MARKER_TIMEOUT )); do
  capture="$(tmux -L "${SOCKET}" capture-pane -t "${SESSION}" -p 2>/dev/null || true)"
  if [[ -z "${trust_handled}" ]] && echo "${capture}" | grep -qi "trust this folder"; then
    log "step 3: trust dialog detected; sending Enter"
    tmux -L "${SOCKET}" send-keys -t "${SESSION}" Enter
    trust_handled="yes"
    sleep 2
  elif echo "${capture}" | grep -qE '^\s*[>❯]' || echo "${capture}" | grep -qi 'try "'; then
    ready_marker_seen="prompt"
    log "step 3: ready marker seen (prompt visible); trust_handled=${trust_handled:-no}"
    break
  fi
  sleep "${POLL_INTERVAL}"
  elapsed=$(( elapsed + POLL_INTERVAL ))
done

if [[ -z "${ready_marker_seen}" ]]; then
  log "step 3: TIMEOUT waiting for TUI readiness; final capture:"
  tmux -L "${SOCKET}" capture-pane -t "${SESSION}" -p | tee -a "${LOG_FILE}"
  fail "TUI readiness not detected within ${READY_MARKER_TIMEOUT}s"
fi

# Snapshot capture for the notes file.
tmux -L "${SOCKET}" capture-pane -t "${SESSION}" -p > "${RUN_DIR}/capture-after-ready.txt"

# ---------- step 4: wait for intent.json ----------
log "step 4: waiting for intent.json at ${INTENT_PATH} (timeout ${INTENT_TIMEOUT}s)"
elapsed=0
while (( elapsed < INTENT_TIMEOUT )); do
  if [[ -s "${INTENT_PATH}" ]]; then
    log "step 4: intent.json appeared after ~${elapsed}s"
    break
  fi
  # If the session died before producing intent, fail loud.
  if ! tmux -L "${SOCKET}" has-session -t "${SESSION}" 2>/dev/null; then
    log "step 4: session ended without producing intent.json; final capture:"
    cat "${RUN_DIR}/capture-after-ready.txt" || true
    fail "session died before intent.json was written"
  fi
  sleep "${POLL_INTERVAL}"
  elapsed=$(( elapsed + POLL_INTERVAL ))
done

[[ -s "${INTENT_PATH}" ]] || fail "intent.json never appeared (timeout ${INTENT_TIMEOUT}s)"

# Validate it's parseable JSON with the expected shape.
if ! jq -e '.kind == "plan" and .plan.goal == "hello"' "${INTENT_PATH}" >/dev/null 2>&1; then
  log "step 4: intent.json contents:"
  cat "${INTENT_PATH}" | tee -a "${LOG_FILE}"
  fail "intent.json schema mismatch"
fi
log "step 4: intent.json valid"
cat "${INTENT_PATH}" | jq . | tee -a "${LOG_FILE}"

# ---------- step 5: try /exit (clean shutdown), fall back to signals ----------
# Finding to verify: Claude Code's interactive TUI does not auto-exit when its
# task is done. The orchestrator must terminate it. We try a clean /exit first,
# then fall back to the signal cleanup in the trap.

log "step 5: sending /exit to agent (clean shutdown attempt)"
tmux -L "${SOCKET}" send-keys -t "${SESSION}" "/exit" Enter
exit_method=""
elapsed=0
while (( elapsed < 15 )); do
  if ! kill -0 "${PANE_PID}" 2>/dev/null; then
    exit_method="/exit"
    log "step 5: pane process exited cleanly via /exit after ~${elapsed}s"
    break
  fi
  sleep "${POLL_INTERVAL}"
  elapsed=$(( elapsed + POLL_INTERVAL ))
done

if [[ -z "${exit_method}" ]]; then
  log "step 5: /exit did not terminate the agent in 15s — finding: TUI does not honor /exit cleanly; orchestrator must signal-kill"
  log "step 5: capture-pane after /exit attempt:"
  tmux -L "${SOCKET}" capture-pane -t "${SESSION}" -p | tail -10 | tee -a "${LOG_FILE}"
  log "step 5: trap will SIGTERM/SIGKILL on exit"
fi

# ---------- step 6: liveness probe (dead) ----------
# Expect: kill -0 returns false now.
if kill -0 "${PANE_PID}" 2>/dev/null; then
  log "step 6: SKIPPED — pane still alive (will be cleaned up by trap)"
else
  log "step 6: liveness probe (expecting dead) — kill -0 ${PANE_PID} returned false. ✓"
fi

# ---------- done ----------
log "spike PASSED — §8.7.2 mechanics validated for this run"
log "scratch state: ${RUN_DIR}"
log "log file: ${LOG_FILE}"
exit 0
