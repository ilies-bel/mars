/**
 * Tests for the notice-route path through healthPass().
 *
 * Key behaviours verified:
 *   1. A finding with route='notice' files a notice exactly once per
 *      (findingKey, unsilenced) condition-cycle, however many passes run.
 *   2. Silencing a findingKey suppresses notices on all subsequent passes.
 *   3. When the condition clears and then recurs, the notice is re-filed
 *      (provided the findingKey is not silenced).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { HealthPassDeps } from '../pass.js'
import type { CheckDef } from '../registry.js'
import type { NoticeRouteDeps } from '../routes/notice.js'

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Make a check that can toggle between failing and passing.
 * Always includes findingKey in the outcome so healthPass can call resetStated
 * when the condition clears.
 */
const makeNoticeCheck = (
  id: string,
  findingKey: string,
  state: { failing: boolean },
): CheckDef => ({
  id,
  description: `Notice check ${id}`,
  requires: [],
  route: 'notice' as const,
  run: async () =>
    state.failing
      ? { ok: false, findingKey, detail: `${id} is broken` }
      : { ok: true, findingKey },
})

/**
 * Build in-memory NoticeRouteDeps with a call-count spy on fileNotice.
 */
const makeNoticeDeps = () => {
  const stated = new Set<string>()
  const silencedKeys = new Set<string>()
  let fileNoticeCallCount = 0
  const filedKeys: string[] = []

  const noticeDeps: NoticeRouteDeps = {
    noticeStore: {
      async hasBeenStated(key) {
        return stated.has(key)
      },
      async markStated(key) {
        stated.add(key)
      },
      async resetStated(key) {
        stated.delete(key)
      },
      async isSilenced(key) {
        return silencedKeys.has(key)
      },
      async silence(key) {
        silencedKeys.add(key)
      },
    },
    async fileNotice({ findingKey }) {
      fileNoticeCallCount++
      filedKeys.push(findingKey)
    },
  }

  return {
    noticeDeps,
    silencedKeys,
    get fileNoticeCallCount() {
      return fileNoticeCallCount
    },
    filedKeys,
  }
}

/** Minimal fix deps that never enqueue anything (not the focus of these tests). */
const noopFixDeps: HealthPassDeps['fix'] = {
  hasActiveTaskForFinding: async () => false,
  enqueueFixTask: async () => {
    throw new Error('enqueueFixTask should not be called in notice-route tests')
  },
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('healthPass notice-route', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('files a notice on the first failing pass', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { failing: true }
    registerCheck(makeNoticeCheck('test.notice-first', 'test.notice-first', state))

    const { noticeDeps } = makeNoticeDeps()
    const summary = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: noticeDeps,
    })

    expect(summary.noticed).toHaveLength(1)
    expect(summary.noticed[0]).toBe('test.notice-first')
    expect(summary.findings).toBe(1)
  })

  it('does NOT re-file notice on subsequent passes while condition persists (repeated-pass dedup)', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { failing: true }
    registerCheck(makeNoticeCheck('test.notice-dedup', 'test.notice-dedup', state))

    const sharedHelper = makeNoticeDeps()

    // First pass — notice should be filed
    const summary1 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: sharedHelper.noticeDeps,
    })
    expect(summary1.noticed).toHaveLength(1)
    expect(sharedHelper.fileNoticeCallCount).toBe(1)

    // Second pass — same condition, same findingKey → deduped
    const summary2 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: sharedHelper.noticeDeps,
    })
    expect(summary2.noticed).toHaveLength(0)
    expect(summary2.alreadyStated).toHaveLength(1)
    expect(summary2.alreadyStated[0]).toBe('test.notice-dedup')
    expect(sharedHelper.fileNoticeCallCount).toBe(1) // still 1, not 2

    // Third pass — still deduped
    const summary3 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: sharedHelper.noticeDeps,
    })
    expect(summary3.noticed).toHaveLength(0)
    expect(sharedHelper.fileNoticeCallCount).toBe(1)
  })

  it('produces zero notices when findingKey is silenced (silence-then-pass)', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { failing: true }
    registerCheck(makeNoticeCheck('test.notice-silence', 'test.notice-silenced', state))

    const helper = makeNoticeDeps()

    // Silence the finding before any pass
    helper.silencedKeys.add('test.notice-silenced')

    const summary = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: helper.noticeDeps,
    })

    expect(summary.noticed).toHaveLength(0)
    expect(summary.silenced).toHaveLength(1)
    expect(summary.silenced[0]).toBe('test.notice-silenced')
    expect(helper.fileNoticeCallCount).toBe(0)
  })

  it('does not re-file on pass after silence, even after a prior notice was stated', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { failing: true }
    registerCheck(makeNoticeCheck('test.notice-silence-after', 'test.notice-silence-after', state))

    const helper = makeNoticeDeps()

    // First pass — notice filed
    await healthPass({ ctx: { prereqs: new Set() }, fix: noopFixDeps, notice: helper.noticeDeps })
    expect(helper.fileNoticeCallCount).toBe(1)

    // Operator silences
    helper.silencedKeys.add('test.notice-silence-after')

    // Second pass — silenced, nothing filed
    const summary2 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: helper.noticeDeps,
    })
    expect(summary2.silenced).toHaveLength(1)
    expect(helper.fileNoticeCallCount).toBe(1) // no second notice
  })

  it('re-files after condition clears and recurs (unsilenced findingKey)', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { failing: true }
    registerCheck(makeNoticeCheck('test.notice-recur', 'test.notice-recur', state))

    const helper = makeNoticeDeps()

    // Pass 1: condition failing → notice filed
    const summary1 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: helper.noticeDeps,
    })
    expect(summary1.noticed).toHaveLength(1)
    expect(helper.fileNoticeCallCount).toBe(1)

    // Condition clears
    state.failing = false

    // Pass 2: condition ok → stated flag reset (no notice)
    const summary2 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: helper.noticeDeps,
    })
    expect(summary2.noticed).toHaveLength(0)
    expect(summary2.findings).toBe(0)

    // Condition recurs
    state.failing = true

    // Pass 3: condition failing again → re-files notice (stated flag was reset)
    const summary3 = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
      notice: helper.noticeDeps,
    })
    expect(summary3.noticed).toHaveLength(1)
    expect(summary3.noticed[0]).toBe('test.notice-recur')
    expect(helper.fileNoticeCallCount).toBe(2) // second filing
  })

  it('counts notice findings even when no notice deps are provided', async () => {
    const { registerCheck } = await import('../registry.js')
    const { healthPass } = await import('../pass.js')

    const state = { failing: true }
    registerCheck(makeNoticeCheck('test.notice-no-deps', 'test.notice-no-deps', state))

    // No notice deps provided — notice findings are counted but not acted on
    const summary = await healthPass({
      ctx: { prereqs: new Set() },
      fix: noopFixDeps,
    })

    expect(summary.findings).toBe(1)
    expect(summary.noticed).toHaveLength(0)
    expect(summary.alreadyStated).toHaveLength(0)
    expect(summary.silenced).toHaveLength(0)
  })
})
