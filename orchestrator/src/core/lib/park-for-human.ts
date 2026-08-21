/**
 * The shared HITL park body: `updateTask({status: 'awaiting-human', ...})` +
 * `raiseActionQueueItem({kind: 'awaiting-human', ...})`.
 *
 * This is the ONE park body in the tree (PRD
 * ae17340a-modular-core-program-make-every-mars-mod slice 27). It was
 * extracted (follow-up 1/3, `mars-f19f0ecd`) from two call sites that
 * duplicated it verbatim — the sentinel-throw fallback in
 * `tools/human/await-human.ts` and the promise-based `onManualPark` hook in
 * `core/daemon/server.ts` — and the sentinel path was then deleted outright
 * (follow-up 3/3, `mars-9dd152c7`). Only the promise-based park remains, so
 * the `variant` discriminant that used to select between the two wordings is
 * gone too.
 *
 * Every park now goes through {@link parkTaskForHuman} and then suspends on
 * `awaitManualDone(runId, stepName)`. The daemon wraps that pair in its own
 * `onManualPark` hook (it adds lease/re-dispatch wiring); every other
 * `MarsServices` bag gets {@link defaultManualPark}, which is that pair and
 * nothing else.
 *
 * The "exactly one action-queue row + exactly one durable event" invariant
 * this body must preserve is pinned by
 * `core/lib/__tests__/unified-park.test.ts`.
 */
import { awaitManualDone } from '@mars/workflow'

import { getTask, updateTask } from '../queue'
import { type DomainTaskStore as TaskStore } from '../store/task-store'
import { raiseActionQueueItem } from './action-queue'
import { AWAIT_HUMAN_SENTINEL } from './sentinels'

export interface ParkTaskForHumanOpts {
  /** `RaiseActionQueueItem.raisedBy` — identifies the raising call site. */
  raisedBy: string
  /** Preview URL for a manual-QA row. Included in the payload when set. */
  previewUrl?: string | null
  /** Preview process log path for a manual-QA row. Included when set. */
  logPath?: string | null
}

export interface ParkTaskForHumanResult {
  leaseOwner: string
  leasedAt: string
  /** Prior human lease owner re-granted the lease, if any (else null). */
  released: string | null
}

/**
 * Park `taskId` in `'awaiting-human'` at `stepName` and raise the
 * `'awaiting-human'` action-queue row so the operator sees it.
 *
 * Auto re-lease: if the task already carries a human lease owner (not the
 * `AWAIT_HUMAN_SENTINEL` identity), that owner is re-granted the lease so a
 * Foreground session walks a manual-heavy runbook as one continuous session
 * without re-attaching. The read is best-effort — a lookup failure falls
 * through to parking under the sentinel identity.
 */
export const parkTaskForHuman = async (
  taskId: string,
  stepName: string,
  note: string | null,
  store: TaskStore,
  opts: ParkTaskForHumanOpts,
): Promise<ParkTaskForHumanResult> => {
  const now = new Date().toISOString()

  let priorOwner: string | null = null
  try {
    priorOwner = (await getTask(taskId, store))?.leaseOwner ?? null
  } catch {
    // fall through — no re-lease
  }
  const released =
    priorOwner !== null && priorOwner !== AWAIT_HUMAN_SENTINEL ? priorOwner : null
  const leaseOwner = released ?? AWAIT_HUMAN_SENTINEL

  // Transition to 'awaiting-human' through the Arc write funnel (ADR-0052).
  // Uses the same field set as Arc.parkForHuman so the task row is consistent
  // with the server's attach/release paths. current_step_name and
  // current_step_guide are written here so the daemon's handleStepDone can
  // locate the pending promise on a promise-based park (resolveManualStep).
  await updateTask(
    taskId,
    {
      status: 'awaiting-human',
      leaseOwner,
      leasedAt: now,
      leaseNote: note,
      currentStepName: stepName,
      currentStepGuide: note,
    },
    store,
  )

  const title = `Task ${taskId} parked at step '${stepName}' — awaiting human`
  const body =
    `Task ${taskId} is parked at manual step '${stepName}'.` +
    (note ? ` Step guide: ${note}.` : '') +
    ` Lease: ${leaseOwner}. Run \`mars step done ${taskId}\` to continue.`

  // Level-triggered (ADR-0048): if the daemon restarts and re-detects, it
  // bumps seen_count rather than spawning a sibling row.
  raiseActionQueueItem({
    kind: 'awaiting-human',
    category: 'daemon',
    priority: 'normal',
    title,
    body,
    payload: {
      situation: 'lease-park',
      taskId,
      leaseOwner,
      leasedAt: now,
      leaseNote: note ?? null,
      stepName,
      ...(opts.previewUrl != null ? { previewUrl: opts.previewUrl } : {}),
      ...(opts.logPath != null ? { logPath: opts.logPath } : {}),
    },
    context: { taskId },
    raisedBy: opts.raisedBy,
    signature: taskId,
    originTaskId: taskId,
    occurrence: {
      leaseOwner,
      leasedAt: now,
      parkedAt: now,
    },
  }).catch((err) => {
    console.error(`[park-for-human] task ${taskId} action-queue raise errored:`, err)
  })

  return { leaseOwner, leasedAt: now, released }
}

/**
 * The arguments every manual park is driven by — the shape of
 * `MarsServices.onManualPark`.
 */
export interface ManualParkArgs {
  /** Engine run id; the key `resolveManualStep` is later called with. */
  runId: string
  /** The task being parked. */
  taskId: string
  /** The manual step's name; the second half of the resume key. */
  stepName: string
  /** Step guide shown to the operator in the action-queue row. */
  guide: string | null
  /**
   * Preview URL for a manual-QA row (the local-preview review gate).
   * Null when no preview was started. Forwarded into the raised
   * action-queue row's payload — see `LeaseParkPayload.previewUrl`.
   */
  previewUrl?: string | null
  /**
   * Preview process log path for a manual-QA row. Null when no preview
   * was started. Forwarded into the raised row's payload — see
   * `LeaseParkPayload.logPath`.
   */
  logPath?: string | null
}

/**
 * The default `MarsServices.onManualPark`: park the task via
 * {@link parkTaskForHuman}, then suspend the step until the operator runs
 * `mars step done`, which calls `resolveManualStep(runId, stepName)`.
 *
 * This IS the park mechanism — there is no second one. The daemon binds it to
 * its own task store and layers its lease/re-dispatch wiring on top; every
 * other `MarsServices` bag (scaffolded workflows, test contexts) binds it to
 * whatever store it already has, so no call site has to invent a park.
 *
 * Bound to a store rather than reading one off `ctx` because the hook is
 * assembled with the services bag, before any ctx exists.
 */
export const createDefaultManualPark =
  (store: TaskStore) =>
  async ({ runId, taskId, stepName, guide, previewUrl, logPath }: ManualParkArgs): Promise<void> => {
    await parkTaskForHuman(taskId, stepName, guide, store, {
      raisedBy: 'primitive:manual-step',
      previewUrl,
      logPath,
    })
    return awaitManualDone(runId, stepName)
  }
