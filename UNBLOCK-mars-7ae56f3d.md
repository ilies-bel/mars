# Unblock note for mars-7ae56f3d

- **This task:** `mars-7ae56f3d`, re-implementation on current `main`
  of "purge stale features/ dir + legacy features-table migration"
  (originally task `mars-624f0740`, parent idea
  `50963583-db-migration-and-features-deletion-prereq`, slice 1).
- **Why it stalled:** the implementor read 5 files without acting and
  was aborted with `too_hard:no-action-after-reads`. Its read trail
  (`orchestrator/src/mastra/__tests__/migration.test.ts`, `ideas.ts`,
  `queue.ts`, plus two grep passes against `orchestrator/src`) never
  touched the files that hold the work because the brief misdescribes
  where they live.

## Missing context the implementor needed

The brief says **"orchestrator features/ directory"** and **"legacy
features-table migration file"**. Both are misleading:

1. **The `features/` directory is at the REPO ROOT, not under
   `orchestrator/`.** There is no `orchestrator/features/`. The dir
   that needs purging is:
   - `/Users/ib472e5l/project/perso/mars-framework/.mars/worktrees/<wt>/features/`
   - Contents on current main:
     - `features/aa5a4119-per-repo-verify-config.md`
     - `features/eb6f8cc6-document-question-answer-lifecycle.md`

2. **The "legacy features-table migration" is not a standalone file —
   it is a helper function inside `orchestrator/src/mastra/proposals.ts`.**
   There is no `orchestrator/src/mastra/migrations/` directory. The
   relevant call sites are:
   - `proposals.ts:228` — single call site:
     `await migrateLegacyFeatures(c)` inside `initProposals()`.
   - `proposals.ts:238-287` — the `migrateLegacyFeatures` helper itself.
     It reads `SELECT * FROM features`, copies rows into `proposals`,
     drops the legacy indexes (`idx_features_status`,
     `idx_features_parent`), drops `feature_deps`, and finally drops
     `features`.

   That helper is the entire surface to remove. It is **not** exported
   (`const migrateLegacyFeatures = async (c: Client) => {…}`), so no
   external caller will dangle.

## The complete change set

Verified by exhaustive grep on this worktree's `orchestrator/src`
(`rg -n "migrateLegacyFeatures|legacy.+features|features.+table"` and
`rg -n "FROM features|INTO features|TABLE features"`):

| # | Change | Path |
|---|--------|------|
| 1 | Delete file | `features/aa5a4119-per-repo-verify-config.md` |
| 2 | Delete file | `features/eb6f8cc6-document-question-answer-lifecycle.md` |
| 3 | Remove call site (1 line) | `orchestrator/src/mastra/proposals.ts:228` |
| 4 | Remove helper (lines 238–287) | `orchestrator/src/mastra/proposals.ts` |

That is the full scope. After step 3+4, the only references to the
legacy `features` table in the orchestrator source tree are gone — no
imports, no tests, no schemas point at it. `__tests__/migration.test.ts`
contains zero hits for `features`, so removing the helper does not
break any existing test.

## What to NOT touch

The original brief was explicit: leave `docs/adr/**` and `CONTEXT.md`
alone — those evolved on `main` after the abandoned branch was cut,
which is precisely why the hand-rebase was abandoned. Confirmed: the
only ADR/CONTEXT churn on main is unrelated to the `features` purge.

## Verify

From this worktree:

```
cd orchestrator && npm run typecheck && npm test
```

Both should stay green. The deletions are inert at the type level
(no exports, no consumers) and the runtime helper only fired against
sqlite databases that still had a `features` table — which prod
databases no longer have post-migration. The function's idempotent
guard (`if (tableCheck.rows.length === 0) return`) means current
prod runs were already a no-op, so deletion is a pure cleanup.

## Recommendation

`mars-7ae56f3d` is **not** a no-op (unlike many recent UNBLOCK notes).
It is a small, surgical change — four file touches total — that the
next implementor dispatch should complete in one pass armed with the
above. The original implementor failed only because the brief's
"orchestrator features/" and "migration file" framing sent it
hunting in the wrong directories.
