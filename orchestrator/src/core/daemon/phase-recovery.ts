/**
 * phase-recovery — the single deep recovery loop shared by the three
 * requeue-style startup reconcilers.
 *
 * Startup reconciliation used to carry three independent copies of the same
 * shape: scan tasks stuck in an in-flight status (`verifying` / `merging` /
 * `running`) from a prior daemon, probe whether the work survived, then
 * `updateTask` each one to `queued` (re-run from a clean setup), `blocked`
 * (incomplete blockers survived), `done` (the merge already landed), or
 * `failed` (the worktree is gone and there is nothing to resume). The bodies
 * were near-identical; the only real differences are *which status to scan*,
 * *what probe decides recoverability*, and a handful of per-phase quirks
 * (whether to emit `task.queued`, what the missing-worktree terminal outcome
 * is). Those differences are captured in {@link PHASE_POLICY} below; the loop
 * itself lives once in {@link recoverPhase}.
 *
 * This is a pure refactor: behaviour is byte-for-byte equivalent to the three
 * originals per phase. In particular every `updateTask` is wrapped in
 * `.catch(() => {})` exactly as before — a single failed row must not abort
 * the pass — and `retryCount` is never touched (a daemon restart is not a
 * task fault and must not burn a retry-budget slot).
 *
 * The dynamic `import(...)` calls are preserved from the inline steps: they
 * keep startup-reconcile's lazy-load behaviour so callers that never reach a
 * recovery phase (e.g. the standalone `mars sync` path) don't pull git/fs
 * machinery into their module graph.
 */

import type { EventEmitter } from 'node:events'
import { hasIncompleteBlockers, listTasks, updateTask, type Task } from '../queue'

/** The three in-flight statuses that a prior daemon can strand a task in. */
export type RecoverablePhase = 'verifying' | 'merging' | 'running'

/**
 * What {@link recoverPhase} did in one pass. Counts feed the reconciler
 * summary fields; `requeued` carries the ids so `reconcile-running` can
 * reconstruct its `Promise<string[]>` contract.
 */
export interface PhaseRecoveryResult {
  /** Ids flipped to `queued` (re-run from setup). */
  requeued: string[]
  /** Count flipped to `blocked` (incomplete blockers survived). */
  blocked: number
  /** Count flipped to `failed` (verifying with a missing worktree). */
  failed: number
  /** Count finalized to `done` (merging whose FF already landed). */
  finalized: number
}

/** What a phase does with a task once the probe has classified it. */
interface PhasePolicy {
  /** The task status to scan with `listTasks`. */
  status: RecoverablePhase
  /**
   * Decide whether the surviving worktree makes the task *recoverable*
   * (re-run from setup) vs needing a terminal outcome. Returns:
   *  - `'recover'` — clear worktree/branch and re-queue (or restore to blocked);
   *  - `'finalize'` — the work already landed; finalize to `done` (merging);
   *  - `'fail'` — nothing to resume; mark `failed` (verifying, missing worktree).
   * `null` means "no probe — always recover" (running).
   */
  classify:
    | ((t: Task, ctx: ProbeCtx) => Promise<'recover' | 'finalize' | 'fail'>)
    | null
  /** Emit `bus.emit('task.queued', …)` when a task is re-queued. */
  emitOnRequeue: boolean
  /** Log line for the re-queue (clear-worktree) path. */
  requeueLog: (t: Task) => string
  /** Log line for the restore-to-blocked path. */
  blockedLog: (t: Task) => string
}

/** Probe helpers handed to a policy's `classify`, lazily imported once per pass. */
interface ProbeCtx {
  exists: (p: string) => boolean
  isBranchMergedIntoMain: (branch: string, repoRoot: string) => Promise<boolean>
  repoRoot: string
}

const PHASE_POLICY: Record<RecoverablePhase, PhasePolicy> = {
  verifying: {
    status: 'verifying',
    // The prior daemon ran this task but the engine run has no checkpoint
    // rows to resume from. If the worktree survives, clear it and re-run from
    // setup (mirroring the merging not-landed path); if it is gone there is
    // nothing to resume, so the task fails.
    classify: async (t, { exists }) =>
      t.branch && t.worktreePath && exists(t.worktreePath) ? 'recover' : 'fail',
    emitOnRequeue: true,
    requeueLog: (t) =>
      `[reconcile] task ${t.id} was verifying; clearing worktree and re-queuing from setup`,
    blockedLog: (t) =>
      `[reconcile] task ${t.id} was verifying; has incomplete blockers, restored to blocked`,
  },
  merging: {
    status: 'merging',
    classify: async (t, { isBranchMergedIntoMain, repoRoot }) => {
      const branch = t.branch ?? `task/${t.id}`
      const landed = await isBranchMergedIntoMain(branch, repoRoot).catch(() => false)
      return landed ? 'finalize' : 'recover'
    },
    emitOnRequeue: true,
    requeueLog: (t) =>
      `[reconcile] task ${t.id} was merging; FF not landed, requeued from setup`,
    blockedLog: (t) =>
      `[reconcile] task ${t.id} was merging; FF not landed, has incomplete blockers, restored to blocked`,
  },
  running: {
    status: 'running',
    // A daemon restart is not a task fault: there is no probe and no terminal
    // outcome. Always discard the stale worktree/branch and re-run from setup
    // (or restore to blocked if incomplete blockers survived).
    classify: null,
    emitOnRequeue: false,
    requeueLog: () => '',
    blockedLog: () => '',
  },
}

/**
 * Options for {@link recoverPhase}. `log`/`bus` come from `ReconcileDeps`;
 * `repoRoot` is the repo to run git against. `requeueLog`/`blockedLog` default
 * from the policy but `running` drives its own logging at the call site (the
 * `requeue-stale-running` reconciler logs *after* the requeue, per id), so it
 * passes `silent: true` to suppress the in-loop log lines.
 */
export interface RecoverPhaseOptions {
  log: (line: string) => void
  bus: Pick<EventEmitter, 'emit'>
  repoRoot: string
  /** Suppress the in-loop requeue/blocked log lines (running drives its own). */
  silent?: boolean
}

/** The cleared-in-flight patch applied on both requeue and restore-to-blocked. */
const CLEARED_INFLIGHT = {
  branch: null,
  worktreePath: null,
  claudeSessionId: null,
  error: null,
  failedPhase: null,
} as const

/**
 * The transient-only patch — applied when the worktree is still on disk and
 * we want to preserve `branch`/`worktreePath` for a clean engine resume.
 * Clearing only the session / error metadata is enough; the checkpoint-resume
 * logic will skip the already-completed setup step and continue from the
 * correct next step without touching the live worktree.
 */
const CLEARED_TRANSIENT = {
  claudeSessionId: null,
  error: null,
  failedPhase: null,
} as const

/**
 * Run the full scan → probe → requeue/block/finalize/fail loop for one phase.
 *
 * The shared body:
 *  1. `listTasks(policy.status)` — every task stranded in this in-flight phase.
 *  2. `policy.classify` — probe the surviving state (worktree / FF-landed);
 *     `null` classify means "always recover".
 *  3. Terminal outcomes:
 *     - `fail`  (verifying, missing worktree): best-effort worktree-registration
 *       cleanup that KEEPS the branch, then `updateTask(failed)` with the
 *       verify failure contract.
 *     - `finalize` (merging, FF landed): remove the surviving worktree, then
 *       `updateTask(done)`.
 *  4. Recover path (recover/always): remove the surviving worktree, delete the
 *     branch, then gate on `hasIncompleteBlockers` — restore to `blocked` if
 *     any survive, else `queued` (+ optional `task.queued` emit) and record the
 *     id in `requeued`.
 *
 * Every `updateTask` is `.catch(() => {})`-swallowed; `retryCount` is never
 * written. Returns the per-pass counts and the requeued ids.
 */
export const recoverPhase = async (
  phase: RecoverablePhase,
  opts: RecoverPhaseOptions,
): Promise<PhaseRecoveryResult> => {
  const policy = PHASE_POLICY[phase]
  const { log, bus, repoRoot, silent = false } = opts

  const { existsSync: exists } = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const { removeWorktree } = await import('../lib/git/worktree')
  const { isBranchMergedIntoMain } = await import('../lib/git/merge')

  const probeCtx: ProbeCtx = { exists, isBranchMergedIntoMain, repoRoot }

  const result: PhaseRecoveryResult = {
    requeued: [],
    blocked: 0,
    failed: 0,
    finalized: 0,
  }

  const tasks = await listTasks(policy.status)
  for (const t of tasks) {
    const verdict = policy.classify
      ? await policy.classify(t, probeCtx)
      : 'recover'

    if (verdict === 'fail') {
      // verifying: the worktree is gone — nothing to resume, mark failed.
      log(`[reconcile] task ${t.id} was verifying; worktree missing, marking failed`)
      if (t.worktreePath) {
        const branch = t.branch ?? `task/${t.id}`
        try {
          // force=true, keepBranch=true: tear down only the stale registration.
          await removeWorktree({ path: t.worktreePath, branch }, true, true)
          log(`[reconcile] removed stale worktree registration for ${t.id} at ${t.worktreePath}`)
        } catch {
          log(`[reconcile] worktree cleanup skipped for ${t.id}: not registered or already removed`)
        }
      }
      await updateTask(t.id, {
        status: 'failed',
        error: 'daemon restart while task was verifying; worktree missing',
        failedPhase: 'verify',
        failureReason: 'daemon restart while task was verifying; worktree missing',
        failureReasonCode: 'unknown',
      }).catch(() => {})
      result.failed++
      continue
    }

    if (verdict === 'finalize') {
      // merging: the FF already landed — finalize to done, drop the worktree.
      const branch = t.branch ?? `task/${t.id}`
      log(`[reconcile] task ${t.id} was merging; FF already landed, finalized to done`)
      if (t.worktreePath && exists(t.worktreePath)) {
        await removeWorktree({ path: t.worktreePath, branch }, true).catch(() => {})
      }
      await updateTask(t.id, {
        status: 'done',
        failedPhase: null,
        error: null,
      }).catch(() => {})
      result.finalized++
      continue
    }

    // recover: if the worktree still exists on disk, preserve it and its git
    // pointers so the checkpoint-resume engine can re-enter at the correct step
    // without re-running setup. If the worktree is gone, delete the branch and
    // the step checkpoints so the next dispatch re-runs setup from scratch —
    // a stale "setup: completed" checkpoint against a missing worktree is the
    // root cause of the 2026-07-02 re-queue loop (see mars-c11be862 post-mortem).
    //
    // Exception: if the worktree is on disk but the workflow run is terminal
    // failed, the step checkpoints are stale (e.g. setup and code completed but
    // verify failed with "working directory no longer exists"). Treating the
    // worktree as if it were gone forces a checkpoint-clear and fresh setup,
    // breaking the re-queue loop for stale verifier tasks after a daemon restart.
    const branch = t.branch ?? `task/${t.id}`
    // Whether the worktree is physically on disk (not just stored in DB).
    const worktreePhysicallyPresent = t.worktreePath != null && exists(t.worktreePath)
    let worktreeOnDisk = worktreePhysicallyPresent

    if (worktreeOnDisk) {
      // Worktree survived the daemon restart — check if the durable workflow
      // run is terminal failed. If so the step checkpoints are stale and
      // checkpoint-resume would re-enter at the failed step (e.g. verify)
      // against a bad environment. Treat as worktree-gone so setup runs fresh.
      const { createQueueWorkflowStore } = await import(
        '../../workflows/queue-workflow-store'
      )
      const run = await createQueueWorkflowStore().getRun(t.id).catch(() => undefined)
      if (run?.status === 'failed') {
        worktreeOnDisk = false
      }
    }

    if (worktreeOnDisk) {
      // Worktree survived and run is resumable — keep it and its branch intact.
      // Only clear transient fields (session id, error, failedPhase) so the
      // next run picks up from the right step with a fresh Claude session.
    } else {
      // Worktree is gone (or physically present but its run is terminal failed
      // so we treat it as gone). Delete the directory if it is on disk, then
      // let the commits-ahead guard below own the branch lifecycle — we pass
      // keepBranch=true so removeWorktree only removes the directory and does
      // not race the guard by also deleting the branch ref.
      if (t.worktreePath) {
        await removeWorktree(
          { path: t.worktreePath, branch },
          true,
          worktreePhysicallyPresent, // keepBranch=true only when dir exists
        ).catch(() => {})
      }
      // Guard: only delete the branch if it has no unmerged commits. A branch
      // whose tip is ahead of the integration branch holds work product —
      // preserve the ref and raise an action-queue row instead of deleting.
      const { listUniqueCommitsAhead } = await import('../lib/sweep')
      // Inline the integration-branch resolution to avoid pulling blocker-resolution
      // into the import chain here (its transitive deps can race with the queue
      // singleton during startup reconciliation).
      const integrationBranch = process.env.INTEGRATION_BRANCH ?? 'main'
      const commitsAhead = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot)
      if (commitsAhead.length > 0) {
        log(
          `[reconcile] PRESERVING branch ${branch} for task ${t.id}: ` +
            `${commitsAhead.length} unmerged commit(s) ahead of ${integrationBranch} — ` +
            `branch NOT deleted during phase-recovery. ` +
            `Use 'mars purge --force ${t.id}' to remove explicitly.`,
        )
        // Raise an action-queue item so the operator knows about the preserved branch.
        // Best-effort: a failure here must not block the phase-recovery loop.
        const { raiseActionQueueItem } = await import('../lib/action-queue')
        await raiseActionQueueItem({
          kind: 'worktree-ahead',
          category: 'orchestrator',
          priority: 'high',
          title: `Branch ${branch} has ${commitsAhead.length} unmerged commit(s) — preserved by phase-recovery`,
          body:
            `Task ${t.id} was recovered after a daemon restart, but its branch ${branch} ` +
            `has ${commitsAhead.length} commit(s) ahead of ${integrationBranch}. ` +
            `The branch has been preserved to avoid losing committed work.\n\n` +
            `Resolve manually: inspect the commits and either cherry-pick them onto ` +
            `${integrationBranch} or remove with 'mars purge --force ${t.id}'.\n\n` +
            `Commits:\n` +
            commitsAhead.map((c) => `  ${c.shortSha} ${c.subject}`).join('\n'),
          payload: { taskId: t.id, branch, integrationBranch, commitsAhead },
          context: { repoRoot },
          raisedBy: 'phase-recovery',
          signature: `phase-recovery-ahead:${t.id}`,
          originTaskId: t.id,
        }).catch(() => {}) // best-effort
      } else {
        await exec('git', ['branch', '-D', branch], { cwd: repoRoot }).catch(() => {})
      }
      const { createQueueWorkflowStore } = await import(
        '../../workflows/queue-workflow-store'
      )
      await createQueueWorkflowStore().deleteRun(t.id).catch(() => {})
    }

    // Preserve branch/worktreePath when the worktree is live; clear everything
    // (including pointers) when the worktree is gone so the task row is clean.
    const patch = worktreeOnDisk ? CLEARED_TRANSIENT : CLEARED_INFLIGHT

    const hasBlockers = await hasIncompleteBlockers(t.id).catch(() => false)
    if (hasBlockers) {
      if (!silent) log(policy.blockedLog(t))
      try {
        await updateTask(t.id, { status: 'blocked', ...patch })
        result.blocked++
      } catch {
        // DB write failed — task stays in its current status.
        // The phantom-task watchdog or a future reconcile pass will retry.
        log(`[reconcile] failed to update task ${t.id} to blocked; skipping`)
      }
      continue
    }

    if (!silent) log(policy.requeueLog(t))
    try {
      await updateTask(t.id, { status: 'queued', ...patch })
      if (policy.emitOnRequeue) bus.emit('task.queued', { taskId: t.id })
      result.requeued.push(t.id)
    } catch {
      // DB write failed — task stays in its current status.
      // The phantom-task watchdog or a future reconcile pass will retry.
      log(`[reconcile] failed to update task ${t.id} to queued; skipping`)
    }
  }

  return result
}
