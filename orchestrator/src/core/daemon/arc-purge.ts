/**
 * Arc-level purge: drops the origin task and every same-origin task (tasks
 * sharing the same `origin_id`) in one operation.
 *
 * Accepts any member id (origin or sibling) as input; resolves to the arc's
 * `origin_id` first, then expands to the full member set.
 *
 * All-or-nothing commit-ahead guard: if `force=false`, checks EVERY member for
 * unique commits ahead of the integration branch BEFORE deleting anything. If
 * any member fails the guard, the whole arc purge is refused with a list of
 * failing members. Pass `force=true` to bypass the guard for all members
 * (mirrors the `force` flag in {@link corePurgeTask}).
 *
 * Each member is purged through {@link corePurgeTask} so worktree removal,
 * branch deletion, the commit-ahead guard, action-queue supersede, and
 * `Arc.drop()`'s atomic edge/cascade handling all run per member — exactly as
 * single-id purge does. Non-origin members are purged first; the origin is
 * purged last so its `fix_for_task_id` cascade handles any remaining fix tasks
 * atomically.
 */
import { getTask, enqueueTask } from '../queue'
import { corePurgeTask } from './purge-task'
import { listUniqueCommitsAhead } from '../lib/sweep'
import { getDefaultDomainTaskStore } from '../store/task-store'

export interface ArcPurgeResult {
  /** Ids of every task that was purged, in the order they were purged. */
  purgedIds: string[]
  /** The resolved origin_id of the arc. */
  originId: string
  /**
   * Id of the compensation/cleanup task created when the arc had integrated
   * work on the integration branch. Absent when no compensation task was
   * needed (branch-only work) or when the task already existed (idempotent).
   * Always set when force=true and any arc member had status='done'.
   */
  compensationTaskId?: string
}

/**
 * Purge an entire task arc (origin + all tasks sharing the same `origin_id`).
 *
 * @param id - Any member of the arc (origin or sibling)
 * @param force - Bypass the commit-ahead guard for all members
 * @param integrationBranch - The branch to compare against for unique commits
 * @param repoRoot - Absolute path to the git repo root
 *
 * @throws {Error} with message `"task <id> not found"` if the given id does not exist
 * @throws {Error} listing all failing members if `force=false` and any member
 *   has unique commits ahead of the integration branch (thrown before any
 *   deletion — all-or-nothing semantics)
 */
export const coreArcPurge = async (
  id: string,
  force: boolean,
  integrationBranch: string,
  repoRoot: string,
): Promise<ArcPurgeResult> => {
  // Resolve the origin_id for the given member id.
  const task = await getTask(id)
  if (!task) {
    throw new Error(`task ${id} not found`)
  }
  const originId = task.originId

  // Collect all arc members (tasks sharing this origin_id).
  const members = await getDefaultDomainTaskStore().listArcMembers(originId)

  // Pre-check (all-or-nothing): if !force, verify no member has unique commits
  // ahead of the integration branch BEFORE deleting anything. This ensures the
  // purge is either fully refused or fully committed — never half-purged.
  if (!force) {
    const aheadFailures: Array<{
      taskId: string
      branch: string
      commitCount: number
    }> = []
    for (const member of members) {
      const branch = member.branch ?? `task/${member.id}`
      const commits = await listUniqueCommitsAhead(branch, integrationBranch, repoRoot)
      if (commits.length > 0) {
        aheadFailures.push({ taskId: member.id, branch, commitCount: commits.length })
      }
    }
    if (aheadFailures.length > 0) {
      const details = aheadFailures
        .map((f) => `  ${f.taskId} (${f.branch}): ${f.commitCount} unique commit(s)`)
        .join('\n')
      throw new Error(
        `arc ${originId}: ${aheadFailures.length} member(s) have unique commits ahead of the integration branch:\n${details}\nPass --force to delete anyway.`,
      )
    }
  }

  // Collect full task details BEFORE purging: status determines whether the arc
  // had work integrated into the branch (status='done' means merged).
  const memberTaskDetails = await Promise.all(members.map((m) => getTask(m.id)))
  const integratedMemberIds = memberTaskDetails
    .filter((t): t is NonNullable<typeof t> => t !== null && t.status === 'done')
    .map((t) => t.id)
  const hasIntegratedWork = integratedMemberIds.length > 0

  // Capture the origin task's title/intent BEFORE it is deleted.
  const originTaskDetail = memberTaskDetails.find((t) => t?.id === originId)
  const originTitle =
    (originTaskDetail?.intent !== '' ? originTaskDetail?.intent : null) ??
    originTaskDetail?.prompt.split('\n')[0] ??
    `arc ${originId}`

  // Purge each member. Non-origin members are purged first so the origin's
  // Arc.drop() cascade (fix children via fix_for_task_id) handles any remaining
  // fix tasks atomically. Members that were already cascade-deleted by a prior
  // step return a synthetic success from corePurgeTask (idempotent).
  const nonOriginMembers = members.filter((m) => m.id !== originId)
  const originMember = members.find((m) => m.id === originId)
  const orderedMembers = [
    ...nonOriginMembers,
    ...(originMember ? [originMember] : []),
  ]

  const purgedIds: string[] = []
  for (const member of orderedMembers) {
    await corePurgeTask(member.id, force, integrationBranch, repoRoot)
    purgedIds.push(member.id)
  }

  // When the arc had integrated work and this was a force-purge, create exactly
  // one compensation/cleanup task. The followup_dedup_key makes this idempotent:
  // a second force-purge (or a crash-retry) finds the existing task and returns
  // its id without creating a duplicate.
  if (!force || !hasIntegratedWork) {
    return { purgedIds, originId }
  }

  const dedupKey = `arc-force-purge-compensation:${originId}`
  const store = getDefaultDomainTaskStore()
  const existing = await store.execute({
    sql: `SELECT id FROM tasks WHERE followup_dedup_key = ?`,
    args: [dedupKey],
  })
  const existingRows = existing.rows as unknown as { id: string }[]
  if (existingRows.length > 0) {
    return { purgedIds, originId, compensationTaskId: existingRows[0].id }
  }

  const memberList = integratedMemberIds.map((mid) => `  - ${mid}`).join('\n')
  const compensationTask = await enqueueTask(
    `Compensate for force-purged arc ${originId}.

The arc below was force-purged while some of its work had already been integrated
into the integration branch (${integrationBranch}). Review the integration branch to
identify and handle any orphaned code from this abandoned arc.

**Abandoned arc:** ${originId}
**Origin task:** ${originTitle}
**Members with integrated commits (status was 'done'):**
${memberList}

**Expected cleanup or revert scope:**
1. Run \`git log ${integrationBranch} --oneline\` to find commits from the task branches above.
2. Decide whether to revert the integrated changes or keep them with documentation.
3. If reverting: use \`git revert <sha>\` for each relevant commit and push to ${integrationBranch}.
4. If keeping: add a code comment or ADR entry referencing this abandoned arc with rationale.

**Verification expectations:**
- The integration branch is in a known, consistent state.
- Either the orphaned changes are explicitly reverted, OR a written decision exists
  to keep them with rationale documented (comment, ADR, or task note).
- No dead code or broken imports remain from the abandoned arc.`,
    undefined,
    {
      skipTriage: true,
      compensatesArcId: originId,
      followupDedupKey: dedupKey,
      intent: `Compensate for force-purged arc ${originId}`,
    },
  )

  return { purgedIds, originId, compensationTaskId: compensationTask.id }
}
