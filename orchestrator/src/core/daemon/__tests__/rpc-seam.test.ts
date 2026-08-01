/**
 * In-process daemon RPC-seam tests (daemon-command-seam ADR; mirrors ADR-0023).
 *
 * These exercise leaf handlers through `dispatchRpc(rpcRegistry, …)` with an
 * injected fake {@link DaemonDeps} — NO spawned daemon, NO socket. This is the
 * payoff the seam buys: an RPC op like `ping`, `reload-config`, or the
 * `shutdown drain` flag-flip is now nameable and assertable directly, where
 * before the only way to reach it was to spawn the daemon and drive a socket.
 *
 * `kill` and the SIGKILL path of `shutdown` are intentionally NOT exercised
 * here — they call `process.kill(..., 'SIGKILL')` and would tear down the test
 * runner. `shutdown drain` is safe because it delegates exit to the injected
 * `deps.shutdown` stub.
 */

import { describe, expect, it, vi } from 'vitest'
import { rpcRegistry, dispatchRpc, buildRpcRegistry } from '../rpc/registry'
import { allRpcHandlers } from '../rpc/handlers'
import { makeSem } from '../server'
import { createPauseController } from '../pause-state'
import type { PauseController } from '../pause-state'
import type { DaemonDeps } from '../rpc/types'
import type { DaemonRequest } from '../protocol'
import type { TaskFlightTracker } from '../task-flight-tracker'

/** A no-op tracker stub exposing the methods the leaves under test touch. */
const fakeTracker = (overrides: Partial<TaskFlightTracker> = {}): TaskFlightTracker =>
  ({
    isInFlight: () => false,
    inFlightKind: () => undefined,
    inFlightCount: () => 0,
    inFlightSnapshot: () => [],
    clearPending: () => {},
    enqueuePending: () => {},
    forceRelease: () => false,
    ...overrides,
  }) as unknown as TaskFlightTracker

/**
 * Build a fake `DaemonDeps`. Every named handler is a throwing stub by default
 * (a test that routes to one overrides it); the inline-case primitives
 * (`acceptingWork` accessors, `sems`, `log`, `drain`, `shutdown`) are real,
 * recordable closures so the seam's live-accessor threading can be asserted.
 */
const makeDeps = (overrides: Partial<DaemonDeps> = {}): {
  deps: DaemonDeps
  state: {
    accepting: boolean
    drained: number
    shutdownCalls: boolean[]
    pause: PauseController
    stormResets: number
  }
} => {
  const state = {
    accepting: true,
    drained: 0,
    shutdownCalls: [] as boolean[],
    // A REAL pause controller: `set-dispatch` is only meaningful against the
    // first-cause-wins semantics, which a boolean stub would not reproduce.
    pause: createPauseController(),
    stormResets: 0,
  }
  const notImpl = (name: string) => () => {
    throw new Error(`unexpected call to ${name}`)
  }
  const deps: DaemonDeps = {
    log: () => {},
    bus: { emit: () => true } as unknown as DaemonDeps['bus'],
    tracker: fakeTracker(),
    sems: {
      implement: makeSem(2),
      triage: makeSem(2),
      refine: makeSem(2),
      structuredWrite: makeSem(2),
      verify: makeSem(2),
    },
    getAcceptingWork: () => state.accepting,
    setAcceptingWork: (v) => {
      state.accepting = v
    },
    getPauseState: () => state.pause.get(),
    pauseDispatch: (reason, detail) => state.pause.pause(reason, detail),
    resumeDispatch: () => {
      state.pause.resume()
    },
    resetSignatureStorm: async () => {
      state.stormResets += 1
    },
    drain: async () => {
      state.drained += 1
    },
    shutdown: async (force) => {
      state.shutdownCalls.push(force === true)
    },
    paths: { socketPath: '/tmp/x.sock', pidFile: '/tmp/x.pid', httpPortFile: '/tmp/x.port' },
    handleAdd: notImpl('handleAdd') as DaemonDeps['handleAdd'],
    setTaskPriority: notImpl('setTaskPriority') as DaemonDeps['setTaskPriority'],
    handleUpdate: notImpl('handleUpdate') as DaemonDeps['handleUpdate'],
    handleContinue: notImpl('handleContinue') as DaemonDeps['handleContinue'],
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
    handleProposalApprove: notImpl('handleProposalApprove') as DaemonDeps['handleProposalApprove'],
    handleProposalReslice: notImpl('handleProposalReslice') as DaemonDeps['handleProposalReslice'],
    handleProposalTake: notImpl('handleProposalTake') as DaemonDeps['handleProposalTake'],
    handleRefine: notImpl('handleRefine') as DaemonDeps['handleRefine'],
    dispatchGlossaryWrite: notImpl('dispatchGlossaryWrite') as DaemonDeps['dispatchGlossaryWrite'],
    dispatchAdrAdd: notImpl('dispatchAdrAdd') as DaemonDeps['dispatchAdrAdd'],
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
  }
  return { deps, state }
}

describe('RPC registry', () => {
  it('registers exactly one leaf per protocol op, no duplicates', () => {
    // Every handler op is unique (buildRpcRegistry throws on dup).
    expect(() => buildRpcRegistry(allRpcHandlers)).not.toThrow()
    // Spot-check the count matches the 45-op protocol surface
    // (35 + preview.spawn + preview.status + preview.teardown + merge.cancel
    //  + spend-control.show + spend-control.set + apply-lever + task.contextForWorker
    //  + mcp.audit.append + set-dispatch).
    expect(rpcRegistry.size).toBe(45)
  })

  it('rejects duplicate ops', () => {
    const dup = [allRpcHandlers[0], allRpcHandlers[0]]
    expect(() => buildRpcRegistry(dup)).toThrow(/duplicate RPC op/)
  })
})

describe('dispatchRpc routing', () => {
  it('ping returns the process pid', async () => {
    const { deps } = makeDeps()
    const res = await dispatchRpc(rpcRegistry, { op: 'ping' }, deps)
    expect(res).toEqual({ ok: true, data: { pid: process.pid } })
  })

  it('an unknown op returns ok:false with an "unknown op" error', async () => {
    const { deps } = makeDeps()
    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'totally-not-a-real-op' } as unknown as DaemonRequest,
      deps,
    )
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/unknown op/)
  })

  it('status delegates to deps.handleStatus', async () => {
    const payload = { pid: 1, startedAt: 'now', inFlight: [], counts: {} }
    const { deps } = makeDeps({
      handleStatus: vi.fn().mockResolvedValue(payload) as DaemonDeps['handleStatus'],
    })
    const res = await dispatchRpc(rpcRegistry, { op: 'status' }, deps)
    expect(res).toEqual({ ok: true, data: payload })
    expect(deps.handleStatus).toHaveBeenCalledOnce()
  })

  it('mcp.audit.append persists the worker mutation evidence through the daemon seam', async () => {
    const appendMcpWorkerAudit = vi.fn().mockResolvedValue(undefined)
    const { deps } = makeDeps({
      appendMcpWorkerAudit: appendMcpWorkerAudit as DaemonDeps['appendMcpWorkerAudit'],
    })
    const audit = {
      toolName: 'mars_task_note',
      taskId: 'mars-audit-001',
      argsJson: { body: '[redacted]' },
      ok: false,
      errorMessage: 'daemon unavailable',
    }

    const result = await dispatchRpc(rpcRegistry, { op: 'mcp.audit.append', ...audit }, deps)

    expect(result).toEqual({ ok: true })
    expect(appendMcpWorkerAudit).toHaveBeenCalledWith(audit)
  })

  it('task.priority routes through deps.setTaskPriority (C1 Arc path)', async () => {
    const task = { id: 't1', priority: 3 }
    const setTaskPriority = vi
      .fn()
      .mockResolvedValue(task) as DaemonDeps['setTaskPriority']
    const { deps } = makeDeps({ setTaskPriority })
    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'task.priority', id: 't1', priority: 3 },
      deps,
    )
    expect(setTaskPriority).toHaveBeenCalledWith('t1', 3)
    expect(res).toEqual({ ok: true, data: task })
  })

  it('proposal.take delegates to handleProposalTake and passes proposalId', async () => {
    const handleProposalTake = vi
      .fn()
      .mockResolvedValue({ proposalId: 'p1', taskId: 't99' }) as DaemonDeps['handleProposalTake']
    const { deps } = makeDeps({ handleProposalTake })
    const res = await dispatchRpc(rpcRegistry, { op: 'proposal.take', proposalId: 'p1' }, deps)
    expect(handleProposalTake).toHaveBeenCalledWith('p1', undefined)
    expect(res).toEqual({ ok: true, data: { proposalId: 'p1', taskId: 't99' } })
  })

  it('proposal.take is gated by the drain gate (work-spawning op)', async () => {
    const { deps } = makeDeps()
    deps.setAcceptingWork(false)
    const res = await dispatchRpc(rpcRegistry, { op: 'proposal.take', proposalId: 'p1' }, deps)
    expect(res.ok).toBe(false)
    expect((res as { errorCode?: string }).errorCode).toBe('DRAINING')
  })
})

describe('inline-case leaves reach live closure state', () => {
  it('reload-config mutates the LIVE semaphore objects and re-drains', async () => {
    const { deps, state } = makeDeps()
    const res = await dispatchRpc(rpcRegistry, { op: 'reload-config' }, deps)
    expect(res.ok).toBe(true)
    // The caps come from the real loadDaemonConfig(); assert the live sems were
    // re-limited to whatever it returned (the data echo matches the sem state).
    const data = (res as { data: { caps: Record<string, number> } }).data
    expect(deps.sems.implement.limit).toBe(data.caps.implement)
    expect(deps.sems.triage.limit).toBe(data.caps.triage)
    expect(deps.sems.refine.limit).toBe(data.caps.refine)
    expect(deps.sems.structuredWrite.limit).toBe(data.caps['structured-write'])
    expect(deps.sems.verify.limit).toBe(data.caps.verify)
    expect(state.drained).toBe(1)
  })

  it('shutdown drain flips the LIVE acceptingWork flag and schedules shutdown', async () => {
    const { deps, state } = makeDeps()
    expect(state.accepting).toBe(true)
    const res = await dispatchRpc(rpcRegistry, { op: 'shutdown', drain: true }, deps)
    expect(res).toEqual({ ok: true, data: { inFlight: 0, draining: true } })
    // setAcceptingWork(false) ran synchronously via the live accessor.
    expect(state.accepting).toBe(false)
    // shutdown(false) is queued in a microtask — flush it.
    await Promise.resolve()
    expect(state.shutdownCalls).toEqual([false])
  })

  it('shutdown (no flags) refuses when work is in flight', async () => {
    const { deps } = makeDeps({ tracker: fakeTracker({ inFlightCount: () => 2 }) })
    const res = await dispatchRpc(rpcRegistry, { op: 'shutdown' }, deps)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/in flight/)
  })
})

describe('status pause state', () => {
  it('status surfaces the pause reason, not just the fact of a pause', async () => {
    const payload = {
      pid: 1,
      startedAt: 'now',
      inFlight: [],
      counts: {},
      sourceSha: null,
      currentSha: null,
      isStale: false,
      pause: {
        paused: true,
        reason: 'storm' as const,
        since: '2026-07-31T00:00:00.000Z',
        detail: 'signature storm: code/api-unreachable x3',
      },
    }
    const { deps } = makeDeps({
      handleStatus: vi.fn().mockResolvedValue(payload) as DaemonDeps['handleStatus'],
    })
    const res = await dispatchRpc(rpcRegistry, { op: 'status' }, deps)
    expect(res.ok).toBe(true)
    const data = (res as { ok: true; data: typeof payload }).data
    expect(data.pause.paused).toBe(true)
    expect(data.pause.reason).toBe('storm')
  })
})

describe('set-dispatch', () => {
  it('off pauses dispatch with reason operator', async () => {
    const { deps, state } = makeDeps()
    const res = await dispatchRpc(rpcRegistry, { op: 'set-dispatch', value: 'off' }, deps)
    expect(res.ok).toBe(true)
    expect((res as { ok: true; data: { paused: boolean; reason: string } }).data).toMatchObject({
      paused: true,
      reason: 'operator',
    })
    expect(state.pause.isPaused()).toBe(true)
  })

  it('on clears a storm pause and reports the cleared reason', async () => {
    const { deps, state } = makeDeps()
    state.pause.pause('storm', 'signature storm: code/api-unreachable x3')

    const res = await dispatchRpc(rpcRegistry, { op: 'set-dispatch', value: 'on' }, deps)

    expect(res.ok).toBe(true)
    expect((res as { ok: true; data: { clearedReason: string } }).data).toMatchObject({
      paused: false,
      clearedReason: 'storm',
    })
    expect(state.pause.isPaused()).toBe(false)
    // The durable breaker flag must be cleared too, or the next daemon start
    // re-pauses the queue the operator just resumed.
    expect(state.stormResets).toBe(1)
    expect(state.drained).toBe(1)
  })

  it('off does not overwrite an existing storm pause (first cause wins)', async () => {
    const { deps, state } = makeDeps()
    state.pause.pause('storm', 'signature storm: verify/x3')
    await dispatchRpc(rpcRegistry, { op: 'set-dispatch', value: 'off' }, deps)
    expect(state.pause.get().reason).toBe('storm')
  })

  it('on is a safe no-op when dispatch was never paused', async () => {
    const { deps, state } = makeDeps()
    const res = await dispatchRpc(rpcRegistry, { op: 'set-dispatch', value: 'on' }, deps)
    expect(res.ok).toBe(true)
    expect((res as { ok: true; data: { clearedReason: string | null } }).data.clearedReason).toBe(
      null,
    )
    expect(state.pause.isPaused()).toBe(false)
  })

  it('rejects a value that is neither on nor off', async () => {
    const { deps } = makeDeps()
    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'set-dispatch', value: 'maybe' } as unknown as DaemonRequest,
      deps,
    )
    expect(res.ok).toBe(false)
    expect((res as { ok: false; error: string }).error).toMatch(/must be 'on' or 'off'/)
  })
})

describe('drain gate and validation', () => {
  it('refuses work-spawning ops while draining (acceptingWork=false)', async () => {
    const { deps } = makeDeps()
    deps.setAcceptingWork(false)
    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'add', prompt: 'do a thing' },
      deps,
    )
    expect(res.ok).toBe(false)
    expect((res as { errorCode?: string }).errorCode).toBe('DRAINING')
  })

  it('still serves read-only ops (ping) while draining', async () => {
    const { deps } = makeDeps()
    deps.setAcceptingWork(false)
    const res = await dispatchRpc(rpcRegistry, { op: 'ping' }, deps)
    expect(res.ok).toBe(true)
  })

  it('add validates prompt type before reaching deps.handleAdd', async () => {
    const handleAdd = vi.fn() as unknown as DaemonDeps['handleAdd']
    const { deps } = makeDeps({ handleAdd })
    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'add', prompt: 42 as unknown as string },
      deps,
    )
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/prompt must be a string/)
    expect(handleAdd).not.toHaveBeenCalled()
  })

  it('glossary-write rejects an empty term before dispatching', async () => {
    const dispatchGlossaryWrite = vi.fn() as unknown as DaemonDeps['dispatchGlossaryWrite']
    const { deps } = makeDeps({ dispatchGlossaryWrite })
    const res = await dispatchRpc(
      rpcRegistry,
      { op: 'glossary-write', kind: 'set', term: '  ', definition: 'd' },
      deps,
    )
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/non-empty term/)
    expect(dispatchGlossaryWrite).not.toHaveBeenCalled()
  })

  it('maps a thrown handler error through mapDaemonError', async () => {
    const { deps } = makeDeps({
      handleRestart: vi
        .fn()
        .mockRejectedValue(new Error('task t9 not found')) as DaemonDeps['handleRestart'],
    })
    const res = await dispatchRpc(rpcRegistry, { op: 'restart', id: 't9' }, deps)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('not found')
  })
})
