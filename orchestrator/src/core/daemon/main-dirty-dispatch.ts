/**
 * Slice F.2: dispatch-time integration with the dirty-main detection helper.
 *
 * This module is a thin orchestration shim that the daemon's
 * `dispatchImplement` calls right before invoking `runWorkflow`. It
 * (1) probes the integration branch via `checkIntegrationBranchDirty`,
 * (2) on dirty, looks up the `main-commiter` recipe from the catalog,
 * (3) calls `spawnOrAttachMainCommitter` to either spawn a fresh
 *     recovery or attach the current task to an existing one at the
 *     same diff hash,
 * (4) returns `true` so the caller skips dispatching the workflow.
 *
 * Stays daemon-side (not workflow-side) because the daemon owns the
 * integration-branch repo root and is the right writer for the
 * recovery-task INSERT. The verify-time check ships separately, inside
 * the workflow's verify step.
 */
import { resolveContext } from '../context'
import {
  checkIntegrationBranchDirty,
  MAIN_COMMITER_RECIPE,
  spawnOrAttachMainCommitter,
} from '../lib/main-dirty'
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
  const detection = await checkIntegrationBranchDirty({
    repoRoot,
    integrationBranch,
    traceCtx: {
      taskId: task.id,
      originId,
      phase: 'setup',
      store: traceStore,
    },
  })
  if (!detection.dirty) return { parked: false }

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
        ? 'spawned fresh'
        : `attached to existing committer in status=${resolution.attachedToStatus}`
    })`,
  )
  return { parked: true, fixTaskId: resolution.fixTaskId, spawned: resolution.spawned }
}
