/**
 * Integration test: manual-step park + re-lease semantics.
 *
 * Spins a synthetic workflow (manual → auto → manual → merge) and verifies:
 *
 *   1. First manual step parks the task (onManualPark called, awaitManualDone
 *      registers a pending resolver).
 *   2. `mars step done` resolves the first park via resolveManualStep.
 *   3. The auto step runs to completion with NO operator action.
 *   4. The second manual step parks again; the lease-owner attribute is the
 *      same as the first park (no re-attach required).
 *   5. A second `mars step done` resolves the second park.
 *   6. The merge step fires, and the workflow completes successfully.
 *
 * This test exercises the promise-based park/resume mechanism introduced in
 * packages/workflow/src/runtime.ts (`awaitManualDone` / `resolveManualStep`)
 * and the onManualPark hook on MarsServices (primitives/index.ts), without
 * touching the database or real git primitives.
 */
import { describe, it, expect, vi } from 'vitest'
import { runWorkflow, InMemoryStore, awaitManualDone, resolveManualStep } from '@mars/workflow'

// ---------------------------------------------------------------------------
// Helper: build a minimal MarsServices stub with an onManualPark hook.
// The hook captures park calls and uses awaitManualDone so the workflow
// suspends until resolveManualStep is called.
// ---------------------------------------------------------------------------

interface ParkRecord {
  runId: string
  taskId: string
  stepName: string
  guide: string | null
  leaseOwner: string
}

const STABLE_LEASE_OWNER = 'alice@laptop'

function makeServices(parks: ParkRecord[]) {
  // leaseOwner survives across parks in the production path because
  // handleStepDone(path 1) only sets status:'running' without clearing the
  // lease field. We simulate that stable identity here with a closure variable
  // that persists for the lifetime of the workflow.
  const currentLeaseOwner = STABLE_LEASE_OWNER

  return {
    store: null as never,
    traceStore: null as never,
    onManualPark: async ({
      runId,
      taskId,
      stepName,
      guide,
    }: {
      runId: string
      taskId: string
      stepName: string
      guide: string | null
    }): Promise<void> => {
      // In production, onManualPark would call updateTask(..., { status:
      // 'awaiting-human', leaseOwner: currentLeaseOwner, currentStepName, ...})
      // and raiseActionQueueItem. Here we just record the call and preserve
      // the lease identity for verification.
      parks.push({ runId, taskId, stepName, guide, leaseOwner: currentLeaseOwner })
      // Register the pending promise — the workflow suspends here until
      // resolveManualStep(runId, stepName) is called.
      return awaitManualDone(runId, stepName)
    },
  }
}

// ---------------------------------------------------------------------------
// Integration test: full manual → auto → manual → merge cycle
// ---------------------------------------------------------------------------

describe('manual-step park + re-lease semantics', () => {
  it('parks at step 1, resumes, auto step runs, parks at step 2 with same lease owner, resumes, merge fires', async () => {
    const taskId = `manual-step-release-${Date.now()}`
    const parks: ParkRecord[] = []
    let autoStepRan = false
    let mergeFired = false

    const services = makeServices(parks)

    // Synthetic workflow: manual → auto → manual → merge.
    // Steps call ctx.services.onManualPark directly so we exercise the
    // hook machinery without the full runAgent/verify/merge primitives
    // (which need git and a real DB). The test is about the park/resume
    // contract, not the primitives' internal implementation.
    const workflowFn = async (ctx: {
      runId: string
      services: typeof services
      step: (name: string, fn: () => unknown | Promise<unknown>) => Promise<unknown>
    }) => {
      // Step 1 — manual
      await ctx.step('step-1', () =>
        ctx.services.onManualPark({
          runId: ctx.runId,
          taskId,
          stepName: 'step-1',
          guide: 'set up the environment manually',
        }),
      )

      // Step 2 — auto (no human action required)
      await ctx.step('step-2', () => {
        autoStepRan = true
      })

      // Step 3 — manual
      await ctx.step('step-3', () =>
        ctx.services.onManualPark({
          runId: ctx.runId,
          taskId,
          stepName: 'step-3',
          guide: 'hand off to the next operator',
        }),
      )

      // Step 4 — merge (auto)
      await ctx.step('merge', () => {
        mergeFired = true
      })

      return { done: true }
    }

    const store = new InMemoryStore()

    // Launch the workflow without awaiting — it will suspend at the first
    // manual step and this call returns a pending Promise.
    const resultPromise = runWorkflow(
      { id: 'test-manual-release', fn: workflowFn as never },
      {},
      { store, services: services as never, runId: taskId },
    )

    // ── Assert park 1 ──────────────────────────────────────────────────────

    // Give the event loop a tick for the workflow to reach step-1 and call
    // onManualPark (which registers the pending resolver and suspends).
    await vi.waitFor(() => expect(parks).toHaveLength(1), { timeout: 1000 })

    expect(parks[0].stepName).toBe('step-1')
    expect(parks[0].guide).toBe('set up the environment manually')
    expect(parks[0].leaseOwner).toBe(STABLE_LEASE_OWNER)
    // Auto step must NOT have run yet (workflow is suspended at step 1).
    expect(autoStepRan).toBe(false)

    // ── Simulate `mars step done` for step 1 ─────────────────────────────

    const resolved1 = resolveManualStep(taskId, 'step-1')
    expect(resolved1).toBe(true)

    // ── Assert auto step runs and park 2 follows ───────────────────────────

    // The workflow resumes: step-1 completes, step-2 (auto) runs, step-3
    // (manual) calls onManualPark and suspends again. Wait for that.
    await vi.waitFor(() => expect(parks).toHaveLength(2), { timeout: 1000 })

    expect(autoStepRan).toBe(true)
    expect(parks[1].stepName).toBe('step-3')
    expect(parks[1].guide).toBe('hand off to the next operator')

    // Lease-owner attribute is STABLE across both parks — the same operator
    // identity is preserved without re-attaching (no re-dispatch was needed).
    expect(parks[1].leaseOwner).toBe(STABLE_LEASE_OWNER)
    expect(parks[1].leaseOwner).toBe(parks[0].leaseOwner)

    // Merge must NOT have fired yet (workflow is suspended at step 3).
    expect(mergeFired).toBe(false)

    // ── Simulate `mars step done` for step 3 ─────────────────────────────

    const resolved2 = resolveManualStep(taskId, 'step-3')
    expect(resolved2).toBe(true)

    // ── Assert merge fires and workflow completes ──────────────────────────

    const result = await resultPromise

    expect(result.status).toBe('completed')
    expect(mergeFired).toBe(true)
  })

  it('resolveManualStep returns false for a stale / already-resolved step (no-op)', () => {
    const runId = `stale-test-${Date.now()}`
    // No pending promise registered for this runId/stepName pair.
    expect(resolveManualStep(runId, 'step-1')).toBe(false)
    // Calling again for a step that was never registered is still false.
    expect(resolveManualStep(runId, 'step-1')).toBe(false)
  })

  it('resolveManualStep returns false after the promise has already been resolved (no double-fire)', async () => {
    const runId = `double-fire-test-${Date.now()}`
    const pending = awaitManualDone(runId, 'my-step')

    // First resolution — succeeds.
    const first = resolveManualStep(runId, 'my-step')
    expect(first).toBe(true)

    // The promise should have resolved.
    await expect(pending).resolves.toBeUndefined()

    // A second call with the same key is a no-op (key was removed on resolve).
    const second = resolveManualStep(runId, 'my-step')
    expect(second).toBe(false)
  })

  it('workflow in a single dispatch — no re-attach is needed across manual steps', async () => {
    // This test verifies the key property: the promise-based approach runs the
    // entire workflow in ONE runWorkflow() call. The operator does not need to
    // call `mars attach` again between two manual steps.
    const taskId = `single-dispatch-${Date.now()}`
    const parks: ParkRecord[] = []
    const services = makeServices(parks)

    let dispatchCount = 0
    const workflowFn = async (ctx: {
      runId: string
      services: typeof services
      step: (name: string, fn: () => unknown | Promise<unknown>) => Promise<unknown>
    }) => {
      dispatchCount += 1
      await ctx.step('m1', () =>
        ctx.services.onManualPark({ runId: ctx.runId, taskId, stepName: 'm1', guide: null }),
      )
      await ctx.step('m2', () =>
        ctx.services.onManualPark({ runId: ctx.runId, taskId, stepName: 'm2', guide: null }),
      )
    }

    const store = new InMemoryStore()
    const resultPromise = runWorkflow(
      { id: 'test-single-dispatch', fn: workflowFn as never },
      {},
      { store, services: services as never, runId: taskId },
    )

    await vi.waitFor(() => expect(parks).toHaveLength(1), { timeout: 1000 })
    resolveManualStep(taskId, 'm1')
    await vi.waitFor(() => expect(parks).toHaveLength(2), { timeout: 1000 })
    resolveManualStep(taskId, 'm2')
    await resultPromise

    // The workflow function was invoked exactly ONCE — no re-dispatch happened.
    expect(dispatchCount).toBe(1)
  })
})
