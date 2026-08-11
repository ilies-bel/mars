/**
 * Tests for the per-check operator posture system.
 *
 * Covers four acceptance criteria:
 *
 *   1. Posture CLI verb persists per check id: getPosture/setPosture round-trip.
 *   2. posture='manual' on a fix-route check → zero tasks, one action-queue
 *      offer row; taking the offer enqueues the task the automatic path would
 *      have created.
 *   3. posture='off' → zero downstream artifacts; other checks in the same
 *      pass still route normally.
 *   4. Default posture is 'automatic' for all route kinds (documented in
 *      posture.ts; asserted here).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createInMemoryPostureStore } from '../posture.js'
import { createInMemoryAlertStore } from '../pass.js'
import type { HealthPassDeps } from '../pass.js'
import type { AlertRouteDeps } from '../routes/alert.js'
import type { FixRouteDeps } from '../routes/fix.js'
import type { CheckDef } from '../registry.js'
import { enactHealthOffer } from '../../../cli/commands/action-queue.js'

// ── helpers ───────────────────────────────────────────────────────────────────

const makeFixCheck = (id: string, findingKey: string): CheckDef => ({
  id,
  description: `Fix check ${id}`,
  requires: [],
  route: 'fix' as const,
  run: async () => ({ ok: false, findingKey, detail: `${id} broken` }),
})

const makeAlertCheck = (id: string, findingKey: string): CheckDef => ({
  id,
  description: `Alert check ${id}`,
  requires: [],
  route: 'alert' as const,
  run: async () => ({ ok: false, findingKey, detail: `${id} broken` }),
})

/**
 * In-memory FixRouteDeps that tracks enqueue calls.
 */
const makeFixDeps = () => {
  const activeTasks = new Set<string>()
  const enqueuedTasks: string[] = []
  let taskIdCounter = 0

  const deps: FixRouteDeps = {
    hasActiveTaskForFinding: async (findingKey: string) => activeTasks.has(findingKey),
    enqueueFixTask: async (params: { findingKey: string; checkId: string; detail: string | undefined }) => {
      taskIdCounter++
      const taskId = `task-${taskIdCounter}`
      activeTasks.add(params.findingKey)
      enqueuedTasks.push(taskId)
      return taskId
    },
  }

  return { deps, enqueuedTasks }
}

/**
 * In-memory AlertRouteDeps that captures raised items, including offerPayload.
 */
const makeAlertDeps = () => {
  const alertStore = createInMemoryAlertStore()
  const raisedItems: Array<{
    id: string
    params: {
      checkId: string
      findingKey: string
      detail: string | undefined
      label: string
      offerPayload?: { findingKey: string; checkId: string; detail: string | undefined }
    }
  }> = []
  const resolvedItems: string[] = []
  let idCounter = 0

  const deps: AlertRouteDeps = {
    alertStore,
    async raiseAlertItem(params) {
      const id = `aq-${++idCounter}`
      raisedItems.push({ id, params })
      return id
    },
    async resolveAlertItem(aqItemId: string) {
      resolvedItems.push(aqItemId)
    },
  }

  return { deps, raisedItems, resolvedItems }
}

const makeNoopFixDeps = (): FixRouteDeps => ({
  hasActiveTaskForFinding: async () => false,
  enqueueFixTask: async () => 'noop',
})

// Tests use vi.resetModules() to isolate the module-level registry singleton.
describe('health check posture', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // ── 4. Default posture ───────────────────────────────────────────────────────

  describe('default posture', () => {
    it('is automatic when no posture has been set (fix-route check)', async () => {
      const store = createInMemoryPostureStore()
      const posture = await store.getPosture('some.check')
      expect(posture).toBe('automatic')
    })

    it('is automatic when no posture has been set (alert-route check)', async () => {
      const store = createInMemoryPostureStore()
      const posture = await store.getPosture('some.other.check')
      expect(posture).toBe('automatic')
    })

    it('listPostures returns empty when no explicit postures set', async () => {
      const store = createInMemoryPostureStore()
      const list = await store.listPostures()
      expect(list).toHaveLength(0)
    })
  })

  // ── 1. CLI verb persists posture ─────────────────────────────────────────────

  describe('setPosture / getPosture round-trip', () => {
    it('persists manual posture and returns it', async () => {
      const store = createInMemoryPostureStore()
      await store.setPosture('test.check', 'manual')
      expect(await store.getPosture('test.check')).toBe('manual')
    })

    it('persists off posture and returns it', async () => {
      const store = createInMemoryPostureStore()
      await store.setPosture('test.check', 'off')
      expect(await store.getPosture('test.check')).toBe('off')
    })

    it('persists automatic posture explicitly and returns it', async () => {
      const store = createInMemoryPostureStore()
      await store.setPosture('test.check', 'manual')
      await store.setPosture('test.check', 'automatic') // reset
      expect(await store.getPosture('test.check')).toBe('automatic')
    })

    it('setPosture is idempotent — setting the same value twice has no effect', async () => {
      const store = createInMemoryPostureStore()
      await store.setPosture('idempotent.check', 'off')
      await store.setPosture('idempotent.check', 'off')
      expect(await store.getPosture('idempotent.check')).toBe('off')
    })

    it('scopes posture per check-id independently', async () => {
      const store = createInMemoryPostureStore()
      await store.setPosture('check.a', 'manual')
      await store.setPosture('check.b', 'off')
      expect(await store.getPosture('check.a')).toBe('manual')
      expect(await store.getPosture('check.b')).toBe('off')
      expect(await store.getPosture('check.c')).toBe('automatic')
    })

    it('listPostures returns all explicitly set postures in check-id order', async () => {
      const store = createInMemoryPostureStore()
      await store.setPosture('z.check', 'off')
      await store.setPosture('a.check', 'manual')
      const list = await store.listPostures()
      expect(list).toEqual([
        { checkId: 'a.check', posture: 'manual' },
        { checkId: 'z.check', posture: 'off' },
      ])
    })
  })

  // ── 2. posture='manual' on fix-route check ────────────────────────────────────

  describe("posture='manual' on fix-route check", () => {
    it('produces zero tasks and one action-queue offer row', async () => {
      const { registerCheck } = await import('../registry.js')
      const { healthPass } = await import('../pass.js')

      registerCheck(makeFixCheck('test.manual-fix', 'test.manual.key'))

      const postureStore = createInMemoryPostureStore()
      await postureStore.setPosture('test.manual-fix', 'manual')

      const { deps: fixDeps, enqueuedTasks } = makeFixDeps()
      const { deps: alertDeps, raisedItems } = makeAlertDeps()

      const summary = await healthPass({
        ctx: { prereqs: new Set() },
        fix: fixDeps,
        alert: alertDeps,
        posture: postureStore,
      })

      // Zero tasks enqueued on the automatic path
      expect(enqueuedTasks).toHaveLength(0)
      expect(summary.enqueued).toHaveLength(0)

      // One offer row raised
      expect(raisedItems).toHaveLength(1)
      expect(summary.alertsRaised).toHaveLength(1)
    })

    it('offer row carries the fix spec as offerPayload', async () => {
      const { registerCheck } = await import('../registry.js')
      const { healthPass } = await import('../pass.js')

      registerCheck(makeFixCheck('test.manual-payload', 'test.manual.payload.key'))

      const postureStore = createInMemoryPostureStore()
      await postureStore.setPosture('test.manual-payload', 'manual')

      const { deps: fixDeps } = makeFixDeps()
      const { deps: alertDeps, raisedItems } = makeAlertDeps()

      await healthPass({
        ctx: { prereqs: new Set() },
        fix: fixDeps,
        alert: alertDeps,
        posture: postureStore,
      })

      const offer = raisedItems[0]!
      expect(offer.params.offerPayload).toBeDefined()
      expect(offer.params.offerPayload!.findingKey).toBe('test.manual.payload.key')
      expect(offer.params.offerPayload!.checkId).toBe('test.manual-payload')
    })

    it('taking the offer enqueues the task the automatic path would have created', async () => {
      const { registerCheck } = await import('../registry.js')
      const { healthPass } = await import('../pass.js')

      registerCheck(makeFixCheck('test.manual-take', 'test.manual.take.key'))

      const postureStore = createInMemoryPostureStore()
      await postureStore.setPosture('test.manual-take', 'manual')

      const { deps: fixDeps, enqueuedTasks } = makeFixDeps()
      const { deps: alertDeps, raisedItems } = makeAlertDeps()

      await healthPass({
        ctx: { prereqs: new Set() },
        fix: fixDeps,
        alert: alertDeps,
        posture: postureStore,
      })

      expect(enqueuedTasks).toHaveLength(0)
      expect(raisedItems).toHaveLength(1)

      // Simulate the operator taking the offer
      const offer = raisedItems[0]!
      const result = await enactHealthOffer(offer.params.offerPayload!, fixDeps)

      // One task enqueued — the same task the automatic path would have created
      expect(result.action).toBe('enqueued')
      expect(enqueuedTasks).toHaveLength(1)
    })

    it('does not raise a second offer row on a subsequent pass (dedup)', async () => {
      const { registerCheck } = await import('../registry.js')
      const { healthPass } = await import('../pass.js')

      registerCheck(makeFixCheck('test.manual-dedup', 'test.manual.dedup.key'))

      const postureStore = createInMemoryPostureStore()
      await postureStore.setPosture('test.manual-dedup', 'manual')

      const { deps: fixDeps } = makeFixDeps()
      const { deps: alertDeps, raisedItems } = makeAlertDeps()

      const run = () => healthPass({
        ctx: { prereqs: new Set() },
        fix: fixDeps,
        alert: alertDeps,
        posture: postureStore,
      })

      await run()
      expect(raisedItems).toHaveLength(1)

      await run()
      expect(raisedItems).toHaveLength(1) // still one — dedup holds
    })
  })

  // ── 3. posture='off' ──────────────────────────────────────────────────────────

  describe("posture='off'", () => {
    it('produces zero tasks for the suppressed check', async () => {
      const { registerCheck } = await import('../registry.js')
      const { healthPass } = await import('../pass.js')

      registerCheck(makeFixCheck('test.off-fix', 'test.off.key'))

      const postureStore = createInMemoryPostureStore()
      await postureStore.setPosture('test.off-fix', 'off')

      const { deps: fixDeps, enqueuedTasks } = makeFixDeps()

      const summary = await healthPass({
        ctx: { prereqs: new Set() },
        fix: fixDeps,
        posture: postureStore,
      })

      expect(enqueuedTasks).toHaveLength(0)
      expect(summary.enqueued).toHaveLength(0)
      // Check still ran (status='finding') but routing was suppressed
      expect(summary.findings).toBe(1)
    })

    it('produces zero offer rows for the suppressed check', async () => {
      const { registerCheck } = await import('../registry.js')
      const { healthPass } = await import('../pass.js')

      registerCheck(makeAlertCheck('test.off-alert', 'test.off.alert.key'))

      const postureStore = createInMemoryPostureStore()
      await postureStore.setPosture('test.off-alert', 'off')

      const { deps: alertDeps, raisedItems } = makeAlertDeps()

      const summary = await healthPass({
        ctx: { prereqs: new Set() },
        fix: makeNoopFixDeps(),
        alert: alertDeps,
        posture: postureStore,
      })

      expect(raisedItems).toHaveLength(0)
      expect(summary.alertsRaised).toHaveLength(0)
    })

    it('other checks in the same pass still route normally', async () => {
      const { registerCheck } = await import('../registry.js')
      const { healthPass } = await import('../pass.js')

      // One suppressed fix check and one normal fix check
      registerCheck(makeFixCheck('test.off-suppressed', 'test.off.suppressed'))
      registerCheck(makeFixCheck('test.off-active', 'test.off.active'))

      const postureStore = createInMemoryPostureStore()
      await postureStore.setPosture('test.off-suppressed', 'off')
      // test.off-active gets default 'automatic'

      const { deps: fixDeps, enqueuedTasks } = makeFixDeps()

      const summary = await healthPass({
        ctx: { prereqs: new Set() },
        fix: fixDeps,
        posture: postureStore,
      })

      // Only the active check's task was enqueued
      expect(enqueuedTasks).toHaveLength(1)
      expect(summary.enqueued).toHaveLength(1)
      expect(summary.findings).toBe(2) // both checks found issues
    })
  })

  // ── Backward compatibility ────────────────────────────────────────────────────

  describe('backward compatibility', () => {
    it('healthPass without posture store routes all findings as automatic', async () => {
      const { registerCheck } = await import('../registry.js')
      const { healthPass } = await import('../pass.js')

      registerCheck(makeFixCheck('test.no-posture', 'test.no.posture.key'))

      const { deps: fixDeps, enqueuedTasks } = makeFixDeps()

      // No posture store provided — should act as if all checks are 'automatic'
      await healthPass({
        ctx: { prereqs: new Set() },
        fix: fixDeps,
        // posture not provided
      })

      expect(enqueuedTasks).toHaveLength(1)
    })
  })
})
