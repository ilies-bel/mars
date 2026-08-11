/**
 * Tests for the fix-route path through healthPass().
 *
 * The key behaviour: a finding with route='fix' enqueues exactly one task
 * across consecutive passes while that task is still active. Idempotency is
 * enforced by the hasActiveTaskForFinding guard in the fix route handler.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HealthPassDeps, PassSummary } from '../pass.js'
import type { CheckDef } from '../registry.js'

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Make a check that always returns a finding with the given findingKey.
 */
const makeFixCheck = (id: string, findingKey: string): CheckDef => ({
  id,
  description: `Fix check ${id}`,
  requires: [],
  route: 'fix' as const,
  run: async () => ({ ok: false, findingKey, detail: `${id} broken` }),
})

/**
 * Build an in-memory FixRouteDeps that tracks enqueue calls and honours an
 * active-task set that the caller manages.
 */
const makeFixDeps = () => {
  const activeTasks = new Set<string>()
  let enqueueCallCount = 0
  let taskIdCounter = 0

  return {
    activeTasks,
    get enqueueCallCount() {
      return enqueueCallCount
    },
    deps: {
      hasActiveTaskForFinding: async (findingKey: string) => activeTasks.has(findingKey),
      enqueueFixTask: async (params: { findingKey: string; checkId: string; detail: string | undefined }) => {
        enqueueCallCount++
        taskIdCounter++
        const taskId = `task-${taskIdCounter}`
        activeTasks.add(params.findingKey)
        return taskId
      },
    } satisfies HealthPassDeps['fix'],
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

// The module-level singleton registry is reset between tests via
// vi.resetModules(), matching the pattern in registry.test.ts.
describe('healthPass fix-route idempotency', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('enqueues a task on the first pass when the check returns a finding', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    registerCheck(makeFixCheck('test.always-broken', 'test.always-broken'))

    const { deps } = makeFixDeps()
    const summary: PassSummary = await healthPass({
      ctx: { prereqs: new Set() },
      fix: deps,
    })

    expect(summary.enqueued).toHaveLength(1)
    expect(summary.findings).toBe(1)
    expect(summary.checked).toBe(1)
  })

  it('does NOT enqueue a second task on a subsequent pass while the first is active', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    registerCheck(makeFixCheck('test.persistent-finding', 'test.persistent-finding'))

    const fixDeps = makeFixDeps()

    // First pass — no active task yet → enqueues
    const summary1 = await healthPass({ ctx: { prereqs: new Set() }, fix: fixDeps.deps })
    expect(summary1.enqueued).toHaveLength(1)
    expect(fixDeps.enqueueCallCount).toBe(1)

    // Second pass — task now active (makeFixDeps adds to activeTasks on enqueue)
    const summary2 = await healthPass({ ctx: { prereqs: new Set() }, fix: fixDeps.deps })
    expect(summary2.enqueued).toHaveLength(0)
    expect(summary2.alreadyActive).toHaveLength(1)
    expect(summary2.alreadyActive[0]).toBe('test.persistent-finding')

    // Exactly one enqueue across both passes
    expect(fixDeps.enqueueCallCount).toBe(1)
  })

  it('re-arms after the active task completes (findingKey removed from active set)', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    registerCheck(makeFixCheck('test.re-armable', 'test.re-armable'))

    const fixDeps = makeFixDeps()

    // First pass — enqueues
    await healthPass({ ctx: { prereqs: new Set() }, fix: fixDeps.deps })
    expect(fixDeps.enqueueCallCount).toBe(1)

    // Simulate task completion: remove from active set
    fixDeps.activeTasks.delete('test.re-armable')

    // Third pass — condition still present, but task completed → re-enqueues
    const summary3 = await healthPass({ ctx: { prereqs: new Set() }, fix: fixDeps.deps })
    expect(summary3.enqueued).toHaveLength(1)
    expect(fixDeps.enqueueCallCount).toBe(2)
  })

  it('skips findings whose route is not fix', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    registerCheck({
      id: 'test.notice-check',
      description: 'Notice check',
      requires: [],
      route: 'notice' as const,
      run: async () => ({ ok: false, findingKey: 'test.notice', detail: 'notice finding' }),
    })

    const fixDeps = makeFixDeps()
    const summary = await healthPass({ ctx: { prereqs: new Set() }, fix: fixDeps.deps })

    // Finding exists but it's a notice route, not a fix route
    expect(summary.findings).toBe(1)
    expect(summary.enqueued).toHaveLength(0)
    expect(fixDeps.enqueueCallCount).toBe(0)
  })

  it('skips fix-route findings that have no findingKey', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    registerCheck({
      id: 'test.no-key',
      description: 'Fix check without key',
      requires: [],
      route: 'fix' as const,
      // No findingKey in the outcome — route handler returns 'no-finding-key'
      run: async () => ({ ok: false, detail: 'broken but no key' }),
    })

    const fixDeps = makeFixDeps()
    const summary = await healthPass({ ctx: { prereqs: new Set() }, fix: fixDeps.deps })

    expect(summary.findings).toBe(1)
    expect(summary.enqueued).toHaveLength(0)
    expect(fixDeps.enqueueCallCount).toBe(0)
  })

  it('counts skipped checks correctly when prereqs are missing', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    registerCheck({
      id: 'test.needs-daemon',
      description: 'Check that requires daemon',
      requires: ['daemon'] as const,
      route: 'fix' as const,
      run: async () => ({ ok: false, findingKey: 'test.daemon-needed', detail: 'daemon broken' }),
    })

    const fixDeps = makeFixDeps()
    // ctx has no prereqs — 'daemon' prereq is missing → skipped
    const summary = await healthPass({ ctx: { prereqs: new Set() }, fix: fixDeps.deps })

    expect(summary.skippedByPrereq).toBe(1)
    expect(summary.checked).toBe(0)
    expect(summary.findings).toBe(0)
    expect(fixDeps.enqueueCallCount).toBe(0)
  })
})
