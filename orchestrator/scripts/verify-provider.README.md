# verify-provider

Operator script that enqueues a trivial Coder task and reports whether the
task completed successfully under the currently configured provider.

## Purpose

This script is part of the HITL slice for **provider-agnostic headless
dispatch** (PRD: `3f05ebd9-model-agnostic-headless-dispatch`). It gives an
operator a quick, repeatable way to confirm that a Codex- or Gemini-driven
Coder session can commit and merge just like a Claude-driven one.

## Prerequisites

### 1 — Provider CLI installed and authenticated

Before running the script, make sure the target provider's CLI is installed
and authenticated on the host:

| Provider | CLI | Auth check |
|----------|-----|------------|
| Claude | `claude` (Claude Code) | `claude --version` |
| Codex | `codex` | `codex --version` |
| Gemini | `gemini` | `gemini --version` |

The Mars Coder worker spawns the CLI directly; if the binary is missing or
unauthenticated the task will fail immediately.

### 2 — Set `MARS_WORKER_PROVIDER` and restart the daemon

The provider is a process-level setting that is read once at daemon startup.
To switch providers:

```bash
export MARS_WORKER_PROVIDER=codex   # or: gemini | claude (default)
mars daemon restart
```

> **Warning:** `mars daemon restart` hard-stops any in-flight tasks. Wait
> until the queue is empty (or deliberately abort in-progress work) before
> restarting.

### 3 — Mars daemon running

```bash
mars daemon status   # or: mars ui
```

The script reads `.mars/pg.dsn` and `.mars/http.port` from the repo root. If
either file is missing the script exits with an error.

## Usage

Run from the repo root or any subdirectory:

```bash
tsx orchestrator/scripts/verify-provider.ts
```

Or make the script executable and run directly:

```bash
chmod +x orchestrator/scripts/verify-provider.ts
orchestrator/scripts/verify-provider.ts
```

You can capture and forward the result:

```bash
tsx orchestrator/scripts/verify-provider.ts | tee /tmp/verify-result.txt
echo "exit: $?"
```

## Output

Progress lines are written to **stderr**; the final summary line is written
to **stdout**:

```
provider=codex commit=a1b2c3d4e5... status=done outcome=PASS
```

| Field | Meaning |
|-------|---------|
| `provider` | Active provider (from `MARS_WORKER_PROVIDER`, `daemon.json`, or default `claude`) |
| `commit` | Git SHA of the merge commit on `main`, or `none` |
| `status` | Final task status: `done` or `failed` |
| `outcome` | `PASS` if `done`, `FAIL` otherwise |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | PASS — task reached `done` |
| `1` | FAIL — task reached `failed` |
| `2` | Timeout — task did not finish within 10 minutes |

## What the script does

1. Reads `.mars/pg.dsn` (daemon DSN) and `.mars/http.port` (HTTP port) from
   the repo root to confirm the daemon is reachable.
2. Derives the active provider from `MARS_WORKER_PROVIDER` → `daemon.json`
   `defaultProvider` → `"codex"` (default).
3. Enqueues a single Coder task: append a unique `PROVIDER-VERIFY-<uuid>`
   marker line to `scratch/verify-provider.txt`.
4. Polls task status every 2 seconds via `GET /api/tasks/<id>`, timing out
   after 10 minutes.
5. On `done`: looks up the marker commit on `main` via
   `git log main -S<marker> --format=%H -1 -- scratch/verify-provider.txt`.
6. Prints the one-line summary and exits with the appropriate code.

The script reports `PASS` only when the task reaches `done` **and** the unique
marker commit is visible on `main`. A `done` task with no matching commit is a
failure because it has not demonstrated the standard merge path.

## Required three-run record

Run the script once each for Codex and Gemini, capturing the final output line
for the closing ritual note. Confirm the corresponding Coder Session's
provider label in `mars ui` after each run.

```bash
MARS_WORKER_PROVIDER=codex mars daemon restart
MARS_WORKER_PROVIDER=codex tsx orchestrator/scripts/verify-provider.ts | tee /tmp/verify-codex.txt

MARS_WORKER_PROVIDER=gemini mars daemon restart
MARS_WORKER_PROVIDER=gemini tsx orchestrator/scripts/verify-provider.ts | tee /tmp/verify-gemini.txt
```

For a Claude control, configure the scratch checkout with
`mars init --provider claude` (or otherwise set `.mars/daemon.json`'s
`defaultProvider` to `claude`), then unset the override and restart:

```bash
unset MARS_WORKER_PROVIDER
mars daemon restart
tsx orchestrator/scripts/verify-provider.ts | tee /tmp/verify-claude.txt
```

An unconfigured checkout defaults to Codex, so unsetting the variable alone
does not select Claude. If any run prints `FAIL`, file `mars proposal add`
with the complete summary line and the relevant dispatch/trace failure
signature before continuing.
