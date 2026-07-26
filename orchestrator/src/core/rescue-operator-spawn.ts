/**
 * Rescue-operator spawn module.
 *
 * Fires when an Arc has no automatic move left — either:
 *  - an origin task fails with a failure signature for which no fix recipe is
 *    registered, OR
 *  - a recovery Chore (fix_for_task_id !== null) itself fails.
 *
 * At most ONE rescue-operator task is spawned per Arc. The counter is keyed on
 * the origin task's `arc_rescue_attempts` column.
 *
 * IMPORTANT: `store.getArcRescueAttempts` / `store.incrementArcRescueAttempts`
 * are called ONLY from this module. The ordinary dispatch path (dispatch.ts and
 * its helpers deciding which queued tasks may run) does NOT read
 * `arc_rescue_attempts` — this counter is the sole domain of the rescue-operator
 * trigger and must not influence task selection logic.
 */

import { getDefaultTaskStore, type DomainTaskStore as TaskStore } from './store/task-store'
import type { Task } from './queue'
import type { FixRecipeContext } from './lib/fix-recipes'
import { buildRescueOperatorPrompt } from './workers/rescue-operator'
import { incrementRescueAttempts } from './daemon/kpi-store.js'

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
 * Idempotent per Arc: when `arc_rescue_attempts >= 1` on the origin task row,
 * returns `{ spawned: false }` without side effects.
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

  // At most one rescue-operator task per Arc. getArcRescueAttempts throws when
  // passed a fix/recovery task id — always pass the origin id resolved above.
  if ((await store.getArcRescueAttempts(originId)) >= 1) {
    return { spawned: false }
  }

  // Increment before dispatch to prevent a concurrent failure event from
  // spawning a second rescue on the same arc.
  await store.incrementArcRescueAttempts(originId)
  await incrementRescueAttempts(store)

  const prompt = buildRescueOperatorPrompt(failedTask.id, originId, failureSignature)

  const rescueTask = await store.enqueueTask(prompt, undefined, {
    tags: ['rescue-operator'],
    originId,
  })

  return { spawned: true, rescueTaskId: rescueTask.id }
}
