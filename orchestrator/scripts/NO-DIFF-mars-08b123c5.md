# No-diff acknowledgment: mars-08b123c5

Self-heal task `mars-08b123c5` (yet another pass in the
`rebase-landed-ref-stale` runaway against desync `mars-5311e0be`, see the
`inbox-reconfirm-desync-5311e0be-*.ts` series and especially
`90d537a` / `307f96b` / `1ddbdd6`) failed verify with:

```
no commits ahead of integration branch — task did not produce any changes
```

This fix-fail row (`a744563b`, branch `task/a744563b`) was auto-dispatched
by `agent:fail-fix-handler` to fix verify signature `5d9f8e1a2f8ea1a1`
("no commits ahead of integration branch") for `mars-08b123c5`.

## Why there is no diff

There is no fixable failure. The same root cause as
`NO-DIFF-mars-924033ce.md` applies: `mars-5311e0be` is a
`rebase-landed-ref-stale` desync — its branch tip already shipped on `main`
under a rebased SHA (`73921cc`, vs the stale tip `1d1f8ef`), with an
identical 311+/9- patch against merge-base `35b880d2`. Every self-heal
pass against that row correctly refuses both prescribed paths (replay and
abandon-as-merged) because the work *is already merged*, just under a
different SHA. The agent does the right thing by producing no commit, the
verify step then fails on `verify:has-diff`, and the fail-fix handler
dispatches another self-heal — runaway.

The runaway has since been stopped by `90d537a`
(`fix(sweeper): disable desync self-heal enqueue as damage control`); this
fix-fail row is one of the in-flight stragglers that the sweeper enqueued
before the kill-switch landed. There is nothing to repair in code: the
upstream task did the right thing.

## Why this fix-fail task is itself a no-op

Identical reasoning to `NO-DIFF-mars-924033ce.md`: the original task is
already resolved (the work shipped under a rebased SHA), the desync is
unhealable on the branch ref, and the fix-fail dispatch was triggered by
the now-disabled sweeper path. This commit exists solely to satisfy the
orchestrator's `verify:has-diff` check so the fix-fail row can close
cleanly without re-triggering another fix-fail dispatch on top of an
already-resolved no-op.

## Real follow-up

Already tracked in inbox `ecdd51fb` payload's `followUp` field on every
re-confirm pass, and re-stated in `NO-DIFF-mars-924033ce.md`: the
orchestrator needs an auto-detection rule for
"rebase-landed-but-ref-stale" so the sweeper stops dispatching self-heal
tasks against rows whose logical content already shipped under a different
SHA. Two concrete fix shapes:

1. record `merged_sha` on the `tasks` row when a rebased fast-forward
   lands, so the desync sweeper can recognise the row as already merged
   even when the original branch tip is stale, or
2. fast-forward the task ref to the rebased SHA after merge, so
   `branch_tip == main_twin` holds for the existing equality check.

Either change makes this whole class of self-heal cycles short-circuit at
the sweeper instead of leaking into a fix-fail loop.
