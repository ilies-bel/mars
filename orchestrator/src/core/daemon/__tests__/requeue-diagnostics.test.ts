/**
 * Tests for requeue-diagnostics helpers.
 *
 * computeStepWindow and computeAttemptDensity are pure functions and are
 * tested with synthetic StepRecord / StepWindow values — no DB needed,
 * imported statically so no PGlite instance is created for those suites.
 *
 * computeBlockedWaitMs reads the outbox events table; its tests use a real
 * PGlite-backed queue DB (same pattern as requeue-ceiling.test.ts) with
 * controlled event timestamps inserted via raw SQL.  Each test explicitly
 * closes the PGlite instance before deleting the temp dir to prevent WASM
 * state leakage across tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { StepRecord } from '@mars/workflow'

// Pure functions: import statically — no DB or module isolation required.
import {
  computeStepWindow,
  computeAttemptDensity,
  classifyRequeueBreach,
  DENSITY_FLOOR_PER_MIN,
  BLOCKED_WAIT_RATIO,
} from '../requeue-diagnostics'
import type { StepWindow } from '../requeue-diagnostics'
import type { Task } from '../../queue'

// ──────────────────────────────────────────────────────────────────────────────
// Helpers shared across suites
// ──────────────────────────────────────────────────────────────────────────────

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-diag-'))
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

// Build a minimal StepRecord for tests that don't need all fields.
const makeStep = (
  name: string,
  attempt: number,
  startedAt: number = 0,
  runId: string = 'run-1',
): StepRecord => ({
  runId,
  name,
  status: 'failed',
  sha: null,
  startedAt,
  finishedAt: null,
  attempt,
  summary: null,
  errorSummary: null,
  transcriptKey: null,
  resultJson: null,
})

// ──────────────────────────────────────────────────────────────────────────────
// Module-isolation helpers for DB-backed tests only
// ──────────────────────────────────────────────────────────────────────────────

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

/**
 * Load queue + requeue-diagnostics with a fresh module scope.
 * Follows the same pattern as requeue-ceiling.test.ts: vi.resetModules()
 * provides test isolation; PGlite is abandoned (not explicitly closed) so the
 * WASM module stays in a consistent state across tests.
 */
const loadBlockedWaitModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  computeBlockedWaitMs: (taskId: string, nowMs: number) => Promise<number>
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const diag = await import('../requeue-diagnostics')
  return { q, computeBlockedWaitMs: diag.computeBlockedWaitMs }
}

// ──────────────────────────────────────────────────────────────────────────────
// computeStepWindow — pure function, no DB setup needed
// ──────────────────────────────────────────────────────────────────────────────

describe('computeStepWindow', () => {
  it('returns null for an empty steps array (0 attempts)', () => {
    expect(computeStepWindow([])).toBeNull()
  })

  it('returns null when all steps have attempt = 0', () => {
    const steps = [
      makeStep('setup-worktree', 0),
      makeStep('code', 0),
    ]
    expect(computeStepWindow(steps)).toBeNull()
  })

  it('returns a window for a single step with attempt = 1 and no timestamp', () => {
    // startedAt = 0 means no valid timestamp; spanMs should be 0, counts preserved.
    const steps = [makeStep('setup-worktree', 1, 0)]
    const w = computeStepWindow(steps)

    expect(w).not.toBeNull()
    expect(w!.attemptCount).toBe(1)
    expect(w!.spanMs).toBe(0)
    expect(w!.firstAttemptStartedAt).toBe(0)
    expect(w!.lastAttemptStartedAt).toBe(0)
  })

  it('identifies the failing step (highest attempt) and returns its window', () => {
    const now = Date.now()
    const steps = [
      makeStep('setup-worktree', 1, now - 10_000),
      makeStep('code', 5, now - 5_000),   // ← this is the failing step
    ]
    const w = computeStepWindow(steps)!

    expect(w.attemptCount).toBe(5)
    expect(w.firstAttemptStartedAt).toBe(now - 5_000)
    expect(w.lastAttemptStartedAt).toBe(now - 5_000)
    expect(w.spanMs).toBe(0)
  })

  it('computes first/last startedAt when multiple records share the failing step name', () => {
    // Simulate multiple records for the same step name (different startedAt).
    const t0 = 1_000_000
    const t1 = 1_060_000
    const t2 = 1_120_000
    const steps = [
      makeStep('setup-worktree', 3, t0, 'run-1'), // earlier attempt record
      makeStep('setup-worktree', 3, t1, 'run-2'), // middle
      makeStep('setup-worktree', 3, t2, 'run-3'), // latest
    ]
    const w = computeStepWindow(steps)!

    expect(w.firstAttemptStartedAt).toBe(t0)
    expect(w.lastAttemptStartedAt).toBe(t2)
    expect(w.spanMs).toBe(t2 - t0)
    expect(w.attemptCount).toBe(3)
  })

  it('ignores zero timestamps when computing the window', () => {
    const t1 = 2_000_000
    const t2 = 2_060_000
    const steps = [
      makeStep('setup-worktree', 5, 0,  'run-a'), // zero → skip
      makeStep('setup-worktree', 5, t1, 'run-b'),
      makeStep('setup-worktree', 5, t2, 'run-c'),
    ]
    const w = computeStepWindow(steps)!

    expect(w.firstAttemptStartedAt).toBe(t1)
    expect(w.lastAttemptStartedAt).toBe(t2)
    expect(w.spanMs).toBe(t2 - t1)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// computeAttemptDensity — pure function, no DB setup needed
// ──────────────────────────────────────────────────────────────────────────────

describe('computeAttemptDensity', () => {
  it('returns attemptCount / 1 when spanMs = 0 (denominator clamps to 1 minute)', () => {
    // 10 attempts in a zero-span window → density = 10 attempts/minute.
    const w: StepWindow = { firstAttemptStartedAt: 0, lastAttemptStartedAt: 0, spanMs: 0, attemptCount: 10 }
    expect(computeAttemptDensity(w)).toBe(10)
  })

  it('returns 1 for 1 attempt with zero span', () => {
    const w: StepWindow = { firstAttemptStartedAt: 0, lastAttemptStartedAt: 0, spanMs: 0, attemptCount: 1 }
    expect(computeAttemptDensity(w)).toBe(1)
  })

  it('dense loop: many attempts in a short window → high density', () => {
    // 60 attempts over 1 minute → 60 attempts/minute.
    const spanMs = 60_000
    const w: StepWindow = { firstAttemptStartedAt: 0, lastAttemptStartedAt: spanMs, spanMs, attemptCount: 60 }
    expect(computeAttemptDensity(w)).toBeCloseTo(60)
  })

  it('sparse gaps: few attempts over a long window → low density', () => {
    // 2 attempts over 2 hours → 1 attempt/minute denominator = 2/120 ≈ 0.017.
    const spanMs = 2 * 60 * 60 * 1_000 // 2 hours in ms
    const w: StepWindow = { firstAttemptStartedAt: 0, lastAttemptStartedAt: spanMs, spanMs, attemptCount: 2 }
    expect(computeAttemptDensity(w)).toBeCloseTo(2 / 120)
  })

  it('exactly one minute span: density = attemptCount / 1', () => {
    // 7 attempts over exactly 1 minute → 7 attempts/minute.
    const spanMs = 60_000
    const w: StepWindow = { firstAttemptStartedAt: 0, lastAttemptStartedAt: spanMs, spanMs, attemptCount: 7 }
    expect(computeAttemptDensity(w)).toBeCloseTo(7)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// classifyRequeueBreach — pure function, no DB setup needed
// ──────────────────────────────────────────────────────────────────────────────

// Minimal Task fixture: retry count is part of the public diagnostic contract.
const makeTask = (id: string = 'task-abc', recoverySpawnedCount = 3): Task =>
  ({ id, recoverySpawnedCount } as unknown as Task)

// Build a StepWindow fixture for density tests.
const makeWindow = (attemptCount: number, spanMs: number): StepWindow => ({
  firstAttemptStartedAt: 0,
  lastAttemptStartedAt: spanMs,
  spanMs,
  attemptCount,
})

describe('classifyRequeueBreach', () => {
  it('exports DENSITY_FLOOR_PER_MIN and BLOCKED_WAIT_RATIO as numbers', () => {
    expect(typeof DENSITY_FLOOR_PER_MIN).toBe('number')
    expect(typeof BLOCKED_WAIT_RATIO).toBe('number')
    expect(DENSITY_FLOOR_PER_MIN).toBeGreaterThan(0)
    expect(BLOCKED_WAIT_RATIO).toBeGreaterThan(0)
    expect(BLOCKED_WAIT_RATIO).toBeLessThanOrEqual(1)
  })

  it('classifies as retry-churn when density is at the floor threshold', () => {
    // Exactly DENSITY_FLOOR_PER_MIN attempts in 1 minute → density = floor.
    const w = makeWindow(DENSITY_FLOOR_PER_MIN, 60_000)
    const result = classifyRequeueBreach(makeTask(), w, 0, 120_000)

    expect(result.kind).toBe('retry-churn')
    expect(result.reason).toContain('attempt density')
  })

  it('classifies as retry-churn when density is well above the floor', () => {
    // 60 attempts over 1 minute → density = 60/min (far above default floor of 1).
    const w = makeWindow(60, 60_000)
    const result = classifyRequeueBreach(makeTask('task-hot'), w, 0, 120_000)

    expect(result.kind).toBe('retry-churn')
    expect(result.reason).toContain('task-hot')
  })

  it('classifies as blocked-wait when blocked time dominates elapsed time', () => {
    // 2 attempts over 120 minutes (sparse → density < 1/min), but blocked for
    // 70% of elapsed time → exceeds the default BLOCKED_WAIT_RATIO of 0.5.
    const elapsedMs = 120 * 60_000
    const blockedWaitMs = Math.round(elapsedMs * 0.7) // 70%
    const w = makeWindow(2, elapsedMs - 1_000) // span just under elapsed

    // density = 2 / 120 = 0.017/min < 1 → not retry-churn
    const result = classifyRequeueBreach(makeTask('task-blocked'), w, blockedWaitMs, elapsedMs)

    expect(result.kind).toBe('blocked-wait')
    expect(result.reason).toContain('task-blocked')
    expect(result.reason).toContain('blocked')
  })

  it('classifies as blocked-wait exactly at the ratio boundary', () => {
    // blocked for exactly BLOCKED_WAIT_RATIO of elapsed time.
    const elapsedMs = 60_000
    const blockedWaitMs = Math.round(elapsedMs * BLOCKED_WAIT_RATIO) // exactly at ratio
    // density: 0 (window null) → not retry-churn
    const result = classifyRequeueBreach(makeTask(), null, blockedWaitMs, elapsedMs)

    expect(result.kind).toBe('blocked-wait')
  })

  it('classifies as queue-starvation when attempts are sparse and no blocked wait', () => {
    // 1 attempt, no blocked time, low density — queue starved.
    const w = makeWindow(1, 0) // single attempt with zero span
    // density = 1/1 = 1 (equals floor) → that would be retry-churn...
    // Use 2 attempts over a long span to keep density below the floor.
    const wSparse = makeWindow(2, 10 * 60_000) // 2 attempts over 10 minutes → 0.2/min
    const result = classifyRequeueBreach(makeTask('task-starved'), wSparse, 0, 10 * 60_000)

    expect(result.kind).toBe('queue-starvation')
    expect(result.reason).toContain('task-starved')
  })

  it('classifies as queue-starvation for exactly 0 attempts (null window)', () => {
    // null window → attemptCount = 0, density = 0, blockedWaitMs = 0
    const result = classifyRequeueBreach(makeTask(), null, 0, 30_000)

    expect(result.kind).toBe('queue-starvation')
  })

  it('classifies as long-running when density is low, no excess blocking, and more than 2 attempts', () => {
    // 5 attempts over 3 hours → density ≈ 0.028/min (well below 1/min).
    // blockedWaitMs = 10 minutes out of 180 minutes elapsed = ~5.6% → below 50% ratio.
    const elapsedMs = 3 * 60 * 60_000
    const blockedWaitMs = 10 * 60_000 // only 10 minutes blocked
    const w = makeWindow(5, elapsedMs - 1_000)

    const result = classifyRequeueBreach(makeTask('task-slow'), w, blockedWaitMs, elapsedMs)

    expect(result.kind).toBe('long-running')
    expect(result.reason).toContain('task-slow')
    expect(result.reason).toContain('5 attempt(s)')
  })

  it('includes the task id in the reason string for all kinds', () => {
    const id = 'mars-deadbeef'

    // retry-churn
    expect(
      classifyRequeueBreach(makeTask(id), makeWindow(60, 60_000), 0, 120_000).reason,
    ).toContain(id)

    // blocked-wait
    expect(
      classifyRequeueBreach(makeTask(id), null, 50_000, 60_000).reason,
    ).toContain(id)

    // queue-starvation
    expect(
      classifyRequeueBreach(makeTask(id), null, 0, 30_000).reason,
    ).toContain(id)

    // long-running
    expect(
      classifyRequeueBreach(makeTask(id), makeWindow(5, 3 * 60 * 60_000), 5_000, 3 * 60 * 60_000).reason,
    ).toContain(id)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// computeBlockedWaitMs (DB-backed)
// ──────────────────────────────────────────────────────────────────────────────

// Helper: insert an event row with a controlled ts (seconds since epoch).
const insertEvent = async (
  q: QueueModule,
  type: string,
  taskId: string,
  tsSec: number,
): Promise<void> => {
  const payload =
    type === 'task.blocked'
      ? JSON.stringify({ taskId, fixTaskId: null, failureSignature: '', failingStep: '' })
      : JSON.stringify({ taskId })

  await q.resolveQueueClient().execute({
    sql: `INSERT INTO events (type, payload, ts) VALUES (?, ?, ?)`,
    args: [type, payload, tsSec],
  })
}

describe('computeBlockedWaitMs', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns 0 when the task has never been blocked', async () => {
    const { q, computeBlockedWaitMs } = await loadBlockedWaitModules(repo)
    const t = await q.enqueueTask('never-blocked task', undefined, { skipTriage: true })

    const result = await computeBlockedWaitMs(t.id, Date.now())
    expect(result).toBe(0)
  })

  it('sums a single block/unblock interval', async () => {
    const { q, computeBlockedWaitMs } = await loadBlockedWaitModules(repo)
    const t = await q.enqueueTask('blocked-once task', undefined, { skipTriage: true })

    // Blocked at second 1000, unblocked at second 1060 → 60 seconds = 60,000 ms.
    await insertEvent(q, 'task.blocked', t.id, 1_000)
    await insertEvent(q, 'task.queued', t.id, 1_060)

    const result = await computeBlockedWaitMs(t.id, Date.now())
    expect(result).toBe(60_000)
  })

  it('sums multiple block/unblock cycles', async () => {
    const { q, computeBlockedWaitMs } = await loadBlockedWaitModules(repo)
    const t = await q.enqueueTask('blocked-twice task', undefined, { skipTriage: true })

    // First interval: 1000 → 1060 = 60 s
    await insertEvent(q, 'task.blocked', t.id, 1_000)
    await insertEvent(q, 'task.queued',  t.id, 1_060)
    // Second interval: 2000 → 2030 = 30 s
    await insertEvent(q, 'task.blocked', t.id, 2_000)
    await insertEvent(q, 'task.queued',  t.id, 2_030)

    const result = await computeBlockedWaitMs(t.id, Date.now())
    // 60,000 + 30,000 = 90,000 ms
    expect(result).toBe(90_000)
  })

  it('counts to nowMs for a task still in the blocked state (open interval)', async () => {
    const { q, computeBlockedWaitMs } = await loadBlockedWaitModules(repo)
    const t = await q.enqueueTask('still-blocked task', undefined, { skipTriage: true })

    const blockedTsSec = 5_000
    await insertEvent(q, 'task.blocked', t.id, blockedTsSec)

    // nowMs = blocked start + 45 seconds in ms
    const nowMs = blockedTsSec * 1_000 + 45_000

    const result = await computeBlockedWaitMs(t.id, nowMs)
    expect(result).toBe(45_000)
  })

  it('ignores events for unrelated tasks', async () => {
    const { q, computeBlockedWaitMs } = await loadBlockedWaitModules(repo)
    const t = await q.enqueueTask('target task', undefined, { skipTriage: true })
    const other = await q.enqueueTask('unrelated task', undefined, { skipTriage: true })

    // Only insert events for the unrelated task.
    await insertEvent(q, 'task.blocked', other.id, 1_000)
    await insertEvent(q, 'task.queued',  other.id, 1_120)

    const result = await computeBlockedWaitMs(t.id, Date.now())
    expect(result).toBe(0)
  })

  it('handles combined closed and open intervals', async () => {
    const { q, computeBlockedWaitMs } = await loadBlockedWaitModules(repo)
    const t = await q.enqueueTask('partial task', undefined, { skipTriage: true })

    // Closed interval: 100 → 200 = 100 s
    await insertEvent(q, 'task.blocked', t.id, 100)
    await insertEvent(q, 'task.queued',  t.id, 200)
    // Open interval: blocked at 300, no unblock
    await insertEvent(q, 'task.blocked', t.id, 300)

    // nowMs = second 350 × 1000 → open interval = 50 s
    const nowMs = 350 * 1_000

    const result = await computeBlockedWaitMs(t.id, nowMs)
    // 100_000 (closed) + 50_000 (open) = 150_000 ms
    expect(result).toBe(150_000)
  })
})
