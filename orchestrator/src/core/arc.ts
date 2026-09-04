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
 * an injected {@link DomainTaskStore} (the deep seam over the shared DB) so
 * all persistence routes through the store rather than a raw DB client.
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { type DbStatement } from './lib/db'
// ADR-0101: import from dependency-free leaves, NOT from queue.ts
import {
  coerceToString,
  validatePriority,
  isTaskTag,
  isMergeMode,
  MERGE_MODES,
  TASK_SEL,
  rowToTask,
  assertTaskKindInvariant,
  getTask,
  IllegalTransitionError,
  TERMINAL_TASK_STATUSES,
  UNSETTLED_BLOCKER_SQL,
  registerArcWriter,
  type ArcWriterPort,
  type Task,
  type TaskPlan,
  type TaskStatus,
  type TaskDropReason,
  type TaskKind,
  type TaskTag,
  type FailedPhase,
  type EnqueueTaskOptions,
  type DropTaskResult,
  type QaReport,
} from './lib/queue-primitives'
import { ensureQueueSchema, resolveQueueClient } from './lib/queue-client'
import { upsertTranscript } from './lib/transcript'
import type { ReviewPacket } from './lib/review-packet.js'
// ADR-0101 edge 2: import from the leaf ArcStorePort (no arc→task-store edge)
// instead of DomainTaskStore from task-store, which imports Arc back and closes
// the task-store→arc→task-store cycle. DomainTaskStore satisfies ArcStorePort
// structurally, so all callers that pass a DomainTaskStore continue to type-check.
import {
  type ArcStorePort,
  getDefaultArcStore,
  getDefaultArcStoreSync,
} from './store/arc-store-port'
import { getStateDir, getRepoRoot, resolveContext } from './context'
import { resolveVcs } from './ports/vcs/registry'
import { provisionWorktreeDeps } from './lib/worktree-deps'
import { buildEventInsert, publish, withWriteTx } from './lib/outbox'
import { maybeAssertArcInvariant } from './arc/invariant'
import { clearBlockerEdges } from './arc/blockers'
import {
  MAIN_COMMITER_RECIPE,
  parseMainCommiterPayload,
} from './lib/main-commiter-payload'
import { internalBus } from '../internal-bus'
import {
  asStepId,
  computeFailureSignature,
  TERMINAL_VERDICT_PREFIXES,
} from './lib/failure-signature'
import { assessStormExcerpt } from './agents/steward'
import { teardownDeploymentsForTask } from './lib/deployment/teardown'
import { linkTaskToThread } from './daemon/chat-thread-tasks'
import {
  raiseActionQueueItem,
  resolveAllRowsForTask,
  resolveRowsNamingDeletedTask,
  supersedeActionQueueItemsForOrigin,
} from './lib/action-queue'
import {
  CANCELLED_CASCADE_ACTION_QUEUE_KIND,
  CANCELLED_CASCADE_FAILURE_REASON,
  composeOriginRecoveryFailedReason,
  ORPHANED_ORIGIN_FAILURE_REASON,
  PREREQUISITE_FAILED_ACTION_QUEUE_KIND,
  WORKTREE_AHEAD_FAILURE_REASON,
  WorktreeAheadOfIntegrationError,
  integrationBranchName,
  raiseOrphanedOriginActionQueue,
  raiseWorktreeAheadActionQueue,
  resetDependentWorktreeToIntegration,
} from './lib/blocker-resolution-primitives'
// Type-only: `no-circular` excludes type-only edges (they vanish at compile
// time), so the aggregate may still name blocker-resolution's result shapes
// without re-opening the `arc -> blocker-resolution -> queue -> arc` cycle.
// Keep this import `import type` — widening it to a value import restores the
// cycle (ADR-0101).
import type {
  BlockByFailureOutcome,
  BlockByFailureResult,
  BlockedDependentRow,
  FailStrandedOriginOutcome,
  FailStrandedOriginResult,
  PropagateRecoveryDoneResult,
  RecoverAllBlockedTasksResult,
  RecoverBlockedTaskOutcome,
  UnblockByTaskResult,
  UnblockOutcome,
} from './blocker-resolution'


// `ArcInvariantError` + the assert seam moved to ./arc/invariant.ts, and
// `truncate` / the FIX_TASK_AUTHOR_* constants moved to ./arc/recovery.ts
// alongside the recovery spawners that were their only consumers.

/**
 * Maps a {@link TaskStatus} to the outbox event that mirrors it, or `null` for
 * statuses that do not have a single matching outbox event (e.g. `'blocked'`,
 * `'running'`). Used by {@link Arc.setTaskStatus} to decide whether to publish.
 *
 * Relocated bit-for-bit from `queue.ts` (ADR-0052 sole-writer).
 */
const mapStatusToEvent = (
  status: TaskStatus,
): 'task.completed' | 'task.dropped' | 'task.failed' | 'task.queued' | null => {
  if (status === 'done') return 'task.completed'
  if (status === 'dropped') return 'task.dropped'
  if (status === 'failed') return 'task.failed'
  if (status === 'queued') return 'task.queued'
  return null
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

/**
 * A single progress journal entry (Foreground-session discipline).
 * Written by {@link Arc.appendProgress}; read by {@link Arc.listProgress}.
 */
export interface ProgressEntry {
  id: string
  taskId: string
  createdAt: number
  author: string
  kind: 'note' | 'check' | 'uncheck'
  body: string
  criterionIndex: number | null
}

/**
 * Parameters for {@link Arc.appendProgress}.
 *
 * `criterionIndex` is 1-based and required for 'check'/'uncheck' kinds.
 * For 'note' entries it must be omitted or null.
 */
export interface AppendProgressParams {
  taskId: string
  author: string
  kind: 'note' | 'check' | 'uncheck'
  body: string
  criterionIndex?: number | null
}

// ── Acceptance / criterion verdict types ──────────────────────────────────────

/**
 * Verdict for a single done-criterion recorded in `task_acceptance`.
 *
 * - `pending`        — not yet evaluated (seeded at task creation)
 * - `met`            — criterion was satisfied
 * - `not-met`        — criterion failed verification
 * - `cannot-verify`  — no surface to exercise (e.g. no Vite project)
 */
export type AcceptanceStatus = 'pending' | 'met' | 'not-met' | 'cannot-verify'

/**
 * A single row from `task_acceptance`, returned by {@link Arc.listAcceptance}.
 */
export interface AcceptanceEntry {
  id: string
  taskId: string
  /** Zero-based position matching `task_done_criteria.position`. */
  position: number
  text: string
  status: AcceptanceStatus
  note: string | null
  updatedAt: number
}

// ── Concern manifest (modular-core program, ADR-0052 follow-on) ───────────
//
// `Arc` currently bundles every arc-shaped write behind one class. Two
// downstream slices peel concerns off it into their own modules (mirroring
// how blocker-resolution.ts already holds the pure blocker-cascade helpers
// `Arc`'s methods delegate to); this manifest is the shared contract those
// slices split against, so both branch off a `main` that already names the
// boundary instead of re-deriving it independently.
//
// **Blocker concern** ("Split arc.ts: extract the blocker concern") — DONE.
// The blocker-EDGE writers — the methods whose *purpose* is a `task_blockers` /
// `task_proposal_blockers` row — now live in ./arc/blockers.ts:
//   addBlockerEdges, addPendingReviewBlockerEdges, removeBlockerEdge,
//   clearBlockerEdges, transferProposalBlockerEdges, failAndClearBlockerEdges
//   (the historic `unblockTask`).
//   Hard cut: this file no longer defines or re-exports them; callers import
//   from ./arc/blockers directly. `core/__tests__/arc-sole-writer.test.ts`
//   allowlists that module alongside this one as a legitimate task_blockers
//   writer. The shared post-write assert moved to ./arc/invariant.ts so the
//   edge module can run it without importing `Arc` (which would cycle).
//
// STILL HERE — the cascade/lifecycle methods that touch `task_blockers`
// incidentally while transitioning task status, not as their reason to exist:
//   unblockByCompletion, blockByTaskFailure, failStrandedOriginOnRecoveryFailure,
//   cascadeCancellation, recoverBlocked, recoverAllBlocked,
//   releaseMainCommitterDependentsAfterSuccess,
//   reparentStrandedDependentsOntoNewCommitter, drop, promoteDraftToQueued.
//   These read and settle edges as part of a status cascade and stay on the
//   aggregate; splitting them would fragment the lifecycle, not the concern.
//   Types: the `BlockByFailureOutcome` / `BlockByFailureResult` /
//   `BlockedDependentRow` / `FailStrandedOriginOutcome` /
//   `FailStrandedOriginResult` / `RecoverAllBlockedTasksResult` /
//   `RecoverBlockedTaskOutcome` / `UnblockByTaskResult` / `UnblockOutcome`
//   family already imported from ./blocker-resolution above —
//   ./blocker-resolution stays the type source of truth.
//
// **Recovery concern** — DONE ("Split arc.ts: extract the recovery
// concern"). `spawnRecovery`, `attachToRecovery`,
// `spawnMainCommitterRecovery` and the `UpsertFixTaskInput` /
// `UpsertFixTaskResult` / `AttachToExistingFixTaskInput` types now live in
// `./arc/recovery.ts` as plain functions taking the store as their first
// argument. `queue-fix-tasks.ts` and `lib/main-dirty.ts` import them from
// there directly and call `maybeAssertArcInvariant` (from ./arc/invariant)
// themselves afterwards.
//
// The import direction is one-way by necessity: `./arc/recovery.ts` imports
// `./queue` and `./store/task-store`, both of which import THIS file, so
// arc.ts must never import `./arc/recovery.ts` — a delegating wrapper here
// would recreate the cycle the split exists to break.
//
// `propagateRecoveryDone` therefore STAYED on the aggregate: it is a
// lifecycle transition on the origin row (flip to `done`, close its action
// queue rows, unblock dependents) and `Arc.unblockByCompletion` calls it
// inline, which would force exactly that forbidden import.
//
// Everything else on `Arc` (origin creation, status-write primitives,
// lease/progress/acceptance bookkeeping, drop/supersede) is core and stays
// on the aggregate — do not fold it into either extraction.
//
// **Cycle status.** The recovery split plus two edge cuts made alongside it
// (`-> proposals`, `-> lib/diagnose-followup`) took the architecture baseline
// from 176 to 169 accepted violations, 25 to 18 import cycles; arc.ts is down
// from 22 cycle entries to 15. The 15 that remain are dominated by two INBOUND
// facade delegations — `queue.ts -> arc.ts` (10 cycles) and
// `store/task-store.ts -> arc.ts` (8) — which exist because both modules are
// thin facades over this aggregate while it imports ~20 symbols back out of
// `queue.ts`. Untangling that is a facade/aggregate re-layering with its own
// slice (task mars-6c94eba5), not something to do opportunistically here.
// Do NOT add a new `arc.ts` import without checking `npm run arch` first.
export class Arc {
  /**
   * Private — construct an Arc only via {@link Arc.load} or
   * {@link Arc.createOrigin}. Holds the injected store seam and the resolved
   * arc id (the origin task's id).
   */
  private constructor(
    private readonly store: ArcStorePort,
    public readonly arcId: string,
  ) {}

  /**
   * Cheap factory: wrap an existing arc id for instance methods added by later
   * slices. Does no I/O and does not assert the arc exists — callers that need
   * existence guarantees should query through the store. The `store` defaults
   * to the process-wide default store (synchronous accessor; the migration is
   * driven on first domain call).
   */
  static load(arcId: string, store?: ArcStorePort): Arc {
    return new Arc(store ?? getDefaultArcStoreSync(), arcId)
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
    store?: ArcStorePort,
  ): Promise<Task> {
    const resolvedStore = store ?? (await getDefaultArcStore())
    const { prompt, plan, opts } = spec

    let promptText = coerceToString(prompt, 'enqueueTask: prompt')
    if (opts?.priority !== undefined) validatePriority(opts.priority)
    if (
      opts?.tags !== undefined &&
      (!Array.isArray(opts.tags) || opts.tags.some((t) => !isTaskTag(t)))
    ) {
      throw new Error(
        `tags must be an array of non-empty strings; got ${JSON.stringify(opts.tags)}`,
      )
    }
    await ensureQueueSchema()
    const id = `mars-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const status: TaskStatus = opts?.skipTriage ? 'queued' : 'draft'
    const authorKind = opts?.author?.kind ?? null
    const authorName = opts?.author?.name ?? null

    // ── Supersede preamble ────────────────────────────────────────────────
    // When opts.supersedes is set: release the superseded task's worktree,
    // create a new worktree on the same branch, and inherit that branch +
    // originId for the new task. The origin drop happens atomically inside
    // resolvedStore.atomic() together with the new task INSERT — so any
    // failure before the atomic commits leaves the origin in its current
    // status ('failed') and the operator can retry with --supersede <oldId>.
    let inheritedBranch: string | null = null
    let inheritedWorktreePath: string | null = null
    let supersedeDerivedOriginId: string | null = null

    if (opts?.supersedes) {
      const supersededId = opts.supersedes
      const superseded = await getTask(supersededId)
      if (!superseded) {
        throw new Error(`supersede: task ${supersededId} not found`)
      }
      // The new task inherits the arc of the superseded task.
      supersedeDerivedOriginId = superseded.originId

      // Step 1: release the old worktree (keep branch — we reuse it).
      if (superseded.worktreePath !== null && superseded.branch !== null) {
        await resolveVcs()
          .removeWorktree({
            path: superseded.worktreePath,
            branch: superseded.branch,
            force: true, // force
            keepBranch: true, // keepBranch — reuse branch for new task
          })
          .catch(() => {
            // worktree already gone on disk — continue; the git pruning in
            // createWorktree / git worktree add would surface a real error.
          })
      }

      // Step 2 (deferred — atomic): the origin drop is committed in the same
      // transaction as the new task INSERT below. Any failure between here and
      // that atomic commit leaves the origin in its pre-supersede status so the
      // operator can retry with --supersede <oldId>.

      // Step 3: create new worktree on superseded branch at new task's path.
      // If this fails, the deferred drop has not yet executed, so the origin
      // stays in its current status and the operator can retry.
      if (superseded.branch !== null) {
        const newWorktreePath = resolve(getStateDir(), 'worktrees', id)
        await mkdir(resolve(newWorktreePath, '..'), { recursive: true })
        try {
          await resolveVcs().addWorktreeForBranch({
            cwd: getRepoRoot(),
            path: newWorktreePath,
            branch: superseded.branch,
          })
          await provisionWorktreeDeps({ worktreeRoot: newWorktreePath })
          inheritedBranch = superseded.branch
          inheritedWorktreePath = newWorktreePath
        } catch (cause) {
          // Fall back to String(cause) when .message is empty — some git errors
          // produce an Error with an empty message, resulting in ". Re-run..."
          // with nothing before the period.
          const causeMsg =
            cause instanceof Error && cause.message
              ? cause.message
              : String(cause)
          throw new Error(
            `supersede: failed to create new worktree for ${supersededId} on branch ` +
              `${superseded.branch}: ${causeMsg}. ` +
              `Re-run 'mars task add --supersede ${supersededId}' to retry.`,
          )
        }

        // Step 4: if the inherited branch's TIP is itself an orchestrator
        // salvage checkpoint (not a finished diff), brief the coder about it
        // up front — a coder dispatched onto a superseded branch otherwise has
        // no signal that the commit it's looking at is a "do not merge as-is"
        // auto-commit, and the merge step will refuse to fast-forward the
        // branch if the coder just re-checkpoints instead of landing a real
        // commit. Best-effort: a git failure here must never block task
        // creation — the merge-time guard (merge.ts) is the actual
        // enforcement point, this is purely advisory.
        if (inheritedBranch !== null) {
          try {
            const tipSha = await resolveVcs().revParse({
              cwd: getRepoRoot(),
              rev: inheritedBranch,
            })
            const { isSalvageCheckpointCommit, buildSupersedeSalvageTipBrief } = await import(
              './lib/git/checkpoint'
            )
            if (tipSha !== null && (await isSalvageCheckpointCommit(getRepoRoot(), tipSha))) {
              promptText = `${promptText}\n\n${buildSupersedeSalvageTipBrief(id)}`
            }
          } catch (err) {
            console.warn(
              `supersede: could not check salvage-checkpoint status of inherited branch ` +
                `${inheritedBranch} (non-fatal, no briefing appended):`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    let originId = supersedeDerivedOriginId ?? (opts?.originId ?? id)
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
    if (taskSpec !== null && !isMergeMode(taskSpec.mergeMode)) {
      throw new Error(
        `spec.mergeMode must be one of ${MERGE_MODES.join(', ')}; got '${String(taskSpec.mergeMode)}'`,
      )
    }
    const verifyCmd = taskSpec ? taskSpec.verifyCmd : null
    const mergeMode = taskSpec ? taskSpec.mergeMode : null
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
    // Derive intent from opts or from the first sentence of prompt (split on
    // '. ' or newline, capped at 200 chars). Inlined — single call site.
    let intent: string
    if (opts?.intent !== undefined && opts.intent !== '') {
      intent = opts.intent.slice(0, 200)
    } else {
      const nlIdx = promptText.indexOf('\n')
      const dotIdx = promptText.indexOf('. ')
      let end: number
      if (dotIdx !== -1 && (nlIdx === -1 || dotIdx < nlIdx)) {
        end = dotIdx + 1 // include the '.'
      } else if (nlIdx !== -1) {
        end = nlIdx // exclude the newline
      } else {
        end = promptText.length
      }
      intent = promptText.slice(0, Math.min(end, 200))
    }
    const originSessionId = opts?.originSessionId ?? null
    const workflow = opts?.workflow ?? null
    const compensatesArcId = opts?.compensatesArcId ?? null
    const followupDedupKey = opts?.followupDedupKey ?? null
    const findingKey = opts?.findingKey ?? null
    const qa: 'auto' | 'manual' = opts?.qa === 'manual' ? 'manual' : 'auto'
    const deferrable = opts?.deferrable === true ? 1 : 0
    // Atomicity invariant: the origin drop and new task INSERT commit in one
    // transaction. If the INSERT fails the origin stays in its pre-supersede
    // status ('failed') and the operator can retry with --supersede <oldId>.
    // If a worktree was created above but the atomic block fails, we remove
    // it best-effort so the retry finds a clean state.
    try {
      await resolvedStore.atomic(async (tx) => {
        // Drop the superseded origin atomically with the new task INSERT.
        // Raw SQL bypasses the application-level terminal-status immutability
        // guard — that guard protects external callers, not this internal
        // atomic sequence where both mutations must commit or roll back together.
        // IMPORTANT: the bypass also skips the status-transition helper's event
        // emission, so we must emit the terminal event pair explicitly below.
        // Omitting them is what caused the bug where dependents stayed blocked
        // forever after a supersede: drainBlockerResolution subscribes to
        // task.terminal and never saw the event, so it never released them.
        if (opts?.supersedes) {
          await tx.execute({
            sql: `UPDATE tasks SET status = 'dropped', drop_reason = 'superseded', worktree_path = NULL, failure_reason = ?, updated_at = ? WHERE id = ?`,
            args: [`superseded by new task ${id}`, now, opts.supersedes],
          })
          // Emit the standard terminal pair so drainBlockerResolution can
          // release any tasks blocked on the superseded task. These events
          // commit in the same transaction as the UPDATE (ADR-0030: event and
          // mutation share one commit). reason: 'dropped' (not a new
          // 'superseded' value) — drainBlockerResolution matches on
          // reason ∈ {'done','dropped'} and 'superseded' would not match.
          await tx.execute(
            buildEventInsert('task.dropped', {
              taskId: opts.supersedes,
              dropReason: 'superseded',
            }),
          )
          await tx.execute(
            buildEventInsert('task.terminal', {
              taskId: opts.supersedes,
              reason: 'dropped',
            }),
          )
        }
        await tx.execute({
          sql: `INSERT INTO tasks (id, prompt, status, plan_functional, plan_technical, author_kind, author_name, origin_id, priority, parent_proposal_id, slice_index, tags_json, kind, verify_cmd, merge_mode, read_first_json, prescriptive_action, slice_kind, sub_deliverable_json, intent, origin_session_id, workflow, compensates_arc_id, followup_dedup_key, finding_key, qa, "deferrable", created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          mergeMode,
          readFirstJson,
          prescriptiveAction,
          sliceKindVal,
          subDeliverableJson,
          intent,
          originSessionId,
          workflow,
          compensatesArcId,
          followupDedupKey,
          findingKey,
          qa,
          deferrable,
          now,
          now,
        ],
      })
      // Write spec.files to task_spec_files junction table.
      if (taskSpec?.files && taskSpec.files.length > 0) {
        for (let i = 0; i < taskSpec.files.length; i++) {
          await tx.execute({
            sql: `INSERT INTO task_spec_files (task_id, path, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            args: [id, taskSpec.files[i], i],
          })
        }
      }
      // Write spec.doneCriteria to task_done_criteria junction table.
      // Also seed a pending task_acceptance row so mars show can display 4-state verdicts.
      // Note: task_acceptance.updated_at is bigint (ms epoch), while the outer `now`
      // is an ISO string (for the tasks table). Use Date.now() here explicitly.
      const seedNow = Date.now()
      if (taskSpec?.doneCriteria && taskSpec.doneCriteria.length > 0) {
        for (let i = 0; i < taskSpec.doneCriteria.length; i++) {
          await tx.execute({
            sql: `INSERT INTO task_done_criteria (task_id, criterion, position) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            args: [id, taskSpec.doneCriteria[i], i],
          })
          await tx.execute({
            sql: `INSERT INTO task_acceptance (id, task_id, position, text, status, updated_at)
                  VALUES (?, ?, ?, ?, 'pending', ?)
                  ON CONFLICT (task_id, position) DO NOTHING`,
            args: [`acc-${id.slice(-8)}-${i}`, id, i, taskSpec.doneCriteria[i], seedNow],
          })
        }
      }
      if (opts?.chatThreadId) await linkTaskToThread(opts.chatThreadId, id, tx)
      // Re-point every incoming task_blockers row that named the superseded
      // task as the blocker. This runs AFTER the new task INSERT so the FK
      // constraint on blocker_task_id is satisfied — the new task row already
      // exists at this point. ON CONFLICT DO NOTHING handles the edge case where
      // a dependent was already blocked by both the old and the new task.
      if (opts?.supersedes) {
        const repointResult = await tx.execute({
          sql: `UPDATE task_blockers SET blocker_task_id = ? WHERE blocker_task_id = ?`,
          args: [id, opts.supersedes],
        })
        const repointedCount = repointResult.rowsAffected
        if (repointedCount > 0) {
          console.log(
            `[supersede] re-pointed ${repointedCount} incoming blocker edge(s) from ${opts.supersedes} to ${id}`,
          )
        }
      }
      }) // end resolvedStore.atomic
    } catch (atomicErr) {
      // Atomic failed: origin stays in its pre-supersede status. Remove the
      // orphaned worktree (if one was created) so a retry finds a clean slate.
      if (inheritedWorktreePath !== null && inheritedBranch !== null) {
        await resolveVcs()
          .removeWorktree({
            path: inheritedWorktreePath,
            branch: inheritedBranch,
            force: true,
            keepBranch: true, // retain branch so --supersede <oldId> can retry
          })
          .catch(() => {})
      }
      throw atomicErr
    }
    // Supersede: if we inherited a branch + worktree from the superseded task,
    // stamp them onto the new task row so the dispatcher sees a ready worktree.
    if (inheritedBranch !== null && inheritedWorktreePath !== null) {
      const updNow = new Date().toISOString()
      await resolvedStore.execute({
        sql: `UPDATE tasks SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?`,
        args: [inheritedBranch, inheritedWorktreePath, updNow, id],
      })
    }
    const r = await resolvedStore.execute({
      sql: `${TASK_SEL} WHERE t.id = ?`,
      args: [id],
    })
    await maybeAssertArcInvariant(id, resolvedStore)
    return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
  }

  /**
   * The Arc-owned status-write primitive (ADR-0052 sole-writer). Builds the
   * canonical raw `UPDATE tasks SET ${fields} WHERE id = ?` statement and runs
   * the lifecycle row-change + paired outbox event INSERTs in a single atomic
   * commit. This is the *only* place the status-bearing `UPDATE tasks SET …`
   * string lives — {@link updateTask} (and, in later slices,
   * {@link Arc.setTaskStatus}) build the column patch (`fields`/`args`),
   * Zod-validated event payloads (`eventStmts`), the terminal-immutability
   * pre-check, and the `isStatusChange` decision, then hand the finished pieces
   * here for the SQL + commit. The caller's `args` array already carries the
   * trailing `WHERE id = ?` bind value (the patch builder pushes `id` last), so
   * this method does not append it.
   *
   * The three-branch dispatch is preserved bit-for-bit from the historic
   * `updateTask` body:
   *   - `appendSessionId` → `withWriteTx` wrapping the row UPDATE, the
   *     `task_claude_sessions` INSERT (`sessionIdStmt`), and every event INSERT
   *     in one write transaction;
   *   - `store` provided → `store.batch([updateStmt, ...eventStmts], 'write')`
   *     so the row change and event inserts share one commit;
   *   - else → `withWriteTx(resolveQueueClient())` wrapping the row UPDATE and
   *     the event INSERTs in one transaction.
   */
  static async applyStatusWrite(input: {
    id: string
    fields: string[]
    args: unknown[]
    eventStmts: DbStatement[]
    store?: ArcStorePort
    appendSessionId?: boolean
    sessionIdStmt?: DbStatement
  }): Promise<void> {
    const updateStmt: DbStatement = {
      sql: `UPDATE tasks SET ${input.fields.join(', ')} WHERE id = ?`,
      args: input.args as never,
    }

    if (input.appendSessionId) {
      // Atomically (a) apply the field updates, (b) insert the new session id
      // into task_claude_sessions (ON CONFLICT DO NOTHING deduplicates), and (c) insert the
      // outbox event row.  All three writes share one write transaction so a
      // crash between any two leaves the DB consistent (either everything
      // committed or nothing).
      const sessionIdStmt = input.sessionIdStmt as DbStatement
      await withWriteTx(resolveQueueClient(), async (tx) => {
        await tx.execute(updateStmt)
        await tx.execute(sessionIdStmt)
        // Event INSERTs share the same transaction: if any throws the whole
        // transaction rolls back (no orphan state row without event).
        for (const stmt of input.eventStmts) await tx.execute(stmt)
      })
    } else if (input.store) {
      // store.batch runs all statements atomically (BEGIN … COMMIT) so the
      // state write and event inserts are in the same commit.
      await input.store.batch([updateStmt, ...input.eventStmts], 'write')
    } else {
      // Common path: wrap state write and event inserts in a single write
      // transaction so a failure between the two never drops the event.
      // TODO(mars-8a44f22d): once all callers thread a `store`, retire this
      // fallback and route through `store.atomic(scope => ...)` like the
      // `appendSessionId` branch above.
      await withWriteTx(resolveQueueClient(), async (tx) => {
        await tx.execute(updateStmt)
        for (const stmt of input.eventStmts) await tx.execute(stmt)
      })
    }
  }

  /**
   * Guarded `'draft' | 'triaging' → 'queued'` promote (ADR-0052 sole-writer).
   *
   * Relocated bit-for-bit from `queue.ts:promoteDraftToQueued`. The status
   * `UPDATE` carries a `NOT EXISTS` conditional WHERE (gate on zero
   * confirmed-or-pending-review incomplete blockers) that cannot be expressed
   * through the column-patch {@link Arc.applyStatusWrite} funnel, so it lives
   * as its own primitive here.
   *
   * PRD 2be831da: `'queued'` requires zero confirmed-or-pending-review rows;
   * rejected rows are historical and must not gate the promote. The guarded
   * UPDATE + the `task.queued` emit share one transaction; the event is
   * appended only when the row actually flipped (`rowsAffected > 0`), so a
   * no-op promote emits nothing. Emitting `task.queued` lets the Invalidator
   * evict any stale failure row for a task that is live again (ADR-0030).
   *
   * Store routing: when `store` is provided the guarded UPDATE + conditional
   * emit run inside `store.atomic` (same commit); otherwise the body is the
   * historic `withWriteTx(resolveQueueClient(), …)` form preserved bit-for-bit.
   *
   * Returns the updated {@link Task} on success; `null` if the row did not
   * flip (already past `'draft'/'triaging'`, missing, or gated by a blocker).
   */
  static async promoteDraftToQueued(
    taskId: string,
    store?: ArcStorePort,
  ): Promise<Task | null> {
    await ensureQueueSchema()
    const now = new Date().toISOString()
    if (store) {
      const upd = await store.atomic(async (scope) => {
        const res = await scope.execute({
          // updated_at first — exempt from STATUS_WRITE arch guard (conditional
          // NOT EXISTS guard cannot be expressed through setTaskStatus).
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'queued'
                 WHERE id = ?
                   AND status IN ('draft', 'triaging')
                   AND NOT EXISTS (
                     SELECT 1 FROM task_blockers b
                     JOIN tasks t ON t.id = b.blocker_task_id
                     WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
                       AND b.state IN ('confirmed', 'pending-review')
                   )`,
          args: [now, taskId, taskId],
        })
        if ((res.rowsAffected ?? 0) > 0) {
          await scope.execute(buildEventInsert('task.queued', { taskId }))
        }
        return res
      })
      if ((upd.rowsAffected ?? 0) === 0) return null
      const r = await store.query({
        sql: `SELECT * FROM tasks WHERE id = ?`,
        args: [taskId],
      })
      if (r.rows.length === 0) return null
      return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
    }
    // PRD 2be831da: 'queued' requires zero confirmed-or-pending-review rows;
    // rejected rows are historical and must not gate the promote.
    // The guarded UPDATE + the task.queued emit share one transaction; the
    // event is appended only when the row actually flipped (rowsAffected > 0),
    // so a no-op promote emits nothing. Emitting task.queued lets the
    // Invalidator evict any stale failure row for a task that is live again
    // (ADR-0030).
    // TODO(mars-8a44f22d): this is the legacy no-store path. Once all callers
    // of Arc.promoteDraftToQueued / queue.promoteDraftToQueued thread a store,
    // retire this branch and have them always take the `if (store)` path above
    // (which uses store.atomic and eliminates this resolveQueueClient() usage).
    const upd = await withWriteTx(resolveQueueClient(), async (tx) => {
      const res = await tx.execute({
        // updated_at first — exempt from STATUS_WRITE arch guard (conditional
        // NOT EXISTS guard cannot be expressed through setTaskStatus).
        sql: `UPDATE tasks
                 SET updated_at = ?, status = 'queued'
               WHERE id = ?
                 AND status IN ('draft', 'triaging')
                 AND NOT EXISTS (
                   SELECT 1 FROM task_blockers b
                   JOIN tasks t ON t.id = b.blocker_task_id
                   WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
                     AND b.state IN ('confirmed', 'pending-review')
                 )`,
        args: [now, taskId, taskId],
      })
      if (res.rowsAffected > 0) {
        await tx.execute(buildEventInsert('task.queued', { taskId }))
      }
      return res
    })
    if (upd.rowsAffected === 0) return null
    // Read the freshly-promoted row back through the typed getTask seam instead
    // of a raw resolveQueueClient() SELECT (mars-8a44f22d: close direct-client
    // escape hatches in arc.ts).
    return getTask(taskId)
  }

  /**
   * Guarded `'draft' → 'triaging'` promote (ADR-0052 sole-writer). Relocated
   * bit-for-bit from `queue.ts:promoteDraftToTriaging`. The dispatcher calls
   * this immediately after picking a draft task so it is observable in the
   * transient `'triaging'` phase while the Linker runs. The conditional WHERE
   * (`AND status = 'draft'`) cannot be expressed through the column-patch
   * {@link Arc.applyStatusWrite} funnel, so it lives as its own primitive here.
   *
   * PARITY: the historic body emitted NO lifecycle event for the
   * draft→triaging flip (it is an internal staging transition the Invalidator
   * does not track), so this relocation issues the guarded UPDATE only — no
   * publish/buildEventInsert. The `updated_at`-first SET ordering is preserved.
   *
   * Returns the updated {@link Task} on success; `null` if the row did not flip
   * (missing, or not currently in `'draft'`).
   */
  static async promoteDraftToTriaging(taskId: string): Promise<Task | null> {
    await ensureQueueSchema()
    const now = new Date().toISOString()
    // TODO(mars-8a44f22d): this guarded UPDATE uses a conditional WHERE
    // (AND status = 'draft') and checks rowsAffected to distinguish a no-op
    // from a real flip. The `store.atomic(scope => scope.execute(...))` path
    // (used by promoteDraftToQueued when a store is injected) would express this
    // cleanly. A store parameter should be threaded through promoteDraftToTriaging
    // and its callers (dispatcher) to retire this resolveQueueClient() usage.
    const upd = await resolveQueueClient().execute({
      sql: `UPDATE tasks
               SET updated_at = ?, status = 'triaging'
             WHERE id = ?
               AND status = 'draft'`,
      args: [now, taskId],
    })
    if (upd.rowsAffected === 0) return null
    // Read the freshly-promoted row back through the typed getTask seam instead
    // of a raw resolveQueueClient() SELECT (mars-8a44f22d: close direct-client
    // escape hatches in arc.ts).
    return getTask(taskId)
  }

  /**
   * Atomic single-writer chokepoint for task status changes (ADR-0052).
   *
   * Relocated bit-for-bit from `queue.ts:setTaskStatus`. Wraps the raw
   * `UPDATE tasks SET status` and the matching outbox event in one commit so
   * the event id is allocated in the same SQLite transaction as the row change
   * (ADR-0030 same-commit guarantee). Callers that need additional column
   * updates (e.g. `drop_reason`, `failure_reason`) or additional events (e.g.
   * `task.terminal`) are appended to the same transaction for terminal
   * statuses. This keeps every terminal status write observable by durable
   * subscribers without a crash window between the row change and its event.
   *
   * Statuses without a registered event mapping (`'blocked'`, `'running'`,
   * etc.) are still written to the row — the method just skips the publish
   * step (see {@link mapStatusToEvent}).
   *
   * PARITY (preserved from the historic `setTaskStatus`):
   *   - **publish-only asymmetry**: `extras.error` rides the `task.failed`
   *     event payload but is NOT written to the `error` column here. A caller
   *     that needs the column persisted must do so in a follow-up write.
   *   - **no terminal-immutability guard**: this method does NOT reject a
   *     write onto an already-terminal row. The sole guard is the caller-side
   *     pre-check ({@link Arc.propagateRecoveryDone} returns early only when
   *     the origin is already `done` — the true idempotent case; `failed` and
   *     `dropped` origins are intentionally reconciled to `done`). Keep that
   *     defense at the call site.
   *
   * Store routing (ADR-0021 / ADR-0030): when `store` is provided the row
   * UPDATE + event INSERT run via `store.batch([updateStmt, ...eventStmts],
   * 'write')` (one BEGIN … COMMIT); otherwise the body is the historic
   * `withWriteTx(resolveQueueClient(), …)` form preserved bit-for-bit.
   */
  static async setTaskStatus(
    taskId: string,
    newStatus: TaskStatus,
    extras?: { error?: string; result?: unknown; dropReason?: TaskDropReason },
    store?: ArcStorePort,
  ): Promise<void> {
    const now = new Date().toISOString()
    const eventType = mapStatusToEvent(newStatus)
    if (store) {
      // Transitioning to 'done': clear stale failure fields from any prior
      // failed attempt so done rows never carry a misleading failure_reason.
      const updateStmt: DbStatement = {
        sql:
          newStatus === 'done'
            ? 'UPDATE tasks SET status = ?, updated_at = ?, failure_reason = NULL, failure_signature = NULL, failure_reason_code = NULL WHERE id = ?'
            : 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
        args: [newStatus, now, taskId],
      }
      // No event mapping (e.g. 'blocked', 'running') → row write only, no emit.
      if (eventType === null) {
        await store.batch([updateStmt], 'write')
        return
      }
      // Build the matching event payload exactly as the historic publish()
      // branches did; buildEventInsert validates the payload against the same
      // Zod schema publish() uses, so the rows are bit-for-bit identical.
      let eventStmt: DbStatement
      if (newStatus === 'done') {
        eventStmt = buildEventInsert('task.completed', {
          taskId,
          result: extras?.result ?? null,
        })
      } else if (newStatus === 'dropped') {
        eventStmt = buildEventInsert('task.dropped', {
          taskId,
          dropReason: extras?.dropReason ?? '',
        })
      } else if (newStatus === 'failed') {
        eventStmt = buildEventInsert('task.failed', {
          taskId,
          error: extras?.error ?? '',
        })
      } else {
        eventStmt = buildEventInsert('task.queued', { taskId })
      }
      const terminalStmt =
        newStatus === 'done' || newStatus === 'dropped' || newStatus === 'failed'
          ? buildEventInsert('task.terminal', {
              taskId,
              reason: newStatus,
            })
          : null
      // Row change + lifecycle event(s) share one commit (ADR-0030).
      await store.batch(
        terminalStmt ? [updateStmt, eventStmt, terminalStmt] : [updateStmt, eventStmt],
        'write',
      )
      return
    }
    await withWriteTx(resolveQueueClient(), async (tx) => {
      // Transitioning to 'done': clear stale failure fields from any prior
      // failed attempt so done rows never carry a misleading failure_reason.
      await tx.execute({
        sql:
          newStatus === 'done'
            ? 'UPDATE tasks SET status = ?, updated_at = ?, failure_reason = NULL, failure_signature = NULL, failure_reason_code = NULL WHERE id = ?'
            : 'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
        args: [newStatus, now, taskId],
      })
      if (eventType === null) return
      if (newStatus === 'done') {
        await publish(tx, 'task.completed', { taskId, result: extras?.result ?? null })
      } else if (newStatus === 'dropped') {
        await publish(tx, 'task.dropped', { taskId, dropReason: extras?.dropReason ?? '' })
      } else if (newStatus === 'failed') {
        await publish(tx, 'task.failed', { taskId, error: extras?.error ?? '' })
      } else if (newStatus === 'queued') {
        await publish(tx, 'task.queued', { taskId })
      }
      if (newStatus === 'done' || newStatus === 'dropped' || newStatus === 'failed') {
        await publish(tx, 'task.terminal', { taskId, reason: newStatus })
      }
    })
  }

  /**
   * The single status-transition funnel (ADR-0052). Routes every task status
   * change through {@link updateTask} — the transition primitive that survives
   * *inside* the aggregate. `updateTask` performs the `UPDATE tasks SET status`
   * + matching outbox event (and the `task.terminal` pair for terminal
   * statuses) in one atomic write, guarding terminal immutability via
   * {@link IllegalTransitionError}.
   *
   * `extras` mirrors the historic `setTaskStatus`/`updateTask` extras shape so
   * callers that carried an `error`/`dropReason` payload — and the richer
   * forensic columns the cascade/terminal funnels write — map cleanly onto
   * `updateTask`'s patch columns:
   *   - `error`            → `patch.error`            (rides the failure payload),
   *   - `dropReason`       → `patch.failureReason`    (rides the `task.dropped`
   *     payload),
   *   - `failureReason`    → `patch.failureReason`    (free-text archive; takes
   *     precedence over `dropReason` when both are given),
   *   - `failureReasonCode`→ `patch.failureReasonCode`(typed catalog code),
   *   - `failureSignature` → `patch.failureSignature` (structured signature).
   * `result` is accepted for shape-compatibility but is not a persisted column;
   * `updateTask` emits `task.completed` with `result: null` (unchanged).
   */
  async transition(
    taskId: string,
    to: TaskStatus,
    extras?: {
      error?: string
      result?: unknown
      dropReason?: TaskDropReason
      failureReason?: string | null
      failureReasonCode?: string | null
      failureSignature?: string | null
    },
  ): Promise<void> {
    const failureReason =
      extras?.failureReason !== undefined
        ? extras.failureReason
        : extras?.dropReason
    await updateTask(taskId, {
      status: to,
      ...(extras?.error !== undefined ? { error: extras.error } : {}),
      ...(extras?.dropReason !== undefined ? { dropReason: extras.dropReason } : {}),
      ...(failureReason !== undefined ? { failureReason } : {}),
      ...(extras?.failureReasonCode !== undefined
        ? { failureReasonCode: extras.failureReasonCode }
        : {}),
      ...(extras?.failureSignature !== undefined
        ? { failureSignature: extras.failureSignature }
        : {}),
    })
  }

  /**
   * Park a task in `'awaiting-human'` with an operator-owned worktree lease
   * (ADR-0052 sole-writer). The pipeline resumes when the lease is released
   * (see `releaseLease`). Compatible with ADR-0063 (no-attach): the human
   * opens their own interactive session; the daemon never attaches to a running
   * pty. No managed subprocess — the phantom watchdog MUST NOT sweep this task.
   *
   * Raises an `'awaiting-human'` action-queue item so the operator can see the
   * parked task and its lease state. The item is level-triggered (ADR-0048):
   * re-detection on an expired lease bumps `seen_count` rather than spawning a
   * sibling row.
   */
  async parkForHuman(
    taskId: string,
    options: {
      leaseOwner: string
      leaseNote?: string | null
      stepName?: string | null
      stepGuide?: string | null
    },
  ): Promise<void> {
    const now = new Date().toISOString()
    await updateTask(taskId, {
      status: 'awaiting-human',
      leaseOwner: options.leaseOwner,
      leasedAt: now,
      leaseNote: options.leaseNote ?? null,
      currentStepName: options.stepName ?? null,
      currentStepGuide: options.stepGuide ?? null,
    })
    await raiseActionQueueItem({
      kind: 'awaiting-human',
      category: 'daemon',
      priority: 'normal',
      title: `Task ${taskId} parked — awaiting human`,
      body:
        options.stepGuide ??
        `Task ${taskId} is parked in its worktree. ` +
        `Lease holder: ${options.leaseOwner}. ` +
        `Work in the worktree, then run \`mars step done ${taskId}\` to hand off to verify+merge, or \`mars release --abort ${taskId}\` to exit without merging.` +
        (options.leaseNote ? ` Note: ${options.leaseNote}` : ''),
      payload: {
        situation: 'lease-park',
        taskId,
        leaseOwner: options.leaseOwner,
        leasedAt: now,
        leaseNote: options.leaseNote ?? null,
      },
      context: { taskId },
      raisedBy: 'arc:park-for-human',
      signature: taskId,
      originTaskId: taskId,
      occurrence: {
        leaseOwner: options.leaseOwner,
        leasedAt: now,
        parkedAt: now,
      },
    }).catch(() => {
      // Non-fatal: task is already parked and the action-queue write failed.
      // The task row itself reflects the parked state; the operator can still
      // discover it via list/status.
    })
  }

  /**
   * Release the worktree lease on an `'awaiting-human'` task and re-queue it
   * for pipeline continuation (ADR-0052 sole-writer).
   *
   * Default (`mars release`): clears all lease fields — the human is done
   * with this task. With `keepLease` (`mars step done`): the lease identity
   * survives the continuation, so when the pipeline parks at the task's NEXT
   * manual step, `awaitHuman` re-grants the lease to the same owner and the
   * Foreground session walks the runbook without re-attaching.
   *
   * Throws if the task is not currently in `'awaiting-human'`.
   */
  async releaseLease(
    taskId: string,
    opts?: { keepLease?: boolean },
  ): Promise<void> {
    const task = await getTask(taskId)
    if (!task) throw new Error(`task ${taskId} not found`)
    if (task.status !== 'awaiting-human') {
      throw new Error(
        `task ${taskId} is in status '${task.status}'; can only release a lease on an 'awaiting-human' task`,
      )
    }
    await updateTask(taskId, {
      status: 'queued',
      ...(opts?.keepLease
        ? {}
        : { leaseOwner: null, leasedAt: null, leaseNote: null }),
    })
  }

  /**
   * Persist a task's review packet (ADR-0052 sole-writer). Relocated from
   * `store/task-store.ts:setReviewPacket`: `review_packet_json` is a
   * non-lifecycle payload column write (no status change, no outbox event),
   * but it must still live behind the Arc aggregate so the task table has
   * exactly one writer (ADR-0052 is column-agnostic) — the store facade now
   * delegates to this instance method, bound to the same client via
   * `Arc.load(taskId, store)`.
   */
  async setReviewPacket(packet: ReviewPacket): Promise<void> {
    await this.store.execute({
      sql: `UPDATE tasks SET review_packet_json = ? WHERE id = ?`,
      args: [JSON.stringify(packet), this.arcId],
    })
  }

  /**
   * Persist a task's QA report (ADR-0052 sole-writer). Relocated from
   * `store/task-store.ts:setQaReport`: `qa_report_json` is a non-lifecycle
   * payload column write (no status change, no outbox event), but it must
   * still live behind the Arc aggregate so the task table has exactly one
   * writer (ADR-0052 is column-agnostic) — the store facade now delegates to
   * this instance method, bound to the same client via
   * `Arc.load(taskId, store)`.
   */
  async setQaReport(report: QaReport): Promise<void> {
    await this.store.execute({
      sql: `UPDATE tasks SET qa_report_json = ? WHERE id = ?`,
      args: [JSON.stringify(report), this.arcId],
    })
  }

  /**
   * Reprioritize a pre-dispatch or blocked task (ADR-0052 sole-writer).
   * Relocated from `queue.ts:setTaskPriority`: the priority `UPDATE tasks SET
   * priority = …, updated_at = …` is a non-lifecycle column write (no status
   * change, no outbox event), but it must still live behind the Arc aggregate
   * so the task table has exactly one writer (ADR-0052) — `setTaskPriority` in
   * queue.ts is now a thin wrapper that delegates here.
   *
   * Priority is a dispatch-ordering attribute: it is read when a task becomes
   * eligible to dispatch, so setting it on `'draft'`, `'triaging'`, or
   * `'blocked'` tasks is meaningful and harmless — the value takes effect the
   * moment the task becomes `'queued'`. Terminal states (`'done'`, `'failed'`,
   * `'dropped'`) and in-flight states (`'running'`, `'verifying'`, `'merging'`,
   * etc.) are rejected with a state-specific message. Returns the re-selected
   * {@link Task}.
   */
  async reprioritize(priority: number): Promise<Task> {
    validatePriority(priority)
    await ensureQueueSchema()
    const id = this.arcId
    const s = this.store
    const before = await s.execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [id],
    })
    if (before.rows.length === 0) {
      throw new Error(`task ${id} not found`)
    }
    const status = (before.rows[0] as unknown as { status: string }).status
    const TERMINAL = ['done', 'failed', 'dropped']
    const IN_FLIGHT = [
      'running',
      'verifying',
      'merging',
      'awaiting-validation',
      'awaiting-human',
      'vega-reconciling',
      'under_investigation',
    ]
    if (TERMINAL.includes(status)) {
      throw new Error(
        `task ${id} is ${status}; priority has no effect on terminal tasks`,
      )
    }
    if (IN_FLIGHT.includes(status)) {
      throw new Error(
        `task ${id} is ${status}; priority cannot be changed while the task is in-flight`,
      )
    }
    // Allowed: draft, triaging, queued, blocked
    const now = new Date().toISOString()
    await s.execute({
      sql: `UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?`,
      args: [priority, now, id],
    })
    await maybeAssertArcInvariant(id, s)
    const r = await s.execute({
      sql: `${TASK_SEL} WHERE t.id = ?`,
      args: [id],
    })
    return rowToTask(r.rows[0] as unknown as Record<string, unknown>)
  }

  /**
   * Update a task's verify command (ADR-0052 sole-writer). Relocated
   * bit-for-bit from `queue.ts:setTaskVerifyCmd`: `verify_cmd` is a
   * non-lifecycle column write (no status change, no outbox event), but it
   * must still live behind the Arc aggregate so the task table has exactly
   * one writer (ADR-0052) — `setTaskVerifyCmd` in queue.ts is now a thin
   * wrapper that delegates here.
   *
   * Allowed for all non-done, non-dropped tasks (including failed tasks,
   * which need their spec repaired before they can be re-tried). Rejects
   * done and dropped tasks — those rows are immutable.
   *
   * The caller is responsible for validating that `verifyCmd` uses relative
   * paths (i.e. does not embed the repo root as an absolute prefix). That
   * check lives at the CLI layer, mirroring the guard on `task add --verify`.
   */
  static async setVerifyCmd(
    id: string,
    verifyCmd: string | null,
  ): Promise<{ id: string; verifyCmd: string | null }> {
    await ensureQueueSchema()
    const client = resolveQueueClient()
    const sel = await client.execute({
      sql: `SELECT status FROM tasks WHERE id = ?`,
      args: [id],
    })
    if (sel.rows.length === 0) {
      throw new Error(`task not found: ${id}`)
    }
    const status = (sel.rows[0] as Record<string, unknown>)['status'] as string
    if (status === 'done' || status === 'dropped') {
      throw new Error(
        `set-verify is not allowed for ${status} tasks — the row is immutable`,
      )
    }
    await client.execute({
      sql: `UPDATE tasks SET verify_cmd = ?, updated_at = NOW() WHERE id = ?`,
      args: [verifyCmd, id],
    })
    return { id, verifyCmd }
  }

  /**
   * The sole audited seam for an operator to reopen a terminal task
   * (ADR-0052 sole-writer). Relocated bit-for-bit from
   * `queue.ts:reopenTerminalTask`; `queue.ts` is now a thin wrapper that
   * delegates here. General task updates cannot use this capability: the
   * database trigger consumes the audit record (`task_terminal_reopens`) in
   * the same transaction as this transition.
   */
  static async reopenTerminalTask(
    id: string,
    reason: string,
    store?: ArcStorePort,
  ): Promise<void> {
    const task = await getTask(id, store)
    if (task === null) throw new Error(`task ${id} not found`)
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      throw new IllegalTransitionError(id, task.status, 'queued')
    }
    const now = new Date().toISOString()
    const statements: DbStatement[] = [
      {
        sql: `INSERT INTO task_terminal_reopens (task_id, reason, reopened_by, reopened_at)
              VALUES (?, ?, 'operator', ?)`,
        args: [id, reason, now],
      },
      {
        sql: `UPDATE tasks SET updated_at = ?, status = 'queued', error = NULL,
                failure_reason = NULL, failure_signature = NULL, failure_reason_code = NULL
              WHERE id = ?`,
        args: [now, id],
      },
      buildEventInsert('task.queued', { taskId: id }),
      {
        sql: `UPDATE task_terminal_reopens SET consumed_at = ?
              WHERE task_id = ? AND consumed_at IS NULL`,
        args: [now, id],
      },
    ]
    if (store) {
      await store.batch(statements, 'write')
    } else {
      await ensureQueueSchema()
      await withWriteTx(resolveQueueClient(), async (tx) => {
        for (const statement of statements) await tx.execute(statement)
      })
    }
  }

  /**
   * Reflection-task insert (ADR-0052). Writes a single self-arc reflection row
   * (`origin_id = self`, status `'done'`) capturing a `mars reflect` run over
   * `corpusSize` task(s). Returns the new task id. Routed through the Arc
   * aggregate so the reflect arc is created by the same write funnel as every
   * other origin; the `origin_id = self` semantics are preserved.
   */
  async insertReflection(corpusSize: number): Promise<string> {
    await ensureQueueSchema()
    const id = `reflect-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const prompt = `mars reflect run over ${corpusSize} task(s) at ${now}`
    await this.store.execute({
      sql: `INSERT INTO tasks (id, prompt, status, origin_id, created_at, updated_at) VALUES (?, ?, 'done', ?, ?, ?)`,
      args: [id, prompt, id, now, now],
    })
    await maybeAssertArcInvariant(id, this.store)
    return id
  }

  /**
   * Structured-write bookkeeping insert (ADR-0052 sole-writer). Writes a
   * single terminal (`status='done'`) row for a deterministic, no-LLM
   * filesystem mutation (e.g. `mars glossary set`, `mars adr add`) that is
   * merged through the durable merge queue but is not queued/dispatchable
   * work. `kind = 'structured-write'` — {@link ORDINARY_TASK_SQL} in
   * queue.ts excludes these rows from ordinary task listings — and the row
   * is self-rooted (`origin_id = id`), the same shape as
   * {@link Arc.insertReflection}. Routed through the Arc aggregate so
   * `runStructuredWrite` (`lib/structured-write.ts`) has exactly one writer,
   * like every other task-row write (ADR-0052).
   *
   * `id` and `prompt` are supplied by the caller: the write id doubles as
   * the merge-queue's `task_id` foreign key, so it must be allocated before
   * this call (it cannot be generated here the way {@link insertReflection}
   * generates its own id).
   *
   * `'structured-write'` is a recognized self-rooted Arc-root kind (see
   * `./arc/invariant.ts`'s INVARIANT B), not a `TaskKind` union
   * member — it never flows through {@link assertTaskKindInvariant}.
   */
  static async recordStructuredWrite(
    id: string,
    prompt: string,
    store?: ArcStorePort,
  ): Promise<void> {
    const resolvedStore = store ?? (await getDefaultArcStore())
    await ensureQueueSchema()
    const now = new Date().toISOString()
    await resolvedStore.execute({
      sql: `INSERT INTO tasks (id, prompt, status, kind, origin_id, created_at, updated_at) VALUES (?, ?, 'done', 'structured-write', ?, ?, ?)`,
      args: [id, prompt, id, now, now],
    })
    await maybeAssertArcInvariant(id, resolvedStore)
  }

  /**
   * Database-level drop of the arc's task (ADR-0052). Works regardless of
   * status — clears every `task_blockers` row mentioning the id on either side,
   * cascade-deletes every fix/recovery task whose `fix_for_task_id` points at
   * the id (ADR-0049), and deletes the task row. Caller is responsible for
   * cancelling any in-flight workflow and removing the worktree+branch on disk
   * before invoking this.
   *
   * Emits `task.dropped` (then `task.terminal{purged}`) BEFORE `DELETE FROM
   * tasks`, all within a single atomic transaction (ADR-0030). The event and
   * the deletion share one commit so the Invalidator can still resolve the
   * taskId — a post-delete emit would race the subscriber cursor read and leave
   * Action-queue rows + dismissal permanently stale.
   *
   * Cascade fix tasks receive the same pre-delete event pair so their own
   * Action-queue rows are invalidated atomically (ADR-0049).
   */
  async drop(opts?: { releaseOrphanedDependents?: boolean }): Promise<DropTaskResult> {
    await ensureQueueSchema()
    const id = this.arcId

    // Belt-and-suspenders: close action-queue rows for this task and its
    // cascaded fix tasks inline, before the task row is deleted. The primary
    // path is event-driven: drop() emits task.dropped in the same atomic tx
    // as DELETE FROM tasks (below), and the Invalidator drains that event to
    // resolve open rows (ADR-0027/0030). This inline call ensures stale cards
    // clear immediately even if the daemon's event drain has not run yet.
    // supersedeActionQueueItemsForOrigin uses the arc fingerprint so it also
    // covers cascaded fix tasks that share the same origin_id as this task.
    // Both calls are idempotent with the event-based closures (a row already
    // resolved is a silent no-op).
    await resolveAllRowsForTask(id)
    // Deletion-only widening: rows that merely *name* this task (in raised_by
    // or anywhere in their payload) become unopenable once it is gone.
    await resolveRowsNamingDeletedTask(id)
    await supersedeActionQueueItemsForOrigin(id, 'origin-dropped', 'drop:pre-delete')

    // Populated inside the atomic; consumed after so the action-queue raise
    // remains best-effort and is intentionally separated from the DB transaction.
    const orphanedDeps: { depId: string; originId: string }[] = []

    // Accumulates the count of merge_jobs rows deleted across the origin task
    // and any cascade-deleted fix tasks. Initialised outside the atomic so the
    // return value type is DropTaskResult (not the Awaited<> of the closure).
    let mergeJobsDeleted = 0

    const result = await this.store.atomic(async (scope) => {
      const before = await scope.execute({
        sql: `SELECT status, origin_id FROM tasks WHERE id = ?`,
        args: [id],
      })
      if (before.rows.length === 0) {
        throw new Error(`task ${id} not found`)
      }
      const beforeRow = before.rows[0] as unknown as {
        status: TaskStatus
        origin_id: string | null
      }
      const previousStatus = beforeRow.status
      // NULL origin_id means "self" throughout the schema (see getTask's
      // coalesce and the orphan-guard comment below) — treat it the same way
      // here so a never-explicitly-set root still reads as its own root.
      const droppedOwnOriginId = beforeRow.origin_id ?? id
      // The dropped task was itself an arc root: dependents naming it as
      // their origin cannot inherit "itself" (that row is about to be
      // deleted), so each becomes its own new arc root instead.
      const droppedWasRoot = droppedOwnOriginId === id

      const incoming = await scope.execute({
        sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE blocker_task_id = ?`,
        args: [id],
      })
      const outgoing = await scope.execute({
        sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ?`,
        args: [id],
      })
      const incomingCount = Number(
        (incoming.rows[0] as unknown as { n: number | bigint }).n,
      )
      const outgoingCount = Number(
        (outgoing.rows[0] as unknown as { n: number | bigint }).n,
      )

      // Cascade: collect every arc member to delete along with the origin
      // (ADR-0049: purge cascades the whole recovery arc).
      //
      // Two link paths reach arc members from an origin:
      //   1. fix_for_task_id = origin.id  — recovery chores (kind='fix').
      //      Cascaded unconditionally (all statuses): fix tasks are the direct
      //      recovery chain and must never outlive their origin.
      //   2. origin_id = origin.id AND tagged 'rescue-operator'  — rescue-operator
      //      tasks spawned by maybeSpawnRescueOperator when the arc has no
      //      automatic move left. These have fix_for_task_id IS NULL and link
      //      to their origin only through origin_id. Narrow cascade: only non-done
      //      rescue-operators are included; a done rescue-operator represents a
      //      completed arc intervention and is preserved as history.
      //
      // Regular blocked tasks that have origin_id = origin.id (e.g. dependents
      // of a now-purged origin) are intentionally excluded here — the orphan-
      // detection loop below detects those and fails them instead, which
      // produces an actionable action-queue item for the operator.
      //
      // The AND id <> ? guard is mandatory: an origin's own origin_id equals
      // its id (self-referential, see Arc.createOrigin), so without the guard
      // the origin would appear in its own cascade list and emit a duplicate
      // task.dropped / task.terminal event.
      const fixRefRows = await scope.execute({
        sql: `SELECT id FROM tasks WHERE fix_for_task_id = ? OR (origin_id = ? AND id <> ? AND status != 'done' AND tags_json LIKE '%rescue-operator%')`,
        args: [id, id, id],
      })
      const cascadedFixTaskIds = fixRefRows.rows.map(
        (row) => (row as unknown as { id: string }).id,
      )

      // Emit task.dropped BEFORE the DELETE so the event survives the row
      // removal and the Invalidator's cursor can still resolve the taskId
      // (ADR-0030).
      await scope.execute(
        buildEventInsert('task.dropped', { taskId: id, dropReason: 'purged' }),
      )
      await scope.execute(
        buildEventInsert('task.terminal', { taskId: id, reason: 'purged' }),
      )

      // Emit pre-delete events for every cascade fix task so their Action-queue
      // rows are invalidated before their rows disappear (ADR-0030 / ADR-0049).
      for (const fixId of cascadedFixTaskIds) {
        await scope.execute(
          buildEventInsert('task.dropped', {
            taskId: fixId,
            dropReason: 'purged',
          }),
        )
        await scope.execute(
          buildEventInsert('task.terminal', { taskId: fixId, reason: 'purged' }),
        )
      }

      // Release dependents: tasks blocked on <id> that have no other
      // non-terminal blocker must flip to 'queued'. This must run BEFORE the
      // bulk DELETE below so the NOT-EXISTS guard sees the correct remaining
      // edge state. The individual edge deletions here make the remaining bulk
      // DELETE a no-op for those rows — correctness is unchanged either way.
      const depRows = await scope.execute({
        sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ?`,
        args: [id],
      })
      const dependentIds = depRows.rows.map(
        (r) => (r as unknown as { task_id: string }).task_id,
      )
      // Pre-pass: any blocked dependent whose origin_id === id (the purged
      // task) is an orphan — its arc root is being deleted. Fail it inline
      // rather than re-queueing it, so the operator gets one action-queue
      // item and a coder is never dispatched against a vanished target.
      // Self-origin dependents (origin_id === dep.id) are arc roots and
      // follow the normal re-queue path (ADR-0040).
      const orphanedDepIds = new Set<string>()
      const failNow = new Date().toISOString()
      for (const depId of dependentIds) {
        const depRow = await scope.execute({
          sql: `SELECT origin_id FROM tasks WHERE id = ? AND status = 'blocked'`,
          args: [depId],
        })
        if (depRow.rows.length === 0) continue
        const originId = (depRow.rows[0] as unknown as { origin_id: string | null }).origin_id
        // Not orphaned: NULL origin (treat as self), self-origin, or origin ≠ purged task.
        if (
          opts?.releaseOrphanedDependents ||
          !originId ||
          originId === depId ||
          originId !== id
        ) continue
        // Orphaned: remove the blocker edge, mark failed, emit terminal events,
        // and clear remaining outbound edges (mirrors markTaskFailed/clearBlockers).
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
          args: [depId, id],
        })
        await scope.execute({
          sql: `UPDATE tasks SET updated_at = ?, status = 'failed', failure_reason = ? WHERE id = ? AND status = 'blocked'`,
          args: [failNow, ORPHANED_ORIGIN_FAILURE_REASON, depId],
        })
        await scope.execute(
          buildEventInsert('task.failed', {
            taskId: depId,
            error: ORPHANED_ORIGIN_FAILURE_REASON,
          }),
        )
        await scope.execute(
          buildEventInsert('task.terminal', { taskId: depId, reason: 'failed' }),
        )
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ?`,
          args: [depId],
        })
        orphanedDepIds.add(depId)
        orphanedDeps.push({ depId, originId: id })
      }
      const releaseNow = new Date().toISOString()
      for (const depId of dependentIds) {
        // Already failed as an orphaned dependent — skip the re-queue path.
        if (orphanedDepIds.has(depId)) continue
        // Remove this specific edge so the NOT-EXISTS subquery below does not
        // count the dropped task as an active blocker when deciding to re-queue.
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
          args: [depId, id],
        })
        // Re-queue the dependent only when every other blocker is already
        // terminal. updated_at precedes status in the SET clause — exempt form
        // required by the architecture guard (status-writer-singleton.test.ts).
        const upd = await scope.execute({
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'queued'
                 WHERE id = ? AND status = 'blocked'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM task_blockers b
                       JOIN tasks t2 ON t2.id = b.blocker_task_id
                      WHERE b.task_id = ?
                        AND t2.status NOT IN ('done', 'failed')
                        AND b.state IN ('confirmed', 'pending-review')
                   )`,
          args: [releaseNow, depId, depId],
        })
        if ((upd.rowsAffected ?? 0) > 0) {
          await scope.execute(
            buildEventInsert('task.unblocked', {
              taskId: depId,
              blockerTaskId: id,
            }),
          )
        }
      }

      await scope.execute({
        sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
        args: [id, id],
      })
      // task_proposal_blockers has a FK on task_id → tasks(id). Delete these
      // rows before the task row so the constraint never fires. (Rows where the
      // task appears as proposal_id are in a different db and have no FK here.)
      await scope.execute({
        sql: `DELETE FROM task_proposal_blockers WHERE task_id = ?`,
        args: [id],
      })
      // questions has a FK on task_id → tasks(id). Remove its rows before the
      // task row is deleted so the FK constraint never fires. The execute is
      // safe because ensureQueueSchema() runs at the top of drop() and will
      // have created the table before we reach this point.
      await scope.execute({
        sql: `DELETE FROM questions WHERE task_id = ?`,
        args: [id],
      })
      // Null out fix_for_task_id pointers in both directions:
      //   (a) rows pointing AT the victim — prevents the self-referential FK on
      //       tasks.fix_for_task_id from blocking the origin DELETE when a fix
      //       task still exists in the table (e.g. if its own DELETE failed).
      //   (b) the victim's own pointer — belt-and-suspenders for fix tasks
      //       dropped directly; no-op for origin tasks (already NULL).
      // These UPDATEs are idempotent and safe regardless of which direction
      // the caller is purging (fix→origin or origin→fix cascade).
      await scope.execute({
        sql: `UPDATE tasks SET fix_for_task_id = NULL WHERE fix_for_task_id = ?`,
        args: [id],
      })
      await scope.execute({
        sql: `UPDATE tasks SET fix_for_task_id = NULL WHERE id = ?`,
        args: [id],
      })
      // Explicit deletes for every junction table whose FK to tasks(id) lacks
      // ON DELETE CASCADE on older DB snapshots (CREATE TABLE IF NOT EXISTS
      // never rebuilds an existing table, so the CASCADE may be absent).
      // Belt-and-suspenders even on up-to-date schemas where CASCADE fires
      // automatically — an explicit DELETE is idempotent.
      await scope.execute({
        sql: `DELETE FROM task_acceptance WHERE task_id = ?`,
        args: [id],
      })
      await scope.execute({
        sql: `DELETE FROM task_claude_sessions WHERE task_id = ?`,
        args: [id],
      })
      await scope.execute({
        sql: `DELETE FROM task_spec_files WHERE task_id = ?`,
        args: [id],
      })
      await scope.execute({
        sql: `DELETE FROM task_done_criteria WHERE task_id = ?`,
        args: [id],
      })
      // task_progress has a FK on task_id → tasks(id) without ON DELETE CASCADE
      // on older schemas (CREATE TABLE IF NOT EXISTS never rebuilds an existing
      // table). Explicit delete guards against FK violations on pre-migration DBs.
      await scope.execute({
        sql: `DELETE FROM task_progress WHERE task_id = ?`,
        args: [id],
      })

      // Cascade-delete each fix/recovery task that pointed at the origin.
      // For each: release any tasks that were blocked on the fix task (e.g.
      // other origins sharing a shared recipe fix task), clean up its edges and
      // proposal blockers, then delete its row. ADR-0049: fix tasks never
      // outlive their origin.
      for (const fixId of cascadedFixTaskIds) {
        // Release tasks blocked on this fix task (unblock them if all other
        // blockers are terminal — mirrors the dependent-release loop above).
        const fixDepRows = await scope.execute({
          sql: `SELECT task_id FROM task_blockers WHERE blocker_task_id = ?`,
          args: [fixId],
        })
        for (const row of fixDepRows.rows) {
          const depId = (row as unknown as { task_id: string }).task_id
          // Skip the origin being dropped — its row disappears below anyway.
          if (depId === id) continue
          await scope.execute({
            sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
            args: [depId, fixId],
          })
          const upd = await scope.execute({
            sql: `UPDATE tasks
                     SET updated_at = ?, status = 'queued'
                   WHERE id = ? AND status = 'blocked'
                     AND NOT EXISTS (
                       SELECT 1
                         FROM task_blockers b
                         JOIN tasks t2 ON t2.id = b.blocker_task_id
                        WHERE b.task_id = ?
                          AND t2.status NOT IN ('done', 'failed')
                          AND b.state IN ('confirmed', 'pending-review')
                     )`,
            args: [releaseNow, depId, depId],
          })
          if ((upd.rowsAffected ?? 0) > 0) {
            await scope.execute(
              buildEventInsert('task.unblocked', {
                taskId: depId,
                blockerTaskId: fixId,
              }),
            )
          }
        }
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
          args: [fixId, fixId],
        })
        await scope.execute({
          sql: `DELETE FROM task_proposal_blockers WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM questions WHERE task_id = ?`,
          args: [fixId],
        })
        // Explicit child-table cleanup for each fix task — mirrors the origin
        // cleanup above so the DELETE FROM tasks below never hits a stale FK.
        await scope.execute({
          sql: `DELETE FROM task_acceptance WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM task_claude_sessions WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM task_spec_files WHERE task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM task_done_criteria WHERE task_id = ?`,
          args: [fixId],
        })
        // task_progress FK guard — mirrors the origin cleanup above.
        await scope.execute({
          sql: `DELETE FROM task_progress WHERE task_id = ?`,
          args: [fixId],
        })
        // self_heal_attempts.fix_task_id has ON DELETE CASCADE (post-migration)
        // but an explicit delete guards against pre-migration schemas.
        await scope.execute({
          sql: `DELETE FROM self_heal_attempts WHERE fix_task_id = ?`,
          args: [fixId],
        })
        // merge_jobs.task_id has no ON DELETE CASCADE — explicit delete required
        // before the tasks row disappears or the FK fires (same class of bug as
        // task_progress above). Count is accumulated into mergeJobsDeleted below.
        const fixMergeJobsDel = await scope.execute({
          sql: `DELETE FROM merge_jobs WHERE task_id = ?`,
          args: [fixId],
        })
        mergeJobsDeleted += Number(fixMergeJobsDel.rowsAffected ?? 0)
        // Belt-and-suspenders: null out any fix_for_task_id pointer from a
        // fix-of-fix task that references this fix task before deleting its
        // row.  Mirrors the origin-level null-out above (line ~2085): if a
        // deeply-nested recovery was spawned for this fix task, the FK on
        // tasks.fix_for_task_id would block the DELETE below without this
        // guard.  The UPDATE is idempotent and a no-op when no such rows
        // exist.
        await scope.execute({
          sql: `UPDATE tasks SET fix_for_task_id = NULL WHERE fix_for_task_id = ?`,
          args: [fixId],
        })
        await scope.execute({
          sql: `DELETE FROM tasks WHERE id = ?`,
          args: [fixId],
        })
      }

      // merge_jobs.task_id has no ON DELETE CASCADE — delete before the tasks
      // row is removed. Explicit delete keeps cleanup visible in the summary
      // line ("merge-jobs=N") and avoids silently discarding merge history on
      // future delete paths that should not cascade.
      const originMergeJobsDel = await scope.execute({
        sql: `DELETE FROM merge_jobs WHERE task_id = ?`,
        args: [id],
      })
      mergeJobsDeleted += Number(originMergeJobsDel.rowsAffected ?? 0)

      // Reparent dangling origin_id references (mars-eb5eab63): any row still
      // naming the about-to-be-deleted task as its origin would otherwise be
      // left pointing at a vanished row, later failing with
      // orphaned_origin_at_unblock the moment an unrelated blocker of its own
      // settles (see Arc.unblockByCompletion). Read this AFTER the orphan
      // pre-pass/re-queue loop above and the cascaded-fix-task deletion loop,
      // so it naturally excludes: dependents just failed as orphans (now
      // 'failed', a terminal status) and cascaded fix tasks (already deleted,
      // so absent from this SELECT). Terminal rows (done/failed/dropped) are
      // left alone — reparenting inert history benefits no one.
      const originRefRows = await scope.execute({
        sql: `SELECT id, status FROM tasks WHERE origin_id = ? AND id <> ?`,
        args: [id, id],
      })
      const originsReparented: string[] = []
      for (const row of originRefRows.rows) {
        const { id: depId, status: depStatus } = row as unknown as {
          id: string
          status: TaskStatus
        }
        if (TERMINAL_TASK_STATUSES.has(depStatus)) continue
        // The dropped task was an arc root: each dependent becomes its own
        // new root. Otherwise every dependent inherits the dropped task's own
        // origin, preserving arc membership up the chain.
        const newOriginId = droppedWasRoot ? depId : droppedOwnOriginId
        await scope.execute({
          sql: `UPDATE tasks SET origin_id = ? WHERE id = ?`,
          args: [newOriginId, depId],
        })
        originsReparented.push(depId)
      }

      await scope.execute({
        sql: `DELETE FROM tasks WHERE id = ?`,
        args: [id],
      })

      return {
        taskId: id,
        previousStatus,
        edgesRemoved: { incoming: incomingCount, outgoing: outgoingCount },
        cascadedFixTaskIds,
        mergeJobsDeleted,
        originsReparented,
      }
    })

    // Best-effort: push one action-queue item per orphaned dependent so the
    // operator is notified. This intentionally runs AFTER the atomic so a
    // transient action-queue failure never rolls back the drop itself.
    for (const { depId, originId } of orphanedDeps) {
      await raiseOrphanedOriginActionQueue(depId, originId).catch(() => {
        /* best-effort — action-queue failure must not surface to the caller */
      })
    }

    return result
  }

  /**
   * Slicer lifecycle purge by explicit id list (ADR-0052 sole-writer). Used by
   * the slice workflow's rollback path to drop a known set of slice + Coder
   * sub-task rows when slicing fails part-way. Distinct from {@link Arc.drop}:
   * single-task scoped (no recovery-arc cascade), no dependent re-queue, and a
   * caller-supplied `dropReason` (e.g. `'slicer-rollback'`) rather than the
   * fixed `'purged'`.
   *
   * Per id, runs ONE atomic transaction that emits `task.dropped{dropReason}`
   * then `task.terminal{reason:'purged'}` BEFORE `DELETE FROM task_blockers`
   * (both edge directions) and `DELETE FROM tasks` — the event and the row
   * removal share one commit so the Invalidator (ADR-0030) can still resolve
   * the taskId and clear any open action-queue rows after the row is gone.
   *
   * Each id is its own atomic scope (never batched across ids) so a single
   * failed delete does not poison the others. Best-effort `.catch()` wrapping
   * is the CALLER's responsibility (preserving the original per-id swallow),
   * NOT this method's — a thrown error here surfaces to the caller's catch.
   */
  static async dropTasksForProposal(
    taskStore: ArcStorePort,
    ids: string[],
    dropReason: TaskDropReason,
  ): Promise<void> {
    for (const id of ids) {
      await taskStore.atomic(async (scope) => {
        await scope.execute(
          buildEventInsert('task.dropped', {
            taskId: id,
            dropReason,
          }),
        )
        await scope.execute(
          buildEventInsert('task.terminal', {
            taskId: id,
            reason: 'purged',
          }),
        )
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
          args: [id, id],
        })
        await scope.execute({
          sql: `DELETE FROM tasks WHERE id = ?`,
          args: [id],
        })
      })
    }
  }

  /**
   * Slicer lifecycle purge by proposal (ADR-0052 sole-writer). Used by the
   * slice workflow's crash-recovery pre-flight to drop any orphaned tasks that
   * claim a proposal as parent before Phase 1 re-inserts a fresh set.
   *
   * SELECTs the orphan ids (outside any transaction), and — when at least one
   * exists — runs ONE atomic transaction that emits `task.dropped{dropReason}`
   * then `task.terminal{reason:'purged'}` for every orphan id BEFORE the two
   * bulk deletes (`DELETE FROM task_blockers` for both edge directions scoped
   * by the parent-proposal sub-select, then `DELETE FROM tasks WHERE
   * parent_proposal_id = ?`). Events and row removal share one commit so the
   * Invalidator (ADR-0030) can still resolve each taskId after the rows are
   * gone.
   *
   * Best-effort `.catch()` wrapping is the CALLER's responsibility (preserving
   * the original swallow on both the SELECT and the atomic), NOT this method's.
   */
  static async dropProposalSlices(
    taskStore: ArcStorePort,
    proposalId: string,
    dropReason: TaskDropReason,
  ): Promise<void> {
    const orphanRows = await taskStore.query({
      sql: `SELECT id FROM tasks WHERE parent_proposal_id = ?`,
      args: [proposalId],
    })
    const orphanIds = orphanRows.rows.map(
      (r) => (r as unknown as { id: string }).id,
    )
    if (orphanIds.length === 0) return
    await taskStore.atomic(async (scope) => {
      for (const orphanId of orphanIds) {
        await scope.execute(
          buildEventInsert('task.dropped', {
            taskId: orphanId,
            dropReason,
          }),
        )
        await scope.execute(
          buildEventInsert('task.terminal', {
            taskId: orphanId,
            reason: 'purged',
          }),
        )
      }
      await scope.execute({
        sql: `DELETE FROM task_blockers WHERE task_id IN (
                SELECT id FROM tasks WHERE parent_proposal_id = ?
              ) OR blocker_task_id IN (
                SELECT id FROM tasks WHERE parent_proposal_id = ?
              )`,
        args: [proposalId, proposalId],
      })
      await scope.execute({
        sql: `DELETE FROM tasks WHERE parent_proposal_id = ?`,
        args: [proposalId],
      })
    })
  }

  /**
   * Unblock-by-completion write funnel (ADR-0052 sole-writer). When a task
   * SETTLES — reaches `done` or `dropped`, see
   * {@link SETTLED_BLOCKER_STATUSES} — look up every task that has it listed
   * as a blocker in `task_blockers` and transition each from `blocked` ->
   * `queued`. A dependent only flips if every one of its blockers has settled.
   *
   * "Completion" here means the blocker's lifecycle completed WITHOUT failing:
   * `dropped` is as final as `done` and can never become `done`, so a
   * dependent left waiting on it is stranded permanently. `failed` is NOT
   * settled and is not routed here — a failed blocker keeps its dependents in
   * `blocked` for operator resolution (the failure does not cascade).
   *
   * STATIC because the subscriber/daemon call this with a *blocker* id that is
   * not an arc root — the relocated body keeps the per-row `store.atomic` scope
   * and the `task.unblocked` event INSIDE the same commit (the only place this
   * status-write SQL lives now), with the SELECTs, internalBus emits,
   * action-queue raises, and worktree reset OUTSIDE the atomic (best-effort).
   *
   * Diagnose Chore intercept (PRD 06e677fb): when the completing task is a
   * diagnose Chore (kind='diagnose'), the generic unblock path is bypassed
   * entirely and `diagnoseVerdictPending` is returned instead. A diagnose
   * Chore's parent is NEVER re-queued blindly — the recorded verdict owns that
   * decision, and running the verdict-driven branch (`runDiagnoseFollowup`,
   * which dispatches a fix or escalates to the action queue) is the CALLER's
   * job. That routing is self-heal, not lifecycle, and invoking it from here
   * closed an `arc -> diagnose-followup -> arc` import cycle.
   */
  static async unblockByCompletion(
    blockerTaskId: string,
  ): Promise<UnblockByTaskResult> {
    // Diagnose Chore intercept — must run before the generic blocker loop so
    // the parent is never flipped to 'queued' through the ordinary path.
    // The verdict branch only owns a diagnose Chore that actually SUCCEEDED —
    // a dropped diagnose Chore produced no verdict to act on, so it falls
    // through to the ordinary settlement loop below (which releases the
    // parent instead of consulting a verdict that does not exist).
    const completingTask = await getTask(blockerTaskId)
    if (completingTask?.kind === 'diagnose' && completingTask.status === 'done') {
      return { blockerTaskId, outcomes: [], diagnoseVerdictPending: true }
    }

    const store = await getDefaultArcStore()
    const now = new Date().toISOString()

    const r = await store.query({
      sql: `SELECT t.id AS id, t.recovery_spawned_count AS recovery_spawned_count
              FROM task_blockers b
              JOIN tasks t ON t.id = b.task_id
             WHERE b.blocker_task_id = ?
               AND t.status = 'blocked'`,
      args: [blockerTaskId],
    })

    const outcomes: UnblockOutcome[] = []
    const integrationBranch = integrationBranchName()

    for (const row of r.rows as unknown as BlockedDependentRow[]) {
      const recoverySpawnedCount = Number(row.recovery_spawned_count ?? 0)
      // An unblocked dependent always proceeds to re-dispatch, regardless of
      // recovery_spawned_count. (No retry-budget gate: it used to fail eligible
      // dependents at unblock time — mars-3d63fe52.)
      const incomplete = await store.query({
        sql: `SELECT 1
                FROM task_blockers b
                JOIN tasks t ON t.id = b.blocker_task_id
               WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
                 AND b.state IN ('confirmed', 'pending-review')
               LIMIT 1`,
        args: [row.id],
      })
      if (incomplete.rows.length > 0) {
        outcomes.push({ taskId: row.id, outcome: 'noop', recoverySpawnedCount })
        continue
      }
      // Recovery-done intercept (mars-f2034bb9): when the settling blocker IS
      // this dependent's own recovery task (kind='fix', fixForTaskId===dependent,
      // status='done'), do NOT re-queue the origin — propagate done to it
      // instead (CLAUDE.md contract: "a successful recovery counts as its
      // origin reaching done").  This makes the subscriber path converge with
      // the inline propagateRecoveryDone() call in the daemon regardless of
      // which path drains first.  propagateRecoveryDone is idempotent on
      // already-done origins, so whichever path runs second is a no-op.
      //
      // EXCEPTION — main-committer recoveries (recipe='main-commiter') skip
      // this path.  Their role is to clean the integration branch, not to
      // deliver the origin's work; they fall through to the normal re-queue so
      // the origin retries on the now-clean branch.
      //
      // Throws on propagateRecoveryDone failure — deliberately not caught here
      // so the subscriber's drainWithStall stall mechanism surfaces it as an
      // action-queue item rather than silently degrading into a re-queue.
      if (
        completingTask?.kind === 'fix' &&
        completingTask.status === 'done' &&
        completingTask.fixForTaskId === row.id &&
        parseMainCommiterPayload(completingTask.recoveryPayload)?.recipe !== MAIN_COMMITER_RECIPE
      ) {
        const propagation = await Arc.load(row.id).propagateRecoveryDone()
        outcomes.push({
          taskId: row.id,
          outcome: propagation.originFlipped ? 'done-via-recovery' : 'noop',
          recoverySpawnedCount,
        })
        continue
      }
      // Fetch the dependent task once; the same row is used for both the
      // orphaned-origin guard below and the worktree-reset path further down.
      const dep = await getTask(row.id)
      // Guard: if the dependent's origin_id points at a different task that no
      // longer exists in the tasks table, fail it rather than re-dispatching a
      // coder against a vanished target.
      //
      // NOTE: origin_id intentionally has no FK and may hold proposal ids (or
      // other non-task arc identifiers) — tasks produced by `mars proposal
      // slice` carry origin_id = proposal_id. Check the proposals table before
      // declaring the origin orphaned; only fail when neither namespace owns
      // the id.
      if (dep?.originId && dep.originId !== dep.id) {
        const originTask = await getTask(dep.originId)
        if (!originTask) {
          // Existence probe only — deliberately a direct `proposals` read
          // rather than `getProposal()` from `proposals.ts`. Importing that
          // module pulls the whole proposal aggregate into the Arc lifecycle
          // module and closes an `arc -> proposals -> queue -> arc` import
          // cycle for a single boolean. `origin_id` always holds a full id
          // here (never a prefix), so exact match is equivalent.
          const originProposal = await store.query({
            sql: `SELECT 1 FROM proposals WHERE id = ? LIMIT 1`,
            args: [dep.originId],
          })
          if (originProposal.rows.length === 0) {
            await raiseOrphanedOriginActionQueue(row.id, dep.originId)
            await markTaskFailed(row.id, ORPHANED_ORIGIN_FAILURE_REASON)
            outcomes.push({
              taskId: row.id,
              outcome: 'failed',
              recoverySpawnedCount,
              failureReason: ORPHANED_ORIGIN_FAILURE_REASON,
            })
            continue
          }
        }
      }
      // Reset the dependent's worktree to integration HEAD BEFORE flipping it
      // to 'queued' — if the reset is refused (commits ahead) the dependent must
      // never enter the dispatch queue.
      //
      // EXCEPT for a human-owned continuation: `mars step done` keeps the
      // lease identity on the row precisely to mark that a Foreground session
      // owns this worktree's commits — they ARE the work product, headed for
      // verify. Resetting would destroy human work; refusing would fail the
      // task for being in exactly the state the live loop puts it in.
      if (dep?.leaseOwner == null) {
        try {
          await resetDependentWorktreeToIntegration(
            row.id,
            dep?.worktreePath ?? null,
            integrationBranch,
          )
        } catch (err: unknown) {
          if (err instanceof WorktreeAheadOfIntegrationError) {
            await raiseWorktreeAheadActionQueue(
              err.taskId,
              err.worktreePath,
              err.aheadCount,
              err.integrationBranch,
            )
            await markTaskFailed(row.id, WORKTREE_AHEAD_FAILURE_REASON)
            outcomes.push({
              taskId: row.id,
              outcome: 'failed',
              recoverySpawnedCount,
              failureReason: WORKTREE_AHEAD_FAILURE_REASON,
            })
            continue
          }
          throw err
        }
      }
      const flipped = await store.atomic(async (scope) => {
        const upd = await scope.execute({
          // updated_at first — exempt from STATUS_WRITE arch guard (conditional WHERE).
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'queued'
                 WHERE id = ? AND status = 'blocked'`,
          args: [now, row.id],
        })
        const didFlip = upd.rowsAffected > 0
        if (didFlip) {
          await scope.execute(
            buildEventInsert('task.unblocked', {
              taskId: row.id,
              blockerTaskId,
            }),
          )
        }
        return didFlip
      })
      if (flipped) {
        outcomes.push({ taskId: row.id, outcome: 'queued', recoverySpawnedCount })
        internalBus().emit('task.unblocked', {
          taskId: row.id,
          blockerTaskId,
        })
      } else {
        outcomes.push({ taskId: row.id, outcome: 'noop', recoverySpawnedCount })
      }
    }

    return { blockerTaskId, outcomes }
  }

  /**
   * Block-by-task-failure write funnel (ADR-0052 sole-writer). When a task
   * lands `failed` (any failure mode), look up every QUEUED task that has a
   * confirmed/pending-review task_blockers edge pointing at the failed task
   * and flip each from `queued` -> `blocked`. Raise a single actionQueue item
   * per affected downstream naming the failed prerequisite so the operator can
   * act.
   *
   * Tasks already in non-queued states (running, blocked, done, failed,
   * dropped, draft, ...) are untouched — the brief is "don't disturb
   * non-queued downstreams".
   *
   * Symmetric with {@link Arc.unblockByCompletion}: that path moves
   * `blocked` -> `queued` when a blocker reaches `done`; this path moves
   * `queued` -> `blocked` when a blocker reaches `failed`.
   *
   * Idempotent: a second invocation finds no `queued` dependents (they
   * are already `blocked`) and is a no-op. The actionQueue call dedupes on
   * `(originTaskId)` fingerprint, so re-raise bumps `seen_count`.
   */
  static async blockByTaskFailure(
    failedBlockerTaskId: string,
  ): Promise<BlockByFailureResult> {
    const store = await getDefaultArcStore()
    const now = new Date().toISOString()

    const r = await store.query({
      sql: `SELECT t.id AS id
              FROM task_blockers b
              JOIN tasks t ON t.id = b.task_id
             WHERE b.blocker_task_id = ?
               AND t.status = 'queued'
               AND b.state IN ('confirmed', 'pending-review')`,
      args: [failedBlockerTaskId],
    })

    const outcomes: BlockByFailureOutcome[] = []
    for (const row of r.rows as unknown as Array<{ id: string }>) {
      const flipped = await store.atomic(async (scope) => {
        const upd = await scope.execute({
          // updated_at first — exempt from STATUS_WRITE arch guard (conditional WHERE).
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'blocked'
                 WHERE id = ? AND status = 'queued'`,
          args: [now, row.id],
        })
        const didFlip = upd.rowsAffected > 0
        // Emit the blocked transition durably, in the same tx, only when the
        // guarded UPDATE actually flipped the row (ADR-0030).
        if (didFlip) {
          await scope.execute(
            buildEventInsert('task.blocked', {
              taskId: row.id,
              fixTaskId: null,
              failureSignature: `prerequisite-failed:${failedBlockerTaskId}`,
              failingStep: 'blocked-dependent',
            }),
          )
        }
        return didFlip
      })
      if (flipped) {
        try {
          await raiseActionQueueItem({
            kind: PREREQUISITE_FAILED_ACTION_QUEUE_KIND,
            category: 'orchestrator',
            priority: 'high',
            title: `Task ${row.id} blocked: prerequisite ${failedBlockerTaskId} failed`,
            body:
              `Task ${row.id} was queued waiting on prerequisite ${failedBlockerTaskId}.\n\n` +
              `The prerequisite failed, so this task has been moved from 'queued' to 'blocked' ` +
              `and will not dispatch into a broken tree.\n\n` +
              `Resolve the failed prerequisite (e.g. \`mars restart ${failedBlockerTaskId}\` or ` +
              `via the actionQueue item raised for it), or drop the blocker edge with ` +
              `\`mars unblock ${row.id} ${failedBlockerTaskId}\`.`,
            payload: {
              dependentTaskId: row.id,
              failedBlockerTaskId,
            },
            context: { repoRoot: process.env.MARS_REPO ?? null },
            raisedBy: 'agent:prerequisite-failed',
            signature: `${row.id}:${failedBlockerTaskId}`,
            originTaskId: row.id,
            occurrence: {
              at: new Date().toISOString(),
              failedBlockerTaskId,
            },
          })
        } catch {
          // best-effort: actionQueue failure must not block the cascade
        }
        outcomes.push({ taskId: row.id, outcome: 'blocked' })
      } else {
        outcomes.push({ taskId: row.id, outcome: 'noop' })
      }
    }

    return { failedBlockerTaskId, outcomes }
  }

  /**
   * Dead-recovery write funnel (ADR-0040 / ADR-0052 sole-writer). When a
   * recovery Chore lands `failed`, the ORIGIN it was spawned for must land
   * `failed` too — CLAUDE.md § Blockers: "A recovery task is itself
   * non-recoverable: if it fails for any reason … the origin goes to `failed`
   * with one actionable action queue item and the operator resolves it
   * explicitly (e.g. `mars restart`)."
   *
   * Without this the origin sat in `blocked` forever, waiting on the one
   * blocker edge that can never reach `done` (a recovery Chore is a leaf and is
   * never re-run). `blocked` is not terminal, so `mars purge` and `mars
   * restart` both refuse it: the arc was unrecoverable without raw SQL.
   *
   * Scope — the origin↔its-own-recovery edge ONLY:
   *  - the completing task must be a recovery (`fix_for_task_id` set) that is
   *    actually `failed`; anything else is a no-op;
   *  - only the recovery's own origin (`fix_for_task_id`) is failed, and only
   *    while it is still `blocked`. Other dependents of the recovery — and the
   *    origin's own dependents — are untouched. The failure does NOT cascade
   *    down the chain; a failed blocker leaving its dependents waiting in
   *    `blocked` is existing intended behaviour.
   *
   * Excluded — `main-commiter` recoveries. A main-committer does NOT carry the
   * origin's work; it cleans the integration branch. Its failure keeps the
   * source parked behind its failed committer and raises an aggregated operator
   * alert; a later dirty episode reparents the cohort onto a fresh committer.
   *
   * Escalation is NOT raised here: `handleTaskFailureWithFixTask` already
   * raises the origin-keyed `Fix and retry <recovery>, or abandon <origin>` row
   * (and the repopulator's origin-fingerprint dedup bumps `seen_count` rather
   * than inserting a second row when the origin's own `task.failed` lands).
   * Only the status transition was missing.
   *
   * Idempotent: the transition is guarded on `status = 'blocked'`, so a replay
   * (or the startup reconcile sweep running over an already-repaired row)
   * reports `noop`.
   */
  static async failStrandedOriginOnRecoveryFailure(
    recoveryTaskId: string,
  ): Promise<FailStrandedOriginResult> {
    const outcomes: FailStrandedOriginOutcome[] = []

    const recovery = await getTask(recoveryTaskId)
    // Only a genuinely failed recovery Chore strands an origin. A recovery that
    // is still running, or that reached `done`, is handled by the ordinary
    // unblock-by-completion path.
    if (!recovery || recovery.fixForTaskId === null || recovery.status !== 'failed') {
      return { recoveryTaskId, outcomes }
    }

    // Main-committers are branch janitors, not carriers of the origin's work —
    // their failure is released, not propagated. See the docblock.
    if (parseMainCommiterPayload(recovery.recoveryPayload)?.recipe === MAIN_COMMITER_RECIPE) {
      return { recoveryTaskId, outcomes }
    }

    const originId = recovery.fixForTaskId
    const origin = await getTask(originId)
    // `blocked` is the only state this repair owns. An origin that already
    // reached a terminal state (or was restarted back into the queue) is not
    // stranded, and the terminal-transition trigger would reject the write.
    if (!origin || origin.status !== 'blocked') {
      outcomes.push({ originTaskId: originId, recoveryTaskId, outcome: 'noop' })
      return { recoveryTaskId, outcomes }
    }

    // Route through the audited terminal seam: `markTaskFailed` -> `updateTask`
    // (the single validated status chokepoint, which also emits the paired
    // `task.failed` + `task.terminal` events), then clears the origin's now-dead
    // outbound blocker edges and blocks any QUEUED downstreams. `blocked` is not
    // terminal, so the `reject_terminal_task_transition` trigger permits it.
    await markTaskFailed(
      originId,
      composeOriginRecoveryFailedReason(recoveryTaskId),
      recovery.failureSignature ?? recovery.failureReasonCode ?? null,
    )
    outcomes.push({ originTaskId: originId, recoveryTaskId, outcome: 'failed' })
    return { recoveryTaskId, outcomes }
  }

  /**
   * Cancellation-cascade write funnel (ADR-0052 sole-writer / PRD slice 2/4
   * mars-9234e1b2). When a blocker reaches `failed` with
   * `failure_reason = 'cancelled'` (i.e. the user explicitly stopped it via
   * the slice-1 stop-task RPC), dependents waiting on it must NOT be recovered
   * — they must fail too, with their own
   * `failure_reason = 'cancelled-blocker-cascade'`, and an actionQueue item
   * naming the cancelled blocker so the operator can see why the dependent died.
   *
   * Keeps the {@link updateTask} choicepoint via the Arc aggregate (the
   * terminal-transition primitive that survives inside the aggregate handles
   * the per-row status flip + paired event); the SELECT and actionQueue raise
   * stay OUTSIDE that write (best-effort).
   *
   * Symmetric with {@link Arc.unblockByCompletion}: that path fires when a
   * blocker reaches `done` and unblocks dependents; this path fires when
   * a blocker is cancelled and cascades the cancel down the dependency
   * chain instead.
   *
   * Blocker edges in `task_blockers` stay attached — they are
   * informational; the dependent row is dead and the edges merely record
   * the cause of death for forensics.
   */
  static async cascadeCancellation(
    blockerTaskId: string,
  ): Promise<UnblockByTaskResult> {
    const store = await getDefaultArcStore()

    const r = await store.query({
      sql: `SELECT t.id AS id, t.recovery_spawned_count AS recovery_spawned_count
              FROM task_blockers b
              JOIN tasks t ON t.id = b.task_id
             WHERE b.blocker_task_id = ?
               AND t.status = 'blocked'
               AND b.state IN ('confirmed', 'pending-review')`,
      args: [blockerTaskId],
    })

    const outcomes: UnblockOutcome[] = []
    for (const row of r.rows as unknown as BlockedDependentRow[]) {
      const recoverySpawnedCount = Number(row.recovery_spawned_count ?? 0)
      const cascadeSignature = computeFailureSignature(
        'blocked-dependent',
        CANCELLED_CASCADE_FAILURE_REASON,
      )
      // Route the terminal flip through the Arc.transition funnel (ADR-0052):
      // the one status funnel, wrapping updateTask. The patch is preserved
      // bit-for-bit — transition maps failureReason/failureReasonCode/
      // failureSignature straight onto updateTask's columns.
      await Arc.load(row.id).transition(row.id, 'failed', {
        error: `cancelled-blocker-cascade: blocker ${blockerTaskId} was cancelled by user`,
        failureReason: CANCELLED_CASCADE_FAILURE_REASON,
        failureSignature: cascadeSignature,
        failureReasonCode: cascadeSignature,
      })
      try {
        await raiseActionQueueItem({
          kind: CANCELLED_CASCADE_ACTION_QUEUE_KIND,
          category: 'orchestrator',
          priority: 'normal',
          title: `Dependent ${row.id} cancelled because blocker ${blockerTaskId} was cancelled`,
          body:
            `Task ${row.id} was waiting on blocker ${blockerTaskId}.\n\n` +
            `The blocker was cancelled by the user (stop-task RPC, failure_reason='cancelled'). ` +
            `Per the cancellation-cascade rule, this dependent has been marked failed ` +
            `with failure_reason='${CANCELLED_CASCADE_FAILURE_REASON}' instead of being unblocked.`,
          payload: {
            dependentTaskId: row.id,
            cancelledBlockerTaskId: blockerTaskId,
            failureReason: CANCELLED_CASCADE_FAILURE_REASON,
          },
          context: { repoRoot: process.env.MARS_REPO ?? null },
          raisedBy: 'agent:blocker-cascade',
          signature: `${row.id}:${blockerTaskId}`,
          originTaskId: row.id,
          occurrence: {
            at: new Date().toISOString(),
            cancelledBlockerTaskId: blockerTaskId,
          },
        })
      } catch {
        // best-effort: actionQueue failure must not block the cascade
      }
      outcomes.push({
        taskId: row.id,
        outcome: 'failed',
        recoverySpawnedCount,
        failureReason: CANCELLED_CASCADE_FAILURE_REASON,
      })
    }

    return { blockerTaskId, outcomes }
  }

  /**
   * Recover-blocked-task write funnel (ADR-0052 sole-writer). Re-evaluate a
   * single blocked task: if all its remaining blockers have resolved (are
   * 'done') or have been removed, flip it from 'blocked' to 'queued' and
   * signal the dispatch loop via internalBus.
   *
   * INSTANCE method keyed on `this.arcId` (the task under recovery). Called
   * after a blocker edge is manually removed (`mars unblock <task> <blocker>`)
   * so a task that now has zero unmet blockers is released immediately — no
   * daemon restart required.
   *
   * Mirrors the per-row logic inside {@link Arc.unblockByCompletion}: same
   * retry-budget check, same worktree reset, same durable outbox event INSIDE
   * the per-row `store.atomic` scope.
   */
  async recoverBlocked(): Promise<RecoverBlockedTaskOutcome> {
    const taskId = this.arcId
    const task = await getTask(taskId)
    if (!task || task.status !== 'blocked') {
      return { taskId, outcome: 'not-blocked', recoverySpawnedCount: 0 }
    }

    const recoverySpawnedCount = task.recoverySpawnedCount ?? 0
    const store = await getDefaultArcStore()

    // A task whose blockers have all resolved always proceeds to re-dispatch,
    // regardless of recovery_spawned_count. (No retry-budget gate: it used to fail
    // eligible dependents at unblock time — mars-3d63fe52.)
    const now = new Date().toISOString()

    // Any confirmed/pending-review blocker edge whose blocker has not settled
    // (SETTLED_BLOCKER_STATUSES: done or dropped)? This is also the boot-time
    // heal for rows already stranded behind a `dropped` blocker: the
    // `orphaned-blocked-scan` reconciler drives every `blocked` row through
    // here via Arc.recoverAllBlocked on each daemon start.
    const incomplete = await store.query({
      sql: `SELECT 1
              FROM task_blockers b
              JOIN tasks t ON t.id = b.blocker_task_id
             WHERE b.task_id = ? AND ${UNSETTLED_BLOCKER_SQL}
               AND b.state IN ('confirmed', 'pending-review')
             LIMIT 1`,
      args: [taskId],
    })
    if (incomplete.rows.length > 0) {
      // Extra lookup for the presentation layer: classify each unsettled blocker
      // as live (queued/running/blocked) or stranded (failed/MISSING).  We use
      // a LEFT JOIN so deleted blockers appear with status 'MISSING' — the
      // operator can then distinguish "still in progress" from "needs rescue".
      const blockerRows = await store.query({
        sql: `SELECT b.blocker_task_id AS blocker_id,
                     COALESCE(t.status, 'MISSING') AS status
                FROM task_blockers b
                LEFT JOIN tasks t ON t.id = b.blocker_task_id
               WHERE b.task_id = ? AND b.state IN ('confirmed', 'pending-review')
                 AND (t.id IS NULL OR ${UNSETTLED_BLOCKER_SQL})`,
        args: [taskId],
      })
      const blockerStatuses = (
        blockerRows.rows as unknown as Array<{ blocker_id: string; status: string }>
      ).map((r) => ({ blockerId: r.blocker_id, status: r.status }))
      return { taskId, outcome: 'noop', recoverySpawnedCount, blockerStatuses }
    }

    // Reset the dependent's worktree to integration HEAD before re-dispatching.
    // Skipped for a human-owned continuation (`mars step done` keeps the lease
    // identity): its commits ahead ARE the work product, headed for verify —
    // see the identical guard in the sweep above.
    const integrationBranch = integrationBranchName()
    if (task.leaseOwner == null) {
      try {
        await resetDependentWorktreeToIntegration(
          taskId,
          task.worktreePath ?? null,
          integrationBranch,
        )
      } catch (err: unknown) {
        if (err instanceof WorktreeAheadOfIntegrationError) {
          await raiseWorktreeAheadActionQueue(
            err.taskId,
            err.worktreePath,
            err.aheadCount,
            err.integrationBranch,
          )
          await markTaskFailed(taskId, WORKTREE_AHEAD_FAILURE_REASON)
          return { taskId, outcome: 'failed', recoverySpawnedCount, failureReason: WORKTREE_AHEAD_FAILURE_REASON }
        }
        throw err
      }
    }

    const flipped = await store.atomic(async (scope) => {
      const upd = await scope.execute({
        // updated_at first — exempt from STATUS_WRITE arch guard (conditional WHERE).
        sql: `UPDATE tasks
                 SET updated_at = ?, status = 'queued'
               WHERE id = ? AND status = 'blocked'`,
        args: [now, taskId],
      })
      const didFlip = upd.rowsAffected > 0
      if (didFlip) {
        await scope.execute(buildEventInsert('task.unblocked', { taskId }))
      }
      return didFlip
    })

    if (flipped) {
      internalBus().emit('task.unblocked', { taskId })
      return { taskId, outcome: 'queued', recoverySpawnedCount }
    }
    return { taskId, outcome: 'noop', recoverySpawnedCount }
  }

  /**
   * Recover-all-blocked write funnel (ADR-0052 sole-writer). Scan every
   * 'blocked' task and re-evaluate each via {@link Arc.recoverBlocked}. Tasks
   * whose blockers are all resolved (done or removed) are flipped to 'queued'
   * and signalled to the dispatch loop.
   *
   * Operator escape hatch: `mars recover` triggers this on the running daemon
   * without needing a restart. Equivalent in intent to the legacy
   * `recoverBlockedTasks` boot-time scan, but safe to run on-demand at any
   * time. The SELECT driving the loop stays OUTSIDE any atomic; each row is
   * recovered through its own `Arc.load(id).recoverBlocked()` instance call.
   */
  static async recoverAllBlocked(): Promise<RecoverAllBlockedTasksResult> {
    const store = await getDefaultArcStore()
    const r = await store.query({
      sql: `SELECT id FROM tasks WHERE status = 'blocked'`,
      args: [],
    })
    const outcomes: RecoverBlockedTaskOutcome[] = []
    for (const row of r.rows as unknown as Array<{ id: string }>) {
      const outcome = await Arc.load(row.id).recoverBlocked()
      outcomes.push(outcome)
    }
    return { outcomes }
  }

  /**
   * Missed-success main-committer completion repair (ADR-0052 sole-writer).
   *
   * After a committer reaches SUCCESS, release every task currently `blocked` solely because
   * of `committerTaskId`: per dependent, in ONE atomic transaction, delete the
   * completed committer's `task_blockers` edge then flip the dependent `blocked` ->
   * `queued` only when no other non-terminal blocker remains, emitting
   * `task.unblocked` in the same commit (ADR-0030). The driving SELECT, the
   * `internalBus().emit` wake-hints, and the per-row logging stay OUTSIDE the
   * atomic (best-effort), exactly as the historic helper structured them.
   *
   * This method is deliberately a reconciliation seam only. Failed committers
   * retain their blocker edges so a fresh dirty-main episode can reparent them.
   *
   * Returns `{ released }` (count of dependents re-queued) so the caller can
   * log the same `released/total` summary it logged before.
   */
  static async releaseMainCommitterDependentsAfterSuccess(
    committerTaskId: string,
    log: (msg: string) => void,
  ): Promise<{ released: number; total: number }> {
    const s = await getDefaultArcStore()
    const now = new Date().toISOString()

    // Find all tasks currently `blocked` that should be released: both via
    // explicit blocker edges AND via the committer's own fix_for_task_id link.
    // UNION (not UNION ALL) deduplicates so a task with both an edge and an
    // origin link is processed once. This covers the case where the blocker
    // edge was never written or was silently removed before the committer
    // completed, leaving the source task stuck in `blocked` with no edge —
    // the exact failure mode observed in the fresh-install reproducer.
    const r = await s.query({
      sql: `SELECT t.id AS id
              FROM task_blockers tb
              JOIN tasks t ON t.id = tb.task_id
             WHERE tb.blocker_task_id = ?
               AND t.status = 'blocked'
             UNION
            SELECT t.id AS id
              FROM tasks committer
              JOIN tasks t ON t.id = committer.fix_for_task_id
             WHERE committer.id = ?
               AND t.status = 'blocked'`,
      args: [committerTaskId, committerTaskId],
    })

    const dependents = r.rows as unknown as Array<{ id: string }>
    // No early return when dependents is empty — the summary log below must
    // always fire so a zero-dependent release pass is visible in the log.
    // A silent early return was the bug's signature: the episode left no trace.

    let released = 0

    for (const row of dependents) {
      const flipped = await s.atomic(async (scope) => {
        // Remove the dead committer's blocker edge. Within this transaction the
        // deletion is immediately visible to the subquery in the UPDATE below.
        await scope.execute({
          sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
          args: [row.id, committerTaskId],
        })
        // Re-queue only when no other non-terminal blocker still exists. This
        // release path is deliberately wider than UNSETTLED_BLOCKER_SQL: a
        // dead committer's siblings are being rescued, so `failed` blockers
        // are ignored here too. `dropped` belongs in the same list for the
        // same reason it belongs in SETTLED_BLOCKER_STATUSES — it is terminal
        // and can never reach `done`.
        // updated_at precedes status in the SET clause — the conditional WHERE
        // cannot be expressed through setTaskStatus; the task.unblocked event is
        // emitted atomically in the same transaction (ADR-0030).
        const upd = await scope.execute({
          sql: `UPDATE tasks
                   SET updated_at = ?, status = 'queued'
                 WHERE id = ? AND status = 'blocked'
                   AND NOT EXISTS (
                     SELECT 1
                       FROM task_blockers b
                       JOIN tasks t2 ON t2.id = b.blocker_task_id
                      WHERE b.task_id = ?
                        AND t2.status NOT IN ('done', 'failed', 'dropped')
                        AND b.state IN ('confirmed', 'pending-review')
                   )`,
          args: [now, row.id, row.id],
        })
        const didFlip = (upd.rowsAffected ?? 0) > 0
        if (didFlip) {
          await scope.execute(
            buildEventInsert('task.unblocked', {
              taskId: row.id,
              blockerTaskId: committerTaskId,
            }),
          )
        }
        return didFlip
      })
      if (flipped) {
        internalBus().emit('task.unblocked', {
          taskId: row.id,
          blockerTaskId: committerTaskId,
        })
        released++
        log(
          `[main-dirty] re-queued task ${row.id} released after successful committer ${committerTaskId}`,
        )
      } else {
        log(
          `[main-dirty] task ${row.id}: successful committer edge removed but other active blockers remain; left blocked`,
        )
      }
    }

    log(
      `[main-dirty] released ${released}/${dependents.length} dependent(s) after successful committer ${committerTaskId}`,
    )
    return { released, total: dependents.length }
  }

  /**
   * Re-parent stranded dependents from prior failed main-committers onto a
   * freshly-spawned committer (ADR-0040 leaf-node exemption, slice F.3).
   *
   * When a main-committer fails, its tasks remain parked on its blocker edge.
   * When a new dirty episode spawns a replacement, this method collects every
   * task still `blocked` on the failed committer and:
   *
   * 1. Inserts `task_blockers(task_id=stranded, blocker_task_id=newCommitterId,
   *    state='confirmed')` — ON CONFLICT DO NOTHING so it's idempotent.
   * 2. Deletes the old failed-committer edge so `unblockByCompletion` can
   *    release the stranded tasks when the new committer succeeds.
   *
   * Writes directly to `task_blockers` without calling `assertNotRecoveryEdge`,
   * mirroring the F.1 exemption used by `spawnMainCommitterRecovery`. The new
   * committer IS a recovery task (kind='fix'), but this edge is legitimate: it
   * is the continuation of the prior committer's responsibility.
   *
   * Returns `{ reparented: N }` where N is the count of unique stranded tasks
   * that received a new edge. Returns `{ reparented: 0 }` when none are found.
   */
  static async reparentStrandedDependentsOntoNewCommitter(
    newCommitterId: string,
    integrationBranch: string,
  ): Promise<{ reparented: number }> {
    const s = await getDefaultArcStore()
    const now = Date.now()

    // Find all (stranded_task_id, failed_committer_id) pairs where the task is
    // still `blocked` on a prior FAILED main-committer for this integration branch.
    const r = await s.query({
      sql: `SELECT tb.task_id AS id, tb.blocker_task_id AS old_committer
              FROM task_blockers tb
              JOIN tasks failed ON failed.id = tb.blocker_task_id
              JOIN tasks dep    ON dep.id    = tb.task_id
             WHERE failed.kind = 'fix'
               AND failed.status = 'failed'
               AND (failed.recovery_payload::jsonb ->> 'recipe') = ?
               AND (failed.recovery_payload::jsonb ->> 'integrationBranch') = ?
               AND dep.status = 'blocked'`,
      args: [MAIN_COMMITER_RECIPE, integrationBranch],
    })

    const rows = r.rows as unknown as Array<{ id: string; old_committer: string }>
    if (rows.length === 0) return { reparented: 0 }

    // Collect unique task IDs (a task may have been blocked by multiple failed
    // committers; ON CONFLICT DO NOTHING handles the duplicate-insert case).
    const uniqueTaskIds = [...new Set(rows.map((row) => row.id))]

    // Batch: add new edge to new committer (idempotent) + delete each old
    // failed-committer edge so unblockByCompletion can release the task.
    const stmts = [
      ...uniqueTaskIds.map((taskId) => ({
        sql: `INSERT INTO task_blockers (task_id, blocker_task_id, state, created_at) VALUES (?, ?, 'confirmed', ?) ON CONFLICT DO NOTHING`,
        args: [taskId, newCommitterId, now],
      })),
      ...rows.map(({ id, old_committer }) => ({
        sql: `DELETE FROM task_blockers WHERE task_id = ? AND blocker_task_id = ?`,
        args: [id, old_committer],
      })),
    ]
    await s.batch(stmts, 'write')

    return { reparented: uniqueTaskIds.length }
  }

  /**
   * Propagate-recovery-done write funnel (ADR-0052 sole-writer). When a
   * recovery task (kind='fix', non-null fixForTaskId) reaches `done`, the work
   * the operator was waiting on has shipped. Flip the origin row (`this.arcId`)
   * to `done`, close actionQueue items keyed on the origin, and propagate the
   * unblock signal so dependents waiting on the origin leave `blocked`.
   *
   * INSTANCE method keyed on `this.arcId` (the origin / fixForTaskId target).
   *
   * Idempotent only for `done`: returns early when origin is already `done`.
   * For `failed` and `dropped` origins this function proceeds to reconcile
   * status to `done` — a successful recovery is authoritative regardless of
   * what the retry-budget guard previously stamped (fix: mars-f109e203 /
   * commit 834fdaa1 — late recovery success must resurrect its origin to done).
   * If the fixForTaskId points at a missing row the method is a no-op.
   *
   * CLAUDE.md contract: "a successful recovery counts as its origin
   * reaching done, so a recovered blocker unblocks the whole chain."
   *
   * PARITY: the two-tx structure is preserved bit-for-bit — first
   * {@link Arc.setTaskStatus} routes the status change + paired `task.completed`
   * event through the single-writer chokepoint, then a second `store.atomic`
   * clears `error = NULL` and emits `task.terminal`. The sole immutability
   * guard is the caller-side pre-check for `done` (the only true idempotent
   * case); Arc.setTaskStatus does NOT enforce terminal immutability (ADR-0052).
   */
  async propagateRecoveryDone(): Promise<PropagateRecoveryDoneResult> {
    const originTaskId = this.arcId
    const origin = await getTask(originTaskId)

    // Close any actionQueue row keyed to the origin regardless of whether we
    // flip its status. The origin may be missing (purged, or the
    // recovery's fixForTaskId was a PRD slug rather than a task row),
    // or already terminal (the retry-budget guard parked it in
    // `failed` before the recovery finished). In either case the
    // operator no longer needs to see a stale "recovery-failed" row:
    // the recovery just succeeded, the underlying work shipped.
    let actionQueueItemsClosed = 0
    try {
      const closed = await supersedeActionQueueItemsForOrigin(originTaskId, 'origin-done')
      actionQueueItemsClosed = closed.length
    } catch {
      // best-effort: actionQueue closing must not block dependent unblock
    }

    if (!origin) {
      return {
        originTaskId,
        originFlipped: false,
        unblock: null,
        actionQueueItemsClosed,
      }
    }
    if (origin.status === 'done') {
      // A completed origin is the only true idempotent case. A successful
      // recovery remains authoritative for origins previously marked failed
      // or dropped, so those statuses are reconciled to done below.
      return {
        originTaskId,
        originFlipped: false,
        unblock: null,
        actionQueueItemsClosed,
      }
    }
    // Route the status change and its paired event through the single-writer
    // chokepoint (Arc.setTaskStatus) so they commit atomically. We intentionally
    // reconcile 'failed' and 'dropped' origins to 'done' here — a successful
    // recovery shipping the work is the authoritative signal that the origin
    // reached done, regardless of what the retry-budget guard or any other
    // upstream writer previously stamped. Failed and dropped rows must first
    // cross the audited reopen seam so the database trigger permits the
    // terminal transition.
    const store = await getDefaultArcStore()
    if (origin.status === 'failed' || origin.status === 'dropped') {
      await Arc.reopenTerminalTask(originTaskId, 'successful recovery', store)
    }
    await Arc.setTaskStatus(originTaskId, 'done', { result: { via: 'recovery' } }, store)
    // Clear the error field and emit the terminal event in a second transaction.
    const now = new Date().toISOString()
    await store.atomic(async (scope) => {
      await scope.execute({
        sql: `UPDATE tasks SET error = NULL, updated_at = ? WHERE id = ?`,
        args: [now, originTaskId],
      })
      await scope.execute(
        buildEventInsert('task.terminal', {
          taskId: originTaskId,
          reason: 'done',
        }),
      )
    })
    const unblock = await Arc.unblockByCompletion(originTaskId)
    return {
      originTaskId,
      originFlipped: true,
      unblock,
      actionQueueItemsClosed,
    }
  }

  /**
   * Append a journal entry to the progress journal for the given task.
   *
   * The Arc aggregate is the sole writer to task_progress (ADR-0052 extension).
   * Validates that the task exists; for 'check'/'uncheck' kinds, validates that
   * `criterionIndex` is a positive integer in range for the task's doneCriteria.
   *
   * @param params.criterionIndex 1-based index into the task's doneCriteria array.
   *   Required for 'check'/'uncheck'; must be omitted or null for 'note'.
   */
  static async appendProgress(
    params: AppendProgressParams,
    store?: ArcStorePort,
  ): Promise<ProgressEntry> {
    await ensureQueueSchema()
    const resolvedStore = store ?? getDefaultArcStoreSync()
    const task = await getTask(params.taskId, resolvedStore)
    if (!task) {
      throw new Error(`task ${params.taskId} not found`)
    }
    if (params.kind === 'check' || params.kind === 'uncheck') {
      const idx = params.criterionIndex
      if (idx === undefined || idx === null || !Number.isInteger(idx) || idx < 1) {
        throw new Error(
          `criterionIndex must be a positive integer for '${params.kind}'; got ${idx}`,
        )
      }
      const criteria = task.spec?.doneCriteria ?? []
      if (idx > criteria.length) {
        throw new Error(
          `criterionIndex ${idx} is out of range; task has ${criteria.length} done criteria`,
        )
      }
    }
    const id = `prog-${randomUUID().slice(0, 8)}`
    const now = Date.now()
    const body = params.body ?? ''
    const criterionIndex =
      params.kind === 'note' ? null : (params.criterionIndex ?? null)
    await resolvedStore.execute({
      sql: `INSERT INTO task_progress (id, task_id, created_at, author, kind, body, criterion_index)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, params.taskId, now, params.author, params.kind, body, criterionIndex],
    })
    // Mirror check/uncheck to task_acceptance so mars show can display 4-state verdicts.
    if ((params.kind === 'check' || params.kind === 'uncheck') && criterionIndex !== null) {
      const criteria = task.spec?.doneCriteria ?? []
      const position = criterionIndex - 1 // convert 1-based criterion_index to 0-based position
      const criterionText = criteria[position] ?? ''
      const newStatus: AcceptanceStatus = params.kind === 'check' ? 'met' : 'pending'
      const accId = `acc-${params.taskId.slice(-8)}-${position}`
      await resolvedStore.execute({
        sql: `INSERT INTO task_acceptance (id, task_id, position, text, status, note, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (task_id, position) DO UPDATE SET
                status = excluded.status,
                note = excluded.note,
                updated_at = excluded.updated_at`,
        args: [accId, params.taskId, position, criterionText, newStatus, body || null, now],
      })
    }
    return {
      id,
      taskId: params.taskId,
      createdAt: now,
      author: params.author,
      kind: params.kind,
      body,
      criterionIndex,
    }
  }

  /**
   * List journal entries for a task, ordered oldest→newest.
   *
   * @param opts.limit Maximum number of entries to return (default: unbounded).
   */
  static async listProgress(
    taskId: string,
    opts?: { limit?: number },
    store?: ArcStorePort,
  ): Promise<ProgressEntry[]> {
    await ensureQueueSchema()
    const resolvedStore = store ?? getDefaultArcStoreSync()
    const limitClause =
      opts?.limit !== undefined ? ` LIMIT ${Math.floor(opts.limit)}` : ''
    const r = await resolvedStore.query({
      sql: `SELECT id, task_id, created_at, author, kind, body, criterion_index
              FROM task_progress
             WHERE task_id = ?
             ORDER BY created_at ASC${limitClause}`,
      args: [taskId],
    })
    return r.rows.map((row) => {
      const rec = row as unknown as {
        id: string
        task_id: string
        created_at: number
        author: string
        kind: string
        body: string
        criterion_index: number | null
      }
      return {
        id: rec.id,
        taskId: rec.task_id,
        createdAt: rec.created_at,
        author: rec.author,
        kind: rec.kind as ProgressEntry['kind'],
        body: rec.body,
        criterionIndex: rec.criterion_index,
      }
    })
  }

  /**
   * Derive the current checklist state from a list of journal entries.
   *
   * State is computed as a fold: for each criterion_index the latest
   * 'check' or 'uncheck' entry wins. 'note' entries are ignored.
   *
   * @param entries Journal entries (any ordering; the fold picks the latest per index).
   * @param doneCriteria The ordered list of criteria from the task spec.
   * @returns One entry per criterion with its current checked state.
   */
  static deriveChecklist(
    entries: ProgressEntry[],
    doneCriteria: readonly string[],
  ): Array<{ criterion: string; checked: boolean }> {
    // Map from 1-based index → most recent entry timestamp
    const stateMap = new Map<number, { checked: boolean; createdAt: number }>()
    for (const entry of entries) {
      if (entry.kind !== 'check' && entry.kind !== 'uncheck') continue
      if (entry.criterionIndex === null) continue
      const existing = stateMap.get(entry.criterionIndex)
      if (existing === undefined || entry.createdAt >= existing.createdAt) {
        stateMap.set(entry.criterionIndex, {
          checked: entry.kind === 'check',
          createdAt: entry.createdAt,
        })
      }
    }
    return doneCriteria.map((criterion, i) => {
      const state = stateMap.get(i + 1)
      return { criterion, checked: state?.checked ?? false }
    })
  }

  /**
   * Record per-criterion verdicts in `task_acceptance`.
   *
   * Called by `behaviourVerify` after exercising a task's done-criteria against
   * the live app surface. Each entry carries a zero-based `position` (matching
   * `task_done_criteria.position`), the criterion text, a verdict status, and an
   * optional evidence note.
   *
   * Uses INSERT … ON CONFLICT DO UPDATE so re-runs overwrite the previous verdict.
   */
  static async recordCriterionVerdicts(
    taskId: string,
    entries: ReadonlyArray<{
      position: number
      text: string
      status: AcceptanceStatus
      note?: string | null
    }>,
    store?: ArcStorePort,
  ): Promise<void> {
    if (entries.length === 0) return
    await ensureQueueSchema()
    const resolvedStore = store ?? getDefaultArcStoreSync()
    const now = Date.now()
    for (const entry of entries) {
      const accId = `acc-${taskId.slice(-8)}-${entry.position}`
      await resolvedStore.execute({
        sql: `INSERT INTO task_acceptance (id, task_id, position, text, status, note, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (task_id, position) DO UPDATE SET
                status = excluded.status,
                note = excluded.note,
                updated_at = excluded.updated_at`,
        args: [accId, taskId, entry.position, entry.text, entry.status, entry.note ?? null, now],
      })
    }
  }

  /**
   * List per-criterion acceptance verdicts for a task, ordered by position.
   *
   * Returns rows from `task_acceptance` — the single source of truth for
   * criterion verdicts after behaviour-verify runs. Returns an empty array for
   * tasks that pre-date the `task_acceptance` seeding (no rows seeded at
   * creation time), letting callers fall back to the legacy `task_progress` fold.
   */
  static async listAcceptance(
    taskId: string,
    store?: ArcStorePort,
  ): Promise<AcceptanceEntry[]> {
    await ensureQueueSchema()
    const resolvedStore = store ?? getDefaultArcStoreSync()
    const r = await resolvedStore.query({
      sql: `SELECT id, task_id, position, text, status, note, updated_at
              FROM task_acceptance
             WHERE task_id = ?
             ORDER BY position ASC`,
      args: [taskId],
    })
    return r.rows.map((row) => {
      const rec = row as unknown as {
        id: string
        task_id: string
        position: number | bigint
        text: string
        status: string
        note: string | null
        updated_at: number | bigint
      }
      return {
        id: rec.id,
        taskId: rec.task_id,
        position: typeof rec.position === 'bigint' ? Number(rec.position) : rec.position,
        text: rec.text,
        status: rec.status as AcceptanceStatus,
        note: rec.note,
        updatedAt: typeof rec.updated_at === 'bigint' ? Number(rec.updated_at) : rec.updated_at,
      }
    })
  }
}

// ---------------------------------------------------------------------------
// updateTask + helpers (ADR-0101: moved from queue.ts to break arc→queue cycle)
// ---------------------------------------------------------------------------

/**
 * Best-effort `<step>/<error-class>` signature for a failure patch that did not
 * carry one. Used by {@link updateTask}'s signature floor.
 *
 * Preference order: a `failure_reason_code` that is already a full signature
 * (it contains a `/`) is authoritative; otherwise the step half comes from the
 * reason code, then the failed phase, then a generic `terminal`, and the error
 * class is classified from whatever text the patch carries.
 */
const deriveFailureSignature = (patch: {
  error?: string | null
  failedPhase?: FailedPhase | null
  failureReason?: string | null
  failureReasonCode?: string | null
}): string => {
  const code = patch.failureReasonCode ?? null
  if (code !== null && code.includes('/')) {
    // Strip any leading terminal-verdict prefix before treating `code` as a
    // signature. Without this, a code like
    // `recovery_exhausted:verify:typecheck/typecheck-cannot-find-name: …`
    // would be returned verbatim, embedding free text into failure_signature.
    const matchedPrefix = TERMINAL_VERDICT_PREFIXES.find((p) => code.startsWith(p))
    if (matchedPrefix) {
      // After stripping the prefix: `<step>/<class>: <error text>` — extract
      // only the `<step>/<class>` part before the `: ` separator.
      const afterPrefix = code.slice(matchedPrefix.length)
      const colonSpace = afterPrefix.indexOf(': ')
      const candidate = colonSpace >= 0 ? afterPrefix.slice(0, colonSpace) : afterPrefix
      if (candidate.includes('/')) return candidate
    }
    return code
  }
  const step = asStepId(code) ?? asStepId(patch.failedPhase) ?? 'terminal'
  return computeFailureSignature(step, patch.error ?? patch.failureReason ?? '')
}

export const updateTask = async (
  id: string,
  patch: Partial<
    Pick<
      Task,
      | 'status'
      | 'plan'
      | 'branch'
      | 'worktreePath'
      | 'claudeSessionId'
      | 'error'
      | 'failedPhase'
      | 'integrationHeadSha'
      | 'devServerUrl'
      | 'devServerPid'
      | 'previewValidated'
      | 'failureReason'
      | 'failureSignature'
      | 'leaseOwner'
      | 'leasedAt'
      | 'leaseNote'
      | 'currentStepName'
      | 'currentStepGuide'
      | 'activityDetail'
      | 'recoverySpawnedCount'
      | 'envRestartCount'
      | 'workflow'
      | 'requeueAnchorMs'
      | 'requeueDispatchUptimeMs'
      | 'stallDiagnostics'
      | 'quotaRejectedAttempts'
      | 'envApiUnreachableAttempts'
    > & {
      /** Typed explanation persisted when a task is deliberately dropped. */
      dropReason?: TaskDropReason | null
      /**
       * Typed catalog code for the failure (e.g. `verify:main-dirty`).
       * Companion to the legacy free-text `failureReason`; either can be
       * written on its own, both can be written together. Slice F.2
       * starts populating it for dirty-main parking.
       */
      failureReasonCode?: string | null
      /**
       * JSON-encoded sidecar for recovery (kind='fix') rows. Slice F.2 stores
       * `{ recipe, integrationBranch }` here for `main-commiter` recoveries.
       */
      recoveryPayload?: string | null
      /**
       * The full verify step output (per-gate headers + diagnostics + gate
       * outcomes JSON). When provided, persisted to the task's transcript record
       * via {@link upsertTranscript} so structural crashes (outer catch path) are
       * visible in the run-timeline view rather than showing 'none recorded'.
       */
      verifyOutput?: string | null
    }
  >,
  store?: ArcStorePort,
): Promise<void> => {
  const fields: string[] = []
  const args: unknown[] = []

  // Read the current status (and branch) before the UPDATE so we can detect real
  // transitions (patch.status === existing status ⇒ no-op, skip dismissals), and
  // so the done-implies-merged guard (below) has access to the branch name.
  let previousStatus: string | null = null
  let taskBranch: string | null = null
  if (patch.status !== undefined) {
    const before = store
      ? await store.query({ sql: `SELECT status, branch FROM tasks WHERE id = ?`, args: [id] })
      : await resolveQueueClient().execute({ sql: `SELECT status, branch FROM tasks WHERE id = ?`, args: [id] })
    if (before.rows.length > 0) {
      const row = before.rows[0] as unknown as { status: string; branch: string | null }
      previousStatus = row.status ?? null
      taskBranch = row.branch ?? null
    }
  }

  // Guard: terminal statuses are immutable.  A task that reached 'done' or
  // 'dropped' must never be moved to a different status — the daemon,
  // Invalidator, and UI all treat those as absorbing states.
  if (
    patch.status !== undefined &&
    previousStatus !== null &&
    patch.status !== previousStatus &&
    TERMINAL_TASK_STATUSES.has(previousStatus as TaskStatus)
  ) {
    throw new IllegalTransitionError(id, previousStatus, patch.status)
  }

  // Done-implies-merged invariant (ADR-0052 / done-with-unmerged-commits).
  //
  // When a task is transitioning to 'done' AND its branch column is set, assert
  // that the branch has 0 commits ahead of the integration branch. A non-zero
  // count means the merge step never completed — the "committer false-done" bug
  // class (3d7cb3c2 / mars-984de140). Intercept by redirecting the patch to
  // 'failed' with a distinct failure_reason_code BEFORE the field-building so
  // every downstream step (eventStmts, blocker promotion) sees the corrected
  // status automatically.
  //
  // Ordering note: `git rev-list --count <integration>..<branch>` runs from the
  // repo root against a named branch ref. Two skip conditions apply:
  //   – branch is NULL → task never had a worktree; nothing to check.
  //   – git exits non-zero → the branch was deleted (normal post-merge cleanup
  //     where the merge step deletes the branch before or alongside the status
  //     write). Treat as 0 commits ahead and allow done.
  //
  // The guard applies only to direct done transitions via updateTask. The
  // propagateRecoveryDone path in Arc sets the ORIGIN to done after a FIX task
  // completes; in that scenario the fix task's branch (not the origin's) was
  // merged. Guarding the origin's branch there would produce false positives
  // (the origin's branch was intentionally never merged — the fix task did the
  // work). That path calls Arc.setTaskStatus directly and bypasses updateTask.
  let doneWithUnmergedCommits = false
  if (
    patch.status === 'done' &&
    previousStatus !== null &&
    previousStatus !== 'done' &&
    taskBranch !== null
  ) {
    const integration = process.env.INTEGRATION_BRANCH ?? 'main'
    const repoRoot = resolveContext().repoRoot
    // Branch deleted or git error — `revListCount` answers null, which we
    // treat as already merged (0 ahead).
    const aheadCount =
      (await resolveVcs().revListCount({
        cwd: repoRoot,
        range: `${integration}..${taskBranch}`,
      })) ?? 0
    if (aheadCount > 0) {
      doneWithUnmergedCommits = true
      patch = {
        ...patch,
        status: 'failed',
        failureReasonCode: 'done-with-unmerged-commits',
      }
    }
  }

  // Transitioning to 'done': clear stale failure fields from any prior failed
  // attempt so a done row never carries a misleading failure_reason.  Only
  // applies when a real status change is happening (previousStatus is set and
  // differs from 'done', the only terminal-immutable guard that blocks this).
  if (patch.status === 'done' && previousStatus !== null && previousStatus !== 'done') {
    patch = { ...patch, failureReason: null, failureSignature: null, failureReasonCode: null }
  }

  // Auto-clear activity_detail when leaving in-flight statuses.
  // activity_detail is a short-lived label for the current merge/verify sub-phase;
  // it must not linger once the task is done, failed, parked, or any other
  // non-in-flight state. Callers may still set activityDetail explicitly to null
  // (clearing is idempotent).
  const IN_FLIGHT_STATUSES = new Set(['running', 'verifying', 'merging', 'vega-reconciling'])
  if (
    patch.status !== undefined &&
    !IN_FLIGHT_STATUSES.has(patch.status) &&
    patch.activityDetail === undefined
  ) {
    patch = { ...patch, activityDetail: null }
  }

  if (patch.status !== undefined) {
    fields.push('status = ?')
    args.push(patch.status)
  }
  if (patch.plan !== undefined) {
    fields.push('plan_functional = ?')
    args.push(patch.plan?.functional ?? null)
    fields.push('plan_technical = ?')
    args.push(patch.plan?.technical ?? null)
  }
  if (patch.branch !== undefined) {
    fields.push('branch = ?')
    args.push(patch.branch)
  }
  if (patch.worktreePath !== undefined) {
    fields.push('worktree_path = ?')
    args.push(patch.worktreePath)
  }
  if (patch.claudeSessionId !== undefined) {
    fields.push('claude_session_id = ?')
    args.push(patch.claudeSessionId)
  }
  if (patch.recoverySpawnedCount !== undefined) {
    fields.push('recovery_spawned_count = ?')
    args.push(patch.recoverySpawnedCount)
  }
  if (patch.envRestartCount !== undefined) {
    fields.push('env_restart_count = ?')
    args.push(patch.envRestartCount)
  }
  if (patch.error !== undefined) {
    fields.push('error = ?')
    args.push(patch.error)
  }
  if (patch.dropReason !== undefined) {
    fields.push('drop_reason = ?')
    args.push(patch.dropReason)
  }
  if (patch.failedPhase !== undefined) {
    fields.push('failed_phase = ?')
    args.push(patch.failedPhase)
  }
  if (patch.integrationHeadSha !== undefined) {
    fields.push('integration_head_sha = ?')
    args.push(patch.integrationHeadSha)
  }
  if (patch.devServerUrl !== undefined) {
    fields.push('dev_server_url = ?')
    args.push(patch.devServerUrl)
  }
  if (patch.devServerPid !== undefined) {
    fields.push('dev_server_pid = ?')
    args.push(patch.devServerPid)
  }
  if (patch.previewValidated !== undefined) {
    fields.push('preview_validated = ?')
    args.push(patch.previewValidated ? 1 : 0)
  }
  if (patch.leaseOwner !== undefined) {
    fields.push('lease_owner = ?')
    args.push(patch.leaseOwner)
  }
  if (patch.leasedAt !== undefined) {
    fields.push('leased_at = ?')
    args.push(patch.leasedAt)
  }
  if (patch.leaseNote !== undefined) {
    fields.push('lease_note = ?')
    args.push(patch.leaseNote)
  }
  if (patch.currentStepName !== undefined) {
    fields.push('current_step_name = ?')
    args.push(patch.currentStepName)
  }
  if (patch.currentStepGuide !== undefined) {
    fields.push('current_step_guide = ?')
    args.push(patch.currentStepGuide)
  }
  if (patch.activityDetail !== undefined) {
    fields.push('activity_detail = ?')
    args.push(patch.activityDetail)
  }
  if (patch.failureReason !== undefined) {
    fields.push('failure_reason = ?')
    args.push(patch.failureReason)
  }
  if (patch.failureSignature !== undefined) {
    fields.push('failure_signature = ?')
    args.push(patch.failureSignature)
  } else if (patch.status === 'failed') {
    // Signature floor. Everything in the self-heal chain keys off
    // `failure_signature` — fix-recipe matching, the signature-storm streak
    // counter, the Steward's evidence brief, `isEnvironmentalSignature`
    // auto-restart — and every one of them skips a NULL, so a failure write
    // that omits the column is invisible to all of it. Several failure writers
    // (the phantom-task watchdog, the requeue ceiling, the operator-reject and
    // awaiting-validation paths) only ever wrote `failure_reason_code`.
    //
    // COALESCE, not an unconditional write: a caller-supplied signature always
    // wins (handled above), and a precise signature already on the row must
    // never be downgraded to one derived from a coarse phase.
    fields.push('failure_signature = COALESCE(failure_signature, ?)')
    args.push(deriveFailureSignature(patch))
  }
  if (patch.failureReasonCode !== undefined) {
    fields.push('failure_reason_code = ?')
    args.push(patch.failureReasonCode)
  }
  if (patch.stallDiagnostics !== undefined) {
    fields.push('stall_diagnostics = ?')
    args.push(patch.stallDiagnostics)
  }
  if (patch.recoveryPayload !== undefined) {
    fields.push('recovery_payload = ?')
    args.push(patch.recoveryPayload)
  }
  if (patch.workflow !== undefined) {
    fields.push('workflow = ?')
    args.push(patch.workflow)
  }
  if (patch.requeueAnchorMs !== undefined) {
    fields.push('requeue_anchor_ms = ?')
    args.push(patch.requeueAnchorMs)
  }
  if (patch.requeueDispatchUptimeMs !== undefined) {
    fields.push('requeue_dispatch_uptime_ms = ?')
    args.push(patch.requeueDispatchUptimeMs)
  }
  if (patch.quotaRejectedAttempts !== undefined) {
    fields.push('quota_rejected_attempts = ?')
    args.push(patch.quotaRejectedAttempts)
  }
  if (patch.envApiUnreachableAttempts !== undefined) {
    fields.push('env_api_unreachable_attempts = ?')
    args.push(patch.envApiUnreachableAttempts)
  }
  fields.push('updated_at = ?')
  args.push(new Date().toISOString())
  args.push(id)

  const isStatusChange =
    patch.status !== undefined &&
    previousStatus !== null &&
    patch.status !== previousStatus

  const appendSessionId =
    patch.claudeSessionId !== undefined &&
    patch.claudeSessionId !== null &&
    patch.claudeSessionId.length > 0

  // Build the event INSERT statements upfront (validates payload via Zod;
  // throws before any DB write if the payload is invalid).  An empty array
  // means no event should be emitted for this call (unchanged-status or
  // non-status write).  Every terminal transition (done/dropped/failed)
  // additionally emits one `task.terminal` event in the same transaction so
  // the Invalidator (alert-dismisser) has a single subscription point for
  // closing Action-queue rows; see ADR-0028/0030.
  const eventStmts: DbStatement[] = []
  if (isStatusChange) {
    if (patch.status === 'failed') {
      eventStmts.push(
        buildEventInsert('task.failed', {
          taskId: id,
          error: patch.error ?? patch.failureReason ?? '',
          // Carry the failure signature in the event payload so subscribers
          // can read it even after reopenTerminalTask NULLs the task-row field.
          failureSignature: patch.failureSignature ?? deriveFailureSignature(patch),
        }),
        buildEventInsert('task.terminal', { taskId: id, reason: 'failed' }),
      )
    } else if (patch.status === 'dropped') {
      eventStmts.push(
        buildEventInsert('task.dropped', {
          taskId: id,
          dropReason: patch.dropReason ?? patch.failureReason ?? '',
        }),
        buildEventInsert('task.terminal', { taskId: id, reason: 'dropped' }),
      )
    } else if (patch.status === 'queued') {
      eventStmts.push(buildEventInsert('task.queued', { taskId: id }))
    } else if (patch.status === 'blocked') {
      eventStmts.push(
        buildEventInsert('task.blocked', {
          taskId: id,
          fixTaskId: null,
          failureSignature: patch.failureSignature ?? '',
          failingStep: patch.failedPhase ?? '',
        }),
      )
    } else if (patch.status === 'done') {
      eventStmts.push(
        buildEventInsert('task.completed', { taskId: id, result: null }),
        buildEventInsert('task.terminal', { taskId: id, reason: 'done' }),
      )
    } else if (patch.status === 'under_investigation') {
      // Operator clicked Investigate on a stale-worktree alert. The event rides
      // the transactional outbox so the Invalidator (alert-dismisser) resolves
      // the open action-queue row on its next drain — the alert disappears from
      // the queue without any inline DB write here (ADR-0027/0030).
      eventStmts.push(buildEventInsert('task.under_investigation', { taskId: id }))
    }
  }

  // Position is MAX(position)+1 for this task, or 0 for the first session.
  // Built here (column patch + payload assembly stays in updateTask), but the
  // raw `UPDATE tasks SET … WHERE id = ?` string and the three-branch atomic
  // commit live in the Arc aggregate — the sole task-table writer (ADR-0052).
  const sessionIdStmt: DbStatement | undefined = appendSessionId
    ? {
        sql: `INSERT INTO task_claude_sessions (task_id, session_id, position)
            SELECT ?, ?,
              COALESCE(
                (SELECT MAX(position) + 1 FROM task_claude_sessions WHERE task_id = ?),
                0
              )
            ON CONFLICT (task_id, session_id) DO NOTHING`,
        args: [id, patch.claudeSessionId as string, id],
      }
    : undefined

  await Arc.applyStatusWrite({
    id,
    fields,
    args,
    eventStmts,
    store,
    appendSessionId,
    sessionIdStmt,
  })

  // Persist verifyOutput when the caller provides it (e.g. the outer catch
  // path in the verify primitive records a structural crash). Best-effort:
  // a transcript write failure must never mask the task status failure.
  if (patch.verifyOutput !== undefined && patch.verifyOutput !== null) {
    await upsertTranscript({ taskId: id, verifyOutput: patch.verifyOutput }, store).catch(
      () => {},
    )
  }

  // NOTE: Action-queue clearing on status change is NOT done inline here.
  // The Invalidator (alert-dismisser) subscribes to the task lifecycle
  // events emitted above and is the SOLE closer of Action-queue rows and
  // dismissals — see ADR-0027/0030. Clearing inline would (a) duplicate the
  // subscriber and (b) be lost for any writer that bypasses updateTask, the
  // exact staleness class this design eliminates.

  // Done-implies-merged guard: raise the action-queue item after the write so
  // it is colocated with the failure event rather than emitted speculatively.
  // Awaited but wrapped in try-catch: best-effort semantics — a raise failure
  // must never mask the task failure itself.
  if (doneWithUnmergedCommits) {
    const integration = process.env.INTEGRATION_BRANCH ?? 'main'
    try {
      await raiseActionQueueItem({
        kind: 'done-with-unmerged-commits',
        category: 'daemon',
        priority: 'urgent',
        title: `Task ${id} failed: done-with-unmerged-commits`,
        body:
          `A done transition was blocked because branch ${taskBranch} still has commits ahead ` +
          `of ${integration}. The merge step did not complete. Investigate and re-merge or restart the task.`,
        payload: { taskId: id, branch: taskBranch, integration },
        context: { taskId: id },
        raisedBy: 'queue:done-implies-merged-guard',
        signature: id,
        originTaskId: id,
      })
    } catch {
      // Best-effort: raise failure must not mask the task failure itself.
    }
  }

  if (patch.status === 'done') {
    // Best-effort: tear down any preview deployments for this task now that it
    // has successfully merged. Errors are caught and logged inside
    // teardownDeploymentsForTask — never rethrown into the caller.
    await teardownDeploymentsForTask(id)

    const dependents = store
      ? await store.query({
          sql: `SELECT DISTINCT task_id FROM task_blockers WHERE blocker_task_id = ?`,
          args: [id],
        })
      : await resolveQueueClient().execute({
          sql: `SELECT DISTINCT task_id FROM task_blockers WHERE blocker_task_id = ?`,
          args: [id],
        })
    for (const row of dependents.rows) {
      const dependentId = (row as unknown as { task_id: string }).task_id
      await Arc.promoteDraftToQueued(dependentId)
    }
  }
}

// ---------------------------------------------------------------------------
// markTaskFailed + helpers (ADR-0101: moved from queue-retry.ts to break
// arc→queue-retry cycle)
// ---------------------------------------------------------------------------

/**
 * Diagnostic evidence a terminal-failure caller can hand to
 * {@link markTaskFailed}.
 *
 * Why this exists: `markTaskFailed` used to write only `failure_reason` /
 * `failure_reason_code`. Every path that reopens a task first — the
 * recovery-spawner's `reopenTerminalTask`, `requeueOrigin`, `mars restart` —
 * NULLs `error` AND `failure_signature`, so a task that landed terminal
 * through this seam after a reopen ended up `failed` with no evidence at all.
 * Self-heal keys entirely off `failure_signature` (fix-recipe matching, the
 * signature-storm streak counter, the Steward's evidence brief,
 * `isEnvironmentalSignature` auto-restart), so those rows were invisible to
 * the whole chain.
 */
export interface FailureEvidence {
  /**
   * Real captured output from the failing command — NOT a restatement of the
   * reason. Derived status text (a `recovery_exhausted:<sig>:` chain) is
   * detected via {@link assessStormExcerpt} and never allowed to overwrite
   * captured output already on the row.
   */
  error?: string | null
  /**
   * The structured `<step>/<error-class>` signature for this failure. Defaults
   * to the `failureReasonCode`, which is itself a signature.
   */
  failureSignature?: string | null
}

/**
 * Decide what (if anything) to write to the `error` column.
 *
 * Real captured output always wins. Derived status text is written only when
 * the column is empty — where *something* beats nothing — and never on top of
 * captured output, which is the evidence-destroying overwrite that once left a
 * Steward staring at a `recovery_failed:` chain repeated to the truncation
 * limit.
 */
const resolveFailureErrorPatch = async (
  taskId: string,
  captured: string | null | undefined,
): Promise<{ error?: string }> => {
  const candidate = (captured ?? '').trim()
  if (candidate.length === 0) return {}
  if (assessStormExcerpt(candidate).usable) return { error: candidate }
  const existing = await getTask(taskId).catch(() => null)
  if ((existing?.error ?? '').trim().length > 0) return {}
  return { error: candidate }
}

/**
 * Terminal failure path. Use when a task exhausted its retry budget on a
 * real error (verify failure, blocker dependent stuck after unblock).
 * Distinct from `markTaskDropped`, which is reserved for explicit abandonment
 * (user "skip", invalid input). A `failed` task can be retried via
 * `mars restart <id>`; a `dropped` task cannot.
 */
export const markTaskFailed = async (
  taskId: string,
  reason: string,
  /**
   * Optional failure signature recorded on `failure_reason_code`. Defaults to
   * classifying `reason` under a generic `terminal` step via
   * {@link computeFailureSignature} so the column always holds a
   * `<step>/<error-class>` signature. Callers that already know the signature
   * (e.g. dispatch-time `verify:main-dirty` parking) pass it explicitly.
   */
  failureReasonCode?: string | null,
  /**
   * Optional captured output + computed signature. Callers that hold the real
   * failure evidence (every `handleTaskFailureWithFixTask` terminal branch
   * does) must pass it so the row lands with a usable `error` and a non-NULL
   * `failure_signature`. See {@link FailureEvidence}.
   */
  evidence?: FailureEvidence,
): Promise<void> => {
  const code = failureReasonCode ?? computeFailureSignature('terminal', reason)
  const errorPatch = await resolveFailureErrorPatch(taskId, evidence?.error)
  // Route the status write, paired events (task.failed + task.terminal), and
  // extra column updates through the single validated chokepoint.  An illegal
  // transition (e.g. task already 'done') throws IllegalTransitionError before
  // any DB write.
  await updateTask(taskId, {
    status: 'failed',
    failureReason: reason,
    failureReasonCode: code,
    // Omitted when the caller has no computed signature: `updateTask`'s
    // signature floor then derives a well-formed `<step>/<class>` value and
    // COALESCEs it in, so the column is never left NULL and a precise
    // signature already on the row is never downgraded.
    ...(evidence?.failureSignature != null
      ? { failureSignature: evidence.failureSignature }
      : {}),
    ...errorPatch,
  })
  // Clear outbound blocker edges through the Arc aggregate (ADR-0052 sole-writer).
  await clearBlockerEdges(getDefaultArcStoreSync(), taskId)
  // Blocking downstream queued tasks whose only path to running was this
  // failed prerequisite (Arc.blockByTaskFailure) used to happen here via a
  // dynamic `./arc` import, best-effort. That created a genuine mutual-
  // recursion cycle with arc.ts (ADR-0101 edge 3). `updateTask` above
  // already durably emits `task.terminal { taskId, reason: 'failed' }` in
  // the same transaction as the status write, so the cascade now runs from
  // `blocker-resolution.ts`'s outbox subscriber in reaction to that event
  // instead — same pattern already used for
  // `Arc.failStrandedOriginOnRecoveryFailure` on the same event.
}

// ── Arc writer port — self-registration ───────────────────────────────────
// Register the Arc implementation for the ArcWriterPort seam defined in
// lib/queue-primitives.ts.  This runs once at module-load time (a side effect
// of importing arc.ts) and breaks the queue.ts → arc.ts and task-store.ts →
// arc.ts import cycles: those modules now import `getArcWriter` (re-exported
// by queue.ts) instead of importing `Arc` from arc.ts.
const arcWriterImpl: ArcWriterPort = {
  createOrigin: (spec, store?) => Arc.createOrigin(spec, store),
  applyStatusWrite: (input) => Arc.applyStatusWrite(input),
  reopenTerminalTask: (id, reason, store?) => Arc.reopenTerminalTask(id, reason, store),
  reprioritize: (id, priority) => Arc.load(id).reprioritize(priority),
  setVerifyCmd: (id, verifyCmd) => Arc.setVerifyCmd(id, verifyCmd),
  drop: (id, store?) => Arc.load(id, store).drop(),
  insertReflection: (corpusSize, store?) => Arc.load('reflect', store).insertReflection(corpusSize),
  promoteDraftToTriaging: (taskId) => Arc.promoteDraftToTriaging(taskId),
  promoteDraftToQueued: (taskId, store?) => Arc.promoteDraftToQueued(taskId, store),
  setReviewPacket: (taskId, packet, store) => Arc.load(taskId, store).setReviewPacket(packet),
  setQaReport: (taskId, report, store) => Arc.load(taskId, store).setQaReport(report),
}
registerArcWriter(arcWriterImpl)
