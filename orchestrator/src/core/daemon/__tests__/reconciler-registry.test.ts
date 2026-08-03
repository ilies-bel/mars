/**
 * Tests for the Reconciler registry seam (../reconciler + ../reconcilers).
 *
 * Guards the two invariants that make the registry a safe seam:
 *  1. The registry exposes the startup steps in the EXACT historical order.
 *  2. runStartupReconcile walks the registry in that order and merges each
 *     step's ReconcileStepResult into the aggregate summary — so a step's
 *     declared order and its summary contribution stay coupled.
 */

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Reconciler, ReconcileDeps } from '../reconciler'
import { RECONCILERS } from '../reconcilers'

const makeDeps = (): ReconcileDeps => ({
  log: () => {},
  bus: new EventEmitter(),
  traceStore: null,
  handleProposalSlice: null,
})

describe('RECONCILERS registry', () => {
  it('lists the startup steps in the exact historical order', () => {
    const names = RECONCILERS.map((r) => r.name)
    expect(names).toEqual([
      'daemon-killed-sweep',
      'daemon-died-sweep',
      'orphaned-chat-run-sweep',
      'blocker-drift-repair',
      'retired-plan-gate-reconcile',
      // Fail origins stranded in `blocked` behind their own failed recovery
      // before anything re-seeds dispatch or re-queues orphaned-blocked rows.
      'stranded-origin-recovery-repair',
      'terminal-origin-chore-repair',
      'merge-jobs-startup-reconcile',
      'orphaned-blocked-scan',
      'recovery-done-propagation',
      'failed-committer-dependent-release',
      'queued-committer-reseed',
      'requeue-stale-running',
      'reseed-dispatch',
      'orphan-span-sweep',
      'verifying-recovery',
      'merging-recovery',
      'vega-reconciling-recovery',
      'stranded-slicing-proposal-reconcile',
      'stalled-proposal-slice',
      'stale-action-queue-sweep',
      'code-drift-clear-sweep',
      'workflow-install-drift-sweep',
      'ghost-subscriber-sweep',
    ])
  })

  it('every entry is a Reconciler with a name and an async run()', () => {
    for (const r of RECONCILERS) {
      expect(typeof r.name).toBe('string')
      expect(r.name.length).toBeGreaterThan(0)
      expect(typeof r.run).toBe('function')
    }
  })
})

describe('runStartupReconcile — registry iteration order', () => {
  it('invokes each registry entry exactly once, in array order', async () => {
    // Replace the real registry with a tiny ordered set of probes so we can
    // assert the orchestrator iterates in order without touching the DB.
    const calls: string[] = []
    const probe = (name: string, contribution: Record<string, number>): Reconciler => ({
      name,
      run: async () => {
        calls.push(name)
        return contribution
      },
    })

    const fakeRegistry: readonly Reconciler[] = [
      probe('first', { blockerDriftRepaired: 2 }),
      probe('second', { runningRequeued: 3 }),
      probe('third', { stalledProposalsSliced: 1 }),
    ]

    vi.resetModules()
    vi.doMock('../reconcilers', () => ({ RECONCILERS: fakeRegistry }))
    const { runStartupReconcile } = await import('../startup-reconcile')

    const summary = await runStartupReconcile(makeDeps())

    // Walked in array order, once each.
    expect(calls).toEqual(['first', 'second', 'third'])

    // Each step's contribution was merged into the aggregate; untouched
    // fields keep their zero default.
    expect(summary.blockerDriftRepaired).toBe(2)
    expect(summary.runningRequeued).toBe(3)
    expect(summary.stalledProposalsSliced).toBe(1)
    expect(summary.daemonKilledAlerts).toBe(0)

    vi.doUnmock('../reconcilers')
    vi.resetModules()
  })
})
