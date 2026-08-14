/**
 * Optimised failed-arc derivation for the Alert read aggregate (ADR-0054).
 *
 * The original implementation in buildAlertSources (server.ts) called
 * store.arcStatus() sequentially for every arc — each call issued a SQL
 * query AND a `git log --grep` subprocess. With 20+ failed arcs this caused
 * GET /alerts to time out (504) because the per-arc cost compounded to
 * multiple seconds.
 *
 * This module fixes that by:
 *   1. Computing arc-failed status inline from the tasks already loaded by
 *      listTasks() — zero additional DB round-trips or git subprocesses.
 *   2. Batching the parent_proposal_id lookup for all failed-arc origins into
 *      one query instead of N.
 *   3. Fetching all referenced proposals in parallel (Promise.all) instead
 *      of sequentially.
 *   4. Computing blocked counts for ALL arcs in a single aggregated query
 *      instead of one IN-clause query per arc.
 *
 * Net result: O(1) fixed DB round-trips regardless of arc count, bounded
 * only by the proposal fetches which are already parallel.
 */

import { listTasks, resolveQueueClient } from '../queue'
import { getProposal } from '../proposals'
import type { AlertChainNode, AlertDescendant, FailedArcRecord } from './alert'

const TERMINAL = new Set(['done', 'failed', 'dropped'])

const truncateLabel = (prompt: string): string => {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length <= 80 ? flat : `${flat.slice(0, 79)}…`
}

/**
 * Derives failed-arc records from the task database.
 *
 * A failed arc is one where every task is terminal AND none reached `'done'`
 * (same predicate as `arcStatus() === 'arc-failed'`). The derivation is done
 * entirely in-memory from the `listTasks()` result; no per-arc DB queries or
 * git subprocesses are issued.
 */
export const listFailedArcs = async (): Promise<FailedArcRecord[]> => {
  const tasks = await listTasks()
  const client = resolveQueueClient()

  // Group tasks by resolved arc root (originId = origin_id ?? id).
  type TaskList = typeof tasks
  const byArc = new Map<string, TaskList>()
  for (const t of tasks) {
    const arcId = t.originId
    const bucket = byArc.get(arcId) ?? []
    bucket.push(t)
    byArc.set(arcId, bucket)
  }

  // Compute arc-failed status inline — no arcStatus() calls, no git subprocesses.
  const failedArcEntries: Array<[string, TaskList]> = []
  for (const [arcId, arcTasks] of byArc) {
    if (!arcTasks.every((t) => TERMINAL.has(t.status))) continue // in-progress
    if (arcTasks.some((t) => t.status === 'done')) continue // arc-done
    failedArcEntries.push([arcId, arcTasks])
  }

  if (failedArcEntries.length === 0) return []

  const allOriginIds = failedArcEntries.map(([arcId]) => arcId)

  // Batch 1: parent_proposal_id for all failed-arc origins — one query.
  const pPlaceholders = allOriginIds.map(() => '?').join(', ')
  const pRows = await client.execute({
    sql: `SELECT id, parent_proposal_id FROM tasks WHERE id IN (${pPlaceholders})`,
    args: allOriginIds,
  })
  const arcToProposalId = new Map<string, string | null>()
  for (const row of pRows.rows) {
    const r = row as unknown as { id: string; parent_proposal_id: string | null }
    arcToProposalId.set(r.id, r.parent_proposal_id ?? null)
  }

  // Batch 2: fetch all referenced proposals in parallel.
  const neededProposalIds = [
    ...new Set(
      [...arcToProposalId.values()].filter((id): id is string => id !== null),
    ),
  ]
  const proposalMap = new Map<string, Awaited<ReturnType<typeof getProposal>>>()
  await Promise.all(
    neededProposalIds.map(async (pId) => {
      proposalMap.set(pId, await getProposal(pId))
    }),
  )

  // Batch 3: blocked counts in one aggregated query across all arc tasks.
  // Build a taskId → arcId lookup so we can aggregate per arc after the query.
  const taskToArc = new Map<string, string>()
  for (const [arcId, arcTasks] of failedArcEntries) {
    for (const t of arcTasks) taskToArc.set(t.id, arcId)
  }
  const allArcTaskIds = [...taskToArc.keys()]
  const arcBlockedCounts = new Map<string, number>()
  try {
    const bPlaceholders = allArcTaskIds.map(() => '?').join(', ')
    const blockedResult = await client.execute({
      sql: `SELECT DISTINCT tb.blocker_task_id, tb.task_id AS blocked_task_id
              FROM task_blockers tb
              JOIN tasks t ON t.id = tb.task_id
             WHERE tb.blocker_task_id IN (${bPlaceholders})
               AND t.status = 'blocked'`,
      args: allArcTaskIds,
    })
    const arcBlockedSets = new Map<string, Set<string>>()
    for (const row of blockedResult.rows) {
      const r = row as unknown as {
        blocker_task_id: string
        blocked_task_id: string
      }
      const arcId = taskToArc.get(r.blocker_task_id)
      if (arcId === undefined) continue
      const s = arcBlockedSets.get(arcId) ?? new Set<string>()
      s.add(r.blocked_task_id)
      arcBlockedSets.set(arcId, s)
    }
    for (const [arcId, s] of arcBlockedSets) {
      arcBlockedCounts.set(arcId, s.size)
    }
  } catch {
    // Non-fatal: blocked count unavailable — leave zero for all arcs.
  }

  // Build records — all data is now in-memory; no further I/O.
  const records: FailedArcRecord[] = []
  for (const [arcId, arcTasks] of failedArcEntries) {
    const origin = arcTasks.find((t) => t.id === arcId) ?? arcTasks[0]!

    // Pick the terminal task carrying the failure signal.
    const failing =
      arcTasks.find((t) => t.status === 'failed' && t.failureSignature !== null) ??
      arcTasks.find((t) => t.status === 'failed') ??
      arcTasks.find((t) => t.status === 'dropped') ??
      origin

    const capturedError = failing.error ?? ''
    const descendants: AlertDescendant[] = arcTasks
      .filter((t) => t.id !== arcId)
      .map((t) => ({ id: t.id, status: t.status }))

    const parentProposalId = arcToProposalId.get(arcId) ?? null
    const proposal = parentProposalId
      ? (proposalMap.get(parentProposalId) ?? null)
      : null

    const restartTasks = arcTasks.filter(
      (t) => t.id !== arcId && t.fixForTaskId === null && t.kind !== 'fix',
    )
    const recoveryTasks = arcTasks.filter(
      (t) => t.id !== arcId && (t.fixForTaskId !== null || t.kind === 'fix'),
    )

    const chain: AlertChainNode[] = [
      ...(proposal
        ? [
            {
              kind: 'proposal' as const,
              id: proposal.id,
              status: proposal.status,
              label: proposal.title || proposal.id,
            },
          ]
        : []),
      {
        kind: 'task' as const,
        id: arcId,
        status: origin.status,
        label: truncateLabel(origin.prompt),
        attemptIndex: 1,
      },
      ...restartTasks.map((t, i) => ({
        kind: 'task' as const,
        id: t.id,
        status: t.status,
        label: truncateLabel(t.prompt),
        attemptIndex: i + 2,
      })),
      ...recoveryTasks.map((t) => ({
        kind: 'task' as const,
        id: t.id,
        status: t.status,
        label: truncateLabel(t.prompt),
      })),
    ]

    records.push({
      arcId,
      goal: origin.intent || origin.prompt,
      failureSignature: failing.failureSignature,
      capturedError,
      traceTail: capturedError,
      descendants,
      chain,
      failedPhase: failing.failedPhase ?? null,
      blockedCount: arcBlockedCounts.get(arcId) ?? 0,
    })
  }
  return records
}
