-- Migration 0008: active main-committer singleton constraint (ADR-0071)
--
-- Enforces "one active main-commiter recovery task per integration branch at a
-- time" at the database level via a partial unique index.  Before this migration
-- the invariant was declared by ADR-0071 but was only a comment, not an
-- invariant — a concurrent read-then-write race in spawnOrAttachMainCommitter
-- allowed two callers that both read `none` to each INSERT a new committer row.
--
-- The index key is
--   (recovery_payload::jsonb ->> 'recipe',
--    recovery_payload::jsonb ->> 'integrationBranch')
-- restricted to rows where
--   kind = 'fix'
--   AND status IN ('queued','running','verifying','merging','vega-reconciling','blocked')
--
-- This predicate is exactly ACTIVE_COMMITTER_STATUSES from main-dirty.ts.  Done
-- and failed committers fall outside the index so a fresh committer can be
-- spawned on the same branch after the previous one settles.
--
-- Pre-existing duplicates (if any) are reaped to 'failed' before the index is
-- created; the newest active committer per branch is kept.  The on-failure
-- handler and the failed-committer reconciler will raise the appropriate action
-- queue rows to surface the reaped duplicates to the operator.
--
-- After this migration, spawnMainCommitterRecovery catches a 23505 unique
-- violation, re-resolves the active committer, and attaches to it instead of
-- failing — so the invariant is both structurally enforced and handled
-- gracefully in the application layer.
--
-- This DDL is idempotent (IF NOT EXISTS); the pre-reap DO block is also safe to
-- re-run because it selects only the current set of active duplicates.

DO $$
DECLARE dup_id text;
BEGIN
  FOR dup_id IN
    SELECT t.id
      FROM tasks t
     WHERE t.kind = 'fix'
       AND t.status IN ('queued','running','verifying','merging','vega-reconciling','blocked')
       AND t.recovery_payload::jsonb ->> 'recipe' = 'main-commiter'
       AND t.id NOT IN (
         SELECT DISTINCT ON (recovery_payload::jsonb ->> 'integrationBranch') id
           FROM tasks
          WHERE kind = 'fix'
            AND status IN ('queued','running','verifying','merging','vega-reconciling','blocked')
            AND recovery_payload::jsonb ->> 'recipe' = 'main-commiter'
          ORDER BY recovery_payload::jsonb ->> 'integrationBranch', created_at DESC
       )
  LOOP
    UPDATE tasks
       SET status              = 'failed',
           failed_phase        = 'code',
           failure_reason      = 'main-commiter:duplicate-singleton',
           failure_reason_code = 'main-commiter:duplicate-singleton',
           failure_signature   = 'main-commiter:duplicate-singleton',
           error               = 'Duplicate active main-commiter reaped at schema migration 0008: ' ||
                                 'only one active committer per branch is permitted (ADR-0071 now ' ||
                                 'enforced by DB constraint uq_tasks_active_main_committer). ' ||
                                 'The newest active committer for this branch was kept; this one was retired.',
           updated_at          = NOW()
     WHERE id = dup_id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_active_main_committer
    ON tasks(
      (recovery_payload::jsonb ->> 'recipe'),
      (recovery_payload::jsonb ->> 'integrationBranch')
    )
    WHERE kind = 'fix'
      AND status IN ('queued','running','verifying','merging','vega-reconciling','blocked');
