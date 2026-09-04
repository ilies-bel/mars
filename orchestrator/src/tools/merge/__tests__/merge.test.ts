/**
 * Contract tests for `src/tools/merge/merge.ts`.
 *
 * These tests verify that the shared constants and types are correctly defined
 * and mutually consistent. They also serve as the knip entry-point that makes
 * all exports reachable so the linter does not flag them as unused before the
 * consumer slices land.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MERGE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MERGE_STEP_TIMEOUT_MS,
  DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS,
  MERGE_ALREADY_TERMINAL_REASON,
  MERGE_ENV_UNREACHABLE_REASON,
  MERGE_IDEMPOTENT_TERMINAL_STATUSES,
  MERGE_PHANTOM_MERGE_SIGNATURE,
  MERGE_STEP_TIMEOUT_FAILURE_REASON,
  MERGE_WEDGED_VCS_SUPERVISOR_REASON,
  MERGE_WORK_LOST_SIGNATURE,
  PARKED_REF_PREFIX,
  WedgedVcsSupervisorError,
  type MergeHeartbeat,
  type MergeHeartbeatFn,
} from '../merge.js'

// ---------------------------------------------------------------------------
// Heartbeat constants
// ---------------------------------------------------------------------------

describe('DEFAULT_MERGE_HEARTBEAT_INTERVAL_MS', () => {
  it('is a positive finite number', () => {
    expect(typeof DEFAULT_MERGE_HEARTBEAT_INTERVAL_MS).toBe('number')
    expect(Number.isFinite(DEFAULT_MERGE_HEARTBEAT_INTERVAL_MS)).toBe(true)
    expect(DEFAULT_MERGE_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0)
  })

  it('is 15 seconds', () => {
    expect(DEFAULT_MERGE_HEARTBEAT_INTERVAL_MS).toBe(15_000)
  })
})

// ---------------------------------------------------------------------------
// Hard step-level timeout
// ---------------------------------------------------------------------------

describe('DEFAULT_MERGE_STEP_TIMEOUT_MS', () => {
  it('is a positive finite number', () => {
    expect(typeof DEFAULT_MERGE_STEP_TIMEOUT_MS).toBe('number')
    expect(Number.isFinite(DEFAULT_MERGE_STEP_TIMEOUT_MS)).toBe(true)
    expect(DEFAULT_MERGE_STEP_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('is larger than the internal per-job watchdog (35 min)', () => {
    // The internal watchdog is VCS_SUPERVISOR_TIMEOUT_MS (30 min) +
    // MERGE_GIT_BUDGET_MS (5 min) = 35 min = 2_100_000 ms.
    const INTERNAL_WATCHDOG_MS = 35 * 60_000
    expect(DEFAULT_MERGE_STEP_TIMEOUT_MS).toBeGreaterThan(INTERNAL_WATCHDOG_MS)
  })

  it('is 45 minutes', () => {
    expect(DEFAULT_MERGE_STEP_TIMEOUT_MS).toBe(45 * 60_000)
  })

  it('has the correct failure reason string', () => {
    expect(MERGE_STEP_TIMEOUT_FAILURE_REASON).toBe('merge:step-timeout')
  })
})

// ---------------------------------------------------------------------------
// Idempotent terminal short-circuit
// ---------------------------------------------------------------------------

describe('MERGE_IDEMPOTENT_TERMINAL_STATUSES', () => {
  it('contains done, failed, and dropped', () => {
    expect(MERGE_IDEMPOTENT_TERMINAL_STATUSES.has('done')).toBe(true)
    expect(MERGE_IDEMPOTENT_TERMINAL_STATUSES.has('failed')).toBe(true)
    expect(MERGE_IDEMPOTENT_TERMINAL_STATUSES.has('dropped')).toBe(true)
  })

  it('contains exactly 3 statuses', () => {
    expect(MERGE_IDEMPOTENT_TERMINAL_STATUSES.size).toBe(3)
  })

  it('does NOT contain running or merging (transient statuses should not short-circuit)', () => {
    expect(MERGE_IDEMPOTENT_TERMINAL_STATUSES.has('running')).toBe(false)
    expect(MERGE_IDEMPOTENT_TERMINAL_STATUSES.has('merging')).toBe(false)
    expect(MERGE_IDEMPOTENT_TERMINAL_STATUSES.has('queued')).toBe(false)
  })

  it('MERGE_ALREADY_TERMINAL_REASON has expected format', () => {
    expect(MERGE_ALREADY_TERMINAL_REASON).toBe('merge:already-terminal')
    // Must start with 'merge:' so failure-signature classifiers recognise it.
    expect(MERGE_ALREADY_TERMINAL_REASON.startsWith('merge:')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// WedgedVcsSupervisorError
// ---------------------------------------------------------------------------

describe('WedgedVcsSupervisorError', () => {
  it('is an instance of Error', () => {
    const err = new WedgedVcsSupervisorError('mars-test-01', 60_000, 'vega')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(WedgedVcsSupervisorError)
  })

  it('sets name to WedgedVcsSupervisorError', () => {
    const err = new WedgedVcsSupervisorError('mars-test-02', 120_000, 'rebase')
    expect(err.name).toBe('WedgedVcsSupervisorError')
  })

  it('exposes taskId, lockHeldMs, lastPhase', () => {
    const err = new WedgedVcsSupervisorError('mars-test-03', 300_000, 'fast-forward')
    expect(err.taskId).toBe('mars-test-03')
    expect(err.lockHeldMs).toBe(300_000)
    expect(err.lastPhase).toBe('fast-forward')
  })

  it('includes taskId and lastPhase in the message', () => {
    const err = new WedgedVcsSupervisorError('mars-wedge-04', 600_000, 'integration-gate')
    expect(err.message).toContain('mars-wedge-04')
    expect(err.message).toContain('integration-gate')
  })

  it('mentions merge:wedged-vcs-supervisor in the message', () => {
    const err = new WedgedVcsSupervisorError('mars-wedge-05', 60_000, 'vega')
    expect(err.message).toContain('merge:wedged-vcs-supervisor')
  })
})

describe('DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS', () => {
  it('is a positive finite number', () => {
    expect(typeof DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS).toBe('number')
    expect(Number.isFinite(DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS)).toBe(true)
    expect(DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('is 20 minutes', () => {
    expect(DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS).toBe(20 * 60_000)
  })

  it('is less than the vcs-supervisor total budget (30 min = 1_800_000 ms)', () => {
    // VCS_SUPERVISOR_TIMEOUT_MS in core/lib/git/merge.ts is 30 * 60 * 1000.
    const VCS_SUPERVISOR_TIMEOUT_MS = 30 * 60_000
    expect(DEFAULT_WEDGED_VCS_SUPERVISOR_TIMEOUT_MS).toBeLessThan(VCS_SUPERVISOR_TIMEOUT_MS)
  })

  it('MERGE_WEDGED_VCS_SUPERVISOR_REASON has expected format', () => {
    expect(MERGE_WEDGED_VCS_SUPERVISOR_REASON).toBe('merge:wedged-vcs-supervisor')
    expect(MERGE_WEDGED_VCS_SUPERVISOR_REASON.startsWith('merge:')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Type-level smoke tests (compile-time only; no runtime assertions needed)
// ---------------------------------------------------------------------------

// These assignments verify the exported types are structurally correct.
// If the types are wrong this file will fail tsc, catching regressions.

it('MergeHeartbeat type is structurally valid', () => {
  const hb: MergeHeartbeat = {
    taskId: 'mars-type-01',
    elapsedMs: 5_000,
    phase: 'rebase',
    at: Date.now(),
  }
  expect(hb.taskId).toBe('mars-type-01')
})

it('MergeHeartbeatFn type accepts void-returning callback', () => {
  const fn: MergeHeartbeatFn = (_hb) => {}
  expect(typeof fn).toBe('function')
})

it('MergeHeartbeatFn type accepts Promise<void>-returning callback', () => {
  const fn: MergeHeartbeatFn = async (_hb) => {}
  expect(typeof fn).toBe('function')
})

// ---------------------------------------------------------------------------
// MERGE_ENV_UNREACHABLE_REASON — post-Vega transient abort
//
// Stamped when Vega COMPLETED (conflictResolved: true) but a subsequent step
// (fast-forward CAS, integration-gate, transient network error) aborted the
// merge. The resolved rebase is already on the task branch; no fix-task is
// spawned; `mars continue` retries just the merge step without re-invoking Vega.
// ---------------------------------------------------------------------------

describe('MERGE_ENV_UNREACHABLE_REASON', () => {
  it('has the expected value', () => {
    expect(MERGE_ENV_UNREACHABLE_REASON).toBe('merge:env-unreachable')
  })

  it('starts with merge: prefix for action-queue classifier compatibility', () => {
    expect(MERGE_ENV_UNREACHABLE_REASON.startsWith('merge:')).toBe(true)
  })

  it('does NOT contain vcs-supervisor-aborted — Vega completed, so its abort is not the cause', () => {
    expect(MERGE_ENV_UNREACHABLE_REASON).not.toContain('vcs-supervisor-aborted')
  })

  it('is distinct from MERGE_WEDGED_VCS_SUPERVISOR_REASON', () => {
    expect(MERGE_ENV_UNREACHABLE_REASON).not.toBe(MERGE_WEDGED_VCS_SUPERVISOR_REASON)
  })

  it('is distinct from MERGE_STEP_TIMEOUT_FAILURE_REASON', () => {
    expect(MERGE_ENV_UNREACHABLE_REASON).not.toBe(MERGE_STEP_TIMEOUT_FAILURE_REASON)
  })

  it('is distinct from MERGE_ALREADY_TERMINAL_REASON', () => {
    expect(MERGE_ENV_UNREACHABLE_REASON).not.toBe(MERGE_ALREADY_TERMINAL_REASON)
  })

  it('is a string literal (not a dynamic value)', () => {
    expect(typeof MERGE_ENV_UNREACHABLE_REASON).toBe('string')
    expect(MERGE_ENV_UNREACHABLE_REASON.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Work-lost and phantom-merge guard constants (zero-commit branch protection)
// ---------------------------------------------------------------------------

describe('MERGE_WORK_LOST_SIGNATURE', () => {
  it('is a string', () => {
    expect(typeof MERGE_WORK_LOST_SIGNATURE).toBe('string')
    expect(MERGE_WORK_LOST_SIGNATURE.length).toBeGreaterThan(0)
  })

  it('equals merge:work-lost', () => {
    expect(MERGE_WORK_LOST_SIGNATURE).toBe('merge:work-lost')
  })

  it('starts with merge: prefix for action-queue classifier compatibility', () => {
    expect(MERGE_WORK_LOST_SIGNATURE.startsWith('merge:')).toBe(true)
  })

  it('is distinct from MERGE_PHANTOM_MERGE_SIGNATURE', () => {
    expect(MERGE_WORK_LOST_SIGNATURE).not.toBe(MERGE_PHANTOM_MERGE_SIGNATURE)
  })
})

describe('MERGE_PHANTOM_MERGE_SIGNATURE', () => {
  it('is a string', () => {
    expect(typeof MERGE_PHANTOM_MERGE_SIGNATURE).toBe('string')
    expect(MERGE_PHANTOM_MERGE_SIGNATURE.length).toBeGreaterThan(0)
  })

  it('equals merge:phantom-merge', () => {
    expect(MERGE_PHANTOM_MERGE_SIGNATURE).toBe('merge:phantom-merge')
  })

  it('starts with merge: prefix for action-queue classifier compatibility', () => {
    expect(MERGE_PHANTOM_MERGE_SIGNATURE.startsWith('merge:')).toBe(true)
  })

  it('is distinct from MERGE_WORK_LOST_SIGNATURE', () => {
    expect(MERGE_PHANTOM_MERGE_SIGNATURE).not.toBe(MERGE_WORK_LOST_SIGNATURE)
  })
})

describe('PARKED_REF_PREFIX', () => {
  it('is a string', () => {
    expect(typeof PARKED_REF_PREFIX).toBe('string')
    expect(PARKED_REF_PREFIX.length).toBeGreaterThan(0)
  })

  it('equals refs/mars/parked', () => {
    expect(PARKED_REF_PREFIX).toBe('refs/mars/parked')
  })

  it('starts with refs/mars/ in the Mars ref namespace', () => {
    expect(PARKED_REF_PREFIX.startsWith('refs/mars/')).toBe(true)
  })

  it('does not end with a slash (callers append /<taskId>/<ts>)', () => {
    expect(PARKED_REF_PREFIX.endsWith('/')).toBe(false)
  })
})
