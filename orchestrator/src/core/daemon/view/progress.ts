/**
 * Daemon-side Progress view: cluster grouping + proposal join.
 *
 * `buildProgressView` is the single authoritative implementation of the
 * "which tasks appear in the Progress tab and under which cluster" logic,
 * previously split between ui/server/db.ts (cluster derivation) and
 * ui/server/index.ts (proposal join). The daemon serves the result as
 * GET /view/progress so the UI can proxy without a local DB read.
 */

import type { Client } from '@libsql/client'

export type Cluster = 'Queued' | 'In progress' | 'Blocked' | 'Failed'
export type ProposalSource = 'reflection' | 'human' | 'planner'

/**
 * Minimal proposal representation used as a DAG node in the Topology view.
 * Only proposals referenced by at least one in-scope task are returned.
 */
export interface ProposalNode {
  id: string
  title: string
  source: ProposalSource
  status: string
}

export interface ProgressTaskSpec {
  files: string[]
  readFirst: string[]
  prescriptiveAction: string | null
  verifyCmd: string | null
  doneCriteria: string[]
  taskType: string
}

/**
 * A task in scope for the Progress tab, with the server-derived cluster tag
 * attached. Shape mirrors ui/server/db.ts Task + Cluster so the UI renders
 * it without a local DB read.
 */
export interface ProgressTask {
  id: string
  prompt: string
  status: string
  cluster: Cluster
  plan: { functional: string; technical: string } | null
  branch: string | null
  worktreePath: string | null
  error: string | null
  failureSignature: string | null
  dropReason: string | null
  retryCount: number
  blockerTaskId: string | null
  blockedBy: string[]
  parentProposalId: string | null
  spec: ProgressTaskSpec | null
  createdAt: string
  updatedAt: string
}

/** Raw task row from the DB, before cluster derivation. */
export interface ProgressTaskRow {
  id: string
  prompt: string
  status: string
  planFunctional: string | null
  planTechnical: string | null
  branch: string | null
  worktreePath: string | null
  error: string | null
  failureSignature: string | null
  dropReason: string | null
  retryCount: number
  blockerTaskId: string | null
  blockedBy: string[]
  parentProposalId: string | null
  filesJson: string | null
  readFirstJson: string | null
  prescriptiveAction: string | null
  verifyCmd: string | null
  doneCriteriaJson: string | null
  taskType: string | null
  createdAt: string
  updatedAt: string
}

export interface ProgressTaskStore {
  listProgressTasks(): Promise<ProgressTaskRow[]>
}

export interface ProposalReader {
  listByIds(ids: string[]): Promise<ProposalNode[]>
}

/**
 * Maps a task to its Progress-tab cluster, or `null` if the task is out of
 * scope (draft/done/dropped). All failed tasks are always in scope — there
 * is no recency gate on the Failed cluster.
 */
export const clusterFor = (status: string): Cluster | null => {
  switch (status) {
    case 'queued':
      return 'Queued'
    case 'running':
    case 'verifying':
    case 'merging':
    case 'vega-reconciling':
      return 'In progress'
    case 'blocked':
      return 'Blocked'
    case 'failed':
      return 'Failed'
    default:
      return null
  }
}

const parseJsonArray = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string')
      : []
  } catch {
    return []
  }
}

const normaliseSource = (raw: unknown): ProposalSource => {
  if (raw === 'reflection' || raw === 'planner' || raw === 'human') return raw
  return 'human'
}

/**
 * Build the Progress view payload: tasks in scope with their cluster tag,
 * plus the proposals referenced by those tasks.
 *
 * This is the authoritative implementation of the Progress tab logic,
 * served by the daemon's GET /view/progress endpoint.
 */
export const buildProgressView = async (
  taskStore: ProgressTaskStore,
  proposalReader: ProposalReader,
): Promise<{ tasks: ProgressTask[]; proposals: ProposalNode[] }> => {
  const rows = await taskStore.listProgressTasks()
  const tasks: ProgressTask[] = []
  const proposalIdSet = new Set<string>()

  for (const row of rows) {
    const cluster = clusterFor(row.status)
    if (cluster === null) continue
    if (row.parentProposalId) proposalIdSet.add(row.parentProposalId)

    const f = row.planFunctional
    const t = row.planTechnical
    const anySpec =
      row.filesJson !== null ||
      row.verifyCmd !== null ||
      row.doneCriteriaJson !== null ||
      row.taskType !== null
    const spec: ProgressTaskSpec | null = anySpec
      ? {
          files: parseJsonArray(row.filesJson),
          readFirst: parseJsonArray(row.readFirstJson),
          prescriptiveAction: row.prescriptiveAction,
          verifyCmd: row.verifyCmd,
          doneCriteria: parseJsonArray(row.doneCriteriaJson),
          taskType: row.taskType ?? 'auto',
        }
      : null

    tasks.push({
      id: row.id,
      prompt: row.prompt,
      status: row.status,
      cluster,
      plan:
        f !== null || t !== null
          ? { functional: f ?? '', technical: t ?? '' }
          : null,
      branch: row.branch,
      worktreePath: row.worktreePath,
      error: row.error,
      failureSignature: row.failureSignature,
      dropReason: row.dropReason,
      retryCount: row.retryCount,
      blockerTaskId: row.blockerTaskId,
      blockedBy: row.blockedBy,
      parentProposalId: row.parentProposalId,
      spec,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  }

  const proposals = await proposalReader.listByIds([...proposalIdSet])
  return { tasks, proposals }
}

// ── DB adapters (for daemon use) ─────────────────────────────────────────────

const parseBlockedBy = (raw: unknown): string[] => {
  if (typeof raw !== 'string' || !raw) return []
  return raw.split(',').filter((id) => id.length > 0)
}

/**
 * Create a ProgressTaskStore backed by a libsql Client.
 * Queries all tasks with their blocker list and parent_proposal_id.
 */
export const createProgressTaskStore = (client: Client): ProgressTaskStore => ({
  async listProgressTasks() {
    const r = await client.execute(`
      SELECT t.id, t.prompt, t.status,
             t.plan_functional, t.plan_technical,
             t.branch, t.worktree_path, t.error,
             t.failure_signature, t.drop_reason,
             COALESCE(t.retry_count, 0) AS retry_count,
             t.parent_proposal_id,
             t.files_json, t.read_first_json, t.prescriptive_action,
             t.verify_cmd, t.done_criteria_json, t.task_type,
             t.created_at, t.updated_at,
             (SELECT b.blocker_task_id FROM task_blockers b
               WHERE b.task_id = t.id ORDER BY b.created_at ASC LIMIT 1) AS blocker_task_id,
             (SELECT GROUP_CONCAT(b.blocker_task_id, ',')
                FROM (SELECT blocker_task_id, created_at FROM task_blockers
                       WHERE task_id = t.id ORDER BY created_at ASC) b) AS blocker_task_ids
      FROM tasks t ORDER BY t.created_at
    `)
    return r.rows.map((row) => {
      const ro = row as unknown as Record<string, unknown>
      return {
        id: ro.id as string,
        prompt: ro.prompt as string,
        status: ro.status as string,
        planFunctional: (ro.plan_functional as string | null) ?? null,
        planTechnical: (ro.plan_technical as string | null) ?? null,
        branch: (ro.branch as string | null) ?? null,
        worktreePath: (ro.worktree_path as string | null) ?? null,
        error: (ro.error as string | null) ?? null,
        failureSignature: (ro.failure_signature as string | null) ?? null,
        dropReason: (ro.drop_reason as string | null) ?? null,
        retryCount: Number(ro.retry_count ?? 0),
        blockerTaskId: (ro.blocker_task_id as string | null) ?? null,
        blockedBy: parseBlockedBy(ro.blocker_task_ids),
        parentProposalId: (ro.parent_proposal_id as string | null) ?? null,
        filesJson: (ro.files_json as string | null) ?? null,
        readFirstJson: (ro.read_first_json as string | null) ?? null,
        prescriptiveAction: (ro.prescriptive_action as string | null) ?? null,
        verifyCmd: (ro.verify_cmd as string | null) ?? null,
        doneCriteriaJson: (ro.done_criteria_json as string | null) ?? null,
        taskType: (ro.task_type as string | null) ?? null,
        createdAt: ro.created_at as string,
        updatedAt: ro.updated_at as string,
      }
    })
  },
})

/**
 * Create a ProposalReader backed by a libsql Client.
 * Returns ProposalNode for each of the given proposal IDs.
 * Tolerates a missing proposals table (fresh or queue-only DBs).
 */
export const createProposalReader = (client: Client): ProposalReader => ({
  async listByIds(ids) {
    if (ids.length === 0) return []
    const tableCheck = await client.execute(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'`,
    )
    if (tableCheck.rows.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const r = await client.execute({
      sql: `SELECT id, title, status, source FROM proposals WHERE id IN (${placeholders})`,
      args: ids,
    })
    return r.rows.map((row) => {
      const ro = row as unknown as Record<string, unknown>
      return {
        id: ro.id as string,
        title: (ro.title as string | null) ?? '',
        status: (ro.status as string | null) ?? 'draft',
        source: normaliseSource(ro.source),
      }
    })
  },
})
