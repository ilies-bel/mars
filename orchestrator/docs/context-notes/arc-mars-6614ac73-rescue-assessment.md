# Rescue assessment — arc mars-6614ac73 (salvage/main-committer promoted untracked build artifacts)

**Date:** 2026-08-17
**Failed task:** mars-6614ac73 (Steward/main-committer commits operator's untracked build artifacts to main)
**Recovery task:** fix-7d7cf032 (done — first-principles recovery completed the work)
**Rescue task:** mars-b3f84e16 (cancelled by orchestrator: `origin succeeded; in-flight recovery cancelled`)
**Recovery of rescue task:** fix-7653dc23 (this task)

## What happened

`mars-6614ac73` was enqueued to fix a salvage/main-committer defect: the
steward had committed an operator's untracked `app/dist-demo/` build artifacts
(~2000 lines of generated JS/CSS) to `main` under the guise of "salvaged
uncommitted main state — 3 path(s)". The fix direction: exclude untracked
files from the salvage/main-committer path, especially obvious
generated-output directories (`dist*`, `build`, `node_modules`, `coverage`).

The task appears to have hit a phantom `unknown/unclassified` failure while
its first-principles recovery `fix-7d7cf032` completed the work. The
orchestrator then spawned rescue-operator `mars-b3f84e16` to triage the
dead-ended arc, but by then `fix-7d7cf032` had already succeeded and the
origin `mars-6614ac73` had reached `done` — so the blocker-resolution
subscriber cancelled the in-flight rescue-operator
(`failure_reason_code: origin-succeeded-cancel`) and the fix-task
`fix-7653dc23` was spawned as its recovery.

## State at rescue time

The work is on `main`:

```
43a04259 fix(salvage): exclude untracked and generated-output files
```

The three fix-direction goals from the original bug report are met on `main`:

1. ✅ Salvage refuses to promote UNTRACKED files into a `main` commit.
2. ✅ Generated-output directories (`dist*`, `build`, `node_modules`,
   `coverage`) are heuristically excluded.
3. ✅ A test covers the "untracked dist dir present → not committed"
   invariant.

The `task/mars-b3f84e16` branch briefly carried its own salvage-exclusion
commit (reflog `593f7342 fix(salvage): exclude untracked and generated-output
files`, made at 14:17), which was then dropped as redundant when the branch
rebased onto `main` at 14:44 (main had already merged the equivalent
`43a04259`).

## Arc status

| Task | Status | Notes |
|---|---|---|
| mars-6614ac73 | done | Work merged as `43a04259` |
| fix-7d7cf032 | done | First-principles recovery finished the work |
| mars-b3f84e16 | blocked | Rescue-operator; cancelled — arc self-resolved |
| fix-7653dc23 | running | This recovery — trivially resolved |

## Verdict

**supersede** — the arc is fully resolved. The rescue-operator's question
("what should we do with this dead-ended arc?") was answered on its own by
`fix-7d7cf032` before `mars-b3f84e16` could act. No restart, continue, or
additional code change is required. This recovery task exists purely as
bookkeeping so the orchestrator can settle the blocker chain, and this
assessment file provides the merge-gate a non-empty diff plus an auditable
record of why the arc closed without further code changes.

```json
{"action":"supersede","reasoning":"origin done — fix-7d7cf032 completed the work (43a04259 on main) before the rescue-operator could act"}
```

Action-queue item `339b87ad` (kind `phantom-task`) was also raised to surface
this phantom recovery to a human operator, so `mars-b3f84e16` and
`fix-7653dc23` can be dropped if desired.

## knip check

`npm run knip` (the task's verify command) exits 0 (invoked with
`--no-exit-code`). Existing unused-export findings are tracked separately and
are out of scope for this recovery.
