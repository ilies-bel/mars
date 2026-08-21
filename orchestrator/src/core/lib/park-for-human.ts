/**
 * The shared HITL park body: `updateTask({status: 'awaiting-human', ...})` +
 * `raiseActionQueueItem({kind: 'awaiting-human', ...})`.
 *
 * Extracted (PRD ae17340a-modular-core-program-make-every-mars-mod slice 27,
 * follow-up 1/3, task `mars-f19f0ecd`) from the two call sites that used to
 * duplicate this body verbatim:
 *
 *   - the sentinel-throw fallback in `tools/human/await-human.ts`
 *   - the promise-based `onManualPark` hook in `core/daemon/server.ts`
 *
 * Both still call this ONE function; only their title/body wording and
 * post-park control flow (throw vs. await a promise) differ — captured here
 * via the `variant` discriminant. No behaviour change and no dispatch-
 * mechanism change: see `await-human.ts`'s doc comment for the full
 * three-step unification plan this task is step 1 of.
 *
 * The "exactly one action-queue row + exactly one durable event" invariant
 * this body must preserve is pinned by
 * `core/lib/__tests__/unified-park.test.ts`.
 */
import { getTask, updateTask } from '../queue'
import { type DomainTaskStore as TaskStore } from '../store/task-store'
import { raiseActionQueueItem } from './action-queue'
import { AWAIT_HUMAN_SENTINEL } from './sentinels'

/** Which call site is parking — selects the title/body wording only. */
export type ParkForHumanVariant = 'sentinel' | 'promise'

export interface ParkTaskForHumanOpts {
  variant: ParkForHumanVariant
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
    opts.variant === 'sentinel'
      ? `Task ${taskId} is parked in its worktree at manual step '${stepName}'.` +
        (note ? ` Step guide: ${note}.` : '') +
        (released
          ? ` Lease re-granted to ${released} — continue in the worktree, then \`mars step done ${taskId}\`.`
          : ` Work in the worktree, then \`mars step done ${taskId}\` (or \`mars release ${taskId} --abort\` to bail).`)
      : `Task ${taskId} is parked at manual step '${stepName}'.` +
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
