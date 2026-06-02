# Daemon shutdown — context for force-stop escalation work

This note exists because the PRD for "make mars watch --stop --force
actually terminate" uses CLI terminology that no longer matches the
codebase. Read this before opening a Slice-1 implementation.

## Terminology mapping

The PRD says **`mars watch --stop --force`**. That command was renamed:

- `mars watch` now errors with `mars watch has been renamed to mars
  daemon` (`src/cli.ts`, around line 1541).
- The current entry point is **`mars daemon stop --force`** (`src/cli.ts`,
  around line 1552). It sends `{ op: 'shutdown', force: true }` over the
  UDS socket via `sendRequest` from `./mastra/daemon/client`.
- There is also a separate **`mars daemon kill`** verb that sends
  `{ op: 'kill' }` (`server.ts` around line 1280). `kill` already does
  the "hard exit" leg of the escalation — SIGKILLs every tracked child,
  marks rows failed, unlinks socket+pid, then SIGKILLs the daemon's
  pgid/pid. Slice 1 is about folding the *bounded escalation* into the
  `shutdown` op so a single `daemon stop --force` is enough; the existing
  `kill` op stays as the explicit nuclear button.

Throughout the slice's acceptance criteria, read "forced stop" as the
`shutdown` op with `force: true`, **not** the `kill` op.

## Current shutdown contract

`server.ts` — handler dispatch is around lines 1248–1278; the
`shutdown(force)` function is around lines 1405–1452.

Today the three modes are:

| request                                | path                                     |
| -------------------------------------- | ---------------------------------------- |
| `{ op: 'shutdown', drain: true }`      | flip `acceptingWork = false`, then call `shutdown(false)` which waits indefinitely on `inFlight` |
| `{ op: 'shutdown', force: true }`      | call `shutdown(true)` — skips the drain loop, calls `server.close()`, unlinks sock+pid, `process.exit(0)` |
| `{ op: 'shutdown' }` (idle stop)       | refuses if `inFlight.size > 0`; otherwise `shutdown(false)` (idle path) |

The bug Slice 1 must fix: `shutdown(true)` *can* still hang even though
it skips the drain loop, because:

1. `await new Promise(resolve => server.close(() => resolve()))` waits
   for every existing UDS connection to fully end.
2. In-flight workflow runs (claude subprocesses, DuckDB/LibSQL handles,
   spawned git/verify) keep the libuv event loop busy. `process.exit(0)`
   is unconditional once we reach it, but anything that throws or hangs
   *before* it — including a stuck `server.close()` — strands the
   process.

The `kill` op already solves the hard-exit half via `killAllChildren()`
+ pgid SIGKILL (`server.ts` lines 1311–1349). Slice 1 should reuse that
infrastructure rather than re-inventing it.

## Suggested escalation skeleton (Slice 1 only)

Tracer-bullet vertical slice. Inside the existing `shutdown(force=true)`
branch, layer the escalation:

1. **Graceful (existing)** — `server.close()` + unlink + `process.exit(0)`,
   but wrap in a timer (~2s) so it can't block forever.
2. **Soft termination** — if graceful didn't land, `process.kill(process.pid, 'SIGTERM')`. The existing `SIGINT/SIGTERM` handler
   (line 1454) already calls `shutdown(false)` — for the force path you
   want a separate trap or a flag that routes the SIGTERM into a
   non-blocking exit. Easiest: skip re-entering `shutdown` and just
   `process.exit(0)` from the trap when `force` is set.
3. **Hard exit** — after ~5s total wall time, reuse `killAllChildren()`
   from `./lib/git` and the pgid/pid SIGKILL block from the `kill`
   handler. `process.kill(-process.pid, 'SIGKILL')` in detached/leader
   mode, plain `SIGKILL` to self otherwise.

Whatever shape you pick: the escalation must (a) stop at the earliest
step that succeeds, (b) bound total wait around 5s, (c) leave non-force
`shutdown` untouched.

## Resource cleanup checklist

The acceptance criterion "release all held resources" means:

- Unlink the UDS socket file (`socketPath` — daemon refuses to start if
  a live socket exists, lines 155–171).
- Unlink the pid file (`pidFile`).
- Close DuckDB observability handles (the probe at lines 178–193
  enforces single-writer; a leaked fd blocks the next `--detach`).
- Close LibSQL/queue handles (look at `initQueue` from `../queue`).

`shutdown()` currently only unlinks sock+pid. DuckDB/LibSQL rely on
process exit to release; SIGKILL is sufficient, but make sure the
graceful path closes them explicitly when it has the chance.

## Where tests go

`src/core/daemon/__tests__/`. Existing patterns: `sem-reload.test.ts`
(in-process daemon start + RPC), `duckdb-lock.test.ts` (probe-only).
Slice 1 needs a test that:

- Boots `startDaemon`, fakes an "undrainable" in-flight entry,
- Issues `{ op: 'shutdown', force: true }`,
- Asserts the daemon process is gone within ~5s (or, in-process, that
  the test child exits and the socket file is unlinked).

A real child-process test (spawning a `node ./bin/daemon`-style entry)
is cleaner for the "no daemon process remains" criterion than poking
internals.

## Out of scope for Slice 1

- Reworking `kill` (separate verb, fine as-is).
- Splitting `shutdown` into multiple ops.
- Touching the non-force drain semantics — they must stay byte-identical.

If any of the above turn out to be necessary, file follow-ups via
`mars proposal add` or `mars task add --blocked-by $TASK_ID` per the
deviation rules in the brief.
