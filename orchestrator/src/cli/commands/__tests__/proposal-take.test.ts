/**
 * Tests for `mars proposal take` CLI behaviour (ADR-0067 / PRD 6c93eb31 slice 8).
 *
 * Covers the five acceptance criteria:
 *   1. Happy path — shaped prd-ready proposal → daemon called with right op+workflow, task id printed.
 *   2. Default workflow — no --workflow flag → daemon receives workflow='live'.
 *   3. Explicit --workflow — --workflow manual → daemon receives workflow='manual'.
 *   4. Non-shaped-proposal error — draft with no PRD body → actionable error, daemon not called.
 *   5. Unknown-id error — nonexistent id → error, daemon not called.
 *
 * All command dispatch uses DYNAMIC imports of test-adapter after vi.resetModules()
 * so every test gets fully fresh module instances (including proposals.ts and its
 * state-client singleton).  Static imports here are type-only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { runCommandInProcess, makeFakeDaemon } from '../../test-adapter'
import type { InProcessOptions } from '../../test-adapter'
import type { DomainTaskStore } from '../../../core/store/task-store'
import type { OrchestratorContext } from '../../../core/context'
import { rpcRegistry, dispatchRpc } from '../../../core/daemon/rpc/registry'
import { makeSem } from '../../../core/daemon/semaphore'
import type { DaemonDeps } from '../../../core/daemon/rpc/types'
import type { TaskFlightTracker } from '../../../core/daemon/task-flight-tracker'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-take-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Dynamically import store + ctx helpers AFTER the module cache reset so
 * they share the same module instances as the command dispatch.
 */
const loadStoreAndCtx = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

/** Create a prd-ready proposal in the local DB and return its id. */
const seedPrdReady = async (): Promise<string> => {
  const { createProposal, addProposalUserStory, promoteProposal, initProposals } =
    await import('../../../core/proposals')
  const { migrateQueueSchema } = await import('../../../core/queue')
  await initProposals()
  await migrateQueueSchema()
  const p = await createProposal('Take test proposal', {
    source: 'human',
    problem: 'There is a problem to solve',
    solution: 'Here is the solution to the problem',
  })
  await addProposalUserStory(p.id, 'As a user I can do the thing')
  await promoteProposal(p.id)
  return p.id
}

/** Create a bare draft proposal with no PRD body fields set. */
const seedUnshaped = async (): Promise<string> => {
  const { createProposal, initProposals } = await import('../../../core/proposals')
  const { migrateQueueSchema } = await import('../../../core/queue')
  await initProposals()
  await migrateQueueSchema()
  const p = await createProposal('Unshaped draft', { source: 'human' })
  return p.id
}

/**
 * Run a command in-process using FRESH module instances (after vi.resetModules()).
 * This guarantees the proposal-lookup code in proposalTake uses the same
 * DB connection as seedPrdReady / seedUnshaped.
 */
const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, opts)
}

/**
 * Create a recording fake daemon from fresh module instances.
 */
const makeFake = async (
  responder?: (req: Record<string, unknown>) => unknown,
) => {
  const { makeFakeDaemon } = await import('../../test-adapter')
  return makeFakeDaemon(responder as Parameters<typeof makeFakeDaemon>[0])
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('mars proposal take — happy path', () => {
  it('sends op=proposal.take with the proposal id, prints task id and workflow', async () => {
    const proposalId = await seedPrdReady()
    const fake = await makeFake((req) => {
      if (req['op'] === 'proposal.take') {
        return { proposalId: req['proposalId'], taskId: 'mars-live-task-001' }
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(['proposal', 'take', proposalId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ op: 'proposal.take', proposalId })
    expect(r.out.join('\n')).toContain('mars-live-task-001')
    // Never delegates to the slicer.
    const sliceCalls = fake.calls.filter((c) => (c as { op: string }).op === 'proposal.slice')
    expect(sliceCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Default workflow — no flag → 'live'
// ---------------------------------------------------------------------------

describe('mars proposal take — default workflow', () => {
  it('sends workflow=live when --workflow is omitted', async () => {
    const proposalId = await seedPrdReady()
    let capturedWorkflow: string | undefined
    const fake = await makeFake((req) => {
      if (req['op'] === 'proposal.take') {
        capturedWorkflow = req['workflow'] as string | undefined
        return { proposalId: req['proposalId'], taskId: 'mars-task-default-wf' }
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(['proposal', 'take', proposalId], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(capturedWorkflow).toBe('live')
    expect(r.out.join('\n')).toContain('live')
  })
})

// ---------------------------------------------------------------------------
// 3. Explicit --workflow flag
// ---------------------------------------------------------------------------

describe('mars proposal take — explicit --workflow', () => {
  it('forwards the specified workflow to the daemon', async () => {
    const proposalId = await seedPrdReady()
    let capturedWorkflow: string | undefined
    const fake = await makeFake((req) => {
      if (req['op'] === 'proposal.take') {
        capturedWorkflow = req['workflow'] as string | undefined
        return { proposalId: req['proposalId'], taskId: 'mars-task-manual-wf' }
      }
      return {}
    })
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(
      ['proposal', 'take', proposalId, '--workflow', 'manual'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(capturedWorkflow).toBe('manual')
    expect(r.out.join('\n')).toContain('manual')
    // Daemon was called exactly once.
    expect(fake.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 4. Non-shaped-proposal error — draft with no PRD body
// ---------------------------------------------------------------------------

describe('mars proposal take — non-shaped-proposal error', () => {
  it('errors with an actionable message when draft has no PRD body, daemon not called', async () => {
    const proposalId = await seedUnshaped()
    const fake = await makeFake()
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(['proposal', 'take', proposalId], { store, ctx, daemon: fake })

    expect(r.code).toBe(1)
    // Error message names what is missing.
    const errText = r.err.join('\n')
    expect(errText).toContain('not fully shaped')
    expect(errText).toContain('missing')
    // Daemon must never be contacted — error is caught locally.
    expect(fake.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Unknown-id error
// ---------------------------------------------------------------------------

describe('mars proposal take — unknown-id error', () => {
  it('errors when the proposal id does not exist, daemon not called', async () => {
    // Ensure DB is initialised but no proposals exist.
    const { initProposals } = await import('../../../core/proposals')
    const { migrateQueueSchema } = await import('../../../core/queue')
    await initProposals()
    await migrateQueueSchema()

    const fake = await makeFake()
    const { store, ctx } = await loadStoreAndCtx()

    const r = await run(
      ['proposal', 'take', 'nonexistent-proposal-id'],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not found')
    expect(fake.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// --help surface
// ---------------------------------------------------------------------------

describe('mars proposal take --help surface', () => {
  it('usage string mentions --workflow <kind>', async () => {
    // Running the command without an id surfaces the usage string via the
    // error sink — the usage must name --workflow.
    const fake = await makeFake()
    const { store, ctx } = await loadStoreAndCtx()
    const r = await run(['proposal', 'take'], { store, ctx, daemon: fake })
    expect(r.code).not.toBe(0)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('--workflow')
  })
})

// ---------------------------------------------------------------------------
// Merged CLI command coverage formerly in cli/__tests__/proposal-take.test.ts
// ---------------------------------------------------------------------------

describe('mars proposal take — command coverage', () => {
  // ---------------------------------------------------------------------------
  // Shared repo fixture
  // ---------------------------------------------------------------------------

  let repo: string

  const setupRepo = (): string => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mars-proposal-take-test-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    mkdirSync(resolve(dir, '.mars'), { recursive: true })
    return dir
  }

  const loadStoreAndCtx = async (): Promise<{
    store: DomainTaskStore
    ctx: OrchestratorContext
  }> => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const queueModule = await import('../../../core/queue')
    await queueModule.migrateQueueSchema()
    const storeModule = await import('../../../core/store/task-store')
    const contextModule = await import('../../../core/context')
    return {
      store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
      ctx: contextModule.resolveContext(repo),
    }
  }

  const baseOpts = async (): Promise<InProcessOptions> => {
    const { store, ctx } = await loadStoreAndCtx()
    return { store, ctx, daemon: makeFakeDaemon() }
  }

  beforeEach(() => {
    repo = setupRepo()
  })
  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // Seed helper — creates a prd-ready proposal for CLI seam tests
  // ---------------------------------------------------------------------------

  const seedPrdReadyProposal = async (): Promise<string> => {
    vi.resetModules()
    process.env.MARS_REPO = repo
    const { createProposal, addProposalUserStory, promoteProposal, initProposals } =
      await import('../../../core/proposals')
    const { migrateQueueSchema } = await import('../../../core/queue')
    await initProposals()
    await migrateQueueSchema()
    const p = await createProposal('CLI seam test proposal', {
      source: 'human',
      problem: 'There is a problem',
      solution: 'Here is the solution',
    })
    await addProposalUserStory(p.id, 'As a user I can do something')
    await promoteProposal(p.id)
    return p.id
  }

  // ---------------------------------------------------------------------------
  // Layer 1: CLI seam — command sends the right op, no slicer invoked
  // ---------------------------------------------------------------------------

  describe('mars proposal take — CLI seam', () => {
    it('sends op=proposal.take with the proposal id and prints the task id', async () => {
      const proposalId = await seedPrdReadyProposal()
      const fake = makeFakeDaemon((req) => {
        if (req.op === 'proposal.take') {
          return { proposalId: req.proposalId, taskId: 'mars-live-task-001' }
        }
        return {}
      })
      const { store, ctx } = await loadStoreAndCtx()
      const r = await runCommandInProcess(['proposal', 'take', proposalId], {
        store,
        ctx,
        daemon: fake,
      })

      expect(r.code).toBe(0)
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]).toMatchObject({ op: 'proposal.take', proposalId })
      expect(r.out.join('\n')).toContain('mars-live-task-001')
      expect(r.out.join('\n')).toContain('live')
    })

    it('never sends op=proposal.slice (slicer not invoked)', async () => {
      const proposalId = await seedPrdReadyProposal()
      const fake = makeFakeDaemon((req) => {
        if (req.op === 'proposal.take') {
          return { proposalId: req.proposalId, taskId: 'mars-live-task-001' }
        }
        return {}
      })
      const { store, ctx } = await loadStoreAndCtx()
      await runCommandInProcess(['proposal', 'take', proposalId], {
        store,
        ctx,
        daemon: fake,
      })

      const sliceCalls = fake.calls.filter((c) => c.op === 'proposal.slice')
      expect(sliceCalls).toHaveLength(0)
    })

    it('exits non-zero with usage when no id is given', async () => {
      const r = await runCommandInProcess(['proposal', 'take'], await baseOpts())
      expect(r.code).not.toBe(0)
      expect(r.err.join('\n')).toContain('usage:')
    })
  })

  describe('mars proposal --help', () => {
    it('lists take as a subcommand', async () => {
      const r = await runCommandInProcess(['proposal', '--help'], await baseOpts())
      expect(r.err.join('\n')).toContain('take')
    })
  })

  // ---------------------------------------------------------------------------
  // Layer 2: RPC seam — leaf routes to handleProposalTake
  // ---------------------------------------------------------------------------

  describe('proposal.take RPC handler', () => {
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

    const makeDeps = (overrides: Partial<DaemonDeps> = {}): DaemonDeps => {
      const notImpl =
        (name: string) =>
        (..._args: unknown[]): never => {
          throw new Error(`unexpected call to ${name}`)
        }
      return {
        log: () => {},
        bus: { emit: () => {} } as unknown as import('node:events').EventEmitter,
        tracker: fakeTracker(),
        sems: {
          implement: makeSem(1),
          triage: makeSem(1),
          refine: makeSem(1),
          verify: makeSem(1),
        },
        getAcceptingWork: () => true,
        setAcceptingWork: () => {},
        getPauseState: notImpl('getPauseState') as DaemonDeps['getPauseState'],
        pauseDispatch: notImpl('pauseDispatch') as DaemonDeps['pauseDispatch'],
        resumeDispatch: notImpl('resumeDispatch') as DaemonDeps['resumeDispatch'],
        resetSignatureStorm: notImpl('resetSignatureStorm') as DaemonDeps['resetSignatureStorm'],
        drain: async () => {},
        shutdown: async () => {},
        paths: { socketPath: '', pidFile: '', httpPortFile: '' },
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
      }
    }

    it('routes proposal.take to handleProposalTake and returns its result', async () => {
      let called: string | undefined
      const deps = makeDeps({
        handleProposalTake: async (proposalId) => {
          called = proposalId
          return { proposalId, taskId: 'mars-live-task-007' }
        },
      })

      const res = await dispatchRpc(
        rpcRegistry,
        { op: 'proposal.take', proposalId: 'prop-xyz' },
        deps,
      )

      expect(res).toMatchObject({ ok: true, data: { proposalId: 'prop-xyz', taskId: 'mars-live-task-007' } })
      expect(called).toBe('prop-xyz')
    })

    it('is gated by acceptingWork (DRAINING)', async () => {
      const deps = makeDeps({ getAcceptingWork: () => false })
      const res = await dispatchRpc(
        rpcRegistry,
        { op: 'proposal.take', proposalId: 'prop-xyz' },
        deps,
      )
      expect(res).toMatchObject({ ok: false, errorCode: 'DRAINING' })
    })
  })

  // ---------------------------------------------------------------------------
  // Layer 3: Integration — task created with workflow='live' and proposal linkage
  // ---------------------------------------------------------------------------

  describe('proposal take — integration: task creation behavior', () => {
    /**
     * Creates a minimal prd-ready proposal and runs the take sequence (claim →
     * enqueueTask with workflow:'live' → mark sliced), then asserts the DB state.
     */
    it('creates one queued task with workflow=live linked to the proposal', async () => {
      vi.resetModules()
      process.env.MARS_REPO = repo

      const { createProposal, addProposalUserStory, promoteProposal, getProposal,
              claimProposalForSlicing, markProposalSliced, initProposals } =
        await import('../../../core/proposals')
      const { enqueueTask, migrateQueueSchema, getTask } = await import('../../../core/queue')

      await initProposals()
      await migrateQueueSchema()

      // Seed a prd-ready proposal.
      const proposal = await createProposal('Live feature', {
        source: 'human',
        problem: 'p',
        solution: 's',
      })
      await addProposalUserStory(proposal.id, 'As a user I can do the live feature')
      await promoteProposal(proposal.id)

      // Replicate handleProposalTake's sequence: claim → enqueue → mark sliced.
      const claimed = await claimProposalForSlicing(proposal.id)
      expect(claimed).toBe(true)

      const task = await enqueueTask('# Live feature\n\nFull PRD body', undefined, {
        originId: proposal.id,
        parentProposalId: proposal.id,
        workflow: 'live',
        spec: {
          files: [],
          verifyCmd: null,
          doneCriteria: ['As a user I can do the live feature'],
          mergeMode: 'auto',
        },
      })

      await markProposalSliced(proposal.id, 1)

      // Verify the task has the right workflow and linkage.
      const fetched = await getTask(task.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.workflow).toBe('live')

      // Verify proposal linkage via DB.
      const { resolveQueueClient } = await import('../../../core/queue')
      const client = resolveQueueClient()
      const rows = await client.execute({
        sql: 'SELECT parent_proposal_id, workflow FROM tasks WHERE id = ?',
        args: [task.id],
      })
      const row = rows.rows[0] as Record<string, unknown>
      expect(row['parent_proposal_id']).toBe(proposal.id)
      expect(row['workflow']).toBe('live')

      // Verify proposal moved to 'sliced'.
      const afterProposal = await getProposal(proposal.id)
      expect(afterProposal?.status).toBe('sliced')
    })

    it('requires prd-ready status — draft proposal is refused by claimProposalForSlicing', async () => {
      vi.resetModules()
      process.env.MARS_REPO = repo

      const { createProposal, claimProposalForSlicing, initProposals } =
        await import('../../../core/proposals')
      const { migrateQueueSchema } = await import('../../../core/queue')

      await initProposals()
      await migrateQueueSchema()

      const proposal = await createProposal('Draft feature', { source: 'human' })

      // A draft proposal cannot be claimed; claimProposalForSlicing should return false.
      const claimed = await claimProposalForSlicing(proposal.id)
      expect(claimed).toBe(false)
    })
  })
})
