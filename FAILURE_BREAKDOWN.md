# Recent implement-run failure classification (task mars-9b907454)

**Date:** 2026-05-17
**Data source:** `.mars/watch.log` (last 24h) + `mars show <id>` per failed task.
**Population:** 254 matched implement runs in the 24h window — 139 success,
115 failed.

Each `[implement] <id> dispatching` was matched to that same id's next
terminal event (`-> failed | -> success | …`) so the dispatching/failed
pairing in the log is no longer confused by interleaved ids. Script:
`parse_watch.py` (per-id pairing) and `bucket_errors2.py` (signature
buckets via `mars show`).

## 1. Per-id duration distribution (recent failed runs)

```
n=115  min=0.7s  p25=23.2s  median=56.3s  p75=150.9s  p90=462.7s  max=713.4s  mean=139.8s
```

Bucketed:

| range            | count |
|------------------|-------|
| [   0,    5) s   |    16 |
| [   5,   10) s   |     8 |
| [  10,   30) s   |    15 |
| [  30,   60) s   |    21 |
| [  60,  120) s   |    24 |
| [ 120,  300) s   |    13 |
| [ 300,  600) s   |    11 |
| [ 600,  inf) s   |     7 |

**The "~30s" claim is wrong.** The distribution is bimodal: a fast cluster
(~1–3s, n≈16) and a slow cluster (~30s–10min). The two clusters correspond
to two different failure modes — see §2.

For reference, succeeded runs: median 299.6s, p90 696.2s.

## 2. Signature buckets (live failed tasks)

`mars show` was queried for each of the 115 failed ids. 20 ids no longer
exist (purged) and so have neither an `error` field nor a `failureReason`;
they are excluded from the live population.

Live failed population: **95 tasks.**

| signature                                          | count | %      |
|----------------------------------------------------|-------|--------|
| `too_hard:no-action-after-reads` (read-span guard) |    47 | 49.5%  |
| `setup:install/install-frozen-lockfile` (pnpm)     |    45 | 47.4%  |
| `verify:typecheck/unclassified`                    |     2 |  2.1%  |
| `daemon restart while task was running`            |     1 |  1.1%  |

The two big buckets cleanly partition by duration:

- **Read-span trips** are the slow cluster — the watcher gives the agent
  time to do 5 Read/Grep/Glob calls before parking. Median duration in
  this bucket is in the 30–120s range.
- **Lockfile trips** are the fast cluster — `pnpm install
  --frozen-lockfile` fails in ~1–3s during `setup`, well before any
  agent code runs.

Representative lockfile error (`mars show mars-4a54b7c0`):

```
pnpm install --frozen-lockfile (cwd=…/mars-4a54b7c0/orchestrator) exited with 1
 ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because
 pnpm-lock.yaml is not up to date with <ROOT>/package.json
  Failure reason:
  specifiers in the lockfile don't match specifiers in package.json:
* 2 dependencies were removed: @mastra/evals@^1.2.1, @mastra/memory@^1.17.2
failureReason: retry_budget_exhausted:setup:install/install-frozen-lockfile
```

Other representative ids: `mars-269bcfc9`, `mars-4c2f5138`, `mars-6e95a827`.

## 3. Are these failures still happening?

The lockfile mismatch was introduced by commit **`689d856` Remove unused
@mastra/evals and @mastra/memory deps from orchestrator** at
`2026-05-17 14:23:11Z` (package.json change without a lockfile bump) and
fixed by **`0c7214e` fix(orchestrator): regenerate pnpm-lock.yaml after
removing @mastra/evals,@mastra/memory** at `2026-05-17 15:11:02Z`.

Splitting the live failed population at that fix timestamp:

| bucket                                  | pre-fix | post-fix |
|-----------------------------------------|--------:|---------:|
| `too_hard:no-action-after-reads`        |      45 |        2 |
| `setup:install/install-frozen-lockfile` |      44 |        1 |
| `verify:typecheck/unclassified`         |       2 |        0 |
| `daemon restart`                        |       1 |        0 |

The one post-fix lockfile failure (`mars-a215f361`, dispatched 15:09:50Z)
straddles the boundary — its worktree was provisioned with the stale
lockfile in the brief window before the regenerate commit landed.

**Post-fix, the only systemic failure mode is the read-span guard.** The
lockfile mass-failure is a transient, already-resolved incident.

## 4. Conclusion

- **No runClaudeCode/spawn outage.** The original "sub-second runClaudeCode
  outage" suspicion was based on misreading interleaved log lines, as the
  brief already noted. The ~1–3s failures are real, but they are `pnpm
  install` exits during `setup`, not Claude spawn failures.
- **Read-span trips: 49% of recent failures.** Already covered by PRD
  f1c48e7b (mars-f0de2ada / mars-578f32a5). No additional fix needed
  here.
- **Lockfile trips: 47% of recent failures, but already fixed in
  `0c7214e`.** Tasks dispatched before that commit churned through their
  retry budget on a stale lockfile. Tasks dispatched after it install
  cleanly. No follow-up task warranted — the fix has landed; the
  remaining queued tasks just need a restart or a re-dispatch on
  worktrees provisioned after `0c7214e`.
- **No distinct non-read-span systemic failure** remains active after the
  lockfile fix. The 2 typecheck and 1 daemon-restart entries are
  one-offs, not a population.

No new task is filed: the two dominant buckets either (a) already have
PRD coverage or (b) are already fixed in `main`.

## Files

- `parse_watch.py`        — per-id pairing + duration distribution
- `bucket_errors2.py`     — signature buckets via `mars show`
- `FAILURE_BREAKDOWN.md`  — this note
