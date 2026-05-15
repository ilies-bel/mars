# Migration: queue `kind` column — `'fix'` → `'chore'`

**Status:** scope note for PRD `89237117-allow-build-install-only-tasks-to-bypass`, slice 1 of 8.
**Audience:** the implementor agent for `mars-e844dba9` (Add kind column to
queue schema with migration). The previous implementor was aborted after 5
reads with no edit; this note collects the missing context so the next run
can act immediately.

## What is already on `main`

The `tasks.kind` column **already exists**. See
`orchestrator/src/mastra/queue.ts`:

- `export type TaskKind = 'task' | 'fix'` (line ~30)
- `deriveTaskKind(fixForTaskId)` returns `'task'` for null pointer,
  `'fix'` otherwise (line ~177)
- `assertTaskKindInvariant(kind, fixForTaskId)` ties the value to
  `fix_for_task_id`
- `initQueue()` (line ~297) adds the column if missing and backfills:
  ```sql
  UPDATE tasks SET kind = 'fix'  WHERE kind IS NULL AND fix_for_task_id IS NOT NULL
  UPDATE tasks SET kind = 'task' WHERE kind IS NULL AND fix_for_task_id IS NULL
  ```
- `idx_tasks_kind` index exists
- `rowToTask` coerces NULL/unknown `kind` via `deriveTaskKind`

The PRD has decided that the legacy `fix-task` discriminator (today
written as `kind='fix'`) **collapses into** the new Chore discriminator
(`kind='chore'`). See the PRD's "solution" paragraph and user story [7]
/ [8]. Quoting [8]:

> the migration to add the kind column with sensible defaults
> (kind='task' for everything except rows with fixForTaskId set, which
> become kind='chore') in a single transaction

## What slice 1 must actually change

This slice is a **value-domain rename** of an existing column, not a
fresh column add. Concretely, in `orchestrator/src/mastra/queue.ts`:

1. **Type.** Widen `TaskKind` to include `'chore'` and drop `'fix'`:
   ```ts
   export type TaskKind = 'task' | 'chore'
   ```
   `'fix'` must no longer appear as a writable value in TS — it only
   exists transiently on disk in legacy rows until the migration runs.

2. **`deriveTaskKind`.** Return `'chore'` (not `'fix'`) when
   `fixForTaskId !== null`. This becomes the read-time default for
   pre-migration rows.

3. **`assertTaskKindInvariant`.** Replace `'fix'` with `'chore'` in the
   two error branches. The semantic invariant is unchanged:
   `kind === 'chore' iff fixForTaskId !== null`.

4. **`rowToTask`.** Treat both `'task'` and `'chore'` as accepted raw
   values; everything else (including the legacy `'fix'` token) falls
   through to `deriveTaskKind(fixForTaskId)` — which now yields
   `'chore'` — so on-disk legacy rows still parse cleanly between
   migration runs.

5. **Migration.** Update the `initQueue` backfill so an existing
   `'fix'` row becomes `'chore'`, AND wrap the column add + both
   backfill `UPDATE`s in a single `c.transaction('write')` so no
   in-flight row is misclassified mid-upgrade. Today the three
   statements run un-transactionally — the slice's acceptance
   criterion "migration runs in a single transaction" requires
   wrapping them. Sketch:

   ```ts
   if (!names.has('kind')) {
     const tx = await c.transaction('write')
     try {
       await tx.execute(`ALTER TABLE tasks ADD COLUMN kind TEXT`)
       await tx.execute(
         `UPDATE tasks SET kind = 'chore'
           WHERE kind IS NULL AND fix_for_task_id IS NOT NULL`,
       )
       await tx.execute(
         `UPDATE tasks SET kind = 'task'
           WHERE kind IS NULL AND fix_for_task_id IS NULL`,
       )
       await tx.commit()
     } catch (error) {
       tx.close()
       throw error
     }
   }
   // Separate forward-fix pass: if the column already exists but still
   // holds the legacy 'fix' token (a repo that upgraded between the
   // task|fix and task|chore generations), rewrite it. Cheap and
   // idempotent — runs every boot, no-ops once converged.
   await c.execute(`UPDATE tasks SET kind = 'chore' WHERE kind = 'fix'`)
   ```

   The forward-fix `UPDATE` is what makes the migration honour the
   acceptance criterion "Rows that previously had the fix-task
   discriminator set are migrated to kind='chore'" for repos that
   already saw the `task|fix` generation. New repos go through the
   `if (!names.has('kind'))` branch and never see `'fix'` on disk.

6. **Tests.** Mirror the existing
   `orchestrator/src/mastra/__tests__/migration.test.ts` structure: set
   up a legacy queue.db with a `tasks` table that includes
   `kind = 'fix'` for a row with `fix_for_task_id` set, call
   `initQueue()`, assert the row is now `kind='chore'`. Add a second
   test: insert a new row without specifying `kind`, assert it reads
   back as `kind='task'` (the typed-field acceptance criterion).

## Out of scope for slice 1

- Do **not** rewrite `queue-fix-tasks.ts`. It still writes
  `fix_for_task_id`; readers will now see `kind='chore'` derived from
  that pointer, which is the intended foundation other slices build on.
- Do **not** add `mars chore add` CLI, `mars chore list`, the
  verify:has-diff bypass, or any user-visible behaviour. Slice 1 is
  schema-only — "No user-visible CLI changes yet" is in the brief.
- Do **not** touch `assertTaskKindInvariant`'s invariant beyond renaming
  `'fix'` to `'chore'`. The pointer-presence rule still holds for now.

## Read trail that previously stalled

The previous run read `migration.test.ts`, `queue-fix-tasks.test.ts`,
`queue-fix-tasks.ts`, `lib/origin-timeline.ts`, then grep'd
`orchestrator`. The file it needed and never opened is
`orchestrator/src/mastra/queue.ts` — that is where `kind` lives. Open
that file first.
