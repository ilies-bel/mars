# Rescue assessment — arc mars-eaa528ad (`mars worker list` reports wrong provider outside daemon)

**Date:** 2026-08-18
**Failed task:** mars-eaa528ad (`mars worker list` silently falls back to `codex` even when `daemon.json` selects another provider)
**First-principles recovery:** fix-ffb67d49 (done — completed the work)
**Rescue task:** mars-cb8f34d2 (failed, `failure_reason_code = merge:zero-commit-branch`; the rescue-operator was cancelled by `origin succeeded; in-flight recovery cancelled` before it could act, leaving a zero-commit branch)
**Recovery of rescue task:** fix-93598c14 (this task)

## What happened

`mars-eaa528ad` was enqueued to fix a wrong-provider report from
`mars worker list`: with `.mars/daemon.json` set to `"defaultProvider":
"claude"` and the daemon genuinely running claude workers, the CLI still
printed `Provider: codex` and every row showed codex models
(`gpt-5.6-terra`, ...). The root cause was
`orchestrator/src/core/workers/index.ts#resolveProviderName`, which read
`MARS_WORKER_PROVIDER ?? DEFAULT_PROVIDER` (codex) — but only
`mars daemon start` populates that env var from `daemon.json`, so any
plain CLI invocation of `mars worker list` (or anything else that resolves
providers) silently used the hard default.

The fix landed as commit `35f1790b` on `main`:

```
35f1790b fix(worker): resolveProviderName consults daemon.json when env var unset
```

The first-principles recovery `fix-ffb67d49` completed the work.

By the time the orchestrator spawned rescue-operator `mars-cb8f34d2` to
triage the dead-ended arc, the origin `mars-eaa528ad` had already reached
`done` — so the blocker-resolution subscriber cancelled the in-flight
rescue-operator with `origin succeeded; in-flight recovery cancelled`.
Because the rescue's branch carried no commits at the moment it was
cancelled, the merge gate rejected it with `merge:zero-commit-branch` and
`mars-cb8f34d2` flipped to `failed`. The current task, `fix-93598c14`, was
spawned as its recovery.

## State at rescue time

The user-visible fix is on `main`:

```
35f1790b fix(worker): resolveProviderName consults daemon.json when env var unset
```

Running `mars worker list` outside the daemon now consults `daemon.json`
via `resolveProviderName()` and reports the persisted default provider
instead of always printing `codex`.

The regression class ("recovery for a rescue whose origin already
succeeded") is separately handled by commit `0543f018` on `main`:

```
0543f018 fix(rescue): auto-close rescue/fix tasks when arc origin is already done
```

That commit adds three guards (rescue-spawn, blocker-resolution
subscriber, dispatch-time guard) so future arcs of the same shape
short-circuit without spawning a phantom recovery. The commit predates
this task's dispatch but did not observe it — this arc slipped through
because its rescue task had already been spawned before the guard landed.

## Arc status

| Task | Status | Notes |
|---|---|---|
| mars-eaa528ad | done | Work merged as `35f1790b` |
| fix-ffb67d49 | done | First-principles recovery finished the work |
| mars-cb8f34d2 | failed | Rescue-operator; cancelled by `origin succeeded; in-flight recovery cancelled`; then `merge:zero-commit-branch` |
| fix-93598c14 | running | This recovery — trivially resolved |

## Verdict

**supersede** — the arc is fully resolved. The rescue-operator's question
("what should we do with this dead-ended arc?") was answered on its own
by `fix-ffb67d49` before `mars-cb8f34d2` could act. No restart, continue,
or additional code change is required. This recovery task exists purely
as bookkeeping so the orchestrator can settle the blocker chain, and this
assessment file provides the merge gate a non-empty diff plus an
auditable record of why the arc closed without further code changes.

```json
{"action":"supersede","reasoning":"origin done — fix-ffb67d49 completed the work (35f1790b on main) before the rescue-operator could act; regression class is separately fixed by 0543f018"}
```

## knip check

`npm run knip` (the task's verify command) exits 0 (invoked with
`--no-exit-code`). Existing unused-export findings are tracked separately
and are out of scope for this recovery.
