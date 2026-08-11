/**
 * Tests for the alert-route path through healthPass().
 *
 * The key behaviour: a finding with route='alert' raises exactly one
 * action-queue row per findingKey while the condition persists. The first pass
 * that sees the condition gone removes the row automatically — no operator
 * gesture required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HealthPassDeps, AlertStore } from '../pass.js'
import type { AlertRouteDeps } from '../routes/alert.js'
import type { CheckDef } from '../registry.js'

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Make a check whose run() result is controlled by the `returning` closure.
 * When `returning.finding` is true the check reports a finding; when false it
 * passes. This lets a single registered check switch state between passes.
 */
const makeControllableAlertCheck = (
  id: string,
  findingKey: string,
  returning: { finding: boolean },
): CheckDef => ({
  id,
  description: `Alert check ${id}`,
  requires: [],
  route: 'alert' as const,
  run: async () =>
    returning.finding
      ? { ok: false, findingKey, detail: `${id} broken` }
      : { ok: true },
})

/**
 * Build an in-memory AlertRouteDeps that tracks raise/resolve calls.
 * The alertStore is a minimal in-memory implementation matching the AlertStore
 * interface — no real DB involved.
 */
const makeAlertDeps = () => {
  const openAlerts = new Map<string, string>()
  const raisedItems: string[] = []
  const resolvedItems: string[] = []
  let idCounter = 0

  const alertStore: AlertStore = {
    async getOpenAlertId(checkId: string) {
      return openAlerts.get(checkId) ?? null
    },
    async setOpenAlertId(checkId: string, aqItemId: string) {
      openAlerts.set(checkId, aqItemId)
    },
    async clearAlert(checkId: string) {
      openAlerts.delete(checkId)
    },
  }

  const deps: AlertRouteDeps = {
    alertStore,
    async raiseAlertItem() {
      const id = `aq-alert-${++idCounter}`
      raisedItems.push(id)
      return id
    },
    async resolveAlertItem(aqItemId: string) {
      resolvedItems.push(aqItemId)
    },
  }

  return { deps, raisedItems, resolvedItems, openAlerts }
}

/** Noop FixRouteDeps — no fix checks are registered in these tests. */
const makeNoopFixDeps = (): HealthPassDeps['fix'] => ({
  hasActiveTaskForFinding: async () => false,
  enqueueFixTask: async () => 'noop-task-id',
})

// ── tests ─────────────────────────────────────────────────────────────────────

describe('healthPass alert-route', () => {
  // Reset the module-level singleton registry between tests so registered
  // checks from one test do not bleed into the next.
  beforeEach(() => {
    vi.resetModules()
  })

  it('raises one action-queue row when the check returns a finding', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { finding: true }
    registerCheck(makeControllableAlertCheck('test.alert-raise', 'test.alert.key-a', state))

    const { deps, raisedItems } = makeAlertDeps()
    const summary = await healthPass({
      ctx: { prereqs: new Set() },
      fix: makeNoopFixDeps(),
      alert: deps,
    })

    expect(raisedItems).toHaveLength(1)
    expect(summary.findings).toBe(1)
    expect(summary.alertsRaised).toHaveLength(1)
    expect(summary.alertsCleared).toHaveLength(0)
  })

  it('does NOT raise a second row on a subsequent pass while condition persists (dedup)', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { finding: true }
    registerCheck(
      makeControllableAlertCheck('test.alert-dedup', 'test.alert.key-b', state),
    )

    const { deps, raisedItems } = makeAlertDeps()

    // Pass 1 — no open alert → raises
    const summary1 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: makeNoopFixDeps(),
      alert: deps,
    })
    expect(raisedItems).toHaveLength(1)
    expect(summary1.alertsRaised).toHaveLength(1)

    // Pass 2 — same condition, alert already open → no second raise
    const summary2 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: makeNoopFixDeps(),
      alert: deps,
    })
    expect(raisedItems).toHaveLength(1)
    expect(summary2.alertsRaised).toHaveLength(0)
    expect(summary2.alertsCleared).toHaveLength(0)
  })

  it('clears the row in the same pass when the check returns ok', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { finding: true }
    registerCheck(makeControllableAlertCheck('test.alert-clear', 'test.alert.key-c', state))

    const { deps, raisedItems, resolvedItems } = makeAlertDeps()

    // Pass 1 — finding → raises row
    await healthPass({
      ctx: { prereqs: new Set() },
      fix: makeNoopFixDeps(),
      alert: deps,
    })
    expect(raisedItems).toHaveLength(1)
    expect(resolvedItems).toHaveLength(0)

    // Pass 2 — condition cleared → resolves row
    state.finding = false
    const summary = await healthPass({
      ctx: { prereqs: new Set() },
      fix: makeNoopFixDeps(),
      alert: deps,
    })
    expect(resolvedItems).toHaveLength(1)
    expect(summary.alertsCleared).toHaveLength(1)
    expect(summary.alertsRaised).toHaveLength(0)
  })

  it('full sequence: finding → row raised → finding again → still one row → gone → zero rows', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { finding: true }
    registerCheck(makeControllableAlertCheck('test.alert-full', 'test.alert.key-d', state))

    const { deps, raisedItems, resolvedItems, openAlerts } = makeAlertDeps()

    const runPass = () =>
      healthPass({ ctx: { prereqs: new Set() }, fix: makeNoopFixDeps(), alert: deps })

    // Pass 1: finding present → row raised
    await runPass()
    expect(raisedItems).toHaveLength(1)
    expect(resolvedItems).toHaveLength(0)
    expect(openAlerts.size).toBe(1)

    // Pass 2: finding still present → still one row (no second raise)
    await runPass()
    expect(raisedItems).toHaveLength(1)
    expect(resolvedItems).toHaveLength(0)
    expect(openAlerts.size).toBe(1)

    // Pass 3: condition cleared → row resolved, store emptied
    state.finding = false
    await runPass()
    expect(raisedItems).toHaveLength(1) // no new raises
    expect(resolvedItems).toHaveLength(1)
    expect(openAlerts.size).toBe(0)
  })

  it('does not clear an alert that was never raised', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { finding: false }
    registerCheck(makeControllableAlertCheck('test.alert-never', 'test.alert.key-e', state))

    const { deps, resolvedItems } = makeAlertDeps()

    // Check passes from the start — no alert should be raised or cleared
    const summary = await healthPass({
      ctx: { prereqs: new Set() },
      fix: makeNoopFixDeps(),
      alert: deps,
    })
    expect(resolvedItems).toHaveLength(0)
    expect(summary.alertsRaised).toHaveLength(0)
    expect(summary.alertsCleared).toHaveLength(0)
  })

  it('existing fix-route tests are unaffected when alert deps are not provided', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    // A fix-route check — should still work without alert deps
    registerCheck({
      id: 'test.fix-compat',
      description: 'Fix check',
      requires: [],
      route: 'fix' as const,
      run: async () => ({ ok: false, findingKey: 'fix.compat.key', detail: 'broken' }),
    })

    let enqueued = false
    const summary = await healthPass({
      ctx: { prereqs: new Set() },
      fix: {
        hasActiveTaskForFinding: async () => false,
        enqueueFixTask: async () => {
          enqueued = true
          return 'task-compat'
        },
      },
      // alert not provided — must not crash
    })

    expect(enqueued).toBe(true)
    expect(summary.enqueued).toHaveLength(1)
    // New fields are present even without alert deps
    expect(summary.alertsRaised).toHaveLength(0)
    expect(summary.alertsCleared).toHaveLength(0)
  })
})
