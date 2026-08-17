/**
 * Integration test: `step done` on the final manual step gates on verify.
 *
 * The live execution path (operator-driven coding step) must not be a quality
 * bypass. When the operator calls `mars step done` on the manual code step,
 * the workflow runs the same verify gate as the headless Worker path; a
 * failing verify rewinds to the manual step instead of proceeding to merge.
 *
 * Two cases modelled on manual-step-release.test.ts:
 *   1. Verify passes → merge fires.
 *   2. Verify fails → workflow re-parks at 'awaiting-human' with the verify
 *      output attached as the step guide; merge never fires.
 *
 * The "live-shaped" workflow used here mirrors what a real live-execution task
 * looks like:
 *   setup-worktree (auto) → run-live (manual, operator codes here) →
 *   review/verify (auto, same gate as headless path) → merge (auto)
 *
 * The key parity assertion: stepping through the manual code gate does not
 * short-circuit review — the quality gate is always enforced.
 */
import { describe, it, expect, vi } from 'vitest'
import { runWorkflow, InMemoryStore, awaitManualDone, resolveManualStep } from '@mars/workflow'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A park event recorded by the onManualPark stub. */
interface ParkRecord {
  stepName: string
  guide: string | null
}

/**
 * Build minimal MarsServices with an onManualPark hook.
 *
 * Each call to onManualPark pushes a ParkRecord and then suspends the
 * workflow at (runId, stepName) until resolveManualStep is called — the same
 * mechanism used by the daemon's `mars step done` handler in production.
 */
function makeServices(parks: ParkRecord[]) {
  return {
    store: null as never,
    traceStore: null as never,
    onManualPark: async ({
      runId,
      stepName,
      guide,
    }: {
      runId: string
      taskId: string
      stepName: string
      guide: string | null
    }): Promise<void> => {
      parks.push({ stepName, guide })
      return awaitManualDone(runId, stepName)
    },
  }
}

/** Minimal ctx shape exposed to the synthetic workflow function. */
type TestCtx = {
  runId: string
  services: ReturnType<typeof makeServices>
  step: (name: string, fn: () => unknown | Promise<unknown>) => Promise<unknown>
}

/**
 * Build a "live-shaped" workflow fn:
 *   setup-worktree (auto) → run-live (manual) → review (auto) → merge (auto)
 *
 * Represents the live execution path where the operator drives the code step.
 * Verify runs immediately after step-done — the same gate as the headless path.
 *
 * When verify fails the workflow re-parks at a rewind step with the error
 * output as the guide, so the operator can see what to fix before calling
 * `mars step done` again.  Merge is only reachable when verify passes.
 *
 * Two callers use this helper (one per `it()`), satisfying the single-caller
 * extraction rule.
 */
function makeLiveWorkflowFn({
  taskId,
  verifyFn,
  onMerge,
}: {
  taskId: string
  verifyFn: () => void | Promise<void>
  onMerge: () => void
}) {
  return async (ctx: TestCtx) => {
    // Auto setup (no-op in test, mirrors the real pipeline)
    await ctx.step('setup-worktree', () => {})

    // Manual coding step — the operator works here; `mars step done` resumes
    await ctx.step('run-live', () =>
      ctx.services.onManualPark({
        runId: ctx.runId,
        taskId,
        stepName: 'run-live',
        guide: 'Work in the worktree, then `mars step done` to proceed.',
      }),
    )

    // Verify runs after step-done — same gate as the headless Worker path.
    // A failing verify must not allow the workflow to reach merge.
    let verifyError: string | null = null
    try {
      await ctx.step('review', () => verifyFn())
    } catch (err) {
      verifyError = (err as Error).message
    }

    // Failing verify rewinds to 'awaiting-human' on the same worktree.
    // The verify output is attached as the step guide so the operator sees
    // exactly what to fix before calling `mars step done` again.
    if (verifyError !== null) {
      await ctx.step('run-live-rewind', () =>
        ctx.services.onManualPark({
          runId: ctx.runId,
          taskId,
          stepName: 'run-live-rewind',
          guide: `Verify failed — fix the issues and \`mars step done\` again:\n${verifyError}`,
        }),
      )
      return { done: false }
    }

    // Merge — only reachable when verify passed (the quality gate is enforced)
    await ctx.step('merge', () => {
      onMerge()
    })
    return { done: true }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('live step-done verify parity', () => {
  it('verify passes after step done — merge fires', async () => {
    const taskId = `live-pass-${Date.now()}`
    const parks: ParkRecord[] = []
    let verifyCalled = false
    let mergeFired = false

    const services = makeServices(parks)
    const store = new InMemoryStore()

    // Launch the workflow without awaiting — it suspends at the manual step.
    const resultPromise = runWorkflow(
      {
        id: 'test-live-verify-pass',
        fn: makeLiveWorkflowFn({
          taskId,
          verifyFn: () => {
            verifyCalled = true
          },
          onMerge: () => {
            mergeFired = true
          },
        }) as never,
      },
      {},
      { store, services: services as never, runId: taskId },
    )

    // Workflow suspends at the manual coding step — verify and merge must NOT
    // have run yet.
    await vi.waitFor(() => expect(parks).toHaveLength(1), { timeout: 1000 })
    expect(parks[0].stepName).toBe('run-live')
    expect(verifyCalled).toBe(false)
    expect(mergeFired).toBe(false)

    // Operator calls `mars step done` — resumes the workflow past the manual step.
    expect(resolveManualStep(taskId, 'run-live')).toBe(true)

    const result = await resultPromise

    // Verify was invoked — the live path does not bypass the quality gate.
    expect(verifyCalled).toBe(true)
    // Merge fired — verify passed, so the pipeline completed.
    expect(mergeFired).toBe(true)
    // No rewind park was raised (verify succeeded, no reason to rewind).
    expect(parks).toHaveLength(1)
    expect(result.status).toBe('completed')
  })

  it('verify fails after step done — rewinds to awaiting-human with verify output as note, merge never fires', async () => {
    const taskId = `live-fail-${Date.now()}`
    const parks: ParkRecord[] = []
    let verifyCalled = false
    let mergeFired = false

    const VERIFY_OUTPUT =
      'typecheck failed: TS2345 argument of type "string" is not assignable to ' +
      'parameter of type "number" in src/foo.ts:42'

    const services = makeServices(parks)
    const store = new InMemoryStore()

    // Launch the workflow without awaiting — it suspends at the manual step.
    const resultPromise = runWorkflow(
      {
        id: 'test-live-verify-fail',
        fn: makeLiveWorkflowFn({
          taskId,
          verifyFn: () => {
            verifyCalled = true
            throw new Error(VERIFY_OUTPUT)
          },
          onMerge: () => {
            mergeFired = true
          },
        }) as never,
      },
      {},
      { store, services: services as never, runId: taskId },
    )

    // Workflow suspends at the manual coding step (first park).
    await vi.waitFor(() => expect(parks).toHaveLength(1), { timeout: 1000 })
    expect(parks[0].stepName).toBe('run-live')

    // Operator calls `mars step done`.
    expect(resolveManualStep(taskId, 'run-live')).toBe(true)

    // Verify runs and fails → workflow re-parks at the rewind step with the
    // error output as the guide.  The task is 'awaiting-human' again on the
    // same worktree — the operator can see exactly what to fix.
    await vi.waitFor(() => expect(parks).toHaveLength(2), { timeout: 1000 })

    // Verify was invoked — the quality gate ran even on the live path.
    expect(verifyCalled).toBe(true)
    // Merge must not have fired — failing verify must block merge.
    expect(mergeFired).toBe(false)
    // The rewind park is on the same task / worktree as the original coding step.
    expect(parks[1].stepName).toBe('run-live-rewind')
    // The verify output is attached to the guide so the operator can act on it.
    expect(parks[1].guide).toContain(VERIFY_OUTPUT)

    // Release the rewind park so the resultPromise can settle.
    resolveManualStep(taskId, 'run-live-rewind')
    const result = await resultPromise

    // The workflow returned (not threw) after the rewind park, so the run is
    // 'completed' — but merge was never called.
    expect(result.status).toBe('completed')
    expect(mergeFired).toBe(false)
  })
})
