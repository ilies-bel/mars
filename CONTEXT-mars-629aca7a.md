# CONTEXT: mars-629aca7a — failed_phase stamping already on main

**Task**: Slice 1/4 of PRD `b35ff545-replace-mars-retry-with-two-distinct-ver` —
"Stamp failed_phase on verify/merge failure."

**Verdict**: No code change required. All six acceptance criteria are
already satisfied on `main` by commit `cc7f12c feat(orchestrator): split
retry into continue/restart, send retry-exhausted to 'failed' instead of
'dropped'`, which landed the failed_phase column, the migration, the
read/write paths, and the workflow stamps as a single coherent change.
Documenting the mapping rather than re-implementing, per repo precedent
(`5989df3`, `150d4c0`, `adb8e52`, `2bc63cc`, ...).

## Acceptance-criteria walkthrough

Mapping each `<done>` line to the exact location in the current tree
(line numbers as of this commit):

1. **A new nullable column on the tasks row stores `'verify' | 'merge' |
   'code' | NULL`** — `failed_phase TEXT` is added to `tasks` by the
   migration block in `orchestrator/src/mastra/queue.ts` lines 356-358.
   The TypeScript-side type `FailedPhase = 'code' | 'verify' | 'merge'`
   is declared at line 65 and threaded through `Task.failedPhase`
   (line 153). The read path coerces unknown/NULL raw values back to
   `null` via `coerceFailedPhase` (lines 724-727), and `rowToTask`
   exposes `failedPhase` on every read (line 716).

2. **Migration runs idempotently on an existing queue database without
   data loss** — the add-column is guarded by
   `if (!names.has('failed_phase'))` (line 356), which reads from
   `PRAGMA table_info(tasks)` (line 243). A second `initQueue` call on
   a DB that already has the column is a no-op: no `DROP`, no `UPDATE`,
   no backfill. Existing rows keep their data verbatim and the new
   column defaults to NULL.

3. **A task that fails its verify step has the column set to `'verify'`** —
   `orchestrator/src/mastra/workflows/implement-workflow.ts` lines
   892-896 (verifyStep failure branch):
   ```ts
   await updateTask(inputData.taskId, {
     status: 'failed',
     error: summary,
     failedPhase: 'verify',
   })
   ```
   `updateTask` supports the `failedPhase` field of the patch
   (`queue.ts` lines 888-891), writing it to the `failed_phase`
   column.

4. **A task that fails its merge step has the column set to `'merge'`** —
   four merge-step failure branches in `implement-workflow.ts` all
   stamp `failedPhase: 'merge'`:
   - dirty merge target (lines 1006-1010),
   - pre-flight git-status error (lines 1037-1041),
   - vcs-supervisor aborted (lines 1078-1082),
   - unhandled merge-step crash (lines 1114-1118).

5. **Tasks that succeed leave the column NULL** — both terminal-success
   paths explicitly clear the column to `null`:
   - Writer short-circuit `updateTask(... { status: 'done',
     failedPhase: null })` at line 970.
   - Coder happy path `updateTask(... { status: 'done',
     failedPhase: null })` at line 1102.
   Additionally, re-entering verify or merge clears the previous
   failure stamp (`failedPhase: null, resumeFrom: null`) at lines
   840-844 and 984-988, so a recovered-then-succeeded task never
   carries stale phase metadata.

6. **Existing tests still pass** — `cd orchestrator && npm run build &&
   npm test` succeeds (build green, 507/507 tests passing) at this
   commit.

## Why this is a "note, don't re-implement"

Slice 1 was implemented in the same change that introduced the slice's
downstream consumers (`mars continue` resume hint, status-transition
clearing, the `resume_from` sister column). Re-introducing the column
or the workflow stamps under a different shape would either be a no-op
edit or a regression. Per the project rule "every change is a hard cut"
(`CLAUDE.md`), the right action is to record the mapping and let the
orchestrator close the task, not to manufacture churn.

The remaining slices of PRD `b35ff545` (`mars continue` verb, `mars
restart` verb, `retry` removal) are separately enqueued and will be
verified against their own acceptance criteria on their own branches.

No code in `orchestrator/src/mastra/queue.ts`,
`orchestrator/src/mastra/workflows/`, or anywhere else needed
modification to satisfy slice 1's acceptance criteria.
