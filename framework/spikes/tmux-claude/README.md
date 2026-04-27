# spike: tmux + Claude Code mechanics

Throwaway spike. Validates §8.7.2 of `docs/CONTRACTS.md` before the real Runner adapter is written. Do not import from this directory.

## What it tests

1. Detached tmux session on isolated socket `-L mars`.
2. Three env vars unset before spawn: `CLAUDECODE`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_ENTRYPOINT`.
3. `history-limit 50000` set immediately after `new-session`.
4. TUI readiness detection via `capture-pane` polling for a stable startup marker.
5. Workspace trust dialog handling (the gotcha surfaced before the spike).
6. Sending a minimal prompt that instructs Claude Code to write `intent.json` and exit.
7. Liveness probe: `has-session` -> `display-message -p "#{pane_pid}"` -> `kill -0 <pid>`.
8. Exit detection: poll `intent.json` mtime + `has-session` returning false.
9. Cleanup: SIGTERM pane PID -> 5s grace -> SIGKILL -> `kill-session`.

## Files

- `spike.sh` — the script. Run it. Prints every step.
- `NOTES.md` — populated by the spike run with the locked readiness heuristic, gotchas, and a verdict on whether §8.7.2 survives reality.

## Running

```bash
./spike.sh
```

Requires: `tmux`, `claude` (Claude Code CLI), `jq` (for intent.json validation).

The spike writes its scratch state under `./run/` (gitignored) so re-runs are clean.
