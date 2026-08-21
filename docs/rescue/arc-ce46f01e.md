# Rescue Assessment — Arc ce46f01e-concurrent-writing-on-main-rebase-verify

**Date:** 2026-08-21
**Rescue task:** mars-7991a762
**Failed task:** fix-a97e8e28 (recovery for origin mars-66198aac)
**Failure signature:** code:context-exhausted/unclassified

## What failed

`mars-66198aac` was slice 10/14 of PRD `ce46f01e-concurrent-writing-on-main-rebase-verify`
("Auto-commit genuine operator dirt as a `wip(operator)` commit with a Notice"). Its
first coder run exhausted context mid-implementation; the orchestrator spawned the
standard one-shot recovery task `fix-a97e8e28` on the same worktree/branch
(`task/mars-66198aac`). That recovery run *also* exhausted context
(`code:context-exhausted/unclassified`) and, per its own failure message,
"worktree was clean at exit (no uncommitted work found)" — read at face value this
looked like the recovery made no progress before dying.

## Root cause of the false alarm

`git log --oneline -- orchestrator/src/core/lib/git/operator-auto-commit.ts` on
`main` tells a different story:

```
af2fdf34 fix(merge): parse auto-commit path lists with -z
61b662d5 feat(merge): auto-commit operator dirt with a Notice
55388de2 wip(checkpoint): coder ran out of context (exit 138) with 3 uncommitted path(s)
47bc3234 mars: periodic code-phase checkpoint (task fix-a97e8e28) #3
1c2f1d50 wip(checkpoint): coder ran out of context (exit 138) with 3 uncommitted path(s)
f4adc202 mars: periodic code-phase checkpoint (task mars-66198aac) #3
```

`fix-a97e8e28` did land real work — `61b662d5` (feat) at 18:40 local and `af2fdf34`
(fix) at 18:51 local, both authored before its own failure was recorded at 16:55 UTC.
"Worktree was clean at exit" simply meant every change was already committed
(periodic checkpointing + the coder's own commits), not that no progress happened —
the failure message describes the *working tree*, not the *branch*.

## Arc state at rescue arrival vs. now

| task | status in brief (stale snapshot) | status now | notes |
|------|-----------------------------------|------------|-------|
| fix-a97e8e28 | failed | failed (terminal, recovery slot spent) | left as-is; recovery tasks are non-recoverable leaves (ADR-0040) |
| mars-66198aac | queued | **done** (workflow: `remerge`) | already merged to `main` before this rescue task could act |
| mars-c8f32367 | blocked | queued | unblocked by mars-66198aac settling |
| mars-baa30840 | blocked | queued | unblocked by mars-66198aac settling |
| mars-cc8086b1 | blocked | blocked | still waiting on a different, unrelated blocker |
| mars-3f11cacc | running | running | unrelated in-flight sibling |
| fix-aefa92ed, fix-05acf448, mars-fa3683a3, mars-7445e85d | done | done | unchanged |

By the time this rescue task inspected the arc, `mars-66198aac` had already been
carried forward through `mars remerge` (its `recoverySlot: spent (fix: fix-a97e8e28)`
plus `workflow: remerge` and terminal `done` status confirm the escape-verb path
described in CLAUDE.md's "recovery-exhausted arc with commits ahead" note was already
taken — the branch held real, coder-authored commits, so `remerge` was the correct
call and it landed cleanly). Both commits are present on `main`'s history and the
downstream blocked siblings have already settled as a result.

## Actions taken

None of the three permitted verbs (`restart`, `continue`, `supersede`) were executed.
All three would be wrong here:

- **restart** — would discard already-merged, real work for no reason.
- **continue** — nothing to continue; the origin task is `done` and its worktree/branch
  no longer exist.
- **supersede** — would create a duplicate task carrying forward a branch whose
  contents are already fully merged into `main`.

Verified `main` is not left in a broken state: `cd orchestrator && npm run knip`
exits 0 in this worktree (pre-existing unused-export findings only, unrelated to this
arc).

**Verdict: no-op — arc self-resolved via `mars remerge mars-66198aac` before this
rescue task could act.**

## Prevention

No new prevention work identified. This is the same class of race documented in
`docs/rescue/arc-mars-ad2d139b.md` and friends (rescue dispatched for a condition
that resolves itself, by another path, before or during the rescue task's own
execution window) — here the resolution was a legitimate operator/automation-driven
`remerge`, not a stale-daemon-code race, so no code change is warranted.
