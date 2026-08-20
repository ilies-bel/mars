# Investigation: arc mars-8693f3a4 "dead-ended" from transient API disconnects, not a code defect

**Rescue task:** `mars-ed0e040e` (rescue-operator, this task — itself hit the same
failure mode twice before this run)
**Subject arc:** `mars-8693f3a4` — "Baseline repair: deterministic manifest-version
resolution" (slice 3 of 3, split from `mars-bff7e039`)
**Verdict:** **`continue`.** No code defect, no salvageable/discardable work either
way — every attempt died before writing a single commit. By the time this rescue
session finished diagnosing, the arc had already been re-queued and was running
again; no further action was taken to avoid duplicating that in-flight recovery.

---

## 1. What actually happened

Event trace for `mars-8693f3a4` (`events` table, `payload LIKE '%8693f3a4%'`):

```
08-20 00:52:01  task.blocked    mars-8693f3a4   (waiting on blocker mars-fe65474f)
08-20 02:05:46  task.unblocked  mars-8693f3a4
08-20 02:38:29  task.failed     mars-8693f3a4   exit 1, "API Error: Connection
                                                 closed mid-response"
08-20 02:38:29  task.blocked    mars-8693f3a4   fixTaskId=fix-3ae33675 (auto-recovery)
08-20 05:16:25  task.failed     fix-3ae33675    exit 1, same "API Error: Connection
                                                 closed mid-response"
08-20 05:16:25  action-queue.raised             kind=failed, signature includes
                                                 code:coder-exit-nonzero/unclassified
08-20 05:16:59  task.terminal   mars-8693f3a4   reason=failed
                                                 error=origin_recovery_failed:fix-3ae33675
08-20 10:36:22  task.queued     mars-8693f3a4   re-queued (external `mars continue`)
08-20 10:38:26  (status=running, updating)      coder actively running again
```

Both the origin coder run and its one permitted recovery attempt (`fix-3ae33675`)
died the same way: `exit 1`, empty stderr, last stream text
`API Error: Connection closed mid-response. The response above may be incomplete.`
This is a transport-level drop of the Anthropic API connection, not an error
surfaced by the coder's own logic — there is no stack trace, no failing
assertion, no lint/type error anywhere in either diagnostic artifact.

Diagnostic logs:
- `.mars/worktrees/mars-8693f3a4/.mars/coder-failures/fix-3ae33675#31bf7056.log`

Per this arc's own recovery policy, one failed recovery attempt is
non-recoverable and the origin goes to `failed` for an operator to resolve
explicitly (`mars continue` or `mars restart`) — which is exactly what
happened, and is also why this rescue-operator task (`mars-ed0e040e`) exists.

### The rescue task hit the identical failure, twice

`mars-ed0e040e`'s own first run, and its auto-spawned recovery `fix-c4143adc`,
both also died from the *same* "API Error: Connection closed mid-response"
message, within 6 messages of session start (see
`.mars/worktrees/mars-ed0e040e/.mars/coder-failures/fix-c4143adc#142fef16.log`) —
i.e. before either one did any diagnostic work at all. That is three
independent coder sessions (origin, its recovery, and this rescue task's first
attempt) all killed by the same transport error inside roughly a four-hour
window (02:38–06:17). This reads as a period of API instability on the
provider side, not anything specific to this task's prompt or worktree.

## 2. Salvage check — nothing to lose either way

Both `git -C .mars/worktrees/mars-8693f3a4 log --oneline main..HEAD` and
`git status --porcelain` come back empty: the branch tip equals `main` and the
tree is clean. Every attempt died before making a single commit or leaving
uncommitted work. There is no partial/broken state to repair and nothing a
`restart` would discard that a `continue` wouldn't equally preserve (nothing).
`continue` is still preferred per policy (default recovery verb; a
`transient network drop is the textbook case), and it is also what already
happened externally.

## 3. Resolution

While this task was mid-diagnosis, `mars-8693f3a4` was re-queued externally
(`task.queued` at 10:36:22) and is now `status=running` (confirmed live via
`psql`, `updated_at` advancing) — i.e. `mars continue mars-8693f3a4` (or
equivalent) was already run, most likely by the operator resolving the
`kind=failed` action-queue item directly. Re-issuing `continue` or `restart`
from this rescue task against an already-`running` task would either be
rejected (continue refuses non-`failed` tasks) or race the in-flight coder, so
no further command was executed here.

**Verdict: `continue`** — matches the action already taken; recorded for the
record, no duplicate action needed.

## 4. Recommendation

No code defect to fix. Worth noting for the runbook: a coder killed by a raw
provider connection drop (`API Error: Connection closed mid-response`, exit 1,
empty stderr) with a clean worktree is textbook `continue` — this doc exists
mainly to confirm that pattern held here across three stacked failures without
a real defect ever entering the picture.


## 5. Addendum — second rescue-operator dispatch (08-20 10:40)

This exact rescue task (`mars-ed0e040e`) was dispatched a second time with the
same brief, naming the same failed member `fix-3ae33675`. Re-checked live state
via `psql` and `mars task show mars-8693f3a4`:

```
08-20 10:36:22  task.queued   mars-8693f3a4   (as recorded above)
08-20 10:40:11  task.queued   mars-8693f3a4   (queued again)
08-20 10:40:19  status=running                confirmed via `mars task show`
```

`mars-8693f3a4` is `running` right now, actively executing the "Baseline
repair: deterministic manifest-version resolution" prompt — a live `continue`
in progress. `fix-3ae33675` itself remains terminally `failed` (it is a leaf
recovery task, non-recoverable by design; it does not re-run). Nothing here
changes the verdict: **`continue`**, already in effect, no command issued from
this task to avoid racing the in-flight coder.

**Loose end:** this is the second rescue-operator dispatch for an arc that
resolved itself before the first one finished landing. The rescue-operator
trigger appears to fire again once a fixed/re-queued arc produces new
downstream events (e.g. the re-queue itself), rather than checking first
whether the named failed task's origin has already moved past `failed`. Worth
a task: have the rescue dispatcher short-circuit to a no-op verdict when the
named origin task is no longer in `failed`/`blocked` status at dispatch time,
instead of re-running a full diagnosis.
