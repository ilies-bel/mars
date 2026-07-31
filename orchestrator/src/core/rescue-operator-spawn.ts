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

import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from './store/task-store'
import type { Task } from './queue'
import type { FixRecipeContext } from './lib/fix-recipes'
import {
  buildRescueOperatorPrompt,
  estimateRescueTriagePromptTokens,
} from './workers/rescue-operator'
import { incrementRescueAttempts } from './daemon/kpi-store.js'
import { recordStewardIntervention } from './steward-ledger'
import { raiseStewardRepeatActionQueueItem, shouldStewardFire } from './steward-guard'
import { hintDispatch } from './daemon/dispatch-hint.js'

export interface MaybeSpawnRescueOperatorInput {
  failedTask: Task
  failureSignature: string
  recipeContext?: FixRecipeContext
  store?: TaskStore
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
 *  - `queue-fix-tasks.ts` after upsertFixTask when `!hasRecipe(failureSignature)`
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

  // The rescue task itself passes through the tight-budget triage worker
  // before it reaches RescueOperator. Build its bounded, newest-first arc
  // context before incrementing the guard so an assembly failure cannot leave
  // an arc marked as rescued without a rescue task to inspect it.
  const arcMembers = await store.listArcMembers(originId)
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
  const rescueTask = await store.enqueueTask(prompt, undefined, {
    skipTriage: true,
    tags: ['rescue-operator'],
    originId,
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
