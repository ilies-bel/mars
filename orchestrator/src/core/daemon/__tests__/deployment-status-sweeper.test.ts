/**
 * deployment-status-sweeper — behaviour tests.
 *
 * Uses vitest fake timers and vi.mock() so the sweeper can be driven purely
 * in-process without a real database or deployment provider.  The mocks
 * stand in for every cross-boundary import; the assertions verify only
 * observable side-effects (which downstream calls are made, with what args).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Module mocks (hoisted before any real imports) ──────────────────────────

vi.mock('../../context.js', () => ({
  resolveDbTarget: vi.fn().mockReturnValue('test-dsn'),
}))

vi.mock('../../lib/db.js', () => ({
  openDb: vi.fn(),
}))

vi.mock('../../lib/deployment/registry.js', () => ({
  getProvider: vi.fn(),
}))

vi.mock('../../lib/action-queue.js', () => ({
  patchOpenActionQueuePayload: vi.fn(),
}))

// ── Imports (after mock registrations) ──────────────────────────────────────

import { startDeploymentStatusSweeper } from '../deployment-status-sweeper.js'
import { openDb } from '../../lib/db.js'
import { getProvider } from '../../lib/deployment/registry.js'
import { patchOpenActionQueuePayload } from '../../lib/action-queue.js'
import type { DbClient } from '../../lib/db.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a fake DbClient whose execute() returns the provided sequences. */
function makeFakeClient(executeResponses: Array<{ rows: unknown[]; rowsAffected: number }>): {
  client: DbClient
  executeMock: ReturnType<typeof vi.fn>
} {
  let callIdx = 0
  const executeMock = vi.fn().mockImplementation(() => {
    const resp = executeResponses[callIdx++] ?? { rows: [], rowsAffected: 0 }
    return Promise.resolve(resp)
  })
  const client = {
    execute: executeMock,
    batch: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as DbClient
  return { client, executeMock }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('startDeploymentStatusSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // ── Criterion: pending → ready transition patches action-queue ───────────

  it('calls provider.status() and patches action-queue payload on ready transition', async () => {
    const { client, executeMock } = makeFakeClient([
      // 1. timeout UPDATE — no rows affected
      { rows: [], rowsAffected: 0 },
      // 2. SELECT pending — one row
      {
        rows: [{ deployment_id: 'dep-abc', task_id: 'task-xyz', provider: 'noop' }],
        rowsAffected: 0,
      },
      // 3. UPDATE to ready
      { rows: [], rowsAffected: 1 },
    ])

    vi.mocked(openDb).mockReturnValue(client)

    const statusFn = vi.fn().mockResolvedValue({
      status: 'ready',
      url: 'https://preview.example.com/task-xyz',
    })
    vi.mocked(getProvider).mockReturnValue({
      status: statusFn,
      deploy: vi.fn(),
      logs: vi.fn(),
      teardown: vi.fn(),
    })
    vi.mocked(patchOpenActionQueuePayload).mockResolvedValue('aq-item-1')

    const sweeper = startDeploymentStatusSweeper({ intervalMs: 50 })

    // Advance fake clock → triggers the first interval tick
    await vi.advanceTimersByTimeAsync(50)

    // Provider was asked for deployment status
    expect(statusFn).toHaveBeenCalledWith('dep-abc')

    // Row was updated to ready
    const readyUpdateCall = executeMock.mock.calls[2][0] as { sql: string; args: unknown[] }
    expect(readyUpdateCall.sql).toMatch(/status\s*=\s*'ready'/)
    expect(readyUpdateCall.args).toContain('dep-abc')

    // Action-queue payload patched with remoteUrl
    expect(vi.mocked(patchOpenActionQueuePayload)).toHaveBeenCalledWith('task-xyz', {
      remoteUrl: 'https://preview.example.com/task-xyz',
    })

    sweeper.stop()
  })

  // ── Criterion: timeout branch marks old rows failed ──────────────────────

  it('issues timeout UPDATE before polling recent pending rows', async () => {
    const { client, executeMock } = makeFakeClient([
      // 1. timeout UPDATE — one timed-out row affected
      { rows: [], rowsAffected: 1 },
      // 2. SELECT pending — nothing left (the row was timed out)
      { rows: [], rowsAffected: 0 },
    ])

    vi.mocked(openDb).mockReturnValue(client)
    // getProvider is not expected to be called since SELECT returns no rows
    vi.mocked(getProvider).mockReturnValue(undefined)

    const sweeper = startDeploymentStatusSweeper({ intervalMs: 50 })

    await vi.advanceTimersByTimeAsync(50)

    // First call must be the timeout UPDATE
    const timeoutSql = (executeMock.mock.calls[0][0] as string | { sql: string })
    const sqlText = typeof timeoutSql === 'string' ? timeoutSql : timeoutSql.sql ?? String(timeoutSql)
    expect(sqlText).toMatch(/status\s*=\s*'failed'/)
    expect(sqlText).toMatch(/error\s*=\s*'deploy timeout'/)
    expect(sqlText).toMatch(/30 minutes/)

    // SELECT follows the UPDATE
    const selectSql = (executeMock.mock.calls[1][0] as string | { sql: string })
    const selectText = typeof selectSql === 'string' ? selectSql : selectSql.sql ?? String(selectSql)
    expect(selectText).toMatch(/SELECT/)
    expect(selectText).toMatch(/status\s*=\s*'pending'/)

    // No provider lookup was needed
    expect(vi.mocked(getProvider)).not.toHaveBeenCalled()

    sweeper.stop()
  })

  // ── Criterion: interval fires repeatedly; stop() cancels it ──────────────

  it('fires on each interval tick and stops cleanly', async () => {
    const { client } = makeFakeClient([])
    // Return an empty client for all ticks
    vi.mocked(openDb).mockReturnValue(client)

    const sweeper = startDeploymentStatusSweeper({ intervalMs: 100 })

    await vi.advanceTimersByTimeAsync(350) // 3 ticks: 100, 200, 300
    const callsAfter3 = vi.mocked(openDb).mock.calls.length
    expect(callsAfter3).toBeGreaterThanOrEqual(3)

    sweeper.stop()
    await vi.advanceTimersByTimeAsync(200) // no new ticks after stop
    expect(vi.mocked(openDb).mock.calls.length).toBe(callsAfter3)
  })
})
