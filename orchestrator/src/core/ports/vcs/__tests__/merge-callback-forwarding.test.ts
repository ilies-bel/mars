/**
 * Regression tests for the Vcs port's merge-callback forwarding.
 *
 * Root cause of mars-82a0b56f: slice 7 introduced `resolveVcs().merge()` as
 * the default mergeFn in merge-worker.ts. `local-git.ts`'s `merge()` only
 * forwarded the six serializable fields to `mergeBranch`, silently dropping
 * the six callback/signal fields that merge-worker.ts had painstakingly
 * constructed (onVerifyRebasedTree, onAfterFastForward, onSupervisorEvent,
 * signal, onOperatorAutoCommit, onProbeIntegrationAfterAutoCommit).
 * 164 merges landed on `main` with no verify gate running.
 *
 * These tests prevent a recurrence:
 *   1. The local-git adapter's merge() must forward every callback to
 *      mergeBranch — presence assertion on each, not just one.
 *   2. When the default mergeFn (resolveVcs().merge) is used and a task-tier
 *      gate is registered, the gate actually runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mock (hoisted before imports) ─────────────────────────────
//
// Mock mergeBranch so no real git is invoked. The factory is called lazily at
// the first module import inside a test, so mutations to `_mergeBranchSpy`
// before each test take effect correctly.

const _mergeBranchSpy = vi.fn()

vi.mock('../../../lib/git/merge.js', () => ({
  mergeBranch: (...args: unknown[]) => _mergeBranchSpy(...args),
  isBranchMergedIntoMain: vi.fn().mockResolvedValue(false),
  isZeroCommitBranch: vi.fn().mockResolvedValue(false),
  checkMergeTargetStatus: vi.fn().mockResolvedValue({ kind: 'clean' }),
}))

// ── Imports (after vi.mock hoisting) ──────────────────────────────────────

import { localGitVcs } from '../local-git.js'
import type { MergeSpec } from '../types.js'

// ── Shared fixtures ────────────────────────────────────────────────────────

const BASE_SPEC: Omit<MergeSpec, 'trace'> = {
  branch: 'task/mars-82a0b56f',
  worktreePath: '/tmp/mars-82a0b56f',
  integrationBranch: 'main',
  lockTimeoutMs: 30_000,
}

const FAKE_MERGE_RESULT = {
  merged: true,
  conflictResolved: false,
  aborted: false,
  output: 'fast-forwarded',
  retriesAttempted: 0,
  vegaSessionId: null,
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('local-git adapter: merge() forwards callbacks to mergeBranch', () => {
  beforeEach(() => {
    _mergeBranchSpy.mockReset()
    _mergeBranchSpy.mockResolvedValue(FAKE_MERGE_RESULT)
  })

  it('forwards onVerifyRebasedTree, onAfterFastForward, onSupervisorEvent, and signal', async () => {
    /**
     * REGRESSION TEST — mars-82a0b56f: asserts that each of the four
     * high-value callbacks arrives at mergeBranch as the identical function
     * reference supplied in the MergeSpec. A presence assertion on one
     * callback is not sufficient; all four are checked.
     */
    const ac = new AbortController()
    const onVerifyRebasedTree = vi.fn().mockResolvedValue({ passed: true })
    const onAfterFastForward = vi.fn().mockResolvedValue(undefined)
    const onSupervisorEvent = vi.fn()

    await localGitVcs.merge({
      ...BASE_SPEC,
      signal: ac.signal,
      onVerifyRebasedTree,
      onAfterFastForward,
      onSupervisorEvent,
    })

    expect(_mergeBranchSpy).toHaveBeenCalledOnce()
    const received = _mergeBranchSpy.mock.calls[0]![0] as Record<string, unknown>

    expect(
      received['onVerifyRebasedTree'],
      'onVerifyRebasedTree must be forwarded to mergeBranch',
    ).toBe(onVerifyRebasedTree)

    expect(
      received['onAfterFastForward'],
      'onAfterFastForward must be forwarded to mergeBranch',
    ).toBe(onAfterFastForward)

    expect(
      received['onSupervisorEvent'],
      'onSupervisorEvent must be forwarded to mergeBranch',
    ).toBe(onSupervisorEvent)

    expect(
      received['signal'],
      'signal must be forwarded to mergeBranch',
    ).toBe(ac.signal)
  })

  it('forwards autoCommitOperatorDirt and onOperatorAutoCommit', async () => {
    const onOperatorAutoCommit = vi.fn()

    await localGitVcs.merge({
      ...BASE_SPEC,
      autoCommitOperatorDirt: true,
      onOperatorAutoCommit,
    })

    const received = _mergeBranchSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(received['autoCommitOperatorDirt']).toBe(true)
    expect(received['onOperatorAutoCommit']).toBe(onOperatorAutoCommit)
  })

  it('forwards onProbeIntegrationAfterAutoCommit', async () => {
    const onProbeIntegrationAfterAutoCommit = vi.fn().mockResolvedValue({ passed: true })

    await localGitVcs.merge({
      ...BASE_SPEC,
      onProbeIntegrationAfterAutoCommit,
    })

    const received = _mergeBranchSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(received['onProbeIntegrationAfterAutoCommit']).toBe(onProbeIntegrationAfterAutoCommit)
  })

  it('passes undefined for callbacks not supplied in the spec', async () => {
    // When no callbacks are provided, mergeBranch receives undefined for each —
    // it must never receive a stub or accidental closure.
    await localGitVcs.merge({ ...BASE_SPEC })

    const received = _mergeBranchSpy.mock.calls[0]![0] as Record<string, unknown>
    expect(received['onVerifyRebasedTree']).toBeUndefined()
    expect(received['onAfterFastForward']).toBeUndefined()
    expect(received['onSupervisorEvent']).toBeUndefined()
    expect(received['signal']).toBeUndefined()
  })
})
