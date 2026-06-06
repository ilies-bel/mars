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
