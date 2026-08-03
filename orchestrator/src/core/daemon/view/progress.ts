/**
 * Daemon-side Progress view: cluster grouping + proposal join.
 *
 * `buildProgressView` is the single authoritative implementation of the
 * "which tasks appear in the Progress tab and under which cluster" logic,
 * previously split between ui/server/db.ts (cluster derivation) and
 * ui/server/index.ts (proposal join). The daemon serves the result as
 * GET /view/progress so the UI can proxy without a local DB read.
 */

import type { DbClient } from '../../lib/db.js'
import { isProposalSource, type ProposalSource } from '../../proposals'

export type Cluster = 'Queued' | 'In progress' | 'Blocked' | 'Failed' | 'Done'
export type { ProposalSource } from '../../proposals'

/**
 * Cheap aggregate counts for the Progress-tab header.
 * - doneToday: tasks that completed (status='done') in the last 24 hours.
 * - doneTotal: all-time done task count.
 * - failedOpen: tasks currently in status='failed'.
 */
export interface ProgressAggregates {
  doneToday: number
  doneTotal: number
  failedOpen: number
}

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
  mergeMode: string
}

/**
 * A task in scope for the Progress tab, with the server-derived cluster tag
 * attached. Shape mirrors ui/server/db.ts Task + Cluster so the UI renders
 * it without a local DB read.
 */
export interface ProgressTask {
  id: string
  prompt: string
  /**
   * Short human-readable summary of the task, set at enqueue (explicitly via
   * `--intent`, otherwise derived from the prompt's first sentence). Board and
   * topology cards prefer this over the raw prompt, which is routinely a
   * multi-paragraph brief on a single line. Null on legacy rows.
   */
  intent: string | null
  status: string
  priority: number
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
  /** Stable arc-origin id — groups related tasks (origin + fix/diagnose) in the Topology view. */
  originId: string | null
  /** Id of the task this row is fixing. Non-null iff kind='fix'. */
  fixForTaskId: string | null
  /** Task role: 'task' | 'fix' | 'diagnose' | null for legacy rows. */
  kind: string | null
  /**
   * When set, this task was created to compensate/cleanup a force-purged arc.
   * The value is the `origin_id` of the abandoned arc. Null for all other tasks.
   * Optional for backwards compat with callers that predated this field.
   */
  compensatesArcId?: string | null
  /** Short-lived sub-phase label written by merge/verify primitives. Null/absent when not in-flight. */
  activityDetail?: string | null
  createdAt: string
  updatedAt: string
}

/** Raw task row from the DB, before cluster derivation. */
export interface ProgressTaskRow {
  id: string
  prompt: string
  intent: string | null
  status: string
  priority: number
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
  mergeMode: string | null
  originId: string | null
  fixForTaskId: string | null
  kind: string | null
  compensatesArcId?: string | null
  /** Short-lived sub-phase label written by merge/verify primitives. Null/absent when not in-flight. */
  activityDetail?: string | null
  createdAt: string
  updatedAt: string
}

export interface ProgressTaskStore {
  listProgressTasks(): Promise<ProgressTaskRow[]>
}

export interface ProposalReader {
  listByIds(ids: string[]): Promise<ProposalNode[]>
}

export interface AggregateReader {
  readAggregates(): Promise<ProgressAggregates>
}

/**
 * Maps a task to its Progress-tab cluster, or `null` if the task is out of
 * scope (draft/dropped). Done tasks are included as arc metadata with cluster
 * 'Done'. All failed tasks are always in scope — there is no recency gate on
 * the Failed cluster.
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
    case 'done':
      return 'Done'
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

const normaliseSource = (raw: unknown): ProposalSource =>
  isProposalSource(raw) ? raw : 'human'

/**
 * Build the Progress view payload: tasks in scope with their cluster tag,
 * plus the proposals referenced by those tasks, plus cheap aggregate counts
 * for the header (doneToday, doneTotal, failedOpen).
 *
 * This is the authoritative implementation of the Progress tab logic,
 * served by the daemon's GET /view/progress endpoint.
 */
export const buildProgressView = async (
  taskStore: ProgressTaskStore,
  proposalReader: ProposalReader,
  aggregateReader: AggregateReader,
): Promise<{ tasks: ProgressTask[]; proposals: ProposalNode[]; aggregates: ProgressAggregates }> => {
  const [rows, aggregates] = await Promise.all([
    taskStore.listProgressTasks(),
    aggregateReader.readAggregates(),
  ])
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
      row.mergeMode !== null
    const spec: ProgressTaskSpec | null = anySpec
      ? {
          files: parseJsonArray(row.filesJson),
          readFirst: parseJsonArray(row.readFirstJson),
          prescriptiveAction: row.prescriptiveAction,
          verifyCmd: row.verifyCmd,
          doneCriteria: parseJsonArray(row.doneCriteriaJson),
          mergeMode: row.mergeMode ?? 'auto',
        }
      : null

    tasks.push({
      id: row.id,
      prompt: row.prompt,
      intent: row.intent,
      status: row.status,
      priority: row.priority,
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
      originId: row.originId,
      fixForTaskId: row.fixForTaskId,
      kind: row.kind,
      compensatesArcId: row.compensatesArcId,
      activityDetail: row.activityDetail,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  }

  const proposals = await proposalReader.listByIds([...proposalIdSet])
  return { tasks: pruneCompletedArcs(tasks), proposals, aggregates }
}

/**
 * Drop Done tasks that belong to fully-completed arcs.
 *
 * Done tasks are never rendered: the board skips all-Done arcs outright and the
 * topology emits no nodes or edges for them. They are carried purely as arc
 * METADATA — a completed origin supplies its arc's title, which is what stops
 * an active arc from rendering as "Abandoned arc / origin force-purged". So the
 * only Done rows worth sending are those sharing an arc with a task that is
 * actually on screen.
 *
 * Without this the view ships every task the repo has ever completed, with full
 * prompts, on every poll of a live-refreshing page: 2015 of 2086 rows and ~10 MB
 * per request in the repo this was written against.
 *
 * The two views key arcs differently — the board by `originId ?? id`, the
 * topology by `parentProposalId ?? originId ?? id` — so a Done row is kept when
 * ANY of its three identifiers matches an arc key claimed by a non-Done task.
 * That is deliberately generous: over-keeping costs a row, under-keeping
 * resurrects the false "abandoned arc" display.
 *
 * Header counts are unaffected — doneToday/doneTotal come from COUNT queries,
 * not from this list.
 */
const pruneCompletedArcs = (tasks: ProgressTask[]): ProgressTask[] => {
  const activeArcKeys = new Set<string>()
  for (const t of tasks) {
    if (t.cluster === 'Done') continue
    activeArcKeys.add(t.id)
    if (t.originId !== null) activeArcKeys.add(t.originId)
    if (t.parentProposalId !== null) activeArcKeys.add(t.parentProposalId)
  }
  return tasks.filter((t) => {
    if (t.cluster !== 'Done') return true
    return (
      activeArcKeys.has(t.id) ||
      (t.originId !== null && activeArcKeys.has(t.originId)) ||
      (t.parentProposalId !== null && activeArcKeys.has(t.parentProposalId))
    )
  })
}

// ── DB adapters (for daemon use) ─────────────────────────────────────────────

const parseBlockedBy = (raw: unknown): string[] => {
  if (typeof raw !== 'string' || !raw) return []
  return raw.split(',').filter((id) => id.length > 0)
}

/**
 * Create a ProgressTaskStore backed by a DbClient.
 * Queries all tasks with their blocker list and parent_proposal_id.
 *
 * The aggregate subselects are COALESCE'd to '[]' / cast to text so the row
 * shape matches the historical behavior exactly: the SQLite-era JSON array
 * aggregate over zero rows produced the string '[]' (never NULL), and
 * downstream `anySpec` detection relies on files_json/done_criteria_json
 * being non-null strings.
 */
export const createProgressTaskStore = (client: DbClient): ProgressTaskStore => ({
  async listProgressTasks() {
    const r = await client.execute(`
      SELECT t.id, t.prompt, t.intent, t.status,
             -- Legacy task rows may have a NULL priority; 0 is the lowest priority.
             COALESCE(t.priority, 0) AS priority,
             t.plan_functional, t.plan_technical,
             t.branch, t.worktree_path, t.error,
             t.failure_signature, t.drop_reason,
             COALESCE(t.retry_count, 0) AS retry_count,
             t.parent_proposal_id,
             (SELECT COALESCE(json_agg(path ORDER BY position)::text, '[]')
                FROM task_spec_files WHERE task_id = t.id) AS files_json,
             t.read_first_json, t.prescriptive_action,
             t.verify_cmd,
             (SELECT COALESCE(json_agg(criterion ORDER BY position)::text, '[]')
                FROM task_done_criteria WHERE task_id = t.id) AS done_criteria_json,
             t.merge_mode,
             t.origin_id, t.fix_for_task_id, t.kind,
             t.compensates_arc_id,
             t.activity_detail,
             t.created_at, t.updated_at,
             (SELECT b.blocker_task_id FROM task_blockers b
               WHERE b.task_id = t.id ORDER BY b.created_at ASC LIMIT 1) AS blocker_task_id,
             (SELECT string_agg(b.blocker_task_id, ',' ORDER BY b.created_at)
                FROM task_blockers b WHERE b.task_id = t.id) AS blocker_task_ids
      FROM tasks t ORDER BY t.created_at
    `)
    return r.rows.map((row) => {
      const ro = row as unknown as Record<string, unknown>
      return {
        id: ro.id as string,
        prompt: ro.prompt as string,
        intent: (ro.intent as string | null) ?? null,
        status: ro.status as string,
        priority: Number(ro.priority ?? 0),
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
        mergeMode: (ro.merge_mode as string | null) ?? null,
        originId: (ro.origin_id as string | null) ?? null,
        fixForTaskId: (ro.fix_for_task_id as string | null) ?? null,
        kind: (ro.kind as string | null) ?? null,
        compensatesArcId: (ro.compensates_arc_id as string | null) ?? null,
        activityDetail: (ro.activity_detail as string | null) ?? null,
        createdAt: ro.created_at as string,
        updatedAt: ro.updated_at as string,
      }
    })
  },
})

/**
 * Create an AggregateReader backed by a DbClient.
 * Executes three cheap COUNT queries:
 *   - doneToday: tasks completed in the last 24 hours (rolling window).
 *   - doneTotal: all-time completed task count.
 *   - failedOpen: tasks currently in status='failed'.
 *
 * updated_at is a native PostgreSQL timestamp, so the database evaluates the
 * rolling window directly rather than relying on lexical ISO-string ordering.
 */
export const createAggregateReader = (client: DbClient): AggregateReader => ({
  async readAggregates() {
    const r = await client.execute(`
      SELECT
        (SELECT COUNT(*) FROM tasks WHERE status = 'done'
           AND updated_at >= now() - interval '1 day') AS done_today,
        (SELECT COUNT(*) FROM tasks WHERE status = 'done') AS done_total,
        (SELECT COUNT(*) FROM tasks WHERE status = 'failed' AND fix_for_task_id IS NULL) AS failed_open
    `)
    const row = r.rows[0] as unknown as Record<string, unknown>
    return {
      doneToday: Number(row?.done_today ?? 0),
      doneTotal: Number(row?.done_total ?? 0),
      failedOpen: Number(row?.failed_open ?? 0),
    }
  },
})

/**
 * Create a ProposalReader backed by a DbClient.
 * Returns ProposalNode for each of the given proposal IDs.
 * Tolerates a missing proposals table (pre-ensureSchema stores).
 */
export const createProposalReader = (client: DbClient): ProposalReader => ({
  async listByIds(ids) {
    if (ids.length === 0) return []
    const tableCheck = await client.execute(
      `SELECT to_regclass('public.proposals') AS reg`,
    )
    if (tableCheck.rows[0]?.reg == null) return []
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
