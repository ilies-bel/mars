/**
 * Rescue-operator spawn module.
 *
 * Fires when an Arc has no automatic move left — either:
 *  - an origin task fails with a failure signature for which no fix recipe is
 *    registered, OR
 *  - a recovery Chore (fix_for_task_id !== null) itself fails.
 *
 * At most ONE rescue-operator task is spawned per Arc. A durable counter is
 * keyed by the Arc's text origin id, so task-id and proposal-slug arcs share
 * the same invariant.
 *
 * A rescue only fires when the Arc has nothing else moving. Three early exits
 * run BEFORE the counter is claimed, so a declined spawn never consumes the
 * Arc's one rescue: the origin is already `done`, the Arc already has an
 * in-flight recovery task, or the supersession checker finds the work already
 * on the integration branch.
 *
 * IMPORTANT: `store.getArcRescueAttempts` / `store.incrementArcRescueAttempts`
 * are called ONLY from this module. The ordinary dispatch path (dispatch.ts and
 * its helpers deciding which queued tasks may run) does NOT read
 * `arc_rescue_attempts` — this counter is the sole domain of the rescue-operator
 * trigger and must not influence task selection logic.
 *
 * A spawned rescue task is autonomous work, not a draft awaiting a human: its
 * prompt instructs the agent to "choose and execute exactly one of the three
 * permitted actions". It must therefore be *runnable* the moment it is created,
 * takes both halves of the enqueue below — `skipTriage` for the persisted
 * status, and `hintDispatch` for the in-memory scheduling. Omitting either one
 * strands the row (see the comments at each call).
 */

/**
 * The tag applied to every rescue-operator task. Used by the dispatch loop and
 * blocker-resolution subscriber to identify rescue tasks when checking whether
 * a stale recovery should be cancelled after its origin reaches `done`.
 */
export const RESCUE_OPERATOR_TAG = 'rescue-operator' as const

import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from './store/task-store'
import { IN_FLIGHT_RECOVERY_STATUSES, type Task } from './queue'
import type { FixRecipeContext } from './lib/fix-recipes'
import {
  buildRescueOperatorPrompt,
  estimateRescueTriagePromptTokens,
} from './workers/rescue-operator'
import { incrementRescueAttempts } from './daemon/kpi-store.js'
import { recordStewardIntervention } from './steward-ledger'
import { raiseStewardRepeatActionQueueItem, shouldStewardFire } from './steward-guard'
import { hintDispatch } from './daemon/dispatch-hint.js'
import { raiseActionQueueItem } from './lib/action-queue'

/**
 * Result of a supersession check: whether the arc's intent is already
 * satisfied on the integration branch.
 */
export type SupersessionCheckResult =
  | { superseded: false }
  | { superseded: true; sha: string }

/**
 * Injectable supersession checker. Receives the arc's origin id and returns
 * whether the arc's intent has already been implemented on main.
 *
 * The default production implementation compares the task prompt against
 * `git log <merge-base>..main` using a cheap model. Tests inject a stub.
 */
export type SupersessionChecker = (originId: string) => Promise<SupersessionCheckResult>

export interface MaybeSpawnRescueOperatorInput {
  failedTask: Task
  failureSignature: string
  recipeContext?: FixRecipeContext
  store?: TaskStore
  /**
   * Optional supersession checker. When provided, it is called before
   * spawning a rescue-operator task. If it signals the arc's intent is
   * already implemented on main, the origin task is dropped with a
   * `superseded-by:<sha>` reason and one action-queue row is raised for
   * the operator instead of spawning a rescue.
   *
   * Best-effort: a checker error does not block the rescue path.
   */
  supersessionChecker?: SupersessionChecker
}

export interface MaybeSpawnRescueOperatorResult {
  spawned: boolean
  rescueTaskId?: string
}

/**
 * Enqueues a rescue-operator agent task when an Arc has no automatic move left.
 *
 * Idempotent per Arc: when the durable `arc_rescue_attempts` counter is already
 * at least one, returns `{ spawned: false }` without side effects.
 *
 * Call sites:
 *  - `queue-fix-tasks.ts` recovery-chore-failed branch (`task.fixForTaskId !== null`)
 *
 * (The no-recipe path in `queue-fix-tasks.ts`, after `upsertFixTask`, used to
 * call this too, but that call was guaranteed dead: `upsertFixTask` always
 * leaves an in-flight fix task visible to `listArcMembers(originId)`, which
 * this function's in-flight-recovery guard below always matches. Removed —
 * see the comment left in its place in `queue-fix-tasks.ts`.)
 *
 * No other code path should call `store.getArcRescueAttempts` or
 * `store.incrementArcRescueAttempts`.
 */
export const maybeSpawnRescueOperator = async (
  input: MaybeSpawnRescueOperatorInput,
): Promise<MaybeSpawnRescueOperatorResult> => {
  const { failedTask, failureSignature } = input
  const store = input.store ?? (await getDefaultTaskStore())

  // `Task.originId` is always populated (rowToTask falls back to the task's own
  // id when the origin_id column is null). For a recovery Chore, originId is the
  // root origin task's id; for a root origin task, it is the task's own id.
  const originId = failedTask.originId

  // Origin-done early exit: if the task that actually mattered here is
  // already terminal `done`, the work that was failing has completed on its
  // own (e.g. via auto-remerge or a concurrent task). Spawning a rescue is
  // pointless — the agent would enter a clean worktree, find nothing to do,
  // and dead-end into an awaiting-human row (observed 2026-08-17: recovery
  // fix-fc05f779 / rescue mars-a6f6fd91 / origin mars-2eb61bfd). Drop
  // silently without claiming the arc-rescue counter or raising any
  // action-queue row.
  //
  // For a recovery Chore (`fixForTaskId !== null`), the task worth checking
  // is the one it was created to fix, NOT `originId` — in a fan-out/
  // proposal-slug Arc, `originId` is the Arc's synthetic root id shared by
  // every member and never resolves to a task row, so checking it silently
  // no-ops and an already-resolved recovery Chore respawns a rescue every
  // time it fails (observed 2026-08-21: fix-c92bb4e6's fix target
  // mars-10a58ad1 reached `done` independently at 02:02, but the recovery
  // Chore's own failure at 02:18 still spawned rescue mars-fa61295d because
  // `store.getTask(originId)` looked up the proposal-slug Arc root instead
  // of mars-10a58ad1, and the rescue agent dead-ended into empty-diff
  // failures twice more before this fix).
  {
    const targetTaskId = failedTask.fixForTaskId ?? originId
    const targetTask = await store.getTask(targetTaskId)
    if (targetTask?.status === 'done') {
      // eslint-disable-next-line no-console
      console.info(
        `[rescue-operator] arc ${originId} target ${targetTaskId} already done — rescue superseded, not spawning`,
      )
      return { spawned: false }
    }
  }

  // In-flight-recovery early exit: if the arc already has a non-terminal
  // recovery/fix task (kind='fix', i.e. `fixForTaskId !== null`), a rescue is
  // redundant — its only permitted actions (restart/continue) are refused by
  // the very in-flight-recovery guard those verbs already carry, so the
  // rescue agent can only ever no-op (observed 2026-08-17:
  // RESCUE-mars-3dcef8b5.md — fix-6b227c76 was already running when the
  // rescue spawned; the rescue's own `mars continue` confirmed the correct
  // corrective action was already underway and made no further mutation).
  // Fetched once here and reused below for prompt assembly so this does not
  // cost a second query. Deliberately placed BEFORE `incrementArcRescueAttempts`
  // so a skipped spawn does not consume the arc's one-rescue-per-arc budget —
  // if the in-flight recovery later fails, the arc is still eligible for its
  // one genuine rescue.
  const arcMembers = await store.listArcMembers(originId)
  const inFlightRecovery = arcMembers.find(
    (member) =>
      member.fixForTaskId !== null && IN_FLIGHT_RECOVERY_STATUSES.includes(member.status),
  )
  if (inFlightRecovery) {
    // eslint-disable-next-line no-console
    console.info(
      `[rescue-operator] arc ${originId} has in-flight recovery ${inFlightRecovery.id} ` +
        `(status=${inFlightRecovery.status}) — rescue redundant, not spawning`,
    )
    return { spawned: false }
  }

  const stewardTarget = {
    kind: 'arc',
    id: originId,
    version: failureSignature,
  }
  const stewardDecision = await shouldStewardFire(stewardTarget)
  if (!stewardDecision.fire) {
    await raiseStewardRepeatActionQueueItem(stewardTarget, stewardDecision.reason)
    return { spawned: false }
  }

  // At most one rescue-operator task per Arc. getArcRescueAttempts throws when
  // passed a fix/recovery task id — always pass the origin id resolved above.
  if ((await store.getArcRescueAttempts(originId)) >= 1) {
    return { spawned: false }
  }

  // Supersession check: before spawning a rescue, verify the arc's intent was
  // not already implemented on main while this arc was failing. When a checker
  // is provided and confirms supersession, the origin is dropped rather than
  // rescued and the operator receives one action-queue row to review.
  // Best-effort: a checker error must not block the rescue path.
  if (input.supersessionChecker) {
    try {
      const checkResult = await input.supersessionChecker(originId)
      if (checkResult.superseded) {
        const supersededReason = `superseded-by:${checkResult.sha}`
        await store.updateTask(originId, {
          status: 'dropped',
          failureReason: supersededReason,
          failureReasonCode: supersededReason,
        })
        await store.clearBlockers(originId)
        await raiseActionQueueItem({
          kind: 'arc-superseded-on-main',
          category: 'orchestrator',
          priority: 'high',
          title: `Arc ${originId} superseded: intent already on main`,
          body:
            `The dead-ended arc ${originId} was not rescued because commit ` +
            `${checkResult.sha} on main already satisfies its intent. ` +
            `The origin has been dropped as '${supersededReason}'.`,
          payload: { originId, supersededBySha: checkResult.sha },
          context: { repoRoot: process.env.MARS_REPO ?? null },
          raisedBy: 'rescue-operator:supersession-check',
          signature: `arc-superseded:${originId}`,
          originTaskId: originId,
          occurrence: {
            at: new Date().toISOString(),
            originId,
            supersededBySha: checkResult.sha,
          },
        })
        console.info(
          `[rescue-operator] arc ${originId} already satisfied on main at ${checkResult.sha} — dropped, no rescue`,
        )
        return { spawned: false }
      }
    } catch (supersessionErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[rescue-operator] supersession check failed (non-fatal), proceeding with rescue:',
        supersessionErr,
      )
    }
  }

  // The rescue task itself passes through the tight-budget triage worker
  // before it reaches RescueOperator. Build its bounded, newest-first arc
  // context before incrementing the guard so an assembly failure cannot leave
  // an arc marked as rescued without a rescue task to inspect it. Reuses the
  // `arcMembers` fetched above for the in-flight-recovery check rather than
  // querying the store a second time.
  if (!arcMembers.some((task) => task.id === failedTask.id)) arcMembers.push(failedTask)
  const prompt = buildRescueOperatorPrompt({
    failedTaskId: failedTask.id,
    originId,
    failureSignature,
    arcMembers,
  })
  console.info(
    `[rescue-operator] assembled triage prompt for arc ${originId}: ` +
      `${estimateRescueTriagePromptTokens(prompt)} estimated tokens, ${arcMembers.length} arc members`,
  )

  // Increment before dispatch to claim the Arc atomically. Two concurrent
  // failures can both observe zero above, but only the caller that receives
  // attempt 1 may enqueue; the durable counter never reopens after a rescue
  // later fails or is dropped.
  if ((await store.incrementArcRescueAttempts(originId)) !== 1) {
    return { spawned: false }
  }
  await incrementRescueAttempts(store)

  // `skipTriage: true` lands the row directly in `'queued'` instead of
  // `'draft'`. This matches every other machine-generated task the orchestrator
  // enqueues from inside its own process (recovery fix tasks in
  // `Arc.spawnRecovery`, diagnose follow-ups, gate-enrichment writer drafts,
  // force-purge compensations) and is load-bearing, not cosmetic:
  //
  //  - Triage is an LLM readiness check for human free prose. A rescue prompt is
  //    machine-generated, fully specified, and unconditionally actionable — the
  //    call is pure cost, and an `actionable: false` verdict would strand it.
  //  - More importantly, nothing surfaces a `'draft'` row for triage from inside
  //    the daemon. The two producers of the triage pending set are the
  //    `task.added` bus emit (fired only by the `add` RPC handler, i.e. `mars
  //    task add`) and the poll-fallback tick, which is gated on the daemon being
  //    completely idle (`tracker.inFlightCount() > 0` returns early). A rescue
  //    task is spawned precisely when the daemon is busy failing tasks, so it
  //    never got triaged and stranded in `'draft'` forever.
  //
  // Queued rows, by contrast, are re-seeded by the boot reconciler, the
  // blocker-resolution drain, and the poll-fallback — the same treatment the
  // recovery fix tasks this module sits beside already rely on.
  // `workflow: 'report'` routes the rescue task through the read-only report
  // pipeline (setup -> code -> finalize; no verify, no merge — see
  // `.mars/workflows/report-workflow.js` / ADR-0056) instead of the default
  // implement pipeline. A rescue-operator's deliverable is a JSON verdict plus
  // whatever `mars restart`/`mars continue`/`mars task add --supersede` it ran
  // against the ARC it is rescuing — never a commit on ITS OWN branch (its
  // denied-tools list forbids `git commit` outright, see
  // RESCUE_OPERATOR_DENIED_TOOLS). Dispatching it through the coder/implement
  // pipeline forced it through an unrelated verify gate (e.g. a project-wide
  // `npm run knip`) and a hard "commit before you exit" contract it has no way
  // to satisfy legitimately — observed on fix-97ffa41d, where the only way to
  // reach a green exit was to physically carry the arc's branch forward
  // instead of executing one of its three permitted verbs.
  const rescueTask = await store.enqueueTask(prompt, undefined, {
    skipTriage: true,
    tags: [RESCUE_OPERATOR_TAG],
    originId,
    workflow: 'report',
  })
  await recordStewardIntervention({
    targetKind: 'arc',
    targetId: originId,
    targetVersion: failureSignature,
    recipeId: 'rescue-operator',
    rationale: `No automatic recovery remained after ${failedTask.id} failed.`,
    outcome: 'rescue-operator-enqueued',
  })

  // Register the row with the daemon's dispatch loop NOW. `enqueueTask` only
  // writes the database; the loop picks work from an in-memory pending set that
  // nothing here can reach directly. Without this the task waited for the
  // `reseed-dispatch` reconciler — which runs once, at daemon startup — so on a
  // long-running daemon it was scheduled only by a restart. A rescue is spawned
  // precisely when the daemon is busy failing tasks, so that wait was unbounded.
  //
  // No-op outside the daemon process (CLI, tests). See daemon/dispatch-hint.ts.
  hintDispatch(rescueTask.id, 'implement')

  return { spawned: true, rescueTaskId: rescueTask.id }
}
