/**
 * Slice F.2 / Slice 2: dispatch-time integration with the dirty-main detection helper.
 *
 * This module is a thin orchestration shim that the daemon's
 * `dispatchImplement` calls right before invoking `runWorkflow`. It
 * (1) classifies the integration branch via `classifyIntegrationDirtState`,
 * (2) on 'clean', returns false (dispatch proceeds normally),
 * (3) on 'committer-scope', looks up the `main-commiter` recipe and calls
 *     `spawnOrAttachMainCommitter` to park the task behind a recovery,
 * (4) on 'unrelated', raises a high-priority action-queue alert and returns
 *     true without inserting a fix task or task_blockers edge.
 *
 * Stays daemon-side (not workflow-side) because the daemon owns the
 * integration-branch repo root and is the right writer for the
 * recovery-task INSERT. The verify-time check ships separately, inside
 * the workflow's verify step.
 */
import { resolveContext } from '../context'
import {
  classifyIntegrationDirtState,
  MAIN_COMMITER_RECIPE,
  spawnOrAttachMainCommitter,
  type IntegrationBranchDirtyResult,
} from '../lib/main-dirty'
import {
  clearUnrelatedDirtActionQueue,
  raiseUnrelatedDirtActionQueue,
} from './main-dirty-action-queue'
import { resolveOriginIdForTask } from '../lib/origin'
import type { RecipeCatalog } from '../lib/recipes'
import type { TraceEventStore } from '../lib/trace-events-store'
import type { Task } from '../queue'

export interface MainDirtyDispatchInput {
  task: Task
  integrationBranch: string
  traceStore: TraceEventStore
  recipeCatalog: RecipeCatalog
  log: (msg: string) => void
}

/** Structured result from the dispatch-time dirty-main probe. */
export type MainDirtyDispatchResult =
  | { parked: false }
  | { parked: true; fixTaskId: string; spawned: boolean }
  | { parked: true; reason: 'unrelated-dirt'; actionQueueItemId: string }

/**
 * Run the dispatch-time dirty-main probe. Returns `{ parked: false }` when:
 * - the integration branch is clean, or
 * - the recipe is missing from the catalog (verify-time check still applies).
 *
 * Returns `{ parked: true, fixTaskId, spawned }` when the task was parked
 * behind a `main-commiter` recovery and the caller must NOT dispatch the
 * workflow. `spawned` is true only when a NEW committer was inserted; the
 * caller is responsible for emitting `task.queued` for `fixTaskId` so the
 * dispatch loop picks it up without waiting for the next daemon restart.
 *
 * Returns `{ parked: true, reason: 'unrelated-dirt', actionQueueItemId }` when
 * the dirty state cannot be resolved by a committer (ignored entries, conflicts,
 * submodule changes). An action-queue alert is raised; no fix task is inserted.
 *
 * Done committers no longer suppress parking (invariant 2): a done committer
 * proves main was clean when it verified, but if main is dirty again a fresh
 * committer must clean it. The source task is parked behind the fresh committer.
 */
export const runMainDirtyDispatchCheck = async (
  input: MainDirtyDispatchInput,
): Promise<MainDirtyDispatchResult> => {
  const { task, integrationBranch, traceStore, recipeCatalog, log } = input
  const { repoRoot } = resolveContext()
  const originId = await resolveOriginIdForTask(task.id).catch(() => task.id)

  const classifyResult = await classifyIntegrationDirtState({
    repoRoot,
    integrationBranch,
    traceCtx: {
      taskId: task.id,
      originId,
      phase: 'setup',
      store: traceStore,
    },
  })

  if (classifyResult.kind === 'clean') {
    await clearUnrelatedDirtActionQueue(integrationBranch)
    return { parked: false }
  }

  if (classifyResult.kind === 'unrelated') {
    const actionQueueItemId = await raiseUnrelatedDirtActionQueue(
      integrationBranch,
      classifyResult.contaminatedPaths,
      log,
    )
    return { parked: true, reason: 'unrelated-dirt', actionQueueItemId }
  }

  // kind === 'committer-scope': dirty files a committer can stage and commit.
  const recipe = recipeCatalog.get(MAIN_COMMITER_RECIPE)
  if (!recipe) {
    // Recipe missing means the binary was shipped without its built-in
    // file (or a broken override stripped it). With the legacy
    // `setup:preflight/dirty-main` backstop retired (slice K), there is
    // nothing to fall back to inside the workflow — the dispatch must
    // proceed and the verify-time dirty-main check (also wired to
    // `main-commiter`) will park the task. Surface a warn-level log so
    // an operator notices the broken catalog.
    log(
      `[main-dirty] dispatch-time: integration branch ${integrationBranch} is dirty for task ${task.id}, but recipe '${MAIN_COMMITER_RECIPE}' is missing from the catalog; proceeding to dispatch (verify-time check still applies)`,
    )
    return { parked: false }
  }

  const detection: IntegrationBranchDirtyResult = {
    dirty: true,
    statusOutput: classifyResult.statusOutput,
  }
  const resolution = await spawnOrAttachMainCommitter({
    sourceTaskId: task.id,
    detection,
    integrationBranch,
    dispatchPhase: 'dispatch',
    recipePrompt: recipe.prompt,
    sourceOriginId: originId,
    traceStore,
  })
  log(
    `[main-dirty] dispatch-time: task ${task.id} parked blocked on main-commiter ${resolution.fixTaskId} (${
      resolution.spawned
        ? resolution.reapedZombieCommitterId
          ? `spawned fresh, replacing zombie committer ${resolution.reapedZombieCommitterId}`
          : 'spawned fresh'
        : `attached to live committer in status=${resolution.attachedToStatus}`
    })`,
  )
  return { parked: true, fixTaskId: resolution.fixTaskId, spawned: resolution.spawned }
}
