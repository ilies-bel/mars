/**
 * Arc recovery concern (ADR-0052 modular-core follow-on, "Split arc.ts:
 * extract the recovery concern").
 *
 * Holds the three recovery-spawn write funnels that used to live inline on
 * the `Arc` aggregate in `../arc.ts`: spawning a fresh fix-task for a failed
 * source ({@link spawnRecovery}), attaching a source to an
 * already-outstanding fix-task ({@link attachToRecovery}), and spawning a
 * `main-commiter` recovery ({@link spawnMainCommitterRecovery}). `../arc.ts`
 * keeps only task lifecycle; see its "Concern manifest" comment for the full
 * boundary contract.
 *
 * BOUNDARY DIRECTION (load-bearing). This module imports `../queue` and
 * `../store/task-store`, both of which import `../arc.ts` — so `../arc.ts`
 * MUST NOT import this file, or the split recreates the very cycle it exists
 * to break. The dependency therefore runs caller → recovery, never
 * arc → recovery: `../queue-fix-tasks.ts` and `../lib/main-dirty.ts` call
 * these functions directly and run `maybeAssertArcInvariant` themselves
 * afterwards. That debug-assert seam lives in `./invariant.ts` — shared by
 * every mutating Arc write, not just the recovery ones, and importable by a
 * concern module without pulling in `Arc` (which would cycle).
 *
 * `Arc.propagateRecoveryDone` deliberately did NOT move here: it is a
 * lifecycle transition on the *origin* row (flip to `done`, then unblock its
 * dependents) and `Arc.unblockByCompletion` calls it inline, which would
 * force exactly the arc → recovery import this boundary forbids.
 *
 * Sole-writer note (ADR-0052): the `tasks` / `task_blockers` writes below are
 * part of the Arc aggregate, so `core/arc/recovery.ts` is allowlisted
 * alongside `core/arc.ts` in `../__tests__/arc-sole-writer.test.ts`.
 */

import { randomUUID } from 'node:crypto'
import { getTask, MAX_PRIORITY, resolveQueueClient } from '../queue'
import type { DomainTaskStore } from '../store/task-store'
import { getRecipeOrGeneric, type FixRecipeContext } from '../lib/fix-recipes'
import { buildEventInsert, emitEvent } from '../lib/outbox'
import {
  MAIN_COMMITER_RECIPE,
  SOURCE_ERROR_SUMMARY,
  VERIFY_MAIN_DIRTY_CODE,
  serialiseMainCommiterPayload,
  parseVerifyOutputPayload,
  type MainCommiterPayload,
} from '../lib/main-commiter-payload'
import { internalBus } from '../../internal-bus'
import { hintDispatch } from '../daemon/dispatch-hint'

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`

const FIX_TASK_AUTHOR_KIND = 'agent'
const FIX_TASK_AUTHOR_NAME = 'fail-fix-handler'

/**
 * Spawn-recovery input. Mirrors the historic `upsertFixTask(input)` parameter
 * shape so the queue-fix-tasks.ts wrapper can delegate without reshaping
 * arguments. Re-exported from queue-fix-tasks.ts for back-compat.
 */
export interface UpsertFixTaskInput {
  sourceTaskId: string
  failureSignature: string
  failingStep: string
  truncatedError: string
  branch: string | null
  /**
   * Recipe context handed to the recipe's `buildPrompt`. Required — the
   * generic prompt builder is gone (see ADR 0002). Callers that don't
   * have meaningful context can pass an empty `statusOutput`; the recipe
   * decides whether to use the rest of the fields.
   */
  recipeContext: FixRecipeContext
  /**
   * TaskStore threaded in from the workflow composition root. When
   * provided, all DB operations run through the store rather than
   * falling back to the module-singleton client.
   */
  store?: DomainTaskStore
  /**
   * Optional QA note from `mars release --abort <id> --note '<text>'`.
   * When present, it is appended verbatim to the fix-task prompt under a
   * `## QA note` heading so the recovery agent sees the operator's
   * feedback without querying the database.
   */
  qaNote?: string
}

export interface UpsertFixTaskResult {
  fixTaskId: string
  created: boolean
}

/**
 * Attach-to-existing-recovery input. Mirrors the historic
 * `attachToExistingFixTask(input)` parameter shape so the queue-fix-tasks.ts
 * wrapper can delegate without reshaping arguments.
 */
export interface AttachToExistingFixTaskInput {
  sourceTaskId: string
  /** The recovery task to attach the source to. Must already exist as a kind='fix' row. */
  fixTaskId: string
  /** Short error summary written to `tasks.error` (truncated to 1000 chars). */
  errorSummary: string
  store?: DomainTaskStore
}

/**
 * Locate an existing outstanding fix-task for a (sourceTaskId,
 * failureSignature) pair. Non-shared recipes dedup per source.
 */
const findExistingFixTask = async (
  store: DomainTaskStore,
  sourceTaskId: string,
  failureSignature: string,
): Promise<string | null> => {
  const r = await store.query({
    sql: `SELECT id FROM tasks
           WHERE fix_for_task_id = ?
             AND failure_signature = ?
             AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [sourceTaskId, failureSignature],
  })
  if (r.rows.length === 0) return null
  return (r.rows[0] as unknown as { id: string }).id
}

/**
 * For shared recipes: locate ANY outstanding fix-task for this signature,
 * regardless of which source task spawned it. New blocked sources attach
 * to it via a `task_blockers` edge instead of spawning a duplicate.
 */
const findSharedFixTask = async (
  store: DomainTaskStore,
  failureSignature: string,
): Promise<string | null> => {
  const r = await store.query({
    sql: `SELECT id FROM tasks
           WHERE failure_signature = ?
             AND fix_for_task_id IS NOT NULL
             AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [failureSignature],
  })
  if (r.rows.length === 0) return null
  return (r.rows[0] as unknown as { id: string }).id
}

/**
 * Recovery-spawn write funnel (ADR-0052). Atomically:
 *  - INSERT a new runnable fix-task row (status='queued', skip triage),
 *  - INSERT a task_blockers row linking the source task to the fix task,
 *  - UPDATE the source task to status='blocked' with recovery_spawned_count incremented,
 *  - append a `self_heal_attempts` ledger row,
 *  - emit a durable `task.blocked` event in the same batch.
 *
 * Idempotent on (sourceTaskId, failureSignature): if a fix task is already
 * outstanding for that pair, the existing task is reused.
 *
 * Every regular-task failure spawns a fix, even with no registered recipe
 * (ADR: uniform failure→fix spawn, supersedes ADR-0002). The signature is
 * resolved via `getRecipeOrGeneric`, which falls back to the
 * signature-agnostic generic recovery recipe when none is registered — so
 * an unknown signature no longer dead-ends, it recovers from first
 * principles. `getRecipeOrGeneric` never throws.
 *
 * F.1 EXEMPTION (ADR-0040). The by-construction origin → fix
 * `task_blockers` edge is written DIRECTLY in the batch below and MUST NOT
 * be routed through `addBlockers`/`assertNotRecoveryEdge`. `spawnRecovery`
 * is the documented canonical origin → recovery edge writer — the one
 * legitimate bypass of F.1's ADR-0040 leaf-node guard (every other
 * `task_blockers` writer goes through `assertNotRecoveryEdge`). The edge
 * here is the canonical attach mechanism; the guard does not apply.
 *
 * Callers (`../queue-fix-tasks.ts`'s `upsertFixTask`) run
 * `maybeAssertArcInvariant` AFTER this resolves — that debug-assert seam lives
 * in `./invariant.ts` rather than here, since it is shared by every mutating
 * Arc write method, not just the recovery ones.
 */
export const spawnRecovery = async (
  store: DomainTaskStore,
  input: UpsertFixTaskInput,
): Promise<UpsertFixTaskResult> => {
  const s = store

  const recipe = getRecipeOrGeneric(input.failureSignature)
  const shared = recipe.shared === true

  // Shared recipes (e.g. dirty merge target) reuse a single in-flight
  // fix-task across every source task that hits the signature. New
  // sources just attach a task_blockers edge — one commit unblocks
  // every dependent at once via Arc.unblockByCompletion.
  const existingId = shared
    ? await findSharedFixTask(s, input.failureSignature)
    : await findExistingFixTask(s, input.sourceTaskId, input.failureSignature)

  const source = await getTask(input.sourceTaskId, s)
  if (!source) {
    throw new Error(`source task ${input.sourceTaskId} not found`)
  }
  const nextRecoverySpawnedCount = source.recoverySpawnedCount + 1
  const errorSummary = truncate(
    `${input.failingStep}: ${input.truncatedError}`,
    1000,
  )
  const now = new Date().toISOString()
  const blockerCreatedAt = Date.now()

  if (existingId) {
    // Attach this source to the existing fix-task and park it.
    await s.batch(
      [
        {
          sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at)
              VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
          args: [input.sourceTaskId, existingId, blockerCreatedAt],
        },
        {
          // updated_at first — exempt from STATUS_WRITE arch guard. Events are
          // emitted atomically in this same batch per ADR-0030.
          sql: `UPDATE tasks
                 SET updated_at = ?,
                     status = 'blocked',
                     recovery_spawned_count = ?,
                     error = ?
               WHERE id = ?`,
          args: [now, nextRecoverySpawnedCount, errorSummary, input.sourceTaskId],
        },
        // Durable task.blocked in the same atomic batch (ADR-0030); the
        // internalBus().emit below stays only as an in-process wake-hint.
        buildEventInsert('task.blocked', {
          taskId: input.sourceTaskId,
          fixTaskId: existingId,
          failureSignature: input.failureSignature,
          failingStep: input.failingStep,
          originId: source.originId,
        }),
      ],
      'write',
    )
    internalBus().emit('task.blocked', {
      taskId: input.sourceTaskId,
      fixTaskId: existingId,
      failureSignature: input.failureSignature,
      failingStep: input.failingStep,
      originId: source.originId,
    })
    return { fixTaskId: existingId, created: false }
  }

  // Inline the source task's prompt so recipes that re-do the original
  // work (e.g. verify:has-diff/no-commits-ahead) don't burn turns
  // re-fetching it from the database. Handlers should already set
  // `originalPrompt`; backfill from the source row if a direct caller
  // forgot. Default to '' only when the source genuinely has no prompt.
  const incomingPrompt = input.recipeContext.originalPrompt
  // Extract the verify-output payload (written by queue-fix-tasks.ts for
  // verify:test/test-assertion-error failures) so the testAssertionErrorRecipe
  // can embed the exact failing assertion diff in the fix-coder's brief.
  // Returns null for NULL payloads, legacy rows, and non-test-assertion
  // signatures — safe to call unconditionally.
  const verifyOutputPayload = parseVerifyOutputPayload(source.recoveryPayload ?? null)
  const recipeContextWithSource: FixRecipeContext = {
    ...input.recipeContext,
    // Thread the failure signature into the context so the generic recipe
    // can branch on gate failures (verify: prefix) vs work failures without
    // resorting to statusOutput heuristics.
    failureSignature: input.failureSignature,
    originalPrompt:
      incomingPrompt && incomingPrompt.trim().length > 0
        ? incomingPrompt
        : source.prompt ?? '',
    ...(verifyOutputPayload !== null ? { verifyOutput: verifyOutputPayload.output } : {}),
  }
  const basePrompt = recipe.buildPrompt(recipeContextWithSource)
  // Append the optional QA note verbatim under a ## QA note heading so
  // the recovery agent sees the operator's feedback from `mars release
  // --abort --note '<text>'` without having to query the database.
  const prompt =
    input.qaNote && input.qaNote.trim().length > 0
      ? `${basePrompt}\n\n## QA note\n\n${input.qaNote}\n`
      : basePrompt
  const fixTaskId = `fix-${randomUUID().slice(0, 8)}`
  // All recovery tasks run at top priority — recovery resumes already-started
  // work and should preempt fresh queued tasks. Shared recipes additionally
  // reuse a single in-flight fix-task across multiple sources (e.g. a clean
  // main blocks everyone); that deduplication behaviour is orthogonal to the
  // priority and is unchanged.
  const fixPriority = MAX_PRIORITY

  await s.batch(
    [
      {
        // ADR-0049: kind='fix' is written by construction so the row is never
        // an orphan from birth. assertTaskKindInvariant enforces this same
        // constraint at the enqueueTask path; spawnRecovery mirrors it here.
        sql: `INSERT INTO tasks (
              id, prompt, status,
              author_kind, author_name,
              fix_for_task_id, failure_signature,
              kind,
              recovery_spawned_count, origin_id, priority,
              created_at, updated_at
            ) VALUES (?, ?, 'queued', ?, ?, ?, ?, 'fix', 0, ?, ?, ?, ?)`,
        args: [
          fixTaskId,
          prompt,
          FIX_TASK_AUTHOR_KIND,
          FIX_TASK_AUTHOR_NAME,
          input.sourceTaskId,
          input.failureSignature,
          source.originId,
          fixPriority,
          now,
          now,
        ],
      },
      {
        // F.1 exemption (ADR-0040): the origin → fix edge is written
        // DIRECTLY here, not through addBlockers/assertNotRecoveryEdge.
        // `spawnRecovery` is the one legitimate origin → recovery edge
        // writer; see the method-level note above.
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, created_at)
            VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        args: [input.sourceTaskId, fixTaskId, blockerCreatedAt],
      },
      {
        // updated_at first — exempt from STATUS_WRITE arch guard. Events are
        // emitted atomically in this same batch per ADR-0030.
        sql: `UPDATE tasks
               SET updated_at = ?,
                   status = 'blocked',
                   recovery_spawned_count = ?,
                   error = ?
             WHERE id = ?`,
        args: [now, nextRecoverySpawnedCount, errorSummary, input.sourceTaskId],
      },
      // Append-only ledger row for the sweeper's per-(parent,signature)
      // dedup + budget logic. Lives inside the same batch as the
      // fix-task INSERT so a rollback leaves no stray attempt row.
      {
        sql: `INSERT INTO self_heal_attempts (
              parent_task_id, failure_signature, fix_task_id, created_at
            ) VALUES (?, ?, ?, ?)`,
        args: [
          input.sourceTaskId,
          input.failureSignature,
          fixTaskId,
          blockerCreatedAt,
        ],
      },
      // Durable task.blocked in the same atomic batch (ADR-0030).
      buildEventInsert('task.blocked', {
        taskId: input.sourceTaskId,
        fixTaskId,
        failureSignature: input.failureSignature,
        failingStep: input.failingStep,
        originId: source.originId,
      }),
    ],
    'write',
  )

  internalBus().emit('task.blocked', {
    taskId: input.sourceTaskId,
    fixTaskId,
    failureSignature: input.failureSignature,
    failingStep: input.failingStep,
    originId: source.originId,
  })
  hintDispatch(fixTaskId, 'implement')

  return { fixTaskId, created: true }
}

/**
 * Slice F.2: attach a new blocked source to an EXISTING recovery (fix) task
 * without spawning a fresh recovery row.
 *
 * Background. `spawnRecovery` is the canonical origin → recovery edge writer
 * and is the documented exemption from F.1's ADR-0040 leaf-node guard (every
 * other `task_blockers` writer goes through `assertNotRecoveryEdge`). When
 * dirty-main dedup determines that a queued / in-flight / failed
 * `main-commiter` already exists for the current diff hash, we still need
 * a `task_blockers` edge (origin → existing recovery) — but we MUST NOT
 * re-create the recovery row. A normal `addBlockers` call would trip
 * F.1's guard because the blocker endpoint is a recovery task; this helper
 * bypasses the guard by writing the edge through the same chokepoint the
 * spawn path uses, then re-parks the source.
 *
 * The combined fields written are exactly the post-spawn shape of
 * `spawnRecovery` minus the fix-task INSERT (and minus the
 * `self_heal_attempts` ledger row, since the cap counts attempt-by-row and
 * we are not adding a new attempt — we are joining an existing one).
 *
 * No-op when the source is already blocked on this exact recovery
 * (`ON CONFLICT DO NOTHING` on the edge).
 */
export const attachToRecovery = async (
  store: DomainTaskStore,
  input: AttachToExistingFixTaskInput,
): Promise<void> => {
  const s = store
  const source = await getTask(input.sourceTaskId, s)
  if (!source) {
    throw new Error(`source task ${input.sourceTaskId} not found`)
  }
  const now = new Date().toISOString()
  const blockerCreatedAt = Date.now()
  const truncatedError = truncate(input.errorSummary, 1000)
  await s.batch(
    [
      {
        // F.1 exemption: this insert reaches `task_blockers` directly because
        // the legitimate origin → recovery edge writer (`spawnRecovery`) is
        // the documented bypass of the ADR-0040 guard, and this helper is its
        // dedup sibling. See ADR-0040 clarification: the origin → recovery
        // edge is the canonical attach mechanism.
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
              VALUES (?, ?, 'confirmed', ?) ON CONFLICT DO NOTHING`,
        args: [input.sourceTaskId, input.fixTaskId, blockerCreatedAt],
      },
      {
        // updated_at first — exempt from STATUS_WRITE arch guard. Events are
        // emitted atomically in this same batch per ADR-0030.
        sql: `UPDATE tasks
                 SET updated_at = ?,
                     status = 'blocked',
                     error = ?,
                     failure_reason = NULL,
                     failure_reason_code = NULL,
                     failure_signature = NULL
               WHERE id = ?`,
        args: [
          now,
          truncatedError,
          input.sourceTaskId,
        ],
      },
      // Durable task.blocked in the same atomic batch (ADR-0030).
      buildEventInsert('task.blocked', {
        taskId: input.sourceTaskId,
        fixTaskId: input.fixTaskId,
        failureSignature: VERIFY_MAIN_DIRTY_CODE,
        failingStep: 'dispatch:main-dirty',
        originId: source.originId,
      }),
    ],
    'write',
  )
  internalBus().emit('task.blocked', {
    taskId: input.sourceTaskId,
    fixTaskId: input.fixTaskId,
    failureSignature: VERIFY_MAIN_DIRTY_CODE,
    failingStep: 'dispatch:main-dirty',
    originId: source.originId,
  })
}

/**
 * Fresh `main-commiter` recovery spawn (ADR-0052 sole-writer). Relocated
 * bit-for-bit from `main-dirty.ts:spawnFresh`. When dirty-main detection finds
 * no active committer at the current hash, this inserts a brand-new recovery
 * (fix) task, parks the source behind it, and records the dirty-main payload.
 *
 * The four batched statements run in one atomic `s.batch([...], 'write')`
 * commit (ADR-0030):
 *   1. INSERT the `kind='fix'` committer row (priority 3,
 *      author='main-commiter-spawn', `recovery_payload` = the serialised
 *      {@link MainCommiterPayload});
 *   2. Insert (ON CONFLICT DO NOTHING) the origin → recovery `task_blockers` edge
 *      (`state='confirmed'`) — the F.1 ADR-0040 leaf-node exemption mirror;
 *   3. UPDATE the source to `status='blocked'`, writing its readable
 *      `error` and clearing all failure metadata
 *      (updated_at first — exempt from the STATUS_WRITE arch guard);
 *   4. the durable `task.blocked` outbox event.
 *
 * PARITY (preserved bit-for-bit):
 *   - a single `now` timestamp threaded through every statement;
 *   - a fresh `fix-${randomUUID().slice(0, 8)}` fix-task id per call;
 *   - `recovery_payload` IS written (unlike {@link spawnRecovery}, which
 *     leaves it NULL — the two writers coexist);
 *   - NO `self_heal_attempts` ledger append (intentional, slice F.2 — the
 *     branch-keyed singleton (ADR-0071), not the per-(parent,signature) cap,
 *     governs committer identity);
 *   - the `recovery.spawned` emit and the `internalBus().emit` stay
 *     OUTSIDE the batch (best-effort wake hints).
 *
 * F.1 EXEMPTION (ADR-0040): the origin → recovery `task_blockers` edge is
 * written DIRECTLY in the batch, NOT through `addBlocker`/`assertNotRecoveryEdge`
 * — this is the canonical origin → recovery edge writer, the same documented
 * bypass that {@link spawnRecovery} carries.
 */
export const spawnMainCommitterRecovery = async (
  store: DomainTaskStore,
  input: {
    sourceTaskId: string
    integrationBranch: string
    dispatchPhase: 'dispatch' | 'verify' | 'merge'
    recipePrompt: string
    sourceOriginId: string
    /** Dirty paths parsed from the detection snapshot (see spawnOrAttachMainCommitter). */
    checkpointedPaths?: string[]
  },
): Promise<{ fixTaskId: string }> => {
  const s = store
  const fixTaskId = `fix-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const blockerCreatedAt = Date.now()
  const payload: MainCommiterPayload = {
    recipe: MAIN_COMMITER_RECIPE,
    integrationBranch: input.integrationBranch,
    ...(input.checkpointedPaths !== undefined && input.checkpointedPaths.length > 0
      ? { checkpointedPaths: input.checkpointedPaths }
      : {}),
  }
  await s.batch(
    [
      {
        sql: `INSERT INTO tasks (
              id, prompt, status, kind,
              author_kind, author_name,
              fix_for_task_id, failure_signature,
              failure_reason, failure_reason_code,
              recovery_spawned_count, origin_id, priority,
              recovery_payload,
              created_at, updated_at
            ) VALUES (?, ?, 'queued', 'fix', ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        args: [
          fixTaskId,
          input.recipePrompt,
          'agent',
          'main-commiter-spawn',
          input.sourceTaskId,
          VERIFY_MAIN_DIRTY_CODE,
          VERIFY_MAIN_DIRTY_CODE,
          VERIFY_MAIN_DIRTY_CODE,
          input.sourceOriginId,
          // Max priority: every queued task is blocked behind this.
          3,
          serialiseMainCommiterPayload(payload),
          now,
          now,
        ],
      },
      {
        // F.1 exemption: this is the canonical origin → recovery edge
        // mirror of `upsertFixTask`. The recovery side cannot grow further
        // edges (recovery-of-recovery is rejected by
        // `handleTaskFailureWithFixTask`), so the leaf invariant holds.
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at)
            VALUES (?, ?, 'confirmed', ?) ON CONFLICT DO NOTHING`,
        args: [input.sourceTaskId, fixTaskId, blockerCreatedAt],
      },
      {
        // updated_at first — exempt from STATUS_WRITE arch guard. Events are
        // emitted atomically in this same batch per ADR-0030.
        sql: `UPDATE tasks
               SET updated_at = ?,
                   status = 'blocked',
                   error = ?,
                   failure_reason = NULL,
                   failure_reason_code = NULL,
                   failure_signature = NULL
             WHERE id = ?`,
        args: [
          now,
          SOURCE_ERROR_SUMMARY(input.integrationBranch, input.dispatchPhase),
          input.sourceTaskId,
        ],
      },
      // Durable task.blocked in the same atomic batch (ADR-0030); the
      // internalBus().emit below stays only as an in-process wake-hint.
      buildEventInsert('task.blocked', {
        taskId: input.sourceTaskId,
        fixTaskId,
        failureSignature: VERIFY_MAIN_DIRTY_CODE,
        failingStep: `${input.dispatchPhase}:main-dirty`,
        originId: input.sourceOriginId,
      }),
    ],
    'write',
  )

  // Emit the canonical `recovery.spawned` event through the unified write
  // path so the trace surface reflects the new recovery exactly like every
  // other recipe-driven spawn. One occurrence, one `trace_events` row
  // (ADR-0097) — this used to be a separate, unvalidated trace kind.
  await emitEvent(
    resolveQueueClient(),
    'recovery.spawned',
    {
      taskId: fixTaskId,
      sourceTaskId: input.sourceTaskId,
      originId: input.sourceOriginId,
      recipe: MAIN_COMMITER_RECIPE,
      integrationBranch: input.integrationBranch,
      dispatchPhase: input.dispatchPhase,
    },
    {
      taskId: fixTaskId,
      originId: input.sourceOriginId,
      phase: input.dispatchPhase === 'verify' ? 'verify' : input.dispatchPhase === 'merge' ? 'merge' : 'setup',
    },
  ).catch(() => {
    // Event emission is best-effort; never fail a recovery spawn on it.
  })

  internalBus().emit('task.blocked', {
    taskId: input.sourceTaskId,
    fixTaskId,
    failureSignature: VERIFY_MAIN_DIRTY_CODE,
    failingStep: `${input.dispatchPhase}:main-dirty`,
    originId: input.sourceOriginId,
  })
  hintDispatch(fixTaskId, 'implement')

  return { fixTaskId }
}
