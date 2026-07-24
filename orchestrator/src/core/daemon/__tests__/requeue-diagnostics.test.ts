/**
 * Tests for requeue-diagnostics helpers.
 *
 * computeStepWindow and computeAttemptDensity are pure functions and are
 * tested with synthetic StepRecord / StepWindow values.
 *
 * computeBlockedWaitMs reads the outbox events table; its tests use a real
 * PGlite-backed queue DB (same pattern as requeue-ceiling.test.ts) with
 * controlled event timestamps inserted via raw SQL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { StepRecord } from '@mars/workflow'

// ──────────────────────────────────────────────────────────────────────────────
// Module-isolation helpers
// ──────────────────────────────────────────────────────────────────────────────

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface DiagnosticsModule {
  computeStepWindow: (steps: StepRecord[]) => import('../requeue-diagnostics').StepWindow | null
  computeAttemptDensity: (w: import('../requeue-diagnostics').StepWindow) => number
  computeBlockedWaitMs: (taskId: string, nowMs: number) => Promise<number>
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-diag-'))
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; diag: DiagnosticsModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const diag = (await import('../requeue-diagnostics')) as unknown as DiagnosticsModule
  return { q, diag }
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
// computeStepWindow
// ──────────────────────────────────────────────────────────────────────────────

describe('computeStepWindow', () => {
  let repo: string
  let diag: DiagnosticsModule

  beforeEach(async () => {
    repo = setupRepo()
    ;({ diag } = await loadModules(repo))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns null for an empty steps array (0 attempts)', () => {
    expect(diag.computeStepWindow([])).toBeNull()
  })

  it('returns null when all steps have attempt = 0', () => {
    const steps = [
      makeStep('setup-worktree', 0),
      makeStep('code', 0),
    ]
    expect(diag.computeStepWindow(steps)).toBeNull()
  })

  it('returns a window for a single step with attempt = 1 and no timestamp', () => {
    // startedAt = 0 means no valid timestamp; spanMs should be 0, counts preserved.
    const steps = [makeStep('setup-worktree', 1, 0)]
    const w = diag.computeStepWindow(steps)

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
    const w = diag.computeStepWindow(steps)!

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
    const w = diag.computeStepWindow(steps)!

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
    const w = diag.computeStepWindow(steps)!

    expect(w.firstAttemptStartedAt).toBe(t1)
    expect(w.lastAttemptStartedAt).toBe(t2)
    expect(w.spanMs).toBe(t2 - t1)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// computeAttemptDensity
// ──────────────────────────────────────────────────────────────────────────────

describe('computeAttemptDensity', () => {
  let repo: string
  let diag: DiagnosticsModule

  beforeEach(async () => {
    repo = setupRepo()
    ;({ diag } = await loadModules(repo))
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns attemptCount / 1 when spanMs = 0 (denominator clamps to 1 minute)', () => {
    // 10 attempts in a zero-span window → density = 10 attempts/minute.
    const w = { firstAttemptStartedAt: 0, lastAttemptStartedAt: 0, spanMs: 0, attemptCount: 10 }
    expect(diag.computeAttemptDensity(w)).toBe(10)
  })

  it('returns 1 for 1 attempt with zero span', () => {
    const w = { firstAttemptStartedAt: 0, lastAttemptStartedAt: 0, spanMs: 0, attemptCount: 1 }
    expect(diag.computeAttemptDensity(w)).toBe(1)
  })

  it('dense loop: many attempts in a short window → high density', () => {
    // 60 attempts over 1 minute → 60 attempts/minute.
    const spanMs = 60_000
    const w = { firstAttemptStartedAt: 0, lastAttemptStartedAt: spanMs, spanMs, attemptCount: 60 }
    expect(diag.computeAttemptDensity(w)).toBeCloseTo(60)
  })

  it('sparse gaps: few attempts over a long window → low density', () => {
    // 2 attempts over 2 hours → 1 attempt/minute denominator = 2/120 ≈ 0.017.
    const spanMs = 2 * 60 * 60 * 1_000 // 2 hours in ms
    const w = { firstAttemptStartedAt: 0, lastAttemptStartedAt: spanMs, spanMs, attemptCount: 2 }
    expect(diag.computeAttemptDensity(w)).toBeCloseTo(2 / 120)
  })

  it('exactly one minute span: density = attemptCount / 1', () => {
    // 7 attempts over exactly 1 minute → 7 attempts/minute.
    const spanMs = 60_000
    const w = { firstAttemptStartedAt: 0, lastAttemptStartedAt: spanMs, spanMs, attemptCount: 7 }
    expect(diag.computeAttemptDensity(w)).toBeCloseTo(7)
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
    const { q, diag } = await loadModules(repo)
    const t = await q.enqueueTask('never-blocked task', undefined, { skipTriage: true })

    const result = await diag.computeBlockedWaitMs(t.id, Date.now())
    expect(result).toBe(0)
  })

  it('sums a single block/unblock interval', async () => {
    const { q, diag } = await loadModules(repo)
    const t = await q.enqueueTask('blocked-once task', undefined, { skipTriage: true })

    // Blocked at second 1000, unblocked at second 1060 → 60 seconds = 60,000 ms.
    await insertEvent(q, 'task.blocked', t.id, 1_000)
    await insertEvent(q, 'task.queued', t.id, 1_060)

    const result = await diag.computeBlockedWaitMs(t.id, Date.now())
    expect(result).toBe(60_000)
  })

  it('sums multiple block/unblock cycles', async () => {
    const { q, diag } = await loadModules(repo)
    const t = await q.enqueueTask('blocked-twice task', undefined, { skipTriage: true })

    // First interval: 1000 → 1060 = 60 s
    await insertEvent(q, 'task.blocked', t.id, 1_000)
    await insertEvent(q, 'task.queued',  t.id, 1_060)
    // Second interval: 2000 → 2030 = 30 s
    await insertEvent(q, 'task.blocked', t.id, 2_000)
    await insertEvent(q, 'task.queued',  t.id, 2_030)

    const result = await diag.computeBlockedWaitMs(t.id, Date.now())
    // 60,000 + 30,000 = 90,000 ms
    expect(result).toBe(90_000)
  })

  it('counts to nowMs for a task still in the blocked state (open interval)', async () => {
    const { q, diag } = await loadModules(repo)
    const t = await q.enqueueTask('still-blocked task', undefined, { skipTriage: true })

    const blockedTsSec = 5_000
    await insertEvent(q, 'task.blocked', t.id, blockedTsSec)

    // nowMs = blocked start + 45 seconds in ms
    const nowMs = blockedTsSec * 1_000 + 45_000

    const result = await diag.computeBlockedWaitMs(t.id, nowMs)
    expect(result).toBe(45_000)
  })

  it('ignores events for unrelated tasks', async () => {
    const { q, diag } = await loadModules(repo)
    const t = await q.enqueueTask('target task', undefined, { skipTriage: true })
    const other = await q.enqueueTask('unrelated task', undefined, { skipTriage: true })

    // Only insert events for the unrelated task.
    await insertEvent(q, 'task.blocked', other.id, 1_000)
    await insertEvent(q, 'task.queued',  other.id, 1_120)

    const result = await diag.computeBlockedWaitMs(t.id, Date.now())
    expect(result).toBe(0)
  })

  it('handles combined closed and open intervals', async () => {
    const { q, diag } = await loadModules(repo)
    const t = await q.enqueueTask('partial task', undefined, { skipTriage: true })

    // Closed interval: 100 → 200 = 100 s
    await insertEvent(q, 'task.blocked', t.id, 100)
    await insertEvent(q, 'task.queued',  t.id, 200)
    // Open interval: blocked at 300, no unblock
    await insertEvent(q, 'task.blocked', t.id, 300)

    // nowMs = second 350 × 1000 → open interval = 50 s
    const nowMs = 350 * 1_000

    const result = await diag.computeBlockedWaitMs(t.id, nowMs)
    // 100_000 (closed) + 50_000 (open) = 150_000 ms
    expect(result).toBe(150_000)
  })
})
