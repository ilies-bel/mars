# spike notes — tmux + Claude Code mechanics

**Date:** 2026-04-27
**Verdict:** §8.7.2 mechanics survive contact with reality, with three documented amendments to the contract and one open question.

## Run summary

End-to-end pass in ~7 seconds:
- Spawn detached tmux session: instant
- Liveness probe (alive): 1s after spawn
- TUI readiness detected: ~1s
- `intent.json` written and validated: ~3s after spawn
- Clean `/exit`: ~1s

## What worked exactly as §8.7.2 specs

| Mechanic | Status |
|---|---|
| Socket isolation `-L mars` | ✓ |
| Session naming `mars-<role>-<handleId>` | ✓ |
| Detached spawn `new-session -d` with `-c <worktreePath>` | ✓ |
| `unset CLAUDECODE / CLAUDE_CODE_SSE_PORT / CLAUDE_CODE_ENTRYPOINT` before launch | ✓ (no inheritance misbehavior observed) |
| `set-option history-limit 50000` after spawn | ✓ |
| Three-step liveness probe (`has-session` → `pane_pid` → `kill -0`) | ✓ both directions (alive after spawn, dead after exit) |
| Cleanup chain (`SIGTERM` → grace → `SIGKILL` → `kill-session`) | ✓ — and the `/exit` fast-path made it unnecessary |

## Findings — amendments to §8.7.2

### F1. The TUI does not auto-exit on task completion. Use `/exit`, fall back to signals.

The contract's exit-detection clause — *"Poll `intent.json` mtime AND `has-session` returning false"* — assumes the agent self-terminates. **It does not.** Claude Code's interactive TUI returns to its prompt waiting for the next user message after writing the file.

**Verified shutdown path:** `tmux send-keys "/exit" Enter` cleanly terminates the pane process within ~1s. The cleanup trap's signal cascade is the fallback.

**Proposed contract revision (§8.7.2 "Exit detection"):**
> Detect intent completion by polling `intent.json` mtime. On detection, send `/exit` via `send-keys` for a clean shutdown. If the pane PID is still alive after a 5s grace period, fall back to `SIGTERM` → 5s → `SIGKILL` → `kill-session`.

This preserves the "intent.json is the source of truth" rule (§8.7.2) but adds the missing termination step. The orchestrator drives termination — agents do not self-exit.

### F2. The workspace trust dialog did not fire for a worktree under a trusted parent.

§8.7.2 doesn't mention the trust dialog at all; it surfaced during pre-spike probing in `/tmp` (an unfamiliar directory). When the spike ran with a worktree path under the already-trusted `mars-framework` repo, **no trust dialog appeared.**

**Implication:** The contract's invariant (§9.3) — *"Each spawn gets its own git worktree under `.mars/worktrees/<handleId>/`"* — happens to side-step the trust dialog because all worktrees are under the trusted repo root.

**Caveat:** If a future config ever points worktrees outside the repo (or runs Mars in a fresh checkout that hasn't been trusted yet), the dialog will block. The spike retained `send-keys Enter` handling for the dialog as defensive code, but it never fired in the green-path run. **Recommend keeping the trust-dialog detection in the real Runner** as a defensive readiness step — costs nothing when not needed, prevents a hang when needed.

### F3. The TUI-ready heuristic is fragile and should be tightened.

The spike's heuristic was `grep -qE '^\s*[>❯]'` against `capture-pane`. This worked but matched on a transient frame where the user-prompt was already echoed and Claude was thinking. Two more reliable markers observed:

- The Claude Code banner block at the top: `Claude Code v2.1.120` plus the model line. Stable, appears within ~1s of spawn.
- The bottom status line: `auto mode on (shift+tab to cycle)`. Stable, appears once the TUI input is ready.

**Recommended marker for the real Runner:** look for the bottom status line (`auto mode on` or equivalent). It appears strictly after input is accepted. The top banner appears earlier than the input-ready state and should not be used.

**Proposed contract addition (§8.7.2 new row "TUI readiness"):**
> Poll `capture-pane` for the bottom status line (`"auto mode on"` substring). Timeout 30s. The top banner is *not* a readiness marker — it appears before the TUI accepts input.

### F4. Spawned Claude Code inherits the user's account, model, and effort.

The captured banner read: `Opus 4.7 with high effort · Claude Max`. The spike never specified a model or effort level — these were inherited from the local Claude Code config / login. For a Mars run, this is a problem:

- **Cost determinism.** A user on Max with high effort burns very different tokens than the same user on default. Mars's `BudgetPool` (§9.4) becomes meaningless if the per-call cost varies with whoever spawned the orchestrator.
- **Reproducibility.** Two runs against the same plan should be comparable. Inherited effort defeats that.

**Open question for the contract:** does the Mars Runner pin `--model <id>` and `--effort <level>` on every spawn? Likely yes. Where do the values live — `mars.config.ts`? Per-role in the agent template frontmatter (§15.1)?

**Recommendation:** add a `model` and `effort` field to the agent template frontmatter (§15.1), validated by the compiler, injected by the runtime as `--model` / `--effort` flags. Default to `sonnet` + `medium` for cost frugality (§VISION token-cost anti-goal).

This is the only finding that requires a real contract addition rather than a clarification.

## Confirmations (no changes needed)

- **No `node-pty` needed.** tmux's PTY does the job; `child_process.spawn` would have failed exactly as §8.7.1 predicted.
- **Detached survival.** The spike orchestrator (the bash script) controls the agent's lifecycle, but the agent's pane PID is independent — orchestrator crash would not have killed the agent. Verified architecturally; not stress-tested.
- **`--allowedTools Write`.** The narrow allowlist worked. The TUI did not prompt for Write permission. Matches §8.8's allow-only posture.
- **Append-system-prompt over file.** Loading the system prompt from a file (`$(cat ...)`) avoids JSON-in-shell quoting hell. Recommend the real Runner do the same: write the composed prompt to `.mars/runs/<id>/system-prompt.txt` and reference it.

## What the spike did **not** test

- Crash recovery. The orchestrator (script) ran to completion; we did not Ctrl-C it mid-run and verify reattach + liveness.
- Concurrent sessions. Only one agent at a time. The §9.2 cap of 3 parallel agents is not stressed.
- The sidecar UDS for tools (§8.8). Spike used `--allowedTools Write` (built-in), not a custom Mars tool. The UDS handler is its own spike.
- Long-running agents. The task completed in ~3s. Behavior under multi-minute sessions, scrollback overflow, and budget exhaustion is unverified.
- `mars agents attach` UX. We never attached to a live session. `tmux -L mars attach -t <session>` should Just Work but is unverified.

## Verdict

§8.7.2 stands. The four findings are amendments and one new requirement (model/effort pinning), not a rewrite. The tmux-based Runner shape is sound; proceed with implementing it as the real adapter.

## Next contract edits (suggested, not yet applied)

1. §8.7.2 "Exit detection" row: add the `/exit` clean-shutdown step before the signal cascade (F1).
2. §8.7.2: add a "TUI readiness" row pointing to the bottom status-line marker (F3).
3. §15.1 frontmatter: add required `model` and `effort` keys, with compiler validation (F4).
4. §9.4 BudgetPool: note that token determinism depends on §15.1 model/effort being pinned (F4 cross-reference).
