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
import {
  getTask,
  resolveQueueClient,
  migrateQueueSchema,
} from '../queue'
import { corePurgeTask } from './purge-task'
import { listUniqueCommitsAhead } from '../lib/sweep'

export interface ArcPurgeResult {
  /** Ids of every task that was purged, in the order they were purged. */
  purgedIds: string[]
  /** The resolved origin_id of the arc. */
  originId: string
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
  await migrateQueueSchema()
  const membersResult = await resolveQueueClient().execute({
    sql: `SELECT id, branch FROM tasks WHERE origin_id = ?`,
    args: [originId],
  })
  const members = membersResult.rows as unknown as Array<{
    id: string
    branch: string | null
  }>

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

  return { purgedIds, originId }
}
