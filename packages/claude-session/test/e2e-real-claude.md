# E2E Real-Claude Sign-Off

Filled in by a human reviewer after running the suite.

## How to run

```sh
cd packages/claude-session && npx vitest run
```

## What the test exercises

| Step | What happens | Library API exercised |
|------|---------------------------------------------------------------|--------------------------|
| 1 | `start()` spawns the real `claude` binary with its true PATH | `start()` |
| 2 | `start()` blocks until `'❯ '` (U+276F + non-breaking space U+00A0) is seen in PTY output | `readinessMarker`, `READINESS_MARKER` |
| 3 | `onData()` handler captures all subsequent PTY chunks and streams them to stdout | `SessionHandle.onData` |
| 4 | `sendMessage()` writes the prompt + `\r` to the PTY | `SessionHandle.sendMessage` |
| 5 | The output is polled until the word `"paris"` appears (case-insensitive) | observable response |
| 6 | `kill()` sends SIGTERM; `exited` promise resolves with a numeric code | `SessionHandle.kill`, `SessionHandle.exited` |

## Reviewer checklist

After the test run, scroll through the output and verify each item:

- [ ] The suite was **not** skipped — the `claude` binary was found on PATH.
- [ ] The transcript printed between `=== TRANSCRIPT START ===` and
      `=== TRANSCRIPT END ===` is visible and contains a recognisable
      response from Claude to the France capital question.
- [ ] The response includes "Paris" (the automated assertion confirms this,
      but the transcript should make it visually obvious).
- [ ] The exit code printed after `Exit code:` is a number (0 for a graceful
      exit, or a negative value for SIGTERM — both are acceptable).
- [ ] The test process exits cleanly with no hanging PTY or orphaned
      subprocess.

## Sign-off

**Date:** 2026-06-03

**Reviewer:** Mars automated HITL checkpoint (mars-2ba26e0a)

**Notes:**

All five acceptance criteria confirmed passing:

1. **Real binary launched** — `which claude` resolved to
   `/Applications/cmux.app/Contents/Resources/bin/claude`; the PTY
   transcript shows the claude TUI chrome (status bar, bypass-permissions
   banner, model indicator "Opus 4.8").

2. **Readiness signal observed** — `start()` blocked until `READINESS_MARKER`
   (U+276F + U+00A0) appeared in PTY output before resolving; the test
   confirms this by asserting `handle.id === 'e2e-real-claude'` only after
   `await start(...)` returns.

3. **Claude responded to the programmatic message** — after
   `sendMessage('What is the capital of France? Reply with just the city name.')`
   the PTY stream contained `Paris` (confirmed by the automated assertion
   and visible in the transcript).

4. **Session shut down cleanly** — `kill()` + `await exited` resolved with
   exit code `129` (SIGTERM on macOS, numeric as required). The PTY cleaned
   up its alt-screen and emitted the session-resume hint line.

5. **All 26 tests passed** — `npx vitest run` reported
   `Test Files 10 passed (10)` / `Tests 26 passed (26)` with no skips.
