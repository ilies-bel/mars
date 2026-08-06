/**
 * RPC-seam regression test for the `step-reset` op.
 *
 * Exercises the `stepResetHandler` leaf through `dispatchRpc` with an injected
 * fake `DaemonDeps` — no spawned daemon, no socket. Verifies:
 *
 *   1. The op routes correctly to `deps.handleStepReset`.
 *   2. The response carries { nextStep, queued, cleared } from the handler.
 *   3. `step-reset` is NOT a work-spawning op and therefore passes through
 *      the drain gate unchanged.
 *   4. A thrown handler error is mapped to ok:false by `dispatchRpc`.
 */

import { describe, expect, it, vi } from 'vitest'
import { rpcRegistry, dispatchRpc } from '../rpc/registry'
import { makeSem } from '../semaphore'
import type { DaemonDeps } from '../rpc/types'
import type { TaskFlightTracker } from '../task-flight-tracker'

const fakeTracker = (): TaskFlightTracker =>
  ({
    isInFlight: () => false,
    inFlightKind: () => undefined,
    inFlightCount: () => 0,
    inFlightSnapshot: () => [],
    clearPending: () => {},
    enqueuePending: () => {},
    forceRelease: () => false,
  }) as unknown as TaskFlightTracker

const notImpl =
  (name: string) =>
  (): never => {
    throw new Error(`unexpected call to ${name}`)
  }

const makeDeps = (overrides: Partial<DaemonDeps> = {}): DaemonDeps => ({
  log: () => {},
  bus: { emit: () => true } as unknown as DaemonDeps['bus'],
  tracker: fakeTracker(),
  sems: {
    implement: makeSem(2),
    triage: makeSem(2),
    refine: makeSem(2),
    verify: makeSem(2),
  },
  getAcceptingWork: () => true,
  setAcceptingWork: () => {},
  getPauseState: notImpl('getPauseState') as DaemonDeps['getPauseState'],
  pauseDispatch: notImpl('pauseDispatch') as DaemonDeps['pauseDispatch'],
  resumeDispatch: notImpl('resumeDispatch') as DaemonDeps['resumeDispatch'],
  resetSignatureStorm: notImpl('resetSignatureStorm') as DaemonDeps['resetSignatureStorm'],
  drain: async () => {},
  shutdown: async () => {},
  paths: { socketPath: '/tmp/x.sock', pidFile: '/tmp/x.pid', httpPortFile: '/tmp/x.port' },
  handleAdd: notImpl('handleAdd') as DaemonDeps['handleAdd'],
  setTaskPriority: notImpl('setTaskPriority') as DaemonDeps['setTaskPriority'],
  handleUpdate: notImpl('handleUpdate') as DaemonDeps['handleUpdate'],
  handleContinue: notImpl('handleContinue') as DaemonDeps['handleContinue'],
  handleStop: notImpl('handleStop') as DaemonDeps['handleStop'],
  handleRestart: notImpl('handleRestart') as DaemonDeps['handleRestart'],
  handleRemerge: notImpl('handleRemerge') as DaemonDeps['handleRemerge'],
  handlePurge: notImpl('handlePurge') as DaemonDeps['handlePurge'],
  handleArcPurge: notImpl('handleArcPurge') as DaemonDeps['handleArcPurge'],
  handleDrop: notImpl('handleDrop') as DaemonDeps['handleDrop'],
  handleUnblock: notImpl('handleUnblock') as DaemonDeps['handleUnblock'],
  handleBlock: notImpl('handleBlock') as DaemonDeps['handleBlock'],
  handleRemoveBlockers: notImpl('handleRemoveBlockers') as DaemonDeps['handleRemoveBlockers'],
  handleRecover: notImpl('handleRecover') as DaemonDeps['handleRecover'],
  runSync: notImpl('runSync') as DaemonDeps['runSync'],
  handleProposalPromote: notImpl('handleProposalPromote') as DaemonDeps['handleProposalPromote'],
  handleProposalSlice: notImpl('handleProposalSlice') as DaemonDeps['handleProposalSlice'],
  handleProposalReslice: notImpl('handleProposalReslice') as DaemonDeps['handleProposalReslice'],
  handleProposalTake: notImpl('handleProposalTake') as DaemonDeps['handleProposalTake'],
  handleRefine: notImpl('handleRefine') as DaemonDeps['handleRefine'],
  dispatchGlossaryWrite: notImpl('dispatchGlossaryWrite') as DaemonDeps['dispatchGlossaryWrite'],
  dispatchAdrAdd: notImpl('dispatchAdrAdd') as DaemonDeps['dispatchAdrAdd'],
  dispatchAdrSupersede: notImpl('dispatchAdrSupersede') as DaemonDeps['dispatchAdrSupersede'],
  dispatchVisionWrite: notImpl('dispatchVisionWrite') as DaemonDeps['dispatchVisionWrite'],
  handleInit: notImpl('handleInit') as DaemonDeps['handleInit'],
  handleStatus: notImpl('handleStatus') as DaemonDeps['handleStatus'],
  investigateWorktree: notImpl('investigateWorktree') as DaemonDeps['investigateWorktree'],
  diagnoseFailure: notImpl('diagnoseFailure') as DaemonDeps['diagnoseFailure'],
  handleReleaseLease: notImpl('handleReleaseLease') as DaemonDeps['handleReleaseLease'],
  handleStepDone: notImpl('handleStepDone') as DaemonDeps['handleStepDone'],
  handleStepReset: notImpl('handleStepReset') as DaemonDeps['handleStepReset'],
  appendProgress: notImpl('appendProgress') as DaemonDeps['appendProgress'],
  appendMcpWorkerAudit: notImpl('appendMcpWorkerAudit') as DaemonDeps['appendMcpWorkerAudit'],
  handlePreviewSpawn: notImpl('handlePreviewSpawn') as DaemonDeps['handlePreviewSpawn'],
  handlePreviewStatus: notImpl('handlePreviewStatus') as DaemonDeps['handlePreviewStatus'],
  handlePreviewTeardown: notImpl('handlePreviewTeardown') as DaemonDeps['handlePreviewTeardown'],
  handleCancelMergeJob: notImpl('handleCancelMergeJob') as DaemonDeps['handleCancelMergeJob'],
  handleSpendControlShow: notImpl('handleSpendControlShow') as DaemonDeps['handleSpendControlShow'],
  handleSpendControlSet: notImpl('handleSpendControlSet') as DaemonDeps['handleSpendControlSet'],
  ...overrides,
})

describe('step-reset RPC handler', () => {
  it('routes to deps.handleStepReset and returns the result payload', async () => {
    const expected = {
      nextStep: 'setup-worktree',
      queued: true,
      cleared: ['setup-worktree', 'run-claude-code', 'verify'],
    }
    const handleStepReset = vi.fn().mockResolvedValue(expected)
    const deps = makeDeps({ handleStepReset: handleStepReset as DaemonDeps['handleStepReset'] })

    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'step-reset', id: 'mars-abc123', stepName: 'setup-worktree' },
      deps,
    )

    expect(handleStepReset).toHaveBeenCalledWith('mars-abc123', 'setup-worktree')
    expect(res).toEqual({ ok: true, data: expected })
  })

  it('is NOT gated by the drain gate (non-work-spawning op)', async () => {
    const expected = { nextStep: 'verify', queued: true, cleared: ['verify'] }
    const handleStepReset = vi.fn().mockResolvedValue(expected)
    const deps = makeDeps({ handleStepReset: handleStepReset as DaemonDeps['handleStepReset'] })
    deps.setAcceptingWork(false)

    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'step-reset', id: 'mars-abc123', stepName: 'verify' },
      deps,
    )

    // The drain gate must not block this op — it's an operator repair command,
    // not a work-spawning call.
    expect(res.ok).toBe(true)
    expect(handleStepReset).toHaveBeenCalledOnce()
  })

  it('maps a thrown handler error to ok:false', async () => {
    const handleStepReset = vi
      .fn()
      .mockRejectedValue(new Error(`step 'nonexistent' has no recorded checkpoint`))
    const deps = makeDeps({ handleStepReset: handleStepReset as DaemonDeps['handleStepReset'] })

    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'step-reset', id: 'mars-abc123', stepName: 'nonexistent' },
      deps,
    )

    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('no recorded checkpoint')
  })
})
