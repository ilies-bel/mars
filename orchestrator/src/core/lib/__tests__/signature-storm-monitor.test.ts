/**
 * Unit tests for the signature-storm circuit breaker.
 *
 * Tests are structured in two layers:
 *  1. `recordFailureSignature` / `resetFailureSignatureStreak` — unit tests
 *     that exercise the public monitor API directly against a real DB.
 *  2. Integration through the recovery-spawn subscriber — verifies that the
 *     storm callback fires and that the action-queue row is raised when the
 *     threshold is met in production choreography (task.failed → drain).
 *
 * Tests observe behaviour through the public interface only. No assertions on
 * private state — the DB row is treated as observable state (it IS the public
 * contract across daemon restarts).
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { DbClient } from '../db.js'
import type { EventName, EventPayload } from '../../../bus/events.js'

// ---------------------------------------------------------------------------
// Module type shims
// ---------------------------------------------------------------------------

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  ensureQueueSchema: typeof import('../../queue').ensureQueueSchema
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../action-queue').listActionQueueItems
}

interface StormMonitorModule {
  recordFailureSignature: typeof import('../signature-storm-monitor').recordFailureSignature
  resetFailureSignatureStreak: typeof import('../signature-storm-monitor').resetFailureSignatureStreak
  SIGNATURE_STORM_TRIP_THRESHOLD: typeof import('../signature-storm-monitor').SIGNATURE_STORM_TRIP_THRESHOLD
  SIGNATURE_STORM_ACTION_QUEUE_KIND: typeof import('../signature-storm-monitor').SIGNATURE_STORM_ACTION_QUEUE_KIND
}

interface RecoverySpawnModule {
  RECOVERY_SPAWN_SUBSCRIBER: typeof import('../../../outbox/subscribers/recovery-spawn').RECOVERY_SPAWN_SUBSCRIBER
  ensureRecoverySpawner: typeof import('../../../outbox/subscribers/recovery-spawn').ensureRecoverySpawner
  drainRecoverySpawner: typeof import('../../../outbox/subscribers/recovery-spawn').drainRecoverySpawner
}

interface PublisherModule {
  publishWithRetry: typeof import('../../../bus/publisher').publishWithRetry
}

interface CircuitBreakerModule {
  apiCircuitBreaker: typeof import('../api-circuit-breaker').apiCircuitBreaker
}

interface Loaded {
  q: QueueModule
  aq: ActionQueueModule
  sm: StormMonitorModule
  rs: RecoverySpawnModule
  pub: PublisherModule
  cb: CircuitBreakerModule
  client: DbClient
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-storm-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (repo: string): Promise<Loaded> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.ensureQueueSchema()
  const aq = (await import('../action-queue')) as unknown as ActionQueueModule
  const sm = (await import('../signature-storm-monitor')) as unknown as StormMonitorModule
  const rs = (await import('../../../outbox/subscribers/recovery-spawn')) as unknown as RecoverySpawnModule
  const pub = (await import('../../../bus/publisher')) as unknown as PublisherModule
  const cb = (await import('../api-circuit-breaker')) as unknown as CircuitBreakerModule
  return { q, aq, sm, rs, pub, cb, client: q.resolveQueueClient() }
}

const publish = async <T extends EventName>(
  pub: PublisherModule,
  client: DbClient,
  type: T,
  payload: EventPayload<T>,
): Promise<void> => {
  await pub.publishWithRetry(client, type, payload)
}

const countStormRows = async (aq: ActionQueueModule): Promise<number> => {
  const items = await aq.listActionQueueItems('open')
  return items.filter((i) => (i as { kind?: string }).kind === 'signature-storm').length
}

// ---------------------------------------------------------------------------
// Unit tests: recordFailureSignature / resetFailureSignatureStreak
// ---------------------------------------------------------------------------

describe('signature-storm-monitor — unit', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_SIGNATURE_STORM_THRESHOLD
    rmSync(repo, { recursive: true, force: true })
  })

  it('increments streak for consecutive identical signatures on different tasks', async () => {
    const { sm, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'

    const r1 = await sm.recordFailureSignature(client, 'task-1', sig)
    expect(r1.streak).toBe(1)
    expect(r1.tripped).toBe(false)

    const r2 = await sm.recordFailureSignature(client, 'task-2', sig)
    expect(r2.streak).toBe(2)
    expect(r2.tripped).toBe(false)
  })

  it('does NOT advance the streak when the same task fails with the same signature twice', async () => {
    const { sm, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'

    const r1 = await sm.recordFailureSignature(client, 'task-1', sig)
    expect(r1.streak).toBe(1)

    // Same task — streak must hold at 1.
    const r2 = await sm.recordFailureSignature(client, 'task-1', sig)
    expect(r2.streak).toBe(1)
    expect(r2.tripped).toBe(false)
  })

  it('resets streak to 1 when a different signature appears', async () => {
    const { sm, client } = await loadModules(repo)

    await sm.recordFailureSignature(client, 'task-1', 'verify:has-diff/no-commits-ahead')
    await sm.recordFailureSignature(client, 'task-2', 'verify:has-diff/no-commits-ahead')

    // Different signature — streak should restart at 1.
    const r = await sm.recordFailureSignature(client, 'task-3', 'setup:install-failed/unclassified')
    expect(r.streak).toBe(1)
    expect(r.tripped).toBe(false)
  })

  it('trips at SIGNATURE_STORM_TRIP_THRESHOLD and returns tripped=true, alreadyTripped=false', async () => {
    const { sm, aq, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD // default 3

    for (let i = 0; i < K - 1; i++) {
      const r = await sm.recordFailureSignature(client, `task-${i}`, sig)
      expect(r.tripped).toBe(false)
    }

    // The K-th call trips the breaker.
    const trip = await sm.recordFailureSignature(client, `task-${K - 1}`, sig)
    expect(trip.streak).toBe(K)
    expect(trip.tripped).toBe(true)
    expect(trip.alreadyTripped).toBe(false)

    // Exactly one action-queue row is raised.
    expect(await countStormRows(aq)).toBe(1)
  })

  it('returns alreadyTripped=true on subsequent calls after the breaker trips', async () => {
    const { sm, aq, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    // Trip the breaker.
    for (let i = 0; i < K; i++) {
      await sm.recordFailureSignature(client, `task-${i}`, sig)
    }
    expect(await countStormRows(aq)).toBe(1)

    // Two more failures with the same signature — must be idempotent.
    const r1 = await sm.recordFailureSignature(client, 'task-extra-1', sig)
    expect(r1.tripped).toBe(true)
    expect(r1.alreadyTripped).toBe(true)

    const r2 = await sm.recordFailureSignature(client, 'task-extra-2', sig)
    expect(r2.tripped).toBe(true)
    expect(r2.alreadyTripped).toBe(true)

    // Still exactly ONE action-queue row — no duplicate rows raised.
    expect(await countStormRows(aq)).toBe(1)
  })

  it('resetFailureSignatureStreak clears the streak so a new storm can trip independently', async () => {
    const { sm, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    // Trip the breaker.
    for (let i = 0; i < K; i++) {
      await sm.recordFailureSignature(client, `task-${i}`, sig)
    }
    const tripped = await sm.recordFailureSignature(client, 'task-post-trip', sig)
    expect(tripped.alreadyTripped).toBe(true)

    // Reset — simulates a successful task completing.
    await sm.resetFailureSignatureStreak(client)

    // After reset, the streak should start fresh.
    const fresh = await sm.recordFailureSignature(client, 'task-new-1', sig)
    expect(fresh.streak).toBe(1)
    expect(fresh.tripped).toBe(false)
    expect(fresh.alreadyTripped).toBe(false)
  })

  it('threshold is overridable via MARS_SIGNATURE_STORM_THRESHOLD env var', async () => {
    process.env.MARS_SIGNATURE_STORM_THRESHOLD = '2'
    const { sm } = await loadModules(repo)
    expect(sm.SIGNATURE_STORM_TRIP_THRESHOLD).toBe(2)
  })

  it('handles env var gracefully: falls back to 3 for non-numeric values', async () => {
    process.env.MARS_SIGNATURE_STORM_THRESHOLD = 'not-a-number'
    const { sm } = await loadModules(repo)
    expect(sm.SIGNATURE_STORM_TRIP_THRESHOLD).toBe(3)
  })

  it('resetFailureSignatureStreak is a no-op when no row exists (first call)', async () => {
    const { sm, client } = await loadModules(repo)
    // Must not throw when the singleton row does not yet exist.
    await expect(sm.resetFailureSignatureStreak(client)).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Integration: storm trip through the recovery-spawn subscriber
// ---------------------------------------------------------------------------

describe('signature-storm — integration via recovery-spawn subscriber', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_SIGNATURE_STORM_THRESHOLD
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  // Signature that classifies to 'unclassified' — mimics disk-full or any
  // environmental failure with no registered error-class rule.
  const STEP = 'setup'
  const ENV_ERROR = 'ENOSPC: no space left on device — install failed'
  const SIG = 'setup/unclassified'

  /**
   * Fail a fresh origin task and drain the subscriber. Returns the task id.
   * Registers the subscriber cursor BEFORE creating the first task so every
   * failure event is captured.
   */
  const failTask = async (
    loaded: Loaded,
    index: number,
    stormCb?: Parameters<typeof loaded.rs.drainRecoverySpawner>[2],
  ): Promise<string> => {
    const { q, rs, client } = loaded
    const t = await q.enqueueTask(`storm task ${index}`, undefined, { skipTriage: true })
    // Directly transition to failed — same path as the setup step in production.
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: null,
      failureReason: STEP,
      error: ENV_ERROR,
    })
    await rs.drainRecoverySpawner(client, undefined, stormCb)
    return t.id
  }

  it('trips at threshold and fires the onStormTripped callback exactly once', async () => {
    const loaded = await loadModules(repo)
    const { sm, rs, client } = loaded
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)

    const trips: Array<{ signature: string; streak: number; lastTaskId: string }> = []
    const stormCb = (opts: { signature: string; streak: number; lastTaskId: string }): void => {
      trips.push(opts)
    }

    // First K-1 failures — below threshold, callback must not fire.
    for (let i = 0; i < K - 1; i++) {
      await failTask(loaded, i, stormCb)
    }
    expect(trips).toHaveLength(0)

    // K-th failure — trips the breaker, callback fires once.
    const lastId = await failTask(loaded, K - 1, stormCb)
    expect(trips).toHaveLength(1)
    expect(trips[0].signature).toContain(STEP)
    expect(trips[0].streak).toBe(K)
    expect(trips[0].lastTaskId).toBe(lastId)

    // Subsequent failures — callback must NOT fire again (alreadyTripped).
    await failTask(loaded, K, stormCb)
    await failTask(loaded, K + 1, stormCb)
    expect(trips).toHaveLength(1)
  })

  it('raises exactly one signature-storm action-queue row on first trip', async () => {
    const loaded = await loadModules(repo)
    const { sm, rs, aq, client } = loaded
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)

    // Below threshold.
    for (let i = 0; i < K - 1; i++) {
      await failTask(loaded, i)
    }
    expect(await countStormRows(aq)).toBe(0)

    // First trip.
    await failTask(loaded, K - 1)
    expect(await countStormRows(aq)).toBe(1)

    // Two more — still exactly one row (idempotent episode).
    await failTask(loaded, K)
    await failTask(loaded, K + 1)
    expect(await countStormRows(aq)).toBe(1)
  })

  it('marks the tripping task failed with no fix-task spawned', async () => {
    const loaded = await loadModules(repo)
    const { q, sm, rs, client } = loaded
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)

    for (let i = 0; i < K - 1; i++) {
      await failTask(loaded, i)
    }

    // K-th task is the one that trips.
    const trippedId = await failTask(loaded, K - 1)

    const tripped = await q.getTask(trippedId)
    expect(tripped?.status).toBe('failed')
    // failureReason carries the storm prefix.
    expect(tripped?.failureReason).toMatch(/^signature-storm:/)

    // No fix-task spawned — the problem is systemic, not per-task.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [trippedId],
    })
    expect(fixRows.rows).toHaveLength(0)
  })

  it('does not trip when the same task fails repeatedly', async () => {
    const loaded = await loadModules(repo)
    const { q, sm, rs, aq, pub, client } = loaded
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    const t = await q.enqueueTask('repeat-fail task', undefined, { skipTriage: true })
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: null,
      failureReason: STEP,
      error: ENV_ERROR,
    })
    await rs.ensureRecoverySpawner(client)

    const trips: unknown[] = []
    // Publish the same task's failure K+2 times.
    for (let i = 0; i < K + 2; i++) {
      await publish(pub, client, 'task.failed', { taskId: t.id, error: ENV_ERROR })
      await rs.drainRecoverySpawner(client, undefined, () => { trips.push(1) })
    }

    expect(trips).toHaveLength(0)
    expect(await countStormRows(aq)).toBe(0)
  })

  it('resets streak after a successful task so a new storm can trip independently', async () => {
    const loaded = await loadModules(repo)
    const { sm, rs, aq, client } = loaded
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)

    // Trip once.
    for (let i = 0; i < K; i++) {
      await failTask(loaded, i)
    }
    expect(await countStormRows(aq)).toBe(1)

    // Simulate a successful task by resetting the streak (what server.ts does
    // on task.completed with status='done').
    await sm.resetFailureSignatureStreak(client)

    // Now K more failures should trip a NEW episode (action-queue row
    // idempotency is per-signature; the second trip raises a second seen_count
    // on the same row, not a second row — still exactly 1 open row).
    const trips: unknown[] = []
    for (let i = K; i < K * 2; i++) {
      await failTask(loaded, i, () => { trips.push(1) })
    }
    expect(trips).toHaveLength(1)
    // The existing row's seen_count bumped — still 1 open row.
    expect(await countStormRows(aq)).toBe(1)
  })
})
