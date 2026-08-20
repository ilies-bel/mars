/**
 * Integration tests: awaitHuman park/resume idempotency (live-pipeline fix).
 *
 * Regression coverage for the infinite re-park loop observed on task
 * mars-dbaf63d9: a live-workflow task parks at 'code' (awaitHuman), the
 * daemon receives `mars step done`, re-queues the task, but on re-dispatch
 * the engine re-executes awaitHuman because the step record is still
 * 'running' or 'failed' (not 'completed').
 *
 * Tests:
 *
 *   1. awaitHuman uses onManualPark when available — the workflow suspends
 *      in-process; after resolveManualStep the workflow continues to verify
 *      and completes without re-parking. The 'code' step ends 'completed'.
 *
 *   2. Daemon-restart case — the workflow parked (onManualPark), the step
 *      record is 'running', the daemon restarted so the in-memory promise is
 *      gone. handleStepDone Path 2 patches the step to 'completed' before
 *      re-queuing. A fresh runWorkflow call with the same runId short-circuits
 *      the 'code' step without re-parking.
 *
 *   3. Sentinel-restart case — awaitHuman threw the sentinel (no onManualPark),
 *      runStep wrote the step as 'failed'. handleStepDone Path 2 patches the
 *      step to 'completed' before re-queuing. Fresh runWorkflow short-circuits.
 */
import { describe, it, expect, vi } from 'vitest'
import { runWorkflow, InMemoryStore, awaitManualDone, resolveManualStep } from '@mars/workflow'
import type { WorkflowCtx } from '@mars/workflow'
import { awaitHuman } from '../primitives'
import type { MarsServices } from '../primitives'

// ---------------------------------------------------------------------------
// Utility: seed an InMemoryStore with a pre-existing run+step snapshot.
// Must create the RunRecord FIRST so `runWorkflow`'s `getRun` finds it and
// skips `createRun` (which would overwrite the steps Map with an empty one).
// ---------------------------------------------------------------------------

async function seedStore(
  store: InMemoryStore,
  runId: string,
  steps: Array<{
    name: string
    status: 'completed' | 'failed' | 'running'
    resultJson?: string | null
    errorSummary?: string | null
  }>,
): Promise<void> {
  const now = Date.now()
  // Create the run record first — createRun is idempotent (if !runs.has(id)).
  await store.createRun({
    id: runId,
    workflowId: 'live',
    inputJson: '{}',
    status: 'running',
    createdAt: now - 10000,
    updatedAt: now - 1000,
  })
  // Now put each step record.
  for (const step of steps) {
    await store.putStep({
      runId,
      name: step.name,
      status: step.status,
      sha: null,
      attempt: 1,
      startedAt: now - 5000,
      finishedAt: step.status !== 'running' ? now - 1000 : null,
      summary: null,
      errorSummary: step.errorSummary ?? null,
      transcriptKey: null,
      resultJson: step.resultJson ?? null,
    })
  }
}

// ---------------------------------------------------------------------------
// Minimal MarsServices stub with onManualPark wired.
// Parks are recorded so tests can assert the count.
// ---------------------------------------------------------------------------

type ParkArgs = { runId: string; taskId: string; stepName: string; guide: string | null }

function makeServices(parks: ParkArgs[]): MarsServices {
  return {
    store: null as never,
    traceStore: null as never,
    enqueueMergeJobAndAwait: null as never,
    onManualPark: async (args: ParkArgs): Promise<void> => {
      parks.push(args)
      return awaitManualDone(args.runId, args.stepName)
    },
  }
}

// ---------------------------------------------------------------------------
// Minimal workflow that mimics live-workflow.js: setup → code (awaitHuman)
// → verify (auto) → merge (auto).
// ---------------------------------------------------------------------------

function makeLiveWorkflow(
  taskId: string,
  services: MarsServices,
  phases: { verifyRan: boolean; mergeRan: boolean },
) {
  return async (ctx: WorkflowCtx<MarsServices, object>): Promise<void> => {
    // setup (always completed on first run in these tests — stubbed)
    await ctx.step('setup', async () => {
      /* no-op: setup already done */
    })

    // code — parks via awaitHuman
    await ctx.step('code', () =>
      awaitHuman(ctx as never, {
        note: `Implement task ${taskId} in the worktree.`,
      }),
    )

    // verify
    await ctx.step('verify', async () => {
      phases.verifyRan = true
    })

    // merge
    await ctx.step('merge', async () => {
      phases.mergeRan = true
    })
  }
}

// ---------------------------------------------------------------------------
// Test 1: in-process resume — promise-based path, no daemon restart.
// ---------------------------------------------------------------------------

describe('awaitHuman: in-process resume via onManualPark', () => {
  it('parks once, resolveManualStep continues to verify+merge, code step ends completed', async () => {
    const taskId = `await-human-inproc-${Date.now()}`
    const parks: ParkArgs[] = []
    const services = makeServices(parks)
    const phases = { verifyRan: false, mergeRan: false }

    const store = new InMemoryStore()

    // Launch the workflow — it suspends at 'code' via onManualPark.
    const resultPromise = runWorkflow(
      { id: 'live', fn: makeLiveWorkflow(taskId, services, phases) as never },
      {},
      { store, services: services as never, runId: taskId },
    )

    // Wait for the park to register.
    await vi.waitFor(() => expect(parks).toHaveLength(1), { timeout: 1000 })

    expect(parks[0].stepName).toBe('code')
    expect(parks[0].guide).toContain(taskId)
    // Verify and merge must NOT have run yet (workflow is parked at 'code').
    expect(phases.verifyRan).toBe(false)
    expect(phases.mergeRan).toBe(false)

    // ── Simulate `mars step done` Path 1 ────────────────────────────────────
    // resolveManualStep resolves the in-process promise; the workflow continues.
    const resolved = resolveManualStep(taskId, 'code')
    expect(resolved).toBe(true)

    // ── Workflow completes ────────────────────────────────────────────────────
    const result = await resultPromise
    expect(result.status).toBe('completed')
    expect(phases.verifyRan).toBe(true)
    expect(phases.mergeRan).toBe(true)

    // The 'code' step must be 'completed' in the store — the engine wrote it
    // when the step fn returned normally after the promise resolved.
    const codeStep = await store.getStep(taskId, 'code')
    expect(codeStep).toBeDefined()
    expect(codeStep!.status).toBe('completed')

    // Must have parked exactly once (no re-park loop).
    expect(parks).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Test 2: daemon-restart case — step is 'running' (promise path, process died).
// handleStepDone Path 2 patches the step to 'completed' before re-dispatch.
// ---------------------------------------------------------------------------

describe('awaitHuman: daemon-restart case — step running, Path 2 patch + re-dispatch', () => {
  it('patching running step to completed makes re-dispatch skip code without re-parking', async () => {
    const taskId = `await-human-restart-${Date.now()}`
    const parks: ParkArgs[] = []
    const services = makeServices(parks)
    const phases = { verifyRan: false, mergeRan: false }

    const store = new InMemoryStore()

    // Launch the workflow — it suspends at 'code' via onManualPark.
    const resultPromise = runWorkflow(
      { id: 'live', fn: makeLiveWorkflow(taskId, services, phases) as never },
      {},
      { store, services: services as never, runId: taskId },
    )

    // Wait for the park.
    await vi.waitFor(() => expect(parks).toHaveLength(1), { timeout: 1000 })
    expect(parks[0].stepName).toBe('code')

    // The 'code' step is 'running' in the store — the workflow is suspended.
    const codeStepBeforeRestart = await store.getStep(taskId, 'code')
    expect(codeStepBeforeRestart).toBeDefined()
    expect(codeStepBeforeRestart!.status).toBe('running')

    // ── Simulate daemon restart ──────────────────────────────────────────────
    // The in-process promise is gone. The pending runWorkflow call is orphaned
    // (the daemon process died). We do NOT call resolveManualStep here.
    // Instead, simulate what handleStepDone Path 2 does: patch step to
    // 'completed' then re-dispatch.

    // Patch: handleStepDone Path 2 marks the parked step completed.
    const prior = await store.getStep(taskId, 'code')
    expect(prior).toBeDefined()
    await store.putStep({
      ...prior!,
      status: 'completed',
      finishedAt: Date.now(),
      resultJson: JSON.stringify({ parkedForHuman: true }),
    })

    // Re-dispatch: fresh runWorkflow with the same runId (new daemon process).
    // The workflow run record is still 'running' (or 'failed' in sentinel path).
    // runWorkflow resets it to 'running' and then steps are checked.
    const parks2: ParkArgs[] = []
    const services2 = makeServices(parks2)
    const phases2 = { verifyRan: false, mergeRan: false }

    const result2 = await runWorkflow(
      { id: 'live', fn: makeLiveWorkflow(taskId, services2, phases2) as never },
      {},
      { store, services: services2 as never, runId: taskId },
    )

    // ── Assert no re-park ────────────────────────────────────────────────────
    // The 'code' step is 'completed' so the engine short-circuits it without
    // calling awaitHuman again. verify and merge run.
    expect(parks2).toHaveLength(0) // no re-park
    expect(phases2.verifyRan).toBe(true)
    expect(phases2.mergeRan).toBe(true)
    expect(result2.status).toBe('completed')

    // Step is still 'completed' in the store.
    const codeStepFinal = await store.getStep(taskId, 'code')
    expect(codeStepFinal!.status).toBe('completed')

    // Clean up the orphaned resultPromise (it will never resolve without
    // resolveManualStep; suppress the unhandled rejection by racing it).
    resolveManualStep(taskId, 'code')
    await resultPromise.catch(() => {})
  })
})

// ---------------------------------------------------------------------------
// Test 3: sentinel-restart case — step is 'failed' because awaitHuman threw
// the sentinel and runStep wrote 'failed', then the daemon crashed before its
// case 'await-human' patch ran.  handleStepDone Path 2 patches 'failed' →
// 'completed' before re-queuing.  A fresh runWorkflow call short-circuits
// the 'code' step without re-parking.
//
// The setup here directly pre-populates the step records rather than running
// awaitHuman with a null store (which would try to hit the real DB).  This
// mirrors exactly what runStep writes in its catch path after a sentinel throw:
//   setup → completed, code → failed (error = sentinel message)
// ---------------------------------------------------------------------------

describe('awaitHuman: sentinel-restart case — step failed, Path 2 patch + re-dispatch', () => {
  it('patching failed step to completed makes re-dispatch skip code without re-parking', async () => {
    const taskId = `await-human-sentinel-${Date.now()}`
    const store = new InMemoryStore()

    // ── Pre-populate the store as runStep would after a sentinel throw ───────
    // setup: completed (ran on the first dispatch before the sentinel park)
    // code: failed — runStep's catch path writes 'failed' when awaitHuman
    // threw the sentinel, because WorkflowTerminalError IS re-thrown by runStep.
    await seedStore(store, taskId, [
      { name: 'setup', status: 'completed', resultJson: '{}' },
      {
        name: 'code',
        status: 'failed',
        errorSummary: `task ${taskId} parked at await-human step 'code'; awaiting lease release`,
      },
    ])

    // Verify the 'failed' record is there — this is the pre-patch state.
    const codeStepBeforePatch = await store.getStep(taskId, 'code')
    expect(codeStepBeforePatch).toBeDefined()
    expect(codeStepBeforePatch!.status).toBe('failed')

    // ── Simulate handleStepDone Path 2: patch failed → completed ────────────
    // This is exactly what the daemon does before re-queuing in Path 2.
    await store.putStep({
      ...codeStepBeforePatch!,
      status: 'completed',
      finishedAt: Date.now(),
      resultJson: JSON.stringify({ parkedForHuman: true }),
    })

    // ── Re-dispatch: fresh runWorkflow with the same runId ───────────────────
    // Simulates the new daemon process picking up the task after step done.
    const parks2: ParkArgs[] = []
    const services2 = makeServices(parks2)
    const phases2 = { verifyRan: false, mergeRan: false }

    const result2 = await runWorkflow(
      { id: 'live', fn: makeLiveWorkflow(taskId, services2, phases2) as never },
      {},
      { store, services: services2 as never, runId: taskId },
    )

    // ── Assert no re-park ────────────────────────────────────────────────────
    // The 'code' step is 'completed' in the store, so the engine short-circuits
    // without calling awaitHuman again.  verify and merge run normally.
    expect(parks2).toHaveLength(0) // no re-park
    expect(phases2.verifyRan).toBe(true)
    expect(phases2.mergeRan).toBe(true)
    expect(result2.status).toBe('completed')

    // The code step record remains 'completed' after re-dispatch.
    const codeStepFinal = await store.getStep(taskId, 'code')
    expect(codeStepFinal!.status).toBe('completed')
  })
})
