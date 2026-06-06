/**
 * Arc — the aggregate root for a task arc (ADR-0052).
 *
 * An *Arc* is the cluster of Actions (tasks) that share one `origin_id`: the
 * single origin task plus any recovery/fix/diagnose tasks spawned beneath it.
 * The Arc aggregate is the write funnel for arc-shaped mutations; this slice
 * (S1) introduces the skeleton and routes **origin creation** through
 * {@link Arc.createOrigin}. Later slices fold the remaining arc writes
 * (recovery spawn, drop, blockers) behind this same root.
 *
 * The class is constructed only via the static factories ({@link Arc.load},
 * {@link Arc.createOrigin}); the constructor is private. Every instance holds
 * an injected {@link DomainTaskStore} (the deep seam over `.mars/mars.db`) so
 * all persistence routes through the store rather than a raw libsql client.
 */

import { randomUUID } from 'node:crypto'
import {
  coerceToString,
  validatePriority,
  isTaskTag,
  isTaskType,
  TASK_TYPES,
  TASK_SEL,
  rowToTask,
  assertTaskKindInvariant,
  migrateQueueSchema,
  getTask,
  MAX_PRIORITY,
  type Task,
  type TaskPlan,
  type TaskStatus,
  type TaskKind,
  type TaskTag,
  type EnqueueTaskOptions,
} from './queue'
import {
  getDefaultTaskStore,
  getDefaultDomainTaskStore,
  type DomainTaskStore,
} from './store/task-store'
import { getRecipe, type FixRecipeContext } from './lib/fix-recipes'
import { buildEventInsert } from './lib/outbox'
import { internalBus } from '../internal-bus'

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
}

export interface UpsertFixTaskResult {
  fixTaskId: string
  created: boolean
}

/**
 * Attach-to-existing-recovery input. Mirrors the historic
 * `attachToExistingFixTask(input)` parameter shape so the queue-fix-tasks.ts
 * wrapper can delegate without reshaping arguments. Re-exported from
 * queue-fix-tasks.ts for back-compat.
 */
export interface AttachToExistingFixTaskInput {
  sourceTaskId: string
  /** The recovery task to attach the source to. Must already exist as a kind='fix' row. */
  fixTaskId: string
  /** Catalog code recorded on the source's `failure_reason_code` column. */
  failureReasonCode: string | null
  /**
   * Loose-string archive of the failure for forensic continuity (mirrors
   * `tasks.failure_reason`). Kept in step with the catalog-driven code.
   */
  failureReason: string | null
  /** Short error summary written to `tasks.error` (truncated to 1000 chars). */
  errorSummary: string
  store?: DomainTaskStore
}

/**
 * Origin-creation spec for {@link Arc.createOrigin}. Mirrors the historic
 * `enqueueTask(prompt, plan?, opts?)` parameter shape so the queue.ts wrapper
 * can delegate without reshaping arguments.
 */
export interface CreateOriginSpec {
  prompt: string
  plan?: TaskPlan
  opts?: EnqueueTaskOptions
}

export class Arc {
  /**
   * Private — construct an Arc only via {@link Arc.load} or
   * {@link Arc.createOrigin}. Holds the injected store seam and the resolved
   * arc id (the origin task's id).
   */
  private constructor(
    private readonly store: DomainTaskStore,
    public readonly arcId: string,
  ) {}

  /**
   * Cheap factory: wrap an existing arc id for instance methods added by later
   * slices. Does no I/O and does not assert the arc exists — callers that need
   * existence guarantees should query through the store. The `store` defaults
   * to the process-wide default store (synchronous accessor; the migration is
   * driven on first domain call).
   */
  static load(arcId: string, store?: DomainTaskStore): Arc {
    return new Arc(store ?? getDefaultDomainTaskStore(), arcId)
  }

  /**
   * The origin-creation write funnel. Creates the single origin Action (task)
   * for a new arc and returns the persisted {@link Task}. All persistence
   * routes through the injected `store` seam (defaulting to the process-wide
   * default store).
   *
   * This is the canonical home of the origin `INSERT INTO tasks` (plus the
   * `task_spec_files` / `task_done_criteria` junction writes); `enqueueTask`
   * in queue.ts is a thin wrapper that delegates here.
   */
  static async createOrigin(
    spec: CreateOriginSpec,
    store?: DomainTaskStore,
  ): Promise<Task> {
    const resolvedStore = store ?? (await getDefaultTaskStore())
    const { prompt, plan, opts } = spec

    const promptText = coerceToString(prompt, 'enqueueTask: prompt')
    if (opts?.priority !== undefined) validatePriority(opts.priority)
    if (
      opts?.tags !== undefined &&
      (!Array.isArray(opts.tags) || opts.tags.some((t) => !isTaskTag(t)))
    ) {
      throw new Error(
        `tags must be an array of non-empty strings; got ${JSON.stringify(opts.tags)}`,
      )
    }
    await migrateQueueSchema()
    const id = `mars-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const status: TaskStatus = opts?.skipTriage ? 'queued' : 'draft'
    const authorKind = opts?.author?.kind ?? null
    const authorName = opts?.author?.name ?? null
    const originId = opts?.originId ?? id
    const priority = opts?.priority ?? 0
    const parentProposalId = opts?.parentProposalId ?? null
    const sliceIndex = opts?.sliceIndex ?? null
    const tags: TaskTag[] = opts?.tags ?? ['coder']
    const kind: TaskKind = opts?.kind ?? 'task'
    // createOrigin never sets fix_for_task_id (fix-tasks go through their own
    // recovery path), so the invariant collapses to: only 'task' and
    // 'diagnose' kinds are valid here.
    assertTaskKindInvariant(kind, null)
    if (kind === 'fix') {
      throw new Error(
        `enqueueTask cannot create kind='fix'; use the recovery fix-task path`,
      )
    }
    const taskSpec = opts?.spec ?? null
    if (taskSpec !== null && !isTaskType(taskSpec.taskType)) {
      throw new Error(
        `spec.taskType must be one of ${TASK_TYPES.join(', ')}; got '${String(taskSpec.taskType)}'`,
      )
    }
    const verifyCmd = taskSpec ? taskSpec.verifyCmd : null
    const taskType = taskSpec ? taskSpec.taskType : null
    const readFirstJson = taskSpec
      ? JSON.stringify(taskSpec.readFirst ?? [])
      : null
    const prescriptiveAction = taskSpec
      ? (taskSpec.prescriptiveAction ?? null)
      : null
    // sliceKindVal: 'coder' | 'hitl' routing hint from the slicer. Distinct from
    // the `kind` variable above (TaskKind: 'task' | 'fix' | 'diagnose').
    const sliceKindVal = taskSpec?.sliceKind ?? null
    const subDeliverableJson = taskSpec?.subDeliverable
      ? JSON.stringify(taskSpec.subDeliverable)
      : null
    const tagsJson = JSON.stringify(tags)
    await resolvedStore.execute({
      sql: `INSERT INTO tasks (id, prompt, status, plan_functional, plan_technical, author_kind, author_name, origin_id, priority, parent_proposal_id, slice_index, tags_json, kind, verify_cmd, task_type, read_first_json, prescriptive_action, slice_kind, sub_deliverable_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        promptText,
        status,
        plan?.functional ?? null,
        plan?.technical ?? null,
        authorKind,
        authorName,
        originId,
        priority,
        parentProposalId,
        sliceIndex,
        tagsJson,
        kind,
        verifyCmd,
        taskType,
        readFirstJson,
        prescriptiveAction,
        sliceKindVal,
        subDeliverableJson,
        now,
        now,
      ],
    })
    // Write spec.files to task_spec_files junction table.
    if (taskSpec?.files && taskSpec.files.length > 0) {
      for (let i = 0; i < taskSpec.files.length; i++) {
        await resolvedStore.execute({
          sql: `INSERT OR IGNORE INTO task_spec_files (task_id, path, position) VALUES (?, ?, ?)`,
          args: [id, taskSpec.files[i], i],
        })
      }
    }
    // Write spec.doneCriteria to task_done_criteria junction table.
    if (taskSpec?.doneCriteria && taskSpec.doneCriteria.length > 0) {
      for (let i = 0; i < taskSpec.doneCriteria.length; i++) {
        await resolvedStore.execute({
          sql: `INSERT OR IGNORE INTO task_done_criteria (task_id, criterion, position) VALUES (?, ?, ?)`,
          args: [id, taskSpec.doneCriteria[i], i],
        })
      }
    }
    const r = await resolvedStore.execute({
      sql: `${TASK_SEL} WHERE t.id = ?`,
      args: [id],
    })
    return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
  }

  /**
   * Locate an existing outstanding fix-task for a (sourceTaskId,
   * failureSignature) pair. Non-shared recipes dedup per source.
   */
  private async findExistingFixTask(
    sourceTaskId: string,
    failureSignature: string,
  ): Promise<string | null> {
    const r = await this.store.query({
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
  private async findSharedFixTask(
    failureSignature: string,
  ): Promise<string | null> {
    const r = await this.store.query({
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
   *  - UPDATE the source task to status='blocked' with retry_count incremented,
   *  - append a `self_heal_attempts` ledger row,
   *  - emit a durable `task.blocked` event in the same batch.
   *
   * Idempotent on (sourceTaskId, failureSignature): if a fix task is already
   * outstanding for that pair, the existing task is reused.
   *
   * Caller must guarantee a recipe exists for `input.failureSignature` —
   * `getRecipe` throws if it doesn't. Use `hasRecipe(signature)` before
   * calling.
   *
   * F.1 EXEMPTION (ADR-0040). The by-construction origin → fix
   * `task_blockers` edge is written DIRECTLY in the batch below and MUST NOT
   * be routed through `addBlockers`/`assertNotRecoveryEdge`. `spawnRecovery`
   * is the documented canonical origin → recovery edge writer — the one
   * legitimate bypass of F.1's ADR-0040 leaf-node guard (every other
   * `task_blockers` writer goes through `assertNotRecoveryEdge`). The edge
   * here is the canonical attach mechanism; the guard does not apply.
   */
  async spawnRecovery(input: UpsertFixTaskInput): Promise<UpsertFixTaskResult> {
    const s = this.store

    const recipe = getRecipe(input.failureSignature)
    const shared = recipe.shared === true

    // Shared recipes (e.g. dirty merge target) reuse a single in-flight
    // fix-task across every source task that hits the signature. New
    // sources just attach a task_blockers edge — one commit unblocks
    // every dependent at once via onBlockerTaskCompleted.
    const existingId = shared
      ? await this.findSharedFixTask(input.failureSignature)
      : await this.findExistingFixTask(
          input.sourceTaskId,
          input.failureSignature,
        )

    const source = await getTask(input.sourceTaskId, s)
    if (!source) {
      throw new Error(`source task ${input.sourceTaskId} not found`)
    }
    const nextRetryCount = source.retryCount + 1
    const errorSummary = truncate(
      `${input.failingStep}: ${input.truncatedError}`,
      1000,
    )
    const now = new Date().toISOString()

    if (existingId) {
      // Attach this source to the existing fix-task and park it.
      await s.batch(
        [
          {
            sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
                VALUES (?, ?, ?)`,
            args: [input.sourceTaskId, existingId, now],
          },
          {
            // updated_at first — exempt from STATUS_WRITE arch guard. Events are
            // emitted atomically in this same batch per ADR-0030.
            sql: `UPDATE tasks
                   SET updated_at = ?,
                       status = 'blocked',
                       retry_count = ?,
                       error = ?
                 WHERE id = ?`,
            args: [now, nextRetryCount, errorSummary, input.sourceTaskId],
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
    // re-fetching it from .mars/queue.db. Handlers should already set
    // `originalPrompt`; backfill from the source row if a direct caller
    // forgot. Default to '' only when the source genuinely has no prompt.
    const incomingPrompt = input.recipeContext.originalPrompt
    const recipeContextWithSource: FixRecipeContext = {
      ...input.recipeContext,
      originalPrompt:
        incomingPrompt && incomingPrompt.trim().length > 0
          ? incomingPrompt
          : source.prompt ?? '',
    }
    const prompt = recipe.buildPrompt(recipeContextWithSource)
    const fixTaskId = randomUUID().slice(0, 8)
    // Shared remediations run at top priority — every other queued task is
    // waiting on this one resource (e.g. a clean main). Non-shared fix-tasks
    // stay at default priority; they only unblock the single source.
    const fixPriority = shared ? MAX_PRIORITY : 0

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
                retry_count, origin_id, priority,
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
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, created_at)
              VALUES (?, ?, ?)`,
          args: [input.sourceTaskId, fixTaskId, now],
        },
        {
          // updated_at first — exempt from STATUS_WRITE arch guard. Events are
          // emitted atomically in this same batch per ADR-0030.
          sql: `UPDATE tasks
                 SET updated_at = ?,
                     status = 'blocked',
                     retry_count = ?,
                     error = ?
               WHERE id = ?`,
          args: [now, nextRetryCount, errorSummary, input.sourceTaskId],
        },
        // Append-only ledger row for the sweeper's per-(parent,signature)
        // dedup + budget logic. Lives inside the same batch as the
        // fix-task INSERT so a rollback leaves no stray attempt row.
        {
          sql: `INSERT INTO self_heal_attempts (
                parent_task_id, failure_signature, fix_task_id, created_at
              ) VALUES (?, ?, ?, ?)`,
          args: [input.sourceTaskId, input.failureSignature, fixTaskId, now],
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
   * (`INSERT OR IGNORE` on the edge).
   */
  async attachToRecovery(input: AttachToExistingFixTaskInput): Promise<void> {
    const s = this.store
    const source = await getTask(input.sourceTaskId, s)
    if (!source) {
      throw new Error(`source task ${input.sourceTaskId} not found`)
    }
    const now = new Date().toISOString()
    const truncatedError = truncate(input.errorSummary, 1000)
    await s.batch(
      [
        {
          // F.1 exemption: this insert reaches `task_blockers` directly because
          // the legitimate origin → recovery edge writer (`spawnRecovery`) is
          // the documented bypass of the ADR-0040 guard, and this helper is its
          // dedup sibling. See ADR-0040 clarification: the origin → recovery
          // edge is the canonical attach mechanism.
          sql: `INSERT OR IGNORE INTO task_blockers (task_id, blocker_task_id, state, created_at)
                VALUES (?, ?, 'confirmed', ?)`,
          args: [input.sourceTaskId, input.fixTaskId, now],
        },
        {
          // updated_at first — exempt from STATUS_WRITE arch guard. Events are
          // emitted atomically in this same batch per ADR-0030.
          sql: `UPDATE tasks
                   SET updated_at = ?,
                       status = 'blocked',
                       error = ?,
                       failure_reason = COALESCE(?, failure_reason),
                       failure_reason_code = COALESCE(?, failure_reason_code)
                 WHERE id = ?`,
          args: [
            now,
            truncatedError,
            input.failureReason,
            input.failureReasonCode,
            input.sourceTaskId,
          ],
        },
        // Durable task.blocked in the same atomic batch (ADR-0030).
        buildEventInsert('task.blocked', {
          taskId: input.sourceTaskId,
          fixTaskId: input.fixTaskId,
          failureSignature: input.failureReasonCode ?? 'verify:main-dirty',
          failingStep: 'dispatch:main-dirty',
          originId: source.originId,
        }),
      ],
      'write',
    )
    internalBus().emit('task.blocked', {
      taskId: input.sourceTaskId,
      fixTaskId: input.fixTaskId,
      failureSignature: input.failureReasonCode ?? 'verify:main-dirty',
      failingStep: 'dispatch:main-dirty',
      originId: source.originId,
    })
  }

  /**
   * Assert the two Arc invariants. PLACEHOLDER (S1): no-op stub; the real
   * checks land in S9.
   *
   *  1. Every Action's `arcId` (`origin_id`) points at a real Arc — i.e. there
   *     is a row whose `id` equals that `origin_id`.
   *  2. Every Arc has exactly one origin Action with `kind='task'` (the row
   *     whose `id === origin_id`).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private static assertArcInvariant(_arcId: string): void {
    // S9: implement the two-invariant check. Intentionally a no-op this slice.
  }
}
