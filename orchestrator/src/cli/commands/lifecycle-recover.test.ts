/**
 * Tests for `mars recover` (bulk, no id) output presentation.
 *
 * The recover command sends `{ op: 'recover' }` to the daemon and prints
 * a human-readable summary.  The key distinction is between:
 *
 *   - tasks waiting on *live* work (blocker is queued/running/blocked) — these
 *     are healthy; the queue just hasn't drained yet.
 *   - tasks *stranded* on a failed or missing blocker — these need operator
 *     attention.
 *
 * These tests exercise the CLI presentation via `runCommandInProcess` with a
 * fake daemon that returns canned `outcomes` arrays.  No daemon process is
 * spawned; `process.exit` is never called.
 */

import { describe, expect, it } from 'vitest'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ── Minimal fixtures ──────────────────────────────────────────────────────────

const fakeCtx: OrchestratorContext = {
  repoRoot: '/tmp/mars-recover-test',
  stateDir: '/tmp/mars-recover-test/.mars',
  queueDbPath: '/tmp/mars-recover-test/.mars/mars.db',
  observabilityDbPath: '/tmp/mars-recover-test/.mars/obs.db',
  stateDbPath: '/tmp/mars-recover-test/.mars/state.db',
}

/** `recover` never touches the store. */
const fakeStore = {} as unknown as DomainTaskStore

// ── Helpers ───────────────────────────────────────────────────────────────────

type BlockerStatus = { blockerId: string; status: string }
type RecoverOutcome = {
  taskId: string
  outcome: 'queued' | 'noop' | 'failed' | 'not-blocked'
  recoverySpawnedCount: number
  failureReason?: string
  blockerStatuses?: BlockerStatus[]
}

const makeDaemon = (outcomes: RecoverOutcome[]) =>
  makeFakeDaemon(() => ({ outcomes }))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mars recover — bulk (no id): healthy case', () => {
  it('all noop tasks blocked on live work → healthy summary, no stranded lines', async () => {
    const daemon = makeDaemon([
      {
        taskId: 'mars-aaa',
        outcome: 'noop',
        recoverySpawnedCount: 0,
        blockerStatuses: [{ blockerId: 'mars-bbb', status: 'queued' }],
      },
      {
        taskId: 'mars-ccc',
        outcome: 'noop',
        recoverySpawnedCount: 0,
        blockerStatuses: [{ blockerId: 'mars-ddd', status: 'running' }],
      },
    ])

    const r = await runCommandInProcess(['recover'], {
      store: fakeStore,
      ctx: fakeCtx,
      daemon,
    })

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    // Should say "healthy" with the task count
    expect(output).toContain('queue healthy')
    expect(output).toContain('2 task(s) waiting on live work')
    expect(output).toContain('nothing stranded')
    // Must NOT say "recovered 0" (the old confusing message)
    expect(output).not.toContain('recovered 0')
    // Must NOT emit any STRANDED lines
    expect(output).not.toContain('STRANDED')
  })

  it('no blocked tasks at all → healthy summary with no stranded lines', async () => {
    const daemon = makeDaemon([])

    const r = await runCommandInProcess(['recover'], {
      store: fakeStore,
      ctx: fakeCtx,
      daemon,
    })

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('queue healthy')
    expect(output).not.toContain('recovered 0')
    expect(output).not.toContain('STRANDED')
  })
})

describe('mars recover — bulk (no id): stranded case', () => {
  it('noop task with failed blocker → STRANDED line naming blocker and status', async () => {
    const daemon = makeDaemon([
      {
        taskId: 'mars-aaa',
        outcome: 'noop',
        recoverySpawnedCount: 0,
        blockerStatuses: [{ blockerId: 'mars-bbb', status: 'failed' }],
      },
    ])

    const r = await runCommandInProcess(['recover'], {
      store: fakeStore,
      ctx: fakeCtx,
      daemon,
    })

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('STRANDED')
    expect(output).toContain('mars-aaa')
    expect(output).toContain('mars-bbb')
    expect(output).toContain('failed')
    // Healthy summary must NOT appear when stranded tasks exist
    expect(output).not.toContain('nothing stranded')
  })

  it('noop task with MISSING blocker → STRANDED line naming blocker as MISSING', async () => {
    const daemon = makeDaemon([
      {
        taskId: 'mars-aaa',
        outcome: 'noop',
        recoverySpawnedCount: 0,
        blockerStatuses: [{ blockerId: 'mars-deleted', status: 'MISSING' }],
      },
    ])

    const r = await runCommandInProcess(['recover'], {
      store: fakeStore,
      ctx: fakeCtx,
      daemon,
    })

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('STRANDED')
    expect(output).toContain('mars-aaa')
    expect(output).toContain('mars-deleted')
    expect(output).toContain('MISSING')
  })

  it('mixed stranded and live tasks → STRANDED lines present, healthy summary absent', async () => {
    const daemon = makeDaemon([
      {
        taskId: 'mars-stranded',
        outcome: 'noop',
        recoverySpawnedCount: 0,
        blockerStatuses: [{ blockerId: 'mars-dead', status: 'failed' }],
      },
      {
        taskId: 'mars-live',
        outcome: 'noop',
        recoverySpawnedCount: 0,
        blockerStatuses: [{ blockerId: 'mars-ok', status: 'queued' }],
      },
    ])

    const r = await runCommandInProcess(['recover'], {
      store: fakeStore,
      ctx: fakeCtx,
      daemon,
    })

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('STRANDED')
    expect(output).toContain('mars-stranded')
    // The healthy summary should NOT appear when stranded tasks exist
    expect(output).not.toContain('nothing stranded')
  })
})

describe('mars recover — bulk (no id): mixed outcomes', () => {
  it('some recovered + all noop on live work → recovered message + healthy summary', async () => {
    const daemon = makeDaemon([
      { taskId: 'mars-rec', outcome: 'queued', recoverySpawnedCount: 1 },
      {
        taskId: 'mars-wait',
        outcome: 'noop',
        recoverySpawnedCount: 0,
        blockerStatuses: [{ blockerId: 'mars-parent', status: 'running' }],
      },
    ])

    const r = await runCommandInProcess(['recover'], {
      store: fakeStore,
      ctx: fakeCtx,
      daemon,
    })

    expect(r.code).toBe(0)
    const output = r.out.join('\n')
    expect(output).toContain('recovered')
    expect(output).toContain('mars-rec')
    expect(output).toContain('queue healthy')
    expect(output).toContain('1 task(s) waiting on live work')
    expect(output).not.toContain('STRANDED')
  })
})
