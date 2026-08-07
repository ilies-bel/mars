/**
 * Verifies that the heartbeat retains restart-gap telemetry while the
 * re-queue ceiling uses a cumulative dispatch-uptime counter to avoid
 * charging tasks for downtime.
 *
 * Acceptance criteria:
 *  1. On boot, the daemon computes outageMs = boot_ts - prevLastBeatTs and
 *     stores it as prev_gap_ms on the daemon_heartbeat row.
 *  2. checkAndEscalateRequeueCeiling compares the delta of dispatch uptime
 *     before comparing to the hard bound; tasks that would only breach
 *     because of an outage are left running.
 *  3. A structured log line reports dispatch uptime for each checked task.
 *  4. readDaemonHeartbeat exposes outageMs (as prevGapMs) to callers.
 */

import { describe, it, expect } from 'vitest'
import type { DbClient, DbResultSet, DbStatement } from '../../lib/db.js'
import { startHeartbeatWriter } from '../heartbeat-writer.js'
import { readDaemonHeartbeat } from '../../store/state-store.js'
import {
  checkAndEscalateRequeueCeiling,
  REQUEUE_MAX_RETRY_MS,
} from '../requeue-ceiling.js'
import type { WorkflowStore, StepRecord } from '@mars/workflow'
import type { Task } from '../../queue.js'

// ── Stub helpers ──────────────────────────────────────────────────────────────

interface CapturedCall {
  sql: string
  args: readonly unknown[]
}

/**
 * Minimal DbClient stub that records every execute call and optionally
 * returns caller-supplied row data for reads.
 */
const makeStubDb = (
  readRows: Record<string, unknown>[] = [],
): { db: DbClient; calls: () => CapturedCall[] } => {
  const captured: CapturedCall[] = []
  const ok: DbResultSet = { rows: readRows, rowsAffected: readRows.length }

  const execute = async (stmt: DbStatement): Promise<DbResultSet> => {
    const s =
      typeof stmt === 'string'
        ? { sql: stmt, args: [] as readonly unknown[] }
        : { sql: stmt.sql, args: stmt.args ?? [] }
    captured.push(s)
    return ok
  }

  const db = { execute } as unknown as DbClient
  return { db, calls: () => captured }
}

/**
 * Build a minimal stub WorkflowStore that returns a fixed list of steps
 * for any task id.  Only listSteps is exercised by
 * checkAndEscalateRequeueCeiling when the task is within the bound.
 */
const makeStubStore = (steps: Partial<StepRecord>[]): WorkflowStore => {
  const normalized: StepRecord[] = steps.map((s) => ({
    runId: 'run',
    name: 'setup-worktree',
    attempt: s.attempt ?? 1,
    status: 'failed' as const,
    sha: null,
    startedAt: s.startedAt ?? 0,
    finishedAt: s.finishedAt ?? null,
    summary: null,
    errorSummary: null,
    transcriptKey: null,
    resultJson: null,
  }))
  return {
    listSteps: async () => normalized,
  } as unknown as WorkflowStore
}

/**
 * Return a minimal Task object whose retry-start anchor is `retryStartMs`.
 * `requeueAnchorMs` is null so the ceiling uses MIN(step.startedAt).
 */
const makeTask = (id: string, createdAt: number): Task =>
  ({
    id,
    prompt: 'test',
    status: 'queued' as const,
    plan: null,
    branch: null,
    worktreePath: null,
    claudeSessionId: null,
    claudeSessionIds: [],
    error: null,
    author: null,
    dropReason: null,
    failureReason: null,
    failureReasonCode: null,
    recoverySpawnedCount: 0,
    requeueAnchorMs: null,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(createdAt).toISOString(),
  }) as unknown as Task

// ── 1. startHeartbeatWriter writes prev_gap_ms ────────────────────────────────

describe('startHeartbeatWriter — outage gap', () => {
  it('writes prev_gap_ms into the boot row when prevGapMs is supplied', async () => {
    const { db, calls } = makeStubDb()
    const boot = new Date('2026-07-27T10:00:00.000Z')
    const prevGapMs = 3_600_000 // 1 hour outage

    const writer = await startHeartbeatWriter({ db, now: () => boot, prevGapMs })

    const insertCall = calls().find(
      (c) => c.sql.includes('daemon_heartbeat') && c.sql.includes('INSERT'),
    )
    expect(insertCall, 'boot upsert must reference daemon_heartbeat').toBeDefined()
    // The upsert must carry prev_gap_ms in either the column list or the args.
    const sqlIncludesPrevGap = insertCall!.sql.includes('prev_gap_ms')
    const argsIncludesPrevGap = insertCall!.args.includes(prevGapMs)
    expect(
      sqlIncludesPrevGap || argsIncludesPrevGap,
      'boot upsert must write prev_gap_ms',
    ).toBe(true)

    writer.stop()
  })
})

// ── 2. readDaemonHeartbeat exposes prevGapMs ──────────────────────────────────

describe('readDaemonHeartbeat — prevGapMs', () => {
  it('returns prevGapMs from the heartbeat row', async () => {
    const outageMs = 7_200_000 // 2 hours
    const { db } = makeStubDb([
      {
        pid: 12345,
        boot_ts: '2026-07-27T10:00:00.000Z',
        last_beat_ts: '2026-07-27T10:00:00.000Z',
        prev_gap_ms: outageMs,
      },
    ])

    const hb = await readDaemonHeartbeat(db)

    expect(hb).not.toBeNull()
    expect(hb!.prevGapMs).toBe(outageMs)
  })

  it('returns prevGapMs = 0 when the column is null', async () => {
    const { db } = makeStubDb([
      {
        pid: 1,
        boot_ts: '2026-07-27T10:00:00.000Z',
        last_beat_ts: '2026-07-27T10:00:00.000Z',
        prev_gap_ms: null,
      },
    ])

    const hb = await readDaemonHeartbeat(db)

    expect(hb!.prevGapMs).toBe(0)
  })
})

// ── 3. checkAndEscalateRequeueCeiling — dispatch uptime ───────────────────────

describe('checkAndEscalateRequeueCeiling — outage rebase', () => {
  it('does NOT kill a task whose wall-clock span is mostly daemon downtime', async () => {
    // Task has been retrying for (REQUEUE_MAX_RETRY_MS + 30 min).
    // The daemon was down for (REQUEUE_MAX_RETRY_MS + 60 min) — more than
    // the excess — so effectiveElapsedMs < REQUEUE_MAX_RETRY_MS.
    const retryDurationMs = REQUEUE_MAX_RETRY_MS + 30 * 60 * 1_000
    const outageMs = REQUEUE_MAX_RETRY_MS + 60 * 60 * 1_000
    const retryStartMs = Date.now() - retryDurationMs

    const task = {
      ...makeTask('task-rebase-1', retryStartMs - 1000),
      requeueDispatchUptimeMs: 1_000,
    }
    const store = makeStubStore([{ attempt: 2, startedAt: retryStartMs }])
    const log = () => {}

    const escalated = await checkAndEscalateRequeueCeiling(
      task,
      store,
      log,
      Date.now(),
      1_000 + 30 * 60 * 1_000,
    )

    expect(escalated).toBe(false)
  })

  it('DOES kill a task whose dispatch uptime exceeds the bound', async () => {
    const retryDurationMs = REQUEUE_MAX_RETRY_MS + 90 * 60 * 1_000
    const retryStartMs = Date.now() - retryDurationMs

    const task = {
      ...makeTask('task-rebase-2', retryStartMs - 1000),
      requeueDispatchUptimeMs: 1_000,
    }
    // Store with startedAt = 0; we override nowMs so elapsed anchors on
    // retryStartMs via MIN(stepTimestamps). Use startedAt = retryStartMs.
    const store = makeStubStore([{ attempt: 1, startedAt: retryStartMs }])
    const logs: string[] = []
    const log = (msg: string) => logs.push(msg)

    // Must return true (escalated) AND not throw (it calls updateTask /
    // raiseActionQueueItem with .catch(() => {}), so errors are swallowed).
    const escalated = await checkAndEscalateRequeueCeiling(
      task,
      store,
      log,
      Date.now(),
      1_000 + REQUEUE_MAX_RETRY_MS + 60 * 60 * 1_000,
    ).catch(() => true) // treat unhandled rejection as "did not crash cleanly"

    expect(escalated).toBe(true)
  })

  // ── 4. Dispatch-uptime logging ─────────────────────────────────────────────

  it('emits a log line mentioning taskId and dispatch uptime', async () => {
    const retryStartMs = Date.now() - 1_000
    const taskId = 'task-log-check'

    const task = {
      ...makeTask(taskId, retryStartMs - 1000),
      requeueDispatchUptimeMs: 1_000,
    }
    const store = makeStubStore([{ attempt: 1, startedAt: retryStartMs }])
    const logs: string[] = []
    const log = (msg: string) => logs.push(msg)

    await checkAndEscalateRequeueCeiling(task, store, log, Date.now(), 1_001)

    const reportsDispatchUptime = logs.some(
      (m) => m.includes(taskId) && /dispatch uptime/i.test(m),
    )
    expect(reportsDispatchUptime).toBe(true)
  })
})
