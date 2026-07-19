/**
 * tool-forge-scanner — recurrence scanner that enqueues a tool-forge task when
 * a missing-helper pattern appears in enough failed tasks.
 *
 * Algorithm:
 *  1. Query recent failed tasks from the DB.
 *  2. For each task, derive a reasonCode from the error text and run
 *     classifyMissingHelper to extract a helperKey.
 *  3. Group tasks by helperKey; count distinct arc-ids (COALESCE(origin_id, id)).
 *  4. For any helperKey whose task count reaches `threshold` AND has no
 *     existing 'proposed'/'benchmarked' ledger row, insert a
 *     tool_promotion_attempts row and call `enqueue`.
 *
 * Idempotent: the ledger-row check means re-running with unchanged data is
 * a no-op.
 */

import { randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import {
  classifyMissingHelper,
  type FailureSignature,
} from './missing-helper-classifier'
import {
  insertAttempt,
  listAttemptsByStatus,
} from '../store/tool-promotion-store'

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 3
const TASK_SCAN_LIMIT = 200
/** Cap the motivating arc ids stored per ledger row to keep blobs manageable. */
const MAX_ARC_IDS_PER_ATTEMPT = 10

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Map raw error text to the reasonCode the classifier expects.
 * Returns an empty string when neither branch fires (caller skips the row).
 */
function deriveReasonCode(errorText: string): string {
  if (/command not found/i.test(errorText)) return 'COMMAND_NOT_FOUND'
  if (/Cannot find module/i.test(errorText)) return 'MODULE_NOT_FOUND'
  return ''
}

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Callable that creates a tool-forge task and returns its id.
 * Injectable so the production CLI can delegate to the real queue path
 * while tests supply a lightweight stub.
 */
export type EnqueueToolForgeFn = (
  prompt: string,
  arcIds: string[],
) => Promise<string>

export interface ToolForgeScanOptions {
  /**
   * Minimum number of failed tasks sharing a helperKey before a forge task
   * is created. Defaults to MARS_TOOL_FORGE_THRESHOLD env var, then 3.
   */
  threshold?: number
  /**
   * Called once per new helperKey that crosses the threshold. When omitted,
   * the scan still inserts ledger rows but skips task creation.
   */
  enqueue?: EnqueueToolForgeFn
}

export interface ToolForgeScanResult {
  /** Task IDs returned by `enqueue` in this scan run. Empty on re-runs. */
  enqueued: string[]
  /** Count of classified task matches per helperKey found in this scan. */
  matchesPerKey: Record<string, number>
  /** Keys that crossed the threshold in this scan. */
  thresholdCrossed: string[]
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Walk recent failed tasks, classify missing-helper patterns, and for any
 * helperKey that reaches `threshold` distinct occurrences AND has no existing
 * 'proposed'/'benchmarked' ledger row: insert a tool_promotion_attempts row
 * (status='proposed') and call `opts.enqueue`.
 *
 * Returns a summary suitable for CLI display.
 */
export async function scanForRecurringHelperGaps(
  db: Client,
  opts: ToolForgeScanOptions = {},
): Promise<ToolForgeScanResult> {
  const threshold =
    opts.threshold ??
    Number(process.env.MARS_TOOL_FORGE_THRESHOLD ?? String(DEFAULT_THRESHOLD))

  // ── Step 1: query failed tasks ─────────────────────────────────────────────
  const taskResult = await db.execute({
    sql: `SELECT id, error, origin_id FROM tasks
          WHERE status = 'failed'
          ORDER BY created_at DESC
          LIMIT ?`,
    args: [TASK_SCAN_LIMIT],
  })

  // ── Step 2: classify each task ────────────────────────────────────────────
  // We track distinct task-ids for threshold counting and distinct arc-ids for
  // the motivating_arc_ids blob written to the ledger.
  const matchesByKey = new Map<
    string,
    { taskIds: string[]; arcIds: string[] }
  >()

  for (const row of taskResult.rows) {
    const errorText = String(row.error ?? '')
    const reasonCode = deriveReasonCode(errorText)
    if (!reasonCode) continue

    const sig: FailureSignature = { reasonCode, snippet: errorText }
    const match = classifyMissingHelper(sig)
    if (!match) continue

    const key = match.helperKey
    const taskId = String(row.id)
    const arcId = String(row.origin_id ?? row.id)

    const entry = matchesByKey.get(key)
    if (!entry) {
      matchesByKey.set(key, { taskIds: [taskId], arcIds: [arcId] })
    } else {
      if (!entry.taskIds.includes(taskId)) entry.taskIds.push(taskId)
      if (!entry.arcIds.includes(arcId)) entry.arcIds.push(arcId)
    }
  }

  // ── Step 3: find keys that already have a ledger row ──────────────────────
  const [proposedAttempts, benchmarkedAttempts] = await Promise.all([
    listAttemptsByStatus(db, 'proposed'),
    listAttemptsByStatus(db, 'benchmarked'),
  ])
  const existingKeys = new Set([
    ...proposedAttempts.map((a) => a.helperKey),
    ...benchmarkedAttempts.map((a) => a.helperKey),
  ])

  // ── Step 4: build result and act on new threshold crossings ───────────────
  const matchesPerKey: Record<string, number> = {}
  const thresholdCrossed: string[] = []
  const enqueued: string[] = []

  for (const [helperKey, data] of matchesByKey) {
    matchesPerKey[helperKey] = data.taskIds.length

    if (data.taskIds.length < threshold) continue
    thresholdCrossed.push(helperKey)

    if (existingKeys.has(helperKey)) continue // idempotency guard

    // Insert the ledger row first — even when enqueue is absent, so a later
    // run with enqueue supplied won't double-count.
    await insertAttempt(db, {
      id: randomUUID(),
      helperKey,
      motivatingArcIds: data.arcIds.slice(0, MAX_ARC_IDS_PER_ATTEMPT),
      createdAt: Math.floor(Date.now() / 1000),
    })

    if (opts.enqueue) {
      const taskId = await opts.enqueue(
        `[tool-forge] Generate missing helper: ${helperKey}\n\n` +
          `This helper was absent in ${data.taskIds.length} failed task(s).\n` +
          `Motivating arc ids: ${data.arcIds.join(', ')}\n\n` +
          `Create a reusable implementation and add it to the coder toolbox.`,
        data.arcIds,
      )
      enqueued.push(taskId)
    }
  }

  return { enqueued, matchesPerKey, thresholdCrossed }
}
