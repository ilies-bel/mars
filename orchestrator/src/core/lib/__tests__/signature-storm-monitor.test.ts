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
  readSignatureStormState: typeof import('../signature-storm-monitor').readSignatureStormState
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

  it('streaks the coarse and step-qualified forms of ONE failure together', async () => {
    const { sm, client } = await loadModules(repo)
    // The same commit-contract failure, as the inline call site records it
    // (fine) and as the durable recovery-spawn subscriber records it (coarse,
    // because it can only recover `failed_phase` from the DB).
    const fine = 'code:commit-contract/uncommitted-changes'
    const coarse = 'code/uncommitted-changes'

    const r1 = await sm.recordFailureSignature(client, 'task-1', fine)
    expect(r1.streak).toBe(1)
    // Under string equality this reset the streak to 1 — one failure counted
    // as two unrelated ones, and whichever form tripped was then the only form
    // the Steward's evidence lookup searched for.
    const r2 = await sm.recordFailureSignature(client, 'task-2', coarse)
    expect(r2.streak).toBe(2)
    const r3 = await sm.recordFailureSignature(client, 'task-3', fine)
    expect(r3.streak).toBe(3)
  })

  it('keeps a different error class in the same gate on its own streak', async () => {
    const { sm, client } = await loadModules(repo)

    await sm.recordFailureSignature(client, 'task-1', 'code:commit-contract/uncommitted-changes')
    const r = await sm.recordFailureSignature(
      client,
      'task-2',
      'code:coder-exit-nonzero/api-unreachable',
    )
    expect(r.streak).toBe(1)
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

  // ── readSignatureStormState — startup pause recovery ─────────────────────

  it('readSignatureStormState reports not-tripped when no row exists', async () => {
    const { sm, client } = await loadModules(repo)
    // No failures recorded yet — no row in DB.
    expect((await sm.readSignatureStormState(client)).tripped).toBe(false)
  })

  it('readSignatureStormState reports not-tripped when streak is below threshold', async () => {
    const { sm, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD
    // Record K-1 failures (below threshold — tripped stays false).
    for (let i = 0; i < K - 1; i++) {
      await sm.recordFailureSignature(client, `task-${i}`, sig)
    }
    expect((await sm.readSignatureStormState(client)).tripped).toBe(false)
  })

  it('readSignatureStormState reports tripped after the breaker trips', async () => {
    const { sm, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD
    for (let i = 0; i < K; i++) {
      await sm.recordFailureSignature(client, `task-${i}`, sig)
    }
    // The K-th call tripped the breaker — persisted tripped=true in DB.
    expect((await sm.readSignatureStormState(client)).tripped).toBe(true)
  })

  it('readSignatureStormState reports not-tripped after resetFailureSignatureStreak (simulates resume)', async () => {
    // This models the daemon restart scenario:
    //   1. Storm trips → tripped=true persisted in DB.
    //   2. Operator clears the pause → resetFailureSignatureStreak clears tripped.
    //   3. Next daemon startup reads the state → not tripped → no re-pause.
    const { sm, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    // Trip the breaker.
    for (let i = 0; i < K; i++) {
      await sm.recordFailureSignature(client, `task-${i}`, sig)
    }
    expect((await sm.readSignatureStormState(client)).tripped).toBe(true)

    // Operator resumes → resume handler calls resetFailureSignatureStreak.
    await sm.resetFailureSignatureStreak(client)

    // Next daemon startup: tripped is cleared → no re-pause.
    expect((await sm.readSignatureStormState(client)).tripped).toBe(false)
  })

  it('never streaks the generic code/unclassified bucket, however many tasks hit it', async () => {
    const { sm, aq, client } = await loadModules(repo)
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    for (let i = 0; i < K + 3; i++) {
      const r = await sm.recordFailureSignature(client, `task-${i}`, 'code/unclassified')
      expect(r.streak).toBe(0)
      expect(r.tripped).toBe(false)
    }
    for (let i = 0; i < K + 3; i++) {
      const r = await sm.recordFailureSignature(client, `vtask-${i}`, 'verify/unclassified')
      expect(r.tripped).toBe(false)
    }
    expect(await countStormRows(aq)).toBe(0)
  })

  it('does not pause dispatch when several main-committers report the same dirty integration branch', async () => {
    const { sm, aq, client } = await loadModules(repo)
    const signature = 'orchestration:main-committer-still-dirty/unclassified'

    for (let i = 0; i < sm.SIGNATURE_STORM_TRIP_THRESHOLD + 2; i++) {
      const result = await sm.recordFailureSignature(client, `committer-${i}`, signature)
      expect(result.tripped).toBe(false)
      expect(result.streak).toBe(0)
    }

    expect(await countStormRows(aq)).toBe(0)
    expect((await sm.readSignatureStormState(client)).tripped).toBe(false)
  })

  it('readSignatureStormState exposes the durable breaker state for pause reconcile', async () => {
    const { sm, client } = await loadModules(repo)
    const sig = 'setup:install-failed/unclassified'
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    const before = await sm.readSignatureStormState(client)
    expect(before.tripped).toBe(false)
    expect(before.signature).toBeNull()

    for (let i = 0; i < K; i++) {
      await sm.recordFailureSignature(client, `task-${i}`, sig)
    }

    const after = await sm.readSignatureStormState(client)
    expect(after.tripped).toBe(true)
    expect(after.signature).toBe(sig)
    expect(after.streak).toBe(K)

    await sm.resetFailureSignatureStreak(client)
    expect((await sm.readSignatureStormState(client)).tripped).toBe(false)
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

  // A step that carries a KIND ('install-failed') and an error with no
  // registered error-class rule, so the signature is
  // `setup:install-failed/unclassified` — diagnostic (the kind names the
  // cause) even though the class is unclassified. A BARE gate plus
  // 'unclassified' (`setup/unclassified`) is the generic bucket the breaker
  // deliberately ignores — see the isDiagnosticSignature suite.
  const STEP = 'setup:install-failed'
  const ENV_ERROR = 'ENOSPC: no space left on device — install failed'
  const SIG = 'setup:install-failed/unclassified'

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

// ---------------------------------------------------------------------------
// Environmental-failure policy: no storm trip, no recovery budget consumed
// ---------------------------------------------------------------------------

/**
 * Tests that validate the two core guarantees from ADR-0080:
 *  1. N consecutive environmental failures (staticEncodable.reason='environmental')
 *     MUST NOT trip the signature-storm circuit breaker or pause the queue.
 *  2. Environmental failures below MAX_ENV_RESTART_ATTEMPTS MUST NOT consume
 *     the origin task's one recovery slot (no fix-task spawned).
 *  3. N consecutive NON-environmental failures MUST still trip the breaker.
 *
 * The environmental signature under test is `verify:worktree-hygiene/worktree-missing`:
 * the worktree was pruned before verify could run (daemon restart incident).
 * Its failure-kinds registry entry carries `staticEncodable: notEncodable('environmental')`.
 */

interface QueueFixTasksModule {
  MAX_ENV_RESTART_ATTEMPTS: typeof import('../../queue-fix-tasks').MAX_ENV_RESTART_ATTEMPTS
}

describe('environmental-failure policy — no storm, no recovery-budget consumption', () => {
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

  // The error string that produces the 'worktree-missing' error class.
  // The failing step is `verify:worktree-hygiene`, NOT `verify:has-diff`: the
  // hygiene probe stopped borrowing the has-diff label precisely because a
  // missing worktree is not a diff verdict, and only the hygiene-qualified
  // signature is registered as `environmental` in the failure-kinds registry.
  // Feeding the old step here produced `verify:has-diff/worktree-missing`,
  // which resolves to no registered kind, so isEnvironmentalSignature() was
  // false and the storm breaker tripped — the exact thing this test denies.
  const ENV_FAILING_STEP = 'verify:worktree-hygiene'
  const ENV_ERROR = 'worktree path /tmp/mars-abc123 no longer exists (daemon restarted mid-flight)'
  // This is the full signature computeFailureSignature produces for the above inputs.
  const ENV_SIGNATURE = 'verify:worktree-hygiene/worktree-missing'

  /**
   * Fail a fresh origin task with the environmental signature and drain.
   * Returns the task id.
   */
  const failEnvTask = async (
    loaded: Loaded,
    index: number,
    stormCb?: Parameters<typeof loaded.rs.drainRecoverySpawner>[2],
  ): Promise<string> => {
    const { q, rs, client } = loaded
    const t = await q.enqueueTask(`env task ${index}`, undefined, { skipTriage: true })
    await q.updateTask(t.id, {
      status: 'failed',
      failedPhase: null,
      failureReason: ENV_FAILING_STEP,
      error: ENV_ERROR,
    })
    await rs.drainRecoverySpawner(client, undefined, stormCb)
    return t.id
  }

  it('N consecutive environmental failures do NOT trip the signature-storm circuit breaker', async () => {
    const loaded = await loadModules(repo)
    const { sm, rs, aq, client } = loaded
    const K = sm.SIGNATURE_STORM_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)

    const trips: unknown[] = []
    const stormCb = (): void => { trips.push(1) }

    // Run K+2 environmental failures — well above the threshold.
    for (let i = 0; i < K + 2; i++) {
      await failEnvTask(loaded, i, stormCb)
    }

    // The circuit breaker must NOT have tripped.
    expect(trips).toHaveLength(0)
    expect(await countStormRows(aq)).toBe(0)
  })

  it('environmental failures below the cap requeue the task without spawning a fix-task', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, client } = loaded
    const qft = (await import('../../queue-fix-tasks')) as unknown as QueueFixTasksModule
    const cap = qft.MAX_ENV_RESTART_ATTEMPTS

    await rs.ensureRecoverySpawner(client)

    // Fail a task below the cap and confirm it gets requeued, not blocked.
    const taskId = await failEnvTask(loaded, 0)
    const reloaded = await q.getTask(taskId)
    // The first failure (envRestartCount 0 → 1) should requeue, not spawn recovery.
    expect(reloaded?.status).toBe('queued')

    // No fix task should have been spawned.
    const fixRows = await client.execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
      args: [taskId],
    })
    expect(fixRows.rows).toHaveLength(0)

    // Confirm cap is at least 1 so the test assertion makes sense.
    expect(cap).toBeGreaterThan(0)
    void ENV_SIGNATURE // referenced in assertion above implicitly via computeFailureSignature
  })

  it('N consecutive environmental failures do NOT consume the origin recovery budget (recoverySpawnedCount unchanged)', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, client } = loaded
    const sm_mod = loaded.sm
    const K = sm_mod.SIGNATURE_STORM_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)

    // Fail K+1 tasks — each below its own per-task cap, so all get requeued.
    const ids: string[] = []
    for (let i = 0; i < K + 1; i++) {
      ids.push(await failEnvTask(loaded, i))
    }

    // Each task should be requeued with recoverySpawnedCount still 0 (budget intact).
    for (const id of ids) {
      const t = await q.getTask(id)
      expect(t?.recoverySpawnedCount).toBe(0)
    }

    // No fix tasks spawned for any of the origins.
    for (const id of ids) {
      const rows = await client.execute({
        sql: `SELECT id FROM tasks WHERE fix_for_task_id = ?`,
        args: [id],
      })
      expect(rows.rows).toHaveLength(0)
    }
  })

  it('N consecutive NON-environmental failures still trip the circuit breaker', async () => {
    const loaded = await loadModules(repo)
    const { q, rs, aq, client } = loaded
    const K = loaded.sm.SIGNATURE_STORM_TRIP_THRESHOLD

    await rs.ensureRecoverySpawner(client)

    const trips: unknown[] = []
    const stormCb = (): void => { trips.push(1) }

    // 'setup:install-failed/unclassified' has no environmental classification in
    // failure-kinds.ts. The step carries a KIND ('install-failed'), which is
    // what makes the signature diagnostic — a bare gate name plus an
    // unclassified error (`setup/unclassified`) is the generic bucket the
    // breaker must ignore, see the isDiagnosticSignature suite below.
    const NON_ENV_STEP = 'setup:install-failed'
    const NON_ENV_ERROR = 'ENOSPC: no space left on device — install failed'
    const failNonEnvTask = async (index: number): Promise<void> => {
      const t = await q.enqueueTask(`non-env task ${index}`, undefined, { skipTriage: true })
      await q.updateTask(t.id, {
        status: 'failed',
        failedPhase: null,
        failureReason: NON_ENV_STEP,
        error: NON_ENV_ERROR,
      })
      await rs.drainRecoverySpawner(client, undefined, stormCb)
    }

    // Run K failures — at the threshold, the breaker should trip.
    for (let i = 0; i < K; i++) {
      await failNonEnvTask(i)
    }

    // The breaker must have tripped exactly once.
    expect(trips).toHaveLength(1)
    expect(await countStormRows(aq)).toBe(1)
  })
})

describe('isDiagnosticSignature', () => {
  const load = async () => {
    const m = await import('../signature-storm-monitor')
    return m.isDiagnosticSignature
  }

  it('rejects placeholder signatures that name no failure kind', async () => {
    // These are what a daemon-restart reconcile burst emits. Streaking them
    // together trips the breaker on unrelated failures and wedges dispatch.
    const isDiagnostic = await load()
    expect(isDiagnostic('unknown/unclassified')).toBe(false)
    expect(isDiagnostic('/unclassified')).toBe(false)
    expect(isDiagnostic('recovery_exhausted:/unclassified/unclassified')).toBe(false)
  })

  it('rejects the two most generic buckets in the system', async () => {
    // Regression: `lastIndexOf(':')` on a colon-less signature returned -1, so
    // `slice(0)` handed back the WHOLE string and the "kind" became the bare
    // gate name ('code'). Both buckets therefore read as diagnostic and
    // reliably tripped the breaker, pausing all dispatch on noise.
    const isDiagnostic = await load()
    expect(isDiagnostic('code/unclassified')).toBe(false)
    expect(isDiagnostic('verify/unclassified')).toBe(false)
    expect(isDiagnostic('setup/unclassified')).toBe(false)
    expect(isDiagnostic('merge/unclassified')).toBe(false)
  })

  it('rejects a bare gate whose error class is the unknown sentinel', async () => {
    const isDiagnostic = await load()
    expect(isDiagnostic('code/unknown')).toBe(false)
    expect(isDiagnostic('verify/unknown')).toBe(false)
  })

  it('accepts signatures with a real kind even when the class is unclassified', async () => {
    const isDiagnostic = await load()
    expect(isDiagnostic('setup:origin-worktree-missing/unclassified')).toBe(true)
    expect(isDiagnostic('merge:vcs-supervisor-aborted/rebase-dirty-worktree')).toBe(true)
  })

  it('accepts a kind-bearing step with no error class at all', async () => {
    const isDiagnostic = await load()
    expect(isDiagnostic('setup:origin-worktree-missing')).toBe(true)
  })

  it('accepts genuinely diagnostic signatures', async () => {
    const isDiagnostic = await load()
    // Kind carries the diagnosis.
    expect(isDiagnostic('code:coder-exit-nonzero/api-unreachable')).toBe(true)
    expect(isDiagnostic('verify:has-diff/no-commits-ahead')).toBe(true)
    // Bare gate, but the error CLASS carries the diagnosis.
    expect(isDiagnostic('merge/uncommitted-changes')).toBe(true)
    expect(isDiagnostic('code/api-unreachable')).toBe(true)
  })
})
