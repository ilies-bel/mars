import type { EventEmitter } from 'node:events'
import { getCompositionRootClient } from '../store/task-store'
import { listTasks, updateTask } from '../queue'
import { CANCELLED_FAILURE_REASON } from '../blocker-resolution'
import { drainAlertDismissals } from './alert-dismisser'
import { drainActionQueueRepopulations } from './action-queue-repopulator'
import { drainBlockerResolution } from '../../outbox/subscribers/blocker-resolution'
import { drainRecoverySpawner, type SignatureStormTripCallback } from '../../outbox/subscribers/recovery-spawn'
import { drainRecoveryAbandoned } from '../../outbox/subscribers/recovery-abandoned'
import { drainSubthreadCloser } from '../../outbox/subscribers/subthread-closer'
import { drainArchivePrompter } from '../../outbox/subscribers/archive-prompter'
import {
  drainArcVerifier,
  type ArcVerificationDispatchResult,
} from '../../outbox/subscribers/arc-verifier-subscriber'
import {
  drainGateFixSteward,
  type GateFixStewardDispatch,
} from '../../outbox/subscribers/gate-fix-steward'
import { drainArchiveEntries } from '../archive/insert.js'
import { resolveDrainIntervalsMs } from '../config/daemon-intervals'
import { drainRecipeConversationNotices } from '../../outbox/subscribers/recipe-conversation-notice'
import {
  clearFailureConversationNoticeFlush,
  drainFailureConversationNotices,
  scheduleFailureConversationNoticeFlush,
} from '../../outbox/subscribers/failure-conversation-notices'
import {
  reclaimExcessFailedWorktrees,
  reclaimSettledWorktrees,
  sweepOrphanWorktrees,
} from './worktree-reclaim'
import type { TaskFlightTracker } from './task-flight-tracker'

/**
 * Everything a periodic outbox drain is allowed to reach for. Sibling to
 * `SweepDeps` in ./sweeps — the two are kept separate because the drains'
 * shared shape (poll the outbox, call `drainX(client, ...)`, log on error)
 * and their shared single-flight requirement (see `startDrains`) do not
 * apply to the reclamation sweeps.
 */
export interface DrainDeps {
  bus: EventEmitter
  log: (line: string) => void
  repoRoot: () => string
  /** Needed only by the blocker-resolution drain: cancel an in-flight recovery whose origin just settled done, and skip re-emitting task.queued for tasks already in flight. */
  tracker: Pick<TaskFlightTracker, 'abort' | 'isInFlight'>
  /** True while the baseline health checker considers the integration branch poisoned (recovery-spawner drain). */
  isBaselinePoisoned: () => boolean
  /** Signature-storm trip handler (recovery-spawner drain). */
  handleSignatureStorm: SignatureStormTripCallback
  /** Schedules async arc-outcome verification for a completed origin (arc-verifier drain). */
  scheduleArcVerification: (originId: string) => ArcVerificationDispatchResult
  /** Dispatches the gate-fix steward for a systemic-gate-failure event (gate-fix-steward drain). */
  runGateFixStewardDispatch: GateFixStewardDispatch
}

/**
 * One periodic outbox drain. `name` doubles as the log prefix, exactly like
 * `SweepSpec` in ./sweeps.
 */
export interface DrainSpec {
  name: string
  intervalMs: () => number
  run: (deps: DrainDeps) => Promise<void>
}

/**
 * Cadences for the drains below. Resolved once at import time — the
 * underlying env is stable for the process's lifetime and every consumer
 * here (`intervalMs`) is itself only invoked once, when `startDrains` arms
 * the interval. See `../config/daemon-intervals.ts`.
 */
const INTERVALS_MS = resolveDrainIntervalsMs()

/**
 * The daemon's periodic outbox-subscriber drains, in one list instead of a
 * run of inline `setInterval(singleFlight(...))` blocks in `server.ts`. Each
 * polls the outbox for events its subscriber cares about and applies the
 * corresponding mutation — see the individual subscriber modules for the
 * durable-cursor semantics that make a dropped tick lose no work.
 */

export const DRAINS: readonly DrainSpec[] = [
  {
    // Polls the outbox for status-transition events and clears the
    // implicated task's action-queue alert(s). Keeps the "status change
    // clears alerts" invariant whole for raw-SQL status writes that bypass
    // the updateTask chokepoint.
    name: 'alert-dismisser',
    intervalMs: () => INTERVALS_MS.alertDismisser,
    run: async ({ log }) => {
      await drainAlertDismissals(getCompositionRootClient(), log)
    },
  },
  {
    // Polls the outbox for task/proposal lifecycle events and applies the
    // corresponding action_queue_items mutations.
    name: 'action-queue-repopulator',
    intervalMs: () => INTERVALS_MS.actionQueueRepopulator,
    run: async ({ bus, log }) => {
      const { processed } = await drainActionQueueRepopulations(getCompositionRootClient(), log)
      if (processed > 0) bus.emit('view.action-queue-invalidated')
    },
  },
  {
    // Polls the outbox for task.terminal { reason: 'done' } events and
    // unblocks any dependents whose every blocker is now done.
    name: 'blocker-resolution',
    intervalMs: () => INTERVALS_MS.blockerResolution,
    run: async ({ bus, log, tracker }) => {
      const { processed } = await drainBlockerResolution(getCompositionRootClient(), log, {
        onCancelInFlightRecovery: (taskId) => {
          if (tracker.abort(taskId)) {
            void updateTask(taskId, {
              status: 'failed',
              error: 'origin succeeded; in-flight recovery cancelled',
              failureReason: CANCELLED_FAILURE_REASON,
              failureReasonCode: 'origin-succeeded-cancel',
            }).catch((err) =>
              log(`[blocker-resolution] cancel in-flight recovery ${taskId}: ${(err as Error).message}`),
            )
          }
        },
      })
      if (processed > 0) {
        const queued = await listTasks('queued')
        for (const t of queued) {
          if (!tracker.isInFlight(t.id)) bus.emit('task.queued', { taskId: t.id })
        }
      }
    },
  },
  {
    // Polls the outbox for task.failed events and spawns fix tasks for any
    // regular-task failures not yet handled — the durable backstop that
    // guarantees ADR-0061's "every regular-task failure spawns a fix" even
    // when the inline dispatch path in the verify primitive is skipped or
    // crashes.
    name: 'recovery-spawner',
    intervalMs: () => INTERVALS_MS.recoverySpawner,
    run: async ({ log, handleSignatureStorm, isBaselinePoisoned }) => {
      await drainRecoverySpawner(
        getCompositionRootClient(),
        log,
        handleSignatureStorm,
        (_taskId, failingStep) => {
          if (!isBaselinePoisoned()) return null
          if (!failingStep.startsWith('verify:')) return null
          return 'verify:poisoned-baseline'
        },
      )
    },
  },
  {
    // Polls for task.terminal { reason: 'dropped' } events on fix tasks and
    // raises a recovery-abandoned action-queue item against the origin so
    // the operator knows the recovery was manually cancelled.
    name: 'recovery-abandoned',
    intervalMs: () => INTERVALS_MS.recoveryAbandoned,
    run: async ({ log }) => {
      await drainRecoveryAbandoned(getCompositionRootClient(), log)
    },
  },
  {
    name: 'subthread-closer',
    intervalMs: () => INTERVALS_MS.subthreadCloser,
    run: async ({ bus, log }) => {
      const { processed } = await drainSubthreadCloser(getCompositionRootClient(), log)
      if (processed > 0) bus.emit('view.chat-invalidated')
    },
  },
  {
    name: 'archive-prompter',
    intervalMs: () => INTERVALS_MS.archivePrompter,
    run: async ({ bus, log }) => {
      const { processed } = await drainArchivePrompter(getCompositionRootClient(), log)
      if (processed > 0) bus.emit('view.chat-invalidated')
    },
  },
  {
    name: 'recipe-conversation-notice',
    intervalMs: () => INTERVALS_MS.recipeConversationNotice,
    run: async ({ log }) => {
      await drainRecipeConversationNotices(getCompositionRootClient(), log)
    },
  },
  {
    // Polling picks up durable outbox events written by another process; the
    // scheduler still flushes each batch at its exact opened_at deadline —
    // scheduleFailureConversationNoticeFlush re-arms that per-tick.
    name: 'failure-conversation-notices',
    intervalMs: () => INTERVALS_MS.failureConversationNotice,
    run: async ({ log }) => {
      await drainFailureConversationNotices(getCompositionRootClient(), Date.now, log)
      await scheduleFailureConversationNoticeFlush(getCompositionRootClient(), log)
    },
  },
  {
    // Polls the outbox for task.terminal { reason: 'done' } events and
    // triggers arc-outcome verification for any arc that has fully completed
    // with merged commits. Fire-and-forget: the verifier runs asynchronously
    // and never blocks the merge path or dispatch loop.
    name: 'arc-verifier',
    intervalMs: () => INTERVALS_MS.arcVerifier,
    run: async ({ log, scheduleArcVerification }) => {
      await drainArcVerifier(getCompositionRootClient(), scheduleArcVerification, log)
    },
  },
  {
    // Polls the outbox for action-queue.resolved and task.terminal { reason:
    // 'done' } events and inserts archive_entries. Insertion is always
    // silent.
    name: 'archive-entries',
    intervalMs: () => INTERVALS_MS.archiveEntries,
    run: async () => {
      await drainArchiveEntries(getCompositionRootClient())
    },
  },
  {
    // Periodic cleanup of `.mars/worktrees/`. Three sweeps per tick:
    // settled (done/dropped), orphan dirs, excess failed. The 2026-07
    // incident showed 287 GB accumulated unnoticed because nothing ever
    // reclaimed them; this drain prevents new accumulation between boots.
    name: 'worktree-reclaim',
    intervalMs: () => INTERVALS_MS.worktreeReclaim,
    run: async ({ log, repoRoot }) => {
      const recRoot = repoRoot()
      const orphan = await sweepOrphanWorktrees(recRoot, log)
      if (orphan.removed.length > 0)
        log(`[worktree-reclaim] periodic: removed ${orphan.removed.length} orphan dir(s)`)

      const settled = await reclaimSettledWorktrees(recRoot, log)
      if (settled.removed.length > 0)
        log(`[worktree-reclaim] periodic: removed ${settled.removed.length} settled worktree(s)`)

      const cap = await reclaimExcessFailedWorktrees(recRoot, log)
      if (cap.removed.length > 0)
        log(`[worktree-reclaim] periodic: removed ${cap.removed.length} excess failed worktree(s)`)
    },
  },
  {
    name: 'gate-fix-steward',
    intervalMs: () => INTERVALS_MS.gateFixSteward,
    run: async ({ log, runGateFixStewardDispatch }) => {
      await drainGateFixSteward(
        getCompositionRootClient(),
        runGateFixStewardDispatch,
        undefined,
        log,
      )
    },
  },
]

export interface DrainsHandle {
  /** Clears every drain interval and the failure-conversation flush timer. */
  stop: () => void
}

/**
 * Every drain below runs on a `setInterval` whose body can outlast its own
 * period (a drain awaits provider calls and verify commands, each of which
 * can take minutes). Unguarded, each tick would stack another concurrent
 * drain of the SAME subscriber on top of the last — `drainWithStall` runs
 * the handler BEFORE claiming the `subscriber_processed_events` row, so
 * concurrent drains all pass the "already processed?" check and all execute
 * the side effect; only the bookkeeping is deduped, not the work. Ticks
 * arriving while a drain is in flight are DROPPED, not queued: a drain
 * always resumes from the durable cursor, so a skipped tick loses no work.
 */
export const startDrains = (deps: DrainDeps): DrainsHandle => {
  const handles = DRAINS.map((spec) => {
    let running = false
    const tick = () => {
      if (running) return
      running = true
      void spec
        .run(deps)
        .catch((err: unknown) => {
          deps.log(`[${spec.name}] drain errored: ${(err as Error).message}`)
        })
        .finally(() => {
          running = false
        })
    }
    const handle = setInterval(tick, spec.intervalMs())
    handle.unref()
    return handle
  })
  return {
    stop: () => {
      for (const handle of handles) clearInterval(handle)
      clearFailureConversationNoticeFlush(getCompositionRootClient())
    },
  }
}
