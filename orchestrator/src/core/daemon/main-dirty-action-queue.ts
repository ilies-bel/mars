/**
 * Slice F.2: actionQueue-side helpers for `main-commiter` recoveries.
 *
 * Two distinct concerns live here, both keyed off the recovery's
 * `recovery_payload`:
 *
 * 1. `sweepStaleFailedMainCommiterActionQueue`: on committer SUCCESS, scan for
 *    open actionQueue rows raised by previously-failed committer attempts on the
 *    same integration branch. Those rows describe a state that the
 *    just-succeeded committer fixed; resolve them with `SupersedeReason:
 *    'origin-done'`.
 *
 * 2. `raiseAggregatedMainCommiterFailureRow`: on committer FAILURE, raise
 *    one actionQueue row whose body lists every task currently `blocked` on this
 *    committer. Overrides the generic `action-queue-repopulator` row for this
 *    specific recovery so the operator sees the affected cohort at a glance.
 */
import { execFileSync } from 'node:child_process'
import {
  findOpenActionQueueItemIdBySignature,
  raiseActionQueueItem,
  supersedeActionQueueItemsBySignature,
  supersedeActionQueueItemsForOrigin,
} from '../lib/action-queue'
import { getDefaultTaskStore } from '../store/task-store'
import type { DomainTaskStore as TaskStore } from '../store/task-store'
import { MAIN_COMMITER_RECIPE } from '../lib/main-dirty'
import { Arc } from '../arc'
import { updateTask } from '../queue'

/**
 * SQL fragment that matches open actionQueue rows for failed `main-commiter`
 * recoveries on the same integration branch as the just-succeeded committer,
 * excluding the fresh committer itself.
 *
 * Implementation note: rather than crack open the actionQueue payload, we use
 * the convention that a `main-commiter` failure actionQueue row records the
 * `recoveryTaskId` in its payload — the same shape the recovery-failed
 * pipeline already uses. We join tasks via that pointer and filter by
 * recipe, integration branch (same branch → same committer scope), and
 * exclude the fresh committer itself so it is never incorrectly swept.
 */
const FIND_STALE_COMMITTER_ACTION_QUEUE_ROWS_SQL = `
  SELECT i.id AS actionQueue_id,
         i.origin_task_id AS origin_task_id
    FROM action_queue_items i
    JOIN tasks t
      ON t.id = COALESCE(
           i.payload::jsonb ->> 'recoveryTaskId',
           i.origin_task_id
         )
   WHERE i.state = 'open'
     AND t.kind = 'fix'
     AND (t.recovery_payload::jsonb ->> 'recipe') = ?
     AND (t.recovery_payload::jsonb ->> 'integrationBranch') = ?
     AND t.id != ?
     AND t.status = 'failed'
`

/**
 * Scan for `failed`-committer actionQueue rows on the same integration branch
 * (other than the fresh committer), and supersede them with `origin-done`. A
 * successful committer on branch B means every older failed-committer row for
 * branch B describes a state that has since been resolved — sweep them so the
 * operator's action queue no longer shows stale entries for that branch.
 *
 * `integrationBranch` scopes the sweep to the same branch as the
 * just-succeeded committer. `freshRecoveryTaskId` is excluded so the fresh
 * committer's own rows (if any exist) are never swept.
 *
 * The function is idempotent: rerunning when no stale rows exist is a
 * silent no-op.
 */
export const sweepStaleFailedMainCommiterActionQueue = async (
  integrationBranch: string,
  freshRecoveryTaskId: string,
  log: (msg: string) => void,
): Promise<void> => {
  const s = await getDefaultTaskStore()
  const r = await s.query({
    sql: FIND_STALE_COMMITTER_ACTION_QUEUE_ROWS_SQL,
    args: [MAIN_COMMITER_RECIPE, integrationBranch, freshRecoveryTaskId],
  })
  if (r.rows.length === 0) return
  const seenOrigins = new Set<string>()
  for (const row of r.rows as unknown as Array<{
    actionQueue_id: string
    origin_task_id: string | null
  }>) {
    if (row.origin_task_id === null || row.origin_task_id.length === 0) continue
    if (seenOrigins.has(row.origin_task_id)) continue
    seenOrigins.add(row.origin_task_id)
    const closed = await supersedeActionQueueItemsForOrigin(
      row.origin_task_id,
      'origin-done',
      `daemon:main-commiter-success:${freshRecoveryTaskId}`,
    )
    if (closed.length > 0) {
      log(
        `[main-dirty] swept ${closed.length} stale failed-committer actionQueue row(s) tied to origin ${row.origin_task_id} after committer ${freshRecoveryTaskId} succeeded`,
      )
    }
  }
}

/**
 * On committer FAILURE, raise a single aggregated actionQueue row that lists
 * every task currently blocked on this committer. Overrides the generic
 * `action-queue-repopulator` shape for this kind of failure so the operator
 * sees the cohort at a glance.
 *
 * Cohort enumeration: query `task_blockers WHERE blocker_task_id =
 * <committer-id>` and resolve each `task_id` to its `(id, prompt,
 * status)`. The dependent count drives the title's `N tasks blocked`
 * suffix; status of each dependent is rendered alongside the id so the
 * operator can tell which are still parked vs. cleared by some other
 * path.
 *
 * Idempotent on the committer task id (signature keys on it). A repeated
 * failure of the same recovery bumps `seenCount` rather than inserting
 * a duplicate row.
 */
export const raiseAggregatedMainCommiterFailureRow = async (
  recoveryTaskId: string,
  log: (msg: string) => void,
): Promise<string | null> => {
  const s = await getDefaultTaskStore()
  const cohort = await s.query({
    sql: `SELECT t.id AS id, t.prompt AS prompt, t.status AS status
            FROM task_blockers tb
            JOIN tasks t ON t.id = tb.task_id
           WHERE tb.blocker_task_id = ?
           ORDER BY t.created_at ASC`,
    args: [recoveryTaskId],
  })
  // Resolve the committer row to extract payload + origin for context.
  const fixRow = await s.query({
    sql: `SELECT origin_id, recovery_payload, error, worktree_path FROM tasks WHERE id = ?`,
    args: [recoveryTaskId],
  })
  if (fixRow.rows.length === 0) {
    log(`[main-dirty] aggregated-row: committer ${recoveryTaskId} not found; skipping actionQueue raise`)
    return null
  }
  const fix = fixRow.rows[0] as unknown as {
    origin_id: string
    recovery_payload: string | null
    error: string | null
    worktree_path: string | null
  }
  const dependents = cohort.rows as unknown as Array<{
    id: string
    prompt: string | null
    status: string
  }>
  const n = dependents.length
  const title =
    n === 0
      ? `main-committer failed — no tasks currently blocked`
      : `main-committer failed — ${n} task${n === 1 ? '' : 's'} blocked`
  const cohortLines =
    dependents.length === 0
      ? ['(no tasks currently waiting on this committer)']
      : dependents.map((d) => {
          const summary =
            d.prompt && d.prompt.length > 0
              ? d.prompt.replace(/\s+/g, ' ').slice(0, 80)
              : '(no prompt)'
          return `- \`${d.id}\` [${d.status}] — ${summary}`
        })
  const body = [
    `Recovery task \`${recoveryTaskId}\` (recipe: \`${MAIN_COMMITER_RECIPE}\`) failed.`,
    `The orchestrator will not retry it (recovery budget is 0 — see ADR-0002).`,
    '',
    `Tasks currently blocked on this committer (${n}):`,
    '',
    ...cohortLines,
    '',
    fix.error ? `Last committer error (truncated):\n\`\`\`\n${fix.error}\n\`\`\`` : null,
    // Without this the operator has no way to find their own work. Spawning a
    // committer MOVES the integration branch's uncommitted changes into the
    // committer's worktree (checkpoint capture on the repo root -> apply by
    // object id in the worktree, see `core/lib/git/checkpoint.ts`; the
    // checkpoint ref survives as a second copy either way).
    // When the committer then fails — which the recipe is SUPPOSED
    // to do whenever the diff is ambiguous, e.g. edits spanning unrelated
    // subsystems — those changes stay behind in a hidden `.mars/worktrees/`
    // path. `git status` on the integration branch is clean and the edits look
    // deleted.
    fix.worktree_path
      ? [
          '',
          "Your uncommitted changes are NOT lost — they were moved off the",
          "integration branch into the committer's worktree:",
          '',
          '```',
          `git -C ${fix.worktree_path} status`,
          `git -C ${fix.worktree_path} diff`,
          '```',
          '',
          'Review them there, then either commit them from that worktree or copy',
          'them back to the integration checkout and commit. The queue stays',
          'parked until the integration branch is clean.',
        ].join('\n')
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n')

  const actionQueueItemId = await raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title,
    body,
    payload: {
      recoveryTaskId,
      recipe: MAIN_COMMITER_RECIPE,
      cohort: dependents.map((d) => ({
        taskId: d.id,
        status: d.status,
      })),
    },
    context: {
      repoRoot: process.env.MARS_REPO ?? null,
    },
    raisedBy: 'daemon:main-commiter-failed',
    // Signature keys on the committer task id so repeat failures of the
    // same recovery (theoretically impossible — recovery budget is 0 —
    // but the test path may re-mark a fix as failed) dedupe on the row.
    signature: `main-commiter:${recoveryTaskId}`,
    originTaskId: fix.origin_id,
    occurrence: {
      at: Date.now(),
      recoveryTaskId,
      dependentCount: n,
    },
  })
  log(
    `[main-dirty] aggregated-row: raised actionQueue ${actionQueueItemId} for failed committer ${recoveryTaskId} with ${n} blocked dependent(s)`,
  )
  return actionQueueItemId
}

/**
 * Raise a high-priority action-queue alert when the integration branch has dirt
 * that a main-committer CANNOT resolve (ignored entries, unmerged conflicts,
 * submodule gitlink changes, or untracked files inside ignored directories).
 *
 * Unlike the committer-scope path, this does NOT insert a fix task or a
 * task_blockers edge. The operator must manually clean the contaminated paths
 * before dispatch can resume.
 *
 * Idempotent on `integrationBranch` (signature-keyed): repeat detections on
 * the same branch bump `seen_count` on the existing open row rather than
 * inserting a new one.
 */
export const unrelatedDirtActionQueueSignature = (integrationBranch: string): string =>
  `main-dirty:unrelated:${integrationBranch}`

export const raiseUnrelatedDirtActionQueue = async (
  integrationBranch: string,
  contaminatedPaths: string[],
  log: (msg: string) => void,
): Promise<string> => {
  const pathLines =
    contaminatedPaths.length > 0
      ? contaminatedPaths.map((p) => `- \`${p}\``).join('\n')
      : '(no specific paths identified)'

  const body = [
    `The integration branch \`${integrationBranch}\` has dirt that a main-committer cannot resolve:`,
    '',
    pathLines,
    '',
    'These paths are ignored entries, unmerged conflicts, submodule gitlinks, or',
    'files inside ignored directories. A committer can only stage tracked and',
    'untracked (non-ignored) files.',
    '',
    'To unblock dispatch, either:',
    '  1. Remove or clean up the contaminated paths listed above, or',
    '  2. Add them to `.gitignore` if they should always be excluded (note:',
    '     already-ignored directory entries need to be deleted, not just ignored).',
    '',
    'Once the integration branch is clean, dispatch will resume automatically.',
  ].join('\n')

  const actionQueueItemId = await raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title: `main-dirty — unrelated dirt on ${integrationBranch}`,
    body,
    payload: { integrationBranch, contaminatedPaths },
    context: { repoRoot: process.env.MARS_REPO ?? null },
    raisedBy: 'daemon:main-dirty-preflight',
    signature: unrelatedDirtActionQueueSignature(integrationBranch),
  })
  log(
    `[main-dirty] unrelated dirt on ${integrationBranch}: raised actionQueue ${actionQueueItemId} (contaminated: ${contaminatedPaths.join(', ')})`,
  )
  return actionQueueItemId
}

/**
 * Resolve the unrelated-dirt alert after the integration branch is clean.
 *
 * The row is a level-triggered projection of current branch state, so it must
 * disappear on the falling edge just as it appears on the rising edge. The
 * lookup keeps ordinary clean dispatches silent and avoids a write when no
 * matching alert is open.
 */
export const clearUnrelatedDirtActionQueue = async (integrationBranch: string): Promise<void> => {
  const signature = unrelatedDirtActionQueueSignature(integrationBranch)
  const openItemId = await findOpenActionQueueItemIdBySignature('failed', signature)
  if (openItemId === null) return
  await supersedeActionQueueItemsBySignature(
    'failed',
    signature,
    'condition-cleared',
    'daemon:main-dirty-condition-cleared',
  )
}

/**
 * On committer FAILURE, release every task that is currently blocked solely
 * because of this committer — BUT only when main is actually clean.
 *
 * Precondition check: runs `git status --porcelain` in `repoRoot`. If main is
 * still dirty, releasing dependents would immediately re-park them behind a
 * NEW committer (they re-detect dirty main at dispatch → spawn fresh committer →
 * block → new committer fails → loop). Instead, keep dependents blocked and
 * rely on the operator action-queue item already raised by
 * `raiseAggregatedMainCommiterFailureRow` to surface the problem.
 *
 * When main IS clean (the committer failure raced with a concurrent merge that
 * happened to clean the branch), release proceeds as before: each dependent's
 * `task_blockers` edge to `committerTaskId` is deleted; tasks with no remaining
 * active blockers are flipped from `blocked` back to `queued`.
 *
 * Tasks with other active blockers (besides the failed committer) have their
 * committer edge removed but remain in `blocked` state, waiting for those
 * other prerequisites.
 *
 * Idempotent: a second call finds no edges or no blocked rows and is a no-op.
 */
export const releaseMainCommitterDependents = async (
  committerTaskId: string,
  log: (msg: string) => void,
  repoRoot: string,
): Promise<void> => {
  // Guard: verify main is clean before releasing dependents. A failed committer
  // over a still-dirty main must NOT re-queue dependents — they would re-detect
  // dirty main, park behind a new committer, and repeat until retry budgets
  // are exhausted. Keep them blocked; the operator action-queue item already
  // raised by raiseAggregatedMainCommiterFailureRow tells the human what happened.
  if (!repoRoot) {
    log(
      `[main-dirty] committer ${committerTaskId}: repoRoot not set; keeping dependents blocked for safety`,
    )
    return
  }
  let mainIsDirty: boolean
  try {
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    mainIsDirty = statusOutput.trim().length > 0
  } catch (err) {
    // Cannot check git status — err on the side of caution.
    log(
      `[main-dirty] committer ${committerTaskId}: could not check git status at ${repoRoot}: ${(err as Error).message}; keeping dependents blocked`,
    )
    return
  }

  if (mainIsDirty) {
    log(
      `[main-dirty] committer ${committerTaskId} failed and main is still dirty; dependents kept blocked — operator must resolve`,
    )
    return
  }

  // Main is clean. ADR-0052 sole-writer: the status write (blocked -> queued),
  // the edge delete, and the task.unblocked emit all live in the Arc aggregate.
  // This is a thin delegating wrapper with no task-table write of its own.
  await Arc.releaseMainCommitterDependents(committerTaskId, log)
}

/**
 * Stamp a main-committer task `failed` with the orchestration failure code and
 * raise a single high-priority action-queue alert naming the still-dirty paths.
 *
 * Called from the verify primitive when `git status --porcelain` on the
 * integration branch is non-empty AFTER the committer ran and its own verify
 * steps passed. This is a non-recoverable orchestration condition — no fix task
 * is spawned. Dependents remain blocked until the operator resolves the dirt
 * manually and then restarts or purges the committer task.
 *
 * The action-queue row uses `signature: main-committer-still-dirty:<taskId>` so
 * repeat detections for the same committer task deduplicate via `seen_count`.
 */
export const handleCommitterStillDirty = async (
  taskId: string,
  integrationBranch: string,
  contaminatedPaths: string[],
  store: TaskStore | undefined,
): Promise<void> => {
  const pathLines =
    contaminatedPaths.length > 0
      ? contaminatedPaths.map((p) => `- ${p}`).join('\n')
      : '(no specific paths identified)'

  await updateTask(
    taskId,
    {
      status: 'failed',
      error: pathLines,
      failedPhase: 'verify',
      failureReason: 'orchestration:main-committer-still-dirty',
      failureReasonCode: 'orchestration:main-committer-still-dirty',
    },
    store,
  )

  await raiseActionQueueItem({
    kind: 'failed',
    category: 'orchestrator',
    priority: 'high',
    title: `main is dirty: ${contaminatedPaths.join(', ') || 'unknown path'}`,
    body: [
      `The main-committer task \`${taskId}\` completed but left the integration branch \`${integrationBranch}\` still dirty.`,
      '',
      'Contaminated paths:',
      '',
      pathLines,
      '',
      'The committer exited without fully cleaning the integration checkout',
      '(e.g. ignored files remain, which a checkpoint never captures, or the committer did not commit).',
      'No automatic recovery is possible — operator review is required.',
      '',
      'To resolve:',
      '  1. Inspect the paths above on the integration branch.',
      '  2. Commit the ones that are real work, or restore the rest with',
      '     `git checkout <ref> -- <paths>` (remove untracked scratch files outright).',
      '     Do NOT `git stash`: the stash is shared by every worktree in this repo,',
      '     so a later `pop` can hand you another task\'s uncommitted work.',
      '  3. Restart or purge the blocked tasks once the branch is clean.',
    ].join('\n'),
    payload: { taskId, integrationBranch, contaminatedPaths },
    context: { repoRoot: process.env.MARS_REPO ?? null },
    raisedBy: 'workflow:verify:main-committer-still-dirty',
    signature: `main-committer-still-dirty:${taskId}`,
    originTaskId: taskId,
  })
}
