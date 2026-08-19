# Investigation: in-flight coder's task row, worktree, and branch vanished mid-run

**Task:** `mars-26a90026` (report pipeline, read-only)
**Subject:** `mars-68870bba`, deleted 2026-08-19 20:32:41 while a coder was executing inside it
**Verdict:** **Not a reconciler, not a race, not raw SQL — an operator `mars drop` on a
`running` task.** The defect is that nothing stops it.

---

## 1. What actually happened

The event log survives task-row deletion by design (ADR-0030: `task.dropped` is
emitted in the *same* atomic transaction as `DELETE FROM tasks`, so the trace
outlives the row). Querying it resolves the question directly:

```sql
SELECT to_char(to_timestamp(ts),'MM-DD HH24:MI:SS'), type, payload
  FROM events WHERE payload LIKE '%68870bba%' ORDER BY id;
```

```
08-19 20:32:41 | task.dropped  | {"taskId":"mars-68870bba","dropReason":"purged"}
08-19 20:32:41 | task.terminal | {"taskId":"mars-68870bba","reason":"purged"}
```

Those two events, in that order with `dropReason:'purged'`, are emitted by exactly
three functions: `Arc.drop`'s origin leg (`arc.ts:2102-2105`), `Arc.drop`'s cascade
leg (`arc.ts:2114-2118`), and the two slicer purge helpers (`arc.ts:2454-2465`,
`arc.ts:2510-2521`).

It was the **origin leg of `Arc.drop`**. Widening to the surrounding event ids shows
the deletion was the first entry in a manual cleanup sweep:

```
139977  20:32:41  task.dropped   mars-68870bba          <-- the vanished task
139978  20:32:41  task.terminal  mars-68870bba
139979  20:33:41  task.dropped   mars-c7f01ce6      \_ origin + cascaded fix
139981  20:33:41  task.dropped   fix-cb2b7dea       /
139983  20:33:42  task.dropped   mars-bff7e039      \_ origin + cascaded fix
139985  20:33:42  task.dropped   fix-6c1d5a52       /
139987  20:35:33  action-queue.resolved  by "drop:pre-delete"
139988  20:35:33  task.dropped   fix-ce7ea677
139990  20:35:34  task.dropped   mars-bf95984a
```

Three tells:

1. **~60 s spacing** between drops — a human (or an agent acting as one) typing
   commands, not a sweep, which would fire them in one burst.
2. **`mars-68870bba` was dropped alone.** The later drops each show an origin
   plus its cascaded `fix-*` in the same second; `mars-68870bba` has no companion,
   so it was the *direct* `id` argument, not collateral from someone else's cascade.
3. **It cannot have been `mars purge`.** `purge` refuses non-terminal tasks and
   `queued`/`running` count as in-flight. `mars drop` accepts **any** status. So the
   command was `mars drop mars-68870bba`.

### Why all three artifacts disappeared together

One command, three symptoms — `dropTask` does the filesystem work and `Arc.drop`
does the row:

- `purge-task.ts:184` — `removeWorktree({ path, branch }, true)`, force, **no
  `keepBranch`** → deletes the worktree directory *and* the branch.
- `arc.ts:2403` — `DELETE FROM tasks WHERE id = ?`.

The coder's shell lost its cwd at precisely that moment, which is the
`Working directory ".../mars-68870bba" was deleted` message in the report.

---

## 2. The real defect: an unenforced precondition

`Arc.drop` is documented to work "regardless of status" (`arc.ts:1999-2000`) and
pushes in-flight cancellation onto its callers as prose:

> *"Caller is responsible for cancelling any in-flight workflow and removing the
> worktree+branch on disk before invoking this."* — `arc.ts:2002-2004`

**No caller enforces it.** `dropTask` guards only against an active *merge job*
(`purge-task.ts:155-156`: "refuse if an active merge job (queued/claimed/running)
exists for this task") — nothing about a running coder or implement workflow. The
`mars drop` CLI has no status guard at all, by documented design.

So dropping a `running` task force-removes the worktree from under a live agent
process that is never cancelled. The agent keeps running against a deleted cwd
until it happens to touch the filesystem and errors out.

This is the one destructive path in the system **without** a live-work guard.
Every sibling has one:

| Path | Guard |
|---|---|
| `merge.ts:849-860` post-merge cleanup | `findLiveWorktreeDependents` |
| `worktree-clean.ts:139-141`, `worktree-prune.ts:61-63` | `skip-in-flight` verdict + 30-min mtime guard + `git status --porcelain` dirty guard |
| stale-merging sweep, `server.ts:6396-6400` | explicit `taskIds`, *because* an unfiltered call once "deletes its worktree mid-flight (root cause of task mars-0c5ffe82)" |
| **`dropTask` / `Arc.drop`** | **merge-job only — nothing for a running coder** |

The stale-merging comment is notable: this exact failure mode has already bitten
once (`mars-0c5ffe82`) and was fixed narrowly at that one call site rather than as
a shared invariant.

---

## 3. Answers to the three questions in the brief

### 3.1 "Could a `stale-worktree` / `phantom-task` reconciler fire against a live worktree?"

**No — hypothesis disproven.** The ADR-0057 derive-on-read refactor did its job:

- `stale-worktree` is derived **read-only** in
  `daemon/view/derived-conditions.ts:488-533` — it `statSync`s and pushes rows,
  zero side effects. The former stored-row raiser is now a no-op stub returning
  `[]` (`daemon/stale-worktree-sweep.ts:23-25`).
- `phantom-task-watchdog` sets `status='failed'` and raises an action-queue row
  (`phantom-task-watchdog.ts:366-406`). It never deletes a row and never removes
  a worktree.
- `reconcilers.ts` contains **no** `DELETE FROM tasks` and **no** worktree removal.
- `action-queue-repopulator.ts` is non-destructive and explicitly refuses to raise
  for purged tasks (`:138-152`).

There was also no duplicate dispatch or second daemon: the single origin-leg event
pair rules out two writers.

**However, an adjacent gap in the same bug class does exist** — see R3 below.
`daemon/worktree-reclaim.ts` runs on boot *and* on a 10-minute interval
(`server.ts:7442-7463`) and removes worktree directories guarded only by the DB
query `isWorktreeSharedWithLiveTask` (`queue.ts:1854-1881`), with **no** mtime
guard and **no** dirty-tree guard — unlike the operator-only `worktree clean`.
Worse, at `worktree-reclaim.ts:123` vs `:139` the guard receives
`task.worktreePath ?? null` while the `rm` target falls back to
`<repoRoot>/.mars/worktrees/<id>`, so a NULL `worktree_path` silently degrades the
check to branch-only. Not this incident's cause, but the next one's.

### 3.2 "Were `task_blockers` rows left dangling? Does `orphanedBlockedScan` need extending?"

**No, and no.**

```sql
SELECT * FROM task_blockers
 WHERE task_id='mars-68870bba' OR blocker_task_id='mars-68870bba';
-- 0 rows
```

`Arc.drop` clears both edge directions inside the same transaction
(`arc.ts:2327-2329`), so no dependent was stranded.

`orphanedBlockedScan` does **not** need a "recovery task disappeared without
terminal status" case, because the premise is false: the drop *did* record a
terminal status. `task.terminal{reason:'purged'}` was emitted and survives. The
row is gone while its terminal event remains — which is exactly the ADR-0030
design working as intended, not a hole.

### 3.3 "Is the origin `mars-6340b827` permanently stranded with no recovery path?"

**No — the report's premise is incorrect on both counts.**

```
mars-6340b827 | failed | task/mars-6340b827
              | /Users/.../.mars/worktrees/mars-6340b827 | updated 08-18 10:14
```

Its branch **and** worktree are still on disk and intact, and it carries an **open**
action-queue row naming the exact recovery path:

```
59a092fc | recovery-abandoned | open | high | "Recovery task dropped"
  "Recovery task fix-3ed29ddf was manually dropped, not exhausted.
   Run `mars continue mars-6340b827` to resume on the existing worktree,
   or `mars restart mars-6340b827` to wipe and re-run."
```

(Raised 08-18 12:02 — pre-dating this incident and referring to a different
recovery task, `fix-3ed29ddf`.) The `recovery-abandoned` kind already covers
"a recovery task was manually dropped" and surfaces a live recovery verb, so
ADR-0040's leaf-node rule does not leave the arc dead-ended.

**Corollary worth recording:** because `mars-6340b827` is still `failed` — never
`dropped` — with `worktree_path` non-NULL and `updated_at` unchanged since 08-18,
the supersede preamble's Step 2 (`arc.ts:360-364`, `updateTask → status:'dropped',
worktreePath: null`) demonstrably **never ran against it**. So `mars-68870bba` was
not created by a completed `--supersede mars-6340b827`, and it never held the
supersede lock on that origin. That is also why dropping it left the origin
untouched. `mars-d039e664` later completed on its own branch
`task/mars-d039e664` (status `done`), not on an inherited one.

---

## 4. Recommendations

Report-only; each is a candidate task.

- **R1 — Give `dropTask` an in-flight guard symmetric to its merge-job guard.**
  `purge-task.ts:155`. Refuse when the task is `running`/`verifying`/`merging`
  unless `--force`, and on `--force` cancel the workflow and kill the worker
  *before* removing the worktree. This alone prevents the incident.

- **R2 — Make `Arc.drop`'s precondition enforceable rather than prose.**
  `arc.ts:2002-2004`. Either assert non-in-flight inside `drop()`, or funnel every
  caller through one cancel-then-drop helper so the invariant cannot be forgotten
  at a new call site — which is how `mars-0c5ffe82` and this incident both happened.

- **R3 — Route `worktree-reclaim.ts` removals through `worktreeRemovalGuard`**
  (mtime + dirty-tree), as `worktree-clean.ts` already does, and fix the
  guard/target path mismatch at `worktree-reclaim.ts:123` vs `:139` so a NULL
  `worktree_path` cannot degrade the check to branch-only.

- **R4 — Emit a trace event when a worktree is force-removed**, naming the
  remover and the target task. This incident needed SQL forensics against the
  `events` table to answer a question that should have been one `/events` read;
  the worktree removal itself left no trace at all.
