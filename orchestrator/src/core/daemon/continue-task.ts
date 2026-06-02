import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { getTask, updateTask } from '../queue'
import { getDefaultTaskStore } from '../lib/task-store'
import { coreRestartTask } from './restart-task'
import { createQueueWorkflowStore } from '../../workflows/queue-workflow-store'
import { PHASE_POLICIES } from '../../workflows/phase-policies'

export interface ContinueResult {
  /**
   * True when the failure was upstream of worktree creation so there is
   * nothing on disk to preserve. In this case continue silently degrades
   * to restart behaviour: the workflow re-enters from setup.
   */
  degradedToRestart: boolean
  /**
   * Human-readable explanation when `degradedToRestart` is true. The CLI
   * surfaces this so the operator understands why their `mars continue`
   * behaved identically to `mars restart`.
   */
  note?: string
}

/**
 * Core continue mechanics shared by the UDS RPC handler.
 *
 * Dispatches on the per-phase policy declared in PHASE_POLICIES
 * (workflows/phase-policies.ts, re-exported from implement-workflow.ts) —
 * the single source of truth for how each FailedPhase is resumed.
 *
 * Policy dispatch:
 *   setup  → restart-from-setup (always; no work to preserve)
 *   code   → coder-on-existing-worktree: assess the worktree, store context
 *             in recoveryPayload, re-queue. Degrades to restart only if there
 *             is no worktree on disk AND no branch ahead of main.
 *             INVARIANT: NEVER discards a worktree that is ahead of main.
 *   verify → engine-resume: re-queue as-is; engine checkpoint-resume skips
 *             completed steps and re-enters verify. Degrades to restart if the
 *             worktree is missing from disk (engine cannot resume without it).
 *   merge  → engine-resume: same as verify.
 *   null   → treated as setup (failure before any phase was recorded).
 *
 * Intentionally has no dependency on the daemon's event bus — the caller is
 * responsible for emitting `task.queued` after this resolves.
 *
 * @throws if the task does not exist or is not in `'failed'` status.
 */
export const coreContinueTask = async (id: string): Promise<ContinueResult> => {
  const task = await getTask(id)
  if (!task) throw new Error(`task ${id} not found`)

  // Guard: refuse if an in-flight recovery (fix-task) is already running for
  // this task. Checked before the status guard so the error names the recovery
  // id rather than giving the generic "only failed tasks" message.
  const store = await getDefaultTaskStore()
  const inflightRows = await store.query({
    sql: `SELECT id FROM tasks
           WHERE fix_for_task_id = ?
             AND status IN ('queued','running','verifying','merging','vega-reconciling','draft','blocked')
           ORDER BY created_at DESC
           LIMIT 1`,
    args: [id],
  })
  if (inflightRows.rows.length > 0) {
    const recoveryId = (inflightRows.rows[0] as unknown as { id: string }).id
    throw new Error(
      `task ${id} already has an in-flight recovery ${recoveryId}; wait for it to complete or use 'mars restart' to discard and re-run`,
    )
  }

  if (task.status !== 'failed') {
    throw new Error(
      `task ${id} is ${task.status}; only failed tasks can be continued (use 'mars restart' instead)`,
    )
  }

  // Null failedPhase means the failure happened before any phase was recorded
  // (e.g. a dirty-main guard fired before worktree creation). Treat as setup.
  const failedPhase = task.failedPhase ?? 'setup'
  const policy = PHASE_POLICIES[failedPhase]

  if (policy.continue === 'restart-from-setup') {
    await coreRestartTask(id, new Set(['failed']), createQueueWorkflowStore())
    const note =
      task.failedPhase === null
        ? 'failure was pre-setup (no worktree to preserve); continue is equivalent to restart here'
        : `failedPhase '${task.failedPhase}' is a pre-coding failure; continue is equivalent to restart here`
    return { degradedToRestart: true, note }
  }

  if (policy.continue === 'coder-on-existing-worktree') {
    // INVARIANT: never discard a worktree/branch that is ahead of main.
    const worktreeOnDisk = !!task.worktreePath && existsSync(task.worktreePath)

    if (!worktreeOnDisk) {
      // Worktree is already gone. Restart from setup so the work can be redone.
      // Before wiping the branch, check whether it has commits ahead of main —
      // if it does, we refuse to silently delete them.
      if (task.branch && task.worktreePath) {
        // Use the repo root (parent of the worktree path) to run git.
        // The worktreePath follows .mars/worktrees/<id>/ so we strip that suffix.
        const repoRoot = task.worktreePath.replace(/\/\.mars\/worktrees\/[^/]+\/?$/, '')
        const probe = spawnSync(
          'git',
          ['rev-list', '--count', `main..${task.branch}`],
          { cwd: repoRoot || undefined, encoding: 'utf8', timeout: 5000 },
        )
        const commitsAhead = Number.parseInt((probe.stdout ?? '').trim(), 10)
        if (Number.isInteger(commitsAhead) && commitsAhead > 0) {
          throw new Error(
            `task ${id}: worktree at ${task.worktreePath} is missing from disk BUT branch ${task.branch} has ${commitsAhead} commit(s) ahead of main — refusing to restart and discard those commits. Recover the branch manually or use 'mars restart' explicitly.`,
          )
        }
      }
      await coreRestartTask(id, new Set(['failed']), createQueueWorkflowStore())
      const note = `worktree at ${task.worktreePath ?? '(unknown)'} is missing from disk; cannot re-enter ${task.failedPhase} phase — restarting from setup`
      return { degradedToRestart: true, note }
    }

    // Worktree is on disk. Assess its state and store context in recoveryPayload
    // so the next coder run is seeded with the current worktree state + failure reason.
    const integrationBranch = process.env['INTEGRATION_BRANCH'] ?? 'main'
    let commitsAhead = 0
    let statusSummary = ''

    const revListResult = spawnSync(
      'git',
      ['rev-list', '--count', `${integrationBranch}..HEAD`],
      { cwd: task.worktreePath ?? undefined, encoding: 'utf8', timeout: 5000 },
    )
    if (revListResult.status === 0) {
      commitsAhead = Number.parseInt((revListResult.stdout ?? '').trim(), 10) || 0
    }

    const statusResult = spawnSync(
      'git',
      ['status', '--short'],
      { cwd: task.worktreePath ?? undefined, encoding: 'utf8', timeout: 5000 },
    )
    if (statusResult.status === 0) {
      statusSummary = (statusResult.stdout ?? '').trim()
    }

    const assessment = [
      `## Continuation context (resumed from failed code phase)`,
      ``,
      `The previous coder run was interrupted. Failure reason: ${task.failureReason ?? task.error ?? 'unknown'}.`,
      ``,
      `Worktree state at resume time:`,
      `- Commits ahead of ${integrationBranch}: ${commitsAhead}`,
      `- Working tree status:`,
      statusSummary.length > 0
        ? statusSummary.split('\n').map((l) => `  ${l}`).join('\n')
        : '  (clean — no staged/unstaged changes)',
      ``,
      `Review any existing commits and staged/unstaged changes before continuing. Build on what is already done rather than starting from scratch.`,
    ].join('\n')

    await updateTask(id, {
      status: 'queued',
      error: null,
      recoveryPayload: JSON.stringify({ type: 'code-resume', assessment }),
    })
    return { degradedToRestart: false }
  }

  // engine-resume: verify and merge phases.
  //
  // The engine's checkpoint-resume (runId=task.id) short-circuits completed
  // steps (setup + code) and re-enters the failed step directly without
  // re-running any LLM. The worktree must be present on disk for this to work.
  const worktreeMissingOnDisk =
    !!task.branch && !!task.worktreePath && !existsSync(task.worktreePath)
  if (worktreeMissingOnDisk) {
    await coreRestartTask(id, new Set(['failed']), createQueueWorkflowStore())
    return {
      degradedToRestart: true,
      note: `worktree at ${task.worktreePath} is missing from disk; cannot re-enter ${task.failedPhase} phase — restarting from setup`,
    }
  }

  // Re-queue as-is. No `resumeFrom`: engine checkpoint-resume (runId=task.id)
  // is the single source of truth for which step the re-dispatch skips into.
  await updateTask(id, {
    status: 'queued',
    error: null,
  })
  return { degradedToRestart: false }
}
