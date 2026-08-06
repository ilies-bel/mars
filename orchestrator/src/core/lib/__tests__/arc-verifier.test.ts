/**
 * Arc-verifier unit tests.
 *
 * Verifies observable behaviours:
 *   1. trigger dedup — one admission per originId (subsequent calls return skipped-dedup)
 *   2. no-merge arcs skipped — arc with no landed commits → no agent call, no AQ item
 *   3. failing verdict → exactly one arc-verification-failed AQ item
 *   4. kill-switch flag suppresses all runs
 *   5. E2E tooling probe (level-triggered):
 *      - tooling unavailable → raises one global e2e-tooling-missing AQ item
 *      - second arc on same repo → raiseActionQueueItem called again (DB dedupes via signature)
 *      - body carries missing[] and setupSteps[] from the probe
 *      - tooling available → resolves any open e2e-tooling-missing items
 *
 * System boundaries mocked:
 *   - raiseActionQueueItem / listActionQueueItems / setActionQueueState (action-queue DB)
 *   - runHeadlessProvider (selected provider subprocess)
 *   - getDefaultTaskStore (mars.db read)
 *   - probeE2eTooling (filesystem probe)
 *   - getProposal (proposals DB read)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RaiseActionQueueItem } from '../action-queue'
import type { E2eToolingReport } from '../e2e-tooling'

// ── Mock raiseActionQueueItem / listActionQueueItems / setActionQueueState ────

const raiseSpy = vi.hoisted(() =>
  vi.fn(async (_item: RaiseActionQueueItem): Promise<string> => 'mock-item-id'),
)
const listActionQueueItemsMock = vi.hoisted(() =>
  vi.fn(async () => [] as Array<{ id: string }>),
)
const setActionQueueStateMock = vi.hoisted(() =>
  vi.fn(async () => {}),
)
vi.mock('../action-queue', async (importActual) => {
  const actual = await importActual<typeof import('../action-queue')>()
  return {
    ...actual,
    raiseActionQueueItem: raiseSpy,
    listActionQueueItems: listActionQueueItemsMock,
    setActionQueueState: setActionQueueStateMock,
  }
})

// ── Mock provider runner ─────────────────────────────────────────────────────

const runHeadlessProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    stdout: '{"ok":true,"findings":[]}',
    stderr: '',
    sessionId: null,
    conversation: [],
    quotaRejected: null,
  })),
)
vi.mock('../../workers/providers', () => ({
  runHeadlessProvider: runHeadlessProviderMock,
}))

// ── Mock getDefaultTaskStore ──────────────────────────────────────────────────

const makeStore = (
  arcStatusResult: {
    status: string
    tasks: Array<{ id: string; status: string }>
    landedCommits: string[]
  },
  members?: Array<{ id: string; branch: string | null }>,
  taskData?: Map<string, unknown>,
) => ({
  arcStatus: vi.fn(async () => arcStatusResult),
  listArcMembers: vi.fn(async () => members ?? ([] as Array<{ id: string; branch: string | null }>)),
  getTask: vi.fn(async (id: string) => taskData?.get(id) ?? null),
})

const getDefaultTaskStoreMock = vi.hoisted(() => vi.fn())
vi.mock('../../store/task-store', () => ({
  getDefaultTaskStore: getDefaultTaskStoreMock,
}))

// ── Also mock collectAssistantText from reflector ────────────────────────────
// collectAssistantText on an empty conversation returns ''; fallback to stdout.
vi.mock('../reflector', () => ({
  collectAssistantText: vi.fn((_conversation: unknown[]) => ''),
}))

// ── Mock getProposal ──────────────────────────────────────────────────────────

const getProposalMock = vi.hoisted(() =>
  vi.fn(async (_id: string) => null as { id: string; userStories: string[]; outOfScope: string } | null),
)
vi.mock('../../proposals', () => ({
  getProposal: getProposalMock,
}))

// ── Mock probeE2eTooling ──────────────────────────────────────────────────────

const probeE2eToolingMock = vi.hoisted(() =>
  vi.fn((_repoRoot: string): E2eToolingReport => ({
    available: false,
    runner: 'none',
    missing: ['@playwright/test is not listed in any package.json'],
    setupSteps: ['npm install --save-dev @playwright/test'],
  })),
)
vi.mock('../e2e-tooling', () => ({
  probeE2eTooling: probeE2eToolingMock,
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const {
  triggerArcVerification,
  runArcVerification,
  isArcVerifyDisabled,
  loadPrdReachabilityContext,
  _clearTriggeredForTests,
  _clearToolingMissCountForTests,
  CONSECUTIVE_TOOLING_MISS_THRESHOLD,
} = await import('../arc-verifier')

// ─────────────────────────────────────────────────────────────────────────────

/** Minimal task-shaped object with the spec fields arc-verifier reads. */
const makeTask = (
  id: string,
  spec: { verifyCmd?: string | null; doneCriteria?: string[] } = {},
) => ({
  id,
  status: 'done',
  prompt: `task ${id}`,
  spec: {
    verifyCmd: spec.verifyCmd ?? null,
    doneCriteria: spec.doneCriteria ?? [],
    files: [],
    mergeMode: 'auto' as const,
  },
})

describe('arc-verifier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearTriggeredForTests()
    _clearToolingMissCountForTests()
    delete process.env.MARS_ARC_VERIFY_DISABLED
  })

  afterEach(() => {
    delete process.env.MARS_ARC_VERIFY_DISABLED
  })

  // ── kill-switch ─────────────────────────────────────────────────────────────

  describe('isArcVerifyDisabled()', () => {
    it('returns false when the flag is not set', () => {
      expect(isArcVerifyDisabled()).toBe(false)
    })

    it('returns true when MARS_ARC_VERIFY_DISABLED=1', () => {
      process.env.MARS_ARC_VERIFY_DISABLED = '1'
      expect(isArcVerifyDisabled()).toBe(true)
    })
  })

  // ── triggerArcVerification — kill-switch ────────────────────────────────────

  it('[flag] returns skipped-disabled and schedules no work when flag is on', () => {
    process.env.MARS_ARC_VERIFY_DISABLED = '1'
    const result = triggerArcVerification('origin-flagged')
    expect(result).toBe('skipped-disabled')
    // No work was scheduled — neither the action queue nor provider runner is called.
    expect(raiseSpy).not.toHaveBeenCalled()
    expect(runHeadlessProviderMock).not.toHaveBeenCalled()
  })

  // ── triggerArcVerification — dedup ──────────────────────────────────────────

  it('[dedup] returns triggered on first call and skipped-dedup on second', () => {
    const r1 = triggerArcVerification('origin-dedup-1')
    const r2 = triggerArcVerification('origin-dedup-1')
    expect(r1).toBe('triggered')
    expect(r2).toBe('skipped-dedup')
  })

  it('[dedup] different originIds each get their own trigger', () => {
    const r1 = triggerArcVerification('origin-a')
    const r2 = triggerArcVerification('origin-b')
    expect(r1).toBe('triggered')
    expect(r2).toBe('triggered')
  })

  it('[dispatch] admits work without spawning a verifier outside the daemon pool', async () => {
    getDefaultTaskStoreMock.mockResolvedValue(
      makeStore({
        status: 'arc-done',
        tasks: [{ id: 'task-dispatch', status: 'done' }],
        landedCommits: ['sha-dispatch'],
      }),
    )

    expect(triggerArcVerification('origin-daemon-dispatch')).toBe('triggered')
    await Promise.resolve()

    expect(runHeadlessProviderMock).not.toHaveBeenCalled()
  })

  it('[dedup] skipped-dedup is returned synchronously without scheduling work', () => {
    // First call marks the originId.
    triggerArcVerification('origin-dedup-sync')
    // Second call must return without touching the agent or action-queue.
    const result = triggerArcVerification('origin-dedup-sync')
    expect(result).toBe('skipped-dedup')
    // We cannot assert the provider wasn't called yet (async work may still be
    // in-flight), but the return value proves the gate fired.
  })

  // ── runArcVerification — no-merge arcs skipped ──────────────────────────────

  describe('runArcVerification', () => {
    it('[no-merge] skips when arc status is in-progress', async () => {
      getDefaultTaskStoreMock.mockResolvedValue(
        makeStore({ status: 'in-progress', tasks: [], landedCommits: [] }),
      )
      const verdict = await runArcVerification('origin-in-progress', { cwd: '/tmp' })
      expect(verdict).toEqual({ ok: true, findings: [] })
      expect(runHeadlessProviderMock).not.toHaveBeenCalled()
      expect(raiseSpy).not.toHaveBeenCalled()
    })

    it('[no-merge] skips when arc is done but has no landed commits', async () => {
      getDefaultTaskStoreMock.mockResolvedValue(
        makeStore({ status: 'arc-done', tasks: [], landedCommits: [] }),
      )
      const verdict = await runArcVerification('origin-no-commits', { cwd: '/tmp' })
      expect(verdict).toEqual({ ok: true, findings: [] })
      expect(runHeadlessProviderMock).not.toHaveBeenCalled()
      expect(raiseSpy).not.toHaveBeenCalled()
    })

    it('[no-merge] skips when arc failed entirely (arc-failed status)', async () => {
      getDefaultTaskStoreMock.mockResolvedValue(
        makeStore({ status: 'arc-failed', tasks: [], landedCommits: ['abc'] }),
      )
      const verdict = await runArcVerification('origin-arc-failed', { cwd: '/tmp' })
      expect(verdict).toEqual({ ok: true, findings: [] })
      expect(runHeadlessProviderMock).not.toHaveBeenCalled()
      expect(raiseSpy).not.toHaveBeenCalled()
    })

    // ── failing verdict → one action-queue item ───────────────────────────────

    it('[verdict-fail] raises exactly one arc-verification-failed item on failing verdict', async () => {
      const findings = ['TypeScript errors in merged code', 'Test suite red after merge']
      runHeadlessProviderMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ ok: false, findings }),
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })

      getDefaultTaskStoreMock.mockResolvedValue(
        makeStore({
          status: 'arc-done',
          tasks: [{ id: 'task-1', status: 'done' }],
          landedCommits: ['sha-abc123'],
        }),
      )

      const verdict = await runArcVerification('origin-fail', {
        cwd: process.cwd(),
      })

      expect(verdict.ok).toBe(false)
      expect(verdict.findings).toEqual(expect.arrayContaining(findings))

      // Exactly one arc-verification-failed item raised (e2e-tooling-missing may also be raised).
      const arcFailCalls = raiseSpy.mock.calls.filter(
        (c) => (c[0] as RaiseActionQueueItem).kind === 'arc-verification-failed',
      )
      expect(arcFailCalls).toHaveLength(1)
      const raised = arcFailCalls[0][0] as RaiseActionQueueItem
      expect(raised.kind).toBe('arc-verification-failed')
      expect(raised.signature).toBe('arc-verification-failed:origin-fail')
      expect(raised.originTaskId).toBe('origin-fail')
      expect(raised.payload).toMatchObject({ originId: 'origin-fail' })
    })

    it('[verdict-fail] does NOT raise an item when verdict is ok', async () => {
      runHeadlessProviderMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, findings: [] }),
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })

      getDefaultTaskStoreMock.mockResolvedValue(
        makeStore({
          status: 'arc-done',
          tasks: [{ id: 'task-2', status: 'done' }],
          landedCommits: ['sha-def456'],
        }),
      )

      const verdict = await runArcVerification('origin-pass', {
        cwd: process.cwd(),
      })

      expect(verdict.ok).toBe(true)
      expect(verdict.findings).toEqual([])
      // No arc-verification-failed raised (e2e-tooling-missing may still be raised).
      const arcFailCalls = raiseSpy.mock.calls.filter(
        (c) => (c[0] as RaiseActionQueueItem).kind === 'arc-verification-failed',
      )
      expect(arcFailCalls).toHaveLength(0)
    })

    it('[verdict-fail] handles unparseable agent output gracefully', async () => {
      runHeadlessProviderMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'something went wrong, not JSON',
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })

      getDefaultTaskStoreMock.mockResolvedValue(
        makeStore({
          status: 'arc-done',
          tasks: [],
          landedCommits: ['sha-xyz'],
        }),
      )

      const verdict = await runArcVerification('origin-bad-output', {
        cwd: process.cwd(),
      })

      // Unparseable output is treated as a failure.
      expect(verdict.ok).toBe(false)
      expect(verdict.findings.length).toBeGreaterThan(0)
      // Still raises one arc-verification-failed item.
      const arcFailCalls = raiseSpy.mock.calls.filter(
        (c) => (c[0] as RaiseActionQueueItem).kind === 'arc-verification-failed',
      )
      expect(arcFailCalls).toHaveLength(1)
      expect(arcFailCalls[0][0].kind).toBe('arc-verification-failed')
    })

    it('[verdict-fail] raises only one item when called twice for the same arc', async () => {
      const findings = ['Test suite red']
      const failPayload = {
        exitCode: 0,
        stdout: JSON.stringify({ ok: false, findings }),
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      }
      runHeadlessProviderMock.mockResolvedValue(failPayload)

      const store = makeStore({
        status: 'arc-done',
        tasks: [],
        landedCommits: ['sha-1'],
      })
      getDefaultTaskStoreMock.mockResolvedValue(store)

      await runArcVerification('origin-dedup-raise', { cwd: process.cwd() })
      await runArcVerification('origin-dedup-raise', { cwd: process.cwd() })

      // raiseActionQueueItem is called twice for arc-verification-failed (the action-queue
      // dedup via signature collapses them into one row in the DB).
      const arcFailCalls = raiseSpy.mock.calls.filter(
        (c) => (c[0] as RaiseActionQueueItem).kind === 'arc-verification-failed',
      )
      expect(arcFailCalls).toHaveLength(2)
      for (const call of arcFailCalls) {
        expect(call[0].kind).toBe('arc-verification-failed')
        expect(call[0].signature).toBe('arc-verification-failed:origin-dedup-raise')
      }
    })

    // ── loadPrdReachabilityContext ─────────────────────────────────────────────

    describe('loadPrdReachabilityContext', () => {
      beforeEach(() => {
        vi.clearAllMocks()
        _clearTriggeredForTests()
      })

      it('(a) Proposal Arc with N user stories returns all stories and out-of-scope lines', async () => {
        getProposalMock.mockResolvedValueOnce({
          id: 'prop-abc123',
          userStories: ['As a user, I can log in', 'As an admin, I can manage users', 'As a user, I can reset my password', 'As a user, I can view my profile'],
          outOfScope: 'Mobile app\nThird-party integrations\nBilling',
        })

        const ctx = await loadPrdReachabilityContext('prop-abc123')

        expect(ctx.sourceProposalId).toBe('prop-abc123')
        expect(ctx.userStories).toEqual([
          'As a user, I can log in',
          'As an admin, I can manage users',
          'As a user, I can reset my password',
          'As a user, I can view my profile',
        ])
        expect(ctx.outOfScope).toEqual(['Mobile app', 'Third-party integrations', 'Billing'])
      })

      it('(b) Proposal Arc with zero user stories returns empty userStories array', async () => {
        getProposalMock.mockResolvedValueOnce({
          id: 'prop-empty-stories',
          userStories: [],
          outOfScope: '',
        })

        const ctx = await loadPrdReachabilityContext('prop-empty-stories')

        expect(ctx.sourceProposalId).toBe('prop-empty-stories')
        expect(ctx.userStories).toEqual([])
        expect(ctx.outOfScope).toEqual([])
      })

      it('(c) task-originated Arc with no source Proposal returns empty arrays and null sourceProposalId', async () => {
        // getProposal returns null — arcId is a task id, not a proposal id
        getProposalMock.mockResolvedValueOnce(null)

        const ctx = await loadPrdReachabilityContext('task-abc123')

        expect(ctx.sourceProposalId).toBeNull()
        expect(ctx.userStories).toEqual([])
        expect(ctx.outOfScope).toEqual([])
      })

      it('returns empty arrays when getProposal throws (treated as no source proposal)', async () => {
        getProposalMock.mockRejectedValueOnce(new Error('db error'))

        const ctx = await loadPrdReachabilityContext('anything')

        expect(ctx.sourceProposalId).toBeNull()
        expect(ctx.userStories).toEqual([])
        expect(ctx.outOfScope).toEqual([])
      })

      it('filters blank lines from out-of-scope text', async () => {
        getProposalMock.mockResolvedValueOnce({
          id: 'prop-blanks',
          userStories: ['Story one'],
          outOfScope: '\nMobile app\n\n  \nBilling\n',
        })

        const ctx = await loadPrdReachabilityContext('prop-blanks')

        expect(ctx.outOfScope).toEqual(['Mobile app', 'Billing'])
      })
    })

    // ── Reachable-surface judgement (judgeReachableSurfaces) ──────────────────

    describe('reachable-surface judgement', () => {
      /**
       * Make a minimal store with `arc-done` + one landed commit so that
       * `runArcVerification` proceeds to the LLM calls.
       */
      const makeReachabilityStore = (originId: string) =>
        makeStore(
          { status: 'arc-done', tasks: [{ id: originId, status: 'done' }], landedCommits: ['sha-reach'] },
          [{ id: originId, branch: null }],
          new Map([[originId, makeTask(originId)]]),
        )

      /** Stub first (done-criteria) provider call to pass, second to return reachability JSON. */
      const stubProviderCalls = (reachabilityResponse: unknown) => {
        runHeadlessProviderMock
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: '{"ok":true,"findings":[]}',
            stderr: '',
            sessionId: null,
            conversation: [],
            quotaRejected: null,
          })
          .mockResolvedValueOnce({
            exitCode: 0,
            stdout: JSON.stringify(reachabilityResponse),
            stderr: '',
            sessionId: null,
            conversation: [],
            quotaRejected: null,
          })
      }

      // ── fixture (a): admin interface promised, only API shipped ──────────────

      it('(a) produces exactly one finding when a story lacks a Reachable surface', async () => {
        const story = 'As an admin, I can manage users in the admin interface'

        getProposalMock.mockResolvedValueOnce({
          id: 'prop-a',
          userStories: [story],
          outOfScope: '',
        })
        getDefaultTaskStoreMock.mockResolvedValue(makeReachabilityStore('prop-a'))

        stubProviderCalls({
          unsatisfiedStories: [
            { story, humanCannotDo: 'The admin interface page was not delivered; only a REST API endpoint exists.' },
          ],
          deferredStories: [],
        })

        const verdict = await runArcVerification('prop-a', { cwd: '/tmp' })

        expect(verdict.ok).toBe(false)
        // Exactly one reachability finding added.
        const reachabilityFindings = verdict.findings.filter((f) =>
          f.includes('User story unsatisfied'),
        )
        expect(reachabilityFindings).toHaveLength(1)
        expect(reachabilityFindings[0]).toContain(story)
        expect(reachabilityFindings[0]).toContain('admin interface')
        // Lands in the action queue via the existing failing-verdict path.
        const arcFailCalls = raiseSpy.mock.calls.filter(
          (c) => (c[0] as RaiseActionQueueItem).kind === 'arc-verification-failed',
        )
        expect(arcFailCalls).toHaveLength(1)
        expect(arcFailCalls[0][0].kind).toBe('arc-verification-failed')
      })

      // ── fixture (b): deferred surface in out_of_scope → no finding ───────────

      it('(b) produces no reachability finding when the story is covered by out_of_scope', async () => {
        const story = 'As a user, I can access the mobile app'

        getProposalMock.mockResolvedValueOnce({
          id: 'prop-b',
          userStories: [story],
          outOfScope: 'Mobile app\nThird-party integrations',
        })
        getDefaultTaskStoreMock.mockResolvedValue(makeReachabilityStore('prop-b'))

        stubProviderCalls({
          unsatisfiedStories: [],
          deferredStories: [story],
        })

        const verdict = await runArcVerification('prop-b', { cwd: '/tmp' })

        // No reachability finding — story was deferred.
        const reachabilityFindings = verdict.findings.filter((f) =>
          f.includes('User story unsatisfied'),
        )
        expect(reachabilityFindings).toHaveLength(0)
        // Overall verdict driven solely by done-criteria check (which passed).
        expect(verdict.ok).toBe(true)
        // No arc-verification-failed raised (e2e-tooling-missing may still be raised).
        const arcFailCalls = raiseSpy.mock.calls.filter(
          (c) => (c[0] as RaiseActionQueueItem).kind === 'arc-verification-failed',
        )
        expect(arcFailCalls).toHaveLength(0)
      })

      // ── fixture (c): no user_stories → no reachability finding ───────────────

      it('(c) emits no reachability finding when user_stories is empty', async () => {
        getProposalMock.mockResolvedValueOnce({
          id: 'prop-c',
          userStories: [],
          outOfScope: '',
        })
        getDefaultTaskStoreMock.mockResolvedValue(makeReachabilityStore('prop-c'))

        // Only one provider call expected (done-criteria; reachability is skipped).
        runHeadlessProviderMock.mockResolvedValueOnce({
          exitCode: 0,
          stdout: '{"ok":true,"findings":[]}',
          stderr: '',
          sessionId: null,
          conversation: [],
          quotaRejected: null,
        })

        const verdict = await runArcVerification('prop-c', { cwd: '/tmp' })

        expect(verdict.ok).toBe(true)
        const reachabilityFindings = verdict.findings.filter((f) =>
          f.includes('User story unsatisfied'),
        )
        expect(reachabilityFindings).toHaveLength(0)
        // Provider called exactly once (no second call for reachability).
        expect(runHeadlessProviderMock).toHaveBeenCalledTimes(1)
        // No arc-verification-failed raised (e2e-tooling-missing may still be raised).
        const arcFailCalls = raiseSpy.mock.calls.filter(
          (c) => (c[0] as RaiseActionQueueItem).kind === 'arc-verification-failed',
        )
        expect(arcFailCalls).toHaveLength(0)
      })

      // ── fixture (d): three unsatisfied stories → exactly one finding ──────────

      it('(d) collapses three unsatisfied stories into exactly one finding', async () => {
        const stories = [
          'As a user, I can see my dashboard',
          'As a user, I can edit my profile',
          'As a user, I can view my order history',
        ]

        getProposalMock.mockResolvedValueOnce({
          id: 'prop-d',
          userStories: stories,
          outOfScope: '',
        })
        getDefaultTaskStoreMock.mockResolvedValue(makeReachabilityStore('prop-d'))

        stubProviderCalls({
          unsatisfiedStories: [
            { story: stories[0], humanCannotDo: 'No dashboard page was delivered.' },
            { story: stories[1], humanCannotDo: 'No profile edit form was delivered.' },
            { story: stories[2], humanCannotDo: 'No order history page was delivered.' },
          ],
          deferredStories: [],
        })

        const verdict = await runArcVerification('prop-d', { cwd: '/tmp' })

        expect(verdict.ok).toBe(false)
        // Exactly ONE reachability finding in the verdict.
        const reachabilityFindings = verdict.findings.filter((f) =>
          f.includes('User story unsatisfied'),
        )
        expect(reachabilityFindings).toHaveLength(1)
        // Primary story is named.
        expect(reachabilityFindings[0]).toContain(stories[0])
        // Count of other unsatisfied stories is mentioned.
        expect(reachabilityFindings[0]).toContain('+2 other unsatisfied')
        // Exactly one arc-verification-failed AQ item raised.
        const arcFailCalls = raiseSpy.mock.calls.filter(
          (c) => (c[0] as RaiseActionQueueItem).kind === 'arc-verification-failed',
        )
        expect(arcFailCalls).toHaveLength(1)
        expect(arcFailCalls[0][0].kind).toBe('arc-verification-failed')
      })

      // ── at-most-one finding regardless of multiple stories ────────────────────

      it('finding message mentions count when exactly two stories are unsatisfied', async () => {
        const stories = ['Story alpha', 'Story beta']

        getProposalMock.mockResolvedValueOnce({
          id: 'prop-two',
          userStories: stories,
          outOfScope: '',
        })
        getDefaultTaskStoreMock.mockResolvedValue(makeReachabilityStore('prop-two'))

        stubProviderCalls({
          unsatisfiedStories: [
            { story: stories[0], humanCannotDo: 'No surface for alpha.' },
            { story: stories[1], humanCannotDo: 'No surface for beta.' },
          ],
          deferredStories: [],
        })

        const verdict = await runArcVerification('prop-two', { cwd: '/tmp' })

        const reachabilityFindings = verdict.findings.filter((f) =>
          f.includes('User story unsatisfied'),
        )
        expect(reachabilityFindings).toHaveLength(1)
        expect(reachabilityFindings[0]).toContain('+1 other unsatisfied story')
      })
    })

    // ── E2E tooling probe (level-triggered) ──────────────────────────────────
    //
    // When tooling is unavailable, one global e2e-tooling-missing action-queue
    // item is raised (deduped via fixed signature in the DB layer, not here).
    // When tooling is available, any open item is auto-resolved.

    describe('E2E tooling probe', () => {
      /** Make a minimal arc-done store for isolation. */
      const makeE2eStore = (originId: string) =>
        makeStore(
          { status: 'arc-done', tasks: [{ id: originId, status: 'done' }], landedCommits: ['sha-e2e'] },
          [{ id: originId, branch: null }],
          new Map([[originId, makeTask(originId)]]),
        )

      beforeEach(() => {
        // Static Claude check always passes so we isolate the tooling branch.
        runHeadlessProviderMock.mockResolvedValue({
          exitCode: 0,
          stdout: '{"ok":true,"findings":[]}',
          stderr: '',
          sessionId: null,
          conversation: [],
          quotaRejected: null,
        })
        // Default: tooling unavailable
        probeE2eToolingMock.mockReturnValue({
          available: false,
          runner: 'none',
          missing: ['@playwright/test is not listed in any package.json'],
          setupSteps: ['npm install --save-dev @playwright/test'],
        })
        listActionQueueItemsMock.mockResolvedValue([])
      })

      it('[tooling-missing] raises e2e-tooling-missing with global signature when tooling unavailable', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(makeE2eStore('origin-e2e-missing'))

        const verdict = await runArcVerification('origin-e2e-missing', { cwd: '/repo' })

        expect(verdict).toEqual({ ok: true, findings: [] })
        // raiseActionQueueItem called once for the tooling alert.
        const e2eCalls = raiseSpy.mock.calls.filter(
          (c) => (c[0] as RaiseActionQueueItem).kind === 'e2e-tooling-missing',
        )
        expect(e2eCalls).toHaveLength(1)
        const raised = e2eCalls[0][0] as RaiseActionQueueItem
        expect(raised.signature).toBe('e2e-tooling-missing')
        // No per-arc id in signature — it is global.
        expect(raised.signature).not.toContain('origin-e2e-missing')
      })

      it('[tooling-missing] body contains the missing pieces and setup steps from the probe', async () => {
        probeE2eToolingMock.mockReturnValue({
          available: false,
          runner: 'none',
          missing: ['@playwright/test is not installed', 'Playwright browsers are not installed'],
          setupSteps: ['npm install --save-dev @playwright/test', 'npx playwright install --with-deps chromium'],
        })
        getDefaultTaskStoreMock.mockResolvedValue(makeE2eStore('origin-e2e-body'))

        await runArcVerification('origin-e2e-body', { cwd: '/repo' })

        const e2eCall = raiseSpy.mock.calls.find(
          (c) => (c[0] as RaiseActionQueueItem).kind === 'e2e-tooling-missing',
        )
        expect(e2eCall).toBeDefined()
        const raised = e2eCall![0] as RaiseActionQueueItem
        expect(raised.payload['missing']).toEqual([
          '@playwright/test is not installed',
          'Playwright browsers are not installed',
        ])
        expect(raised.payload['setupSteps']).toEqual([
          'npm install --save-dev @playwright/test',
          'npx playwright install --with-deps chromium',
        ])
        expect(raised.body).toContain('@playwright/test is not installed')
        expect(raised.body).toContain('npx playwright install --with-deps chromium')
      })

      it('[tooling-missing-two-arcs] second arc completion calls raiseActionQueueItem again (DB dedupes via signature)', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(makeE2eStore('origin-arc-1'))
        await runArcVerification('origin-arc-1', { cwd: '/repo' })

        getDefaultTaskStoreMock.mockResolvedValue(makeE2eStore('origin-arc-2'))
        await runArcVerification('origin-arc-2', { cwd: '/repo' })

        // Both arcs call raise; the DB layer dedupes via fingerprint.
        const e2eCalls = raiseSpy.mock.calls.filter(
          (c) => (c[0] as RaiseActionQueueItem).kind === 'e2e-tooling-missing',
        )
        expect(e2eCalls).toHaveLength(2)
        // Both share the same global signature.
        for (const [item] of e2eCalls) {
          expect((item as RaiseActionQueueItem).signature).toBe('e2e-tooling-missing')
        }
      })

      it('[tooling-available] resolves open e2e-tooling-missing items when tooling is available', async () => {
        probeE2eToolingMock.mockReturnValue({
          available: true,
          runner: 'playwright' as const,
          missing: [],
          setupSteps: [],
        })
        listActionQueueItemsMock.mockResolvedValue([{ id: 'aq-stale-01' }, { id: 'aq-stale-02' }])
        getDefaultTaskStoreMock.mockResolvedValue(makeE2eStore('origin-e2e-avail'))

        const verdict = await runArcVerification('origin-e2e-avail', { cwd: '/repo' })

        expect(verdict.ok).toBe(true)
        // No e2e-tooling-missing raised.
        expect(raiseSpy.mock.calls.some((c) => (c[0] as RaiseActionQueueItem).kind === 'e2e-tooling-missing')).toBe(false)
        // Both stale items resolved.
        expect(setActionQueueStateMock).toHaveBeenCalledTimes(2)
        expect(setActionQueueStateMock).toHaveBeenCalledWith('aq-stale-01', 'resolved', expect.objectContaining({ by: 'arc-verifier' }))
        expect(setActionQueueStateMock).toHaveBeenCalledWith('aq-stale-02', 'resolved', expect.objectContaining({ by: 'arc-verifier' }))
      })

      it('[tooling-available-no-open] does not call setActionQueueState when no open items exist', async () => {
        probeE2eToolingMock.mockReturnValue({
          available: true,
          runner: 'playwright' as const,
          missing: [],
          setupSteps: [],
        })
        listActionQueueItemsMock.mockResolvedValue([])
        getDefaultTaskStoreMock.mockResolvedValue(makeE2eStore('origin-e2e-clean'))

        await runArcVerification('origin-e2e-clean', { cwd: '/repo' })

        expect(setActionQueueStateMock).not.toHaveBeenCalled()
      })
    })
  })

  // ── Arc-level E2E pass ────────────────────────────────────────────────────
  //
  // When E2E tooling is available the verifier boots the app and captures
  // a screenshot per done criterion. The pass is:
  //  - serialized machine-wide via .mars/.e2e.lock
  //  - durable: a completed pass is never re-run (marker survives daemon restart)
  //  - best-effort: arc verdict is never changed by E2E pass success/failure

  describe('arc-level E2E pass', () => {
    /** Shared helper — minimal arc-done store with tasks that have criteria. */
    const makeArcDoneStore = (
      originId: string,
      doneCriteria: string[] = ['widget loads'],
    ) =>
      makeStore(
        { status: 'arc-done', tasks: [{ id: originId, status: 'done' }], landedCommits: ['sha-e2e'] },
        [{ id: originId, branch: null }],
        new Map([[originId, makeTask(originId, { doneCriteria })]]),
      )

    type StubCriterionResult = { criterion: string; verdict: 'unverifiable'; screenshotPath: string | null; note: string }

    /** Build a fresh injectable deps object for each test. */
    const makeE2eDeps = (overrides: {
      isPassDone?: boolean
      bootPlan?: { cmd: string; cwd: string; url: string; reason: string } | null
      browserCheckResult?: StubCriterionResult[]
      acquireLock?: (path: string, timeout: number) => Promise<() => Promise<void>>
      markE2ePassDone?: (originId: string, stateDir: string) => Promise<void>
    } = {}) => {
      const markerMap = new Map<string, boolean>()
      const {
        isPassDone = false,
        bootPlan = { cmd: 'npm run dev', cwd: '/repo', url: 'http://localhost:5173', reason: 'vite' },
        browserCheckResult = [{ criterion: 'widget loads', verdict: 'unverifiable' as const, screenshotPath: 'qa/0.png', note: 'captured' }],
      } = overrides

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const runBrowserCheckSpy = vi.fn(async () => browserCheckResult as any)
      const acquireLockSpy = overrides.acquireLock ?? vi.fn(async (_path: string, _timeout: number) => vi.fn(async () => {}))
      const markDoneBase = overrides.markE2ePassDone ?? vi.fn(async () => {})

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const deps: any = {
        discoverAppBoot: vi.fn(() => bootPlan),
        runBrowserCheck: runBrowserCheckSpy,
        acquireLock: acquireLockSpy,
        isE2ePassDone: vi.fn((_originId: string, _stateDir: string) => isPassDone || (markerMap.get(_originId) ?? false)),
        markE2ePassDone: async (originId: string, stateDir: string) => {
          markerMap.set(originId, true)
          return markDoneBase(originId, stateDir)
        },
      }

      return {
        deps,
        runBrowserCheckSpy,
        acquireLockSpy: acquireLockSpy as ReturnType<typeof vi.fn>,
        markDoneBase: markDoneBase as ReturnType<typeof vi.fn>,
      }
    }

    beforeEach(() => {
      // E2E tooling available for all tests in this block.
      probeE2eToolingMock.mockReturnValue({
        available: true,
        runner: 'playwright' as const,
        missing: [],
        setupSteps: [],
      })
      listActionQueueItemsMock.mockResolvedValue([])
      // Static Claude check always passes.
      runHeadlessProviderMock.mockResolvedValue({
        exitCode: 0,
        stdout: '{"ok":true,"findings":[]}',
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })
    })

    // ── Tracer bullet: browser check runs when tooling + boot + criteria ──────

    it('[e2e-pass] calls runBrowserCheck when tooling available + boot plan + criteria', async () => {
      const { deps, runBrowserCheckSpy } = makeE2eDeps()
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-e2e-runs'))

      await runArcVerification('origin-e2e-runs', { cwd: '/repo', e2eDeps: deps })

      expect(runBrowserCheckSpy).toHaveBeenCalledOnce()
      expect(runBrowserCheckSpy).toHaveBeenCalledWith(
        expect.objectContaining({ cmd: 'npm run dev' }),
        ['widget loads'],
        expect.objectContaining({ taskId: 'origin-e2e-runs' }),
      )
    })

    // ── Arc verdict never changes due to E2E pass ────────────────────────────

    it('[e2e-pass:verdict-unchanged] arc verdict ok=true is preserved even when E2E ran', async () => {
      const { deps } = makeE2eDeps()
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-e2e-verdict'))

      const verdict = await runArcVerification('origin-e2e-verdict', { cwd: '/repo', e2eDeps: deps })

      expect(verdict.ok).toBe(true)
      expect(verdict.findings).toEqual([])
    })

    // ── CAN'T-VERIFY: no done criteria ───────────────────────────────────────

    it('[e2e-pass:no-criteria] skips runBrowserCheck when arc has no done criteria', async () => {
      const { deps, runBrowserCheckSpy, acquireLockSpy } = makeE2eDeps()
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-e2e-no-crit', []))

      await runArcVerification('origin-e2e-no-crit', { cwd: '/repo', e2eDeps: deps })

      expect(runBrowserCheckSpy).not.toHaveBeenCalled()
      expect(acquireLockSpy).not.toHaveBeenCalled()
    })

    // ── CAN'T-VERIFY: no boot plan ───────────────────────────────────────────

    it('[e2e-pass:no-boot] skips runBrowserCheck when no boot plan discovered', async () => {
      const { deps, runBrowserCheckSpy, acquireLockSpy } = makeE2eDeps({ bootPlan: null })
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-e2e-no-boot'))

      await runArcVerification('origin-e2e-no-boot', { cwd: '/repo', e2eDeps: deps })

      expect(runBrowserCheckSpy).not.toHaveBeenCalled()
      expect(acquireLockSpy).not.toHaveBeenCalled()
    })

    // ── Durable marker: completed pass never re-runs ─────────────────────────

    it('[e2e-pass:durable] second call with same originId skips runBrowserCheck after marker is set', async () => {
      const { deps, runBrowserCheckSpy } = makeE2eDeps()
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-durable'))

      // First call: runs E2E pass, marker is set inside makeE2eDeps
      await runArcVerification('origin-durable', { cwd: '/repo', e2eDeps: deps })
      expect(runBrowserCheckSpy).toHaveBeenCalledTimes(1)

      // Second call: isE2ePassDone now returns true (marker in markerMap)
      await runArcVerification('origin-durable', { cwd: '/repo', e2eDeps: deps })
      expect(runBrowserCheckSpy).toHaveBeenCalledTimes(1) // unchanged
    })

    it('[e2e-pass:durable-preexist] pre-existing marker (simulates daemon restart) skips run', async () => {
      // isPassDone: true simulates a marker file written in a previous daemon lifetime
      const { deps, runBrowserCheckSpy } = makeE2eDeps({ isPassDone: true })
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-preexist'))

      await runArcVerification('origin-preexist', { cwd: '/repo', e2eDeps: deps })

      expect(runBrowserCheckSpy).not.toHaveBeenCalled()
    })

    // ── Serialization: lock acquired before browser check, released after ────

    it('[e2e-pass:lock] acquireLock is called with .e2e.lock path before runBrowserCheck', async () => {
      let lockAcquiredBeforeBrowserCheck = false
      let lockAcquired = false

      const { deps } = makeE2eDeps({
        acquireLock: async () => {
          lockAcquired = true
          return async () => {}
        },
      })
      // Wrap runBrowserCheck to verify lock is held
      const originalRun = deps.runBrowserCheck
      deps.runBrowserCheck = vi.fn(async (...args) => {
        lockAcquiredBeforeBrowserCheck = lockAcquired
        return originalRun(...args)
      })
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-lock-order'))

      await runArcVerification('origin-lock-order', { cwd: '/repo', e2eDeps: deps })

      expect(lockAcquiredBeforeBrowserCheck).toBe(true)
    })

    it('[e2e-pass:lock-path] acquireLock receives a path containing .e2e.lock', async () => {
      const { deps, acquireLockSpy } = makeE2eDeps()
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-lock-path'))

      await runArcVerification('origin-lock-path', { cwd: '/repo', e2eDeps: deps })

      expect(acquireLockSpy).toHaveBeenCalledWith(
        expect.stringContaining('.e2e.lock'),
        expect.any(Number),
      )
    })

    it('[e2e-pass:lock-released] lock is released in finally even when runBrowserCheck throws', async () => {
      let released = false
      const { deps } = makeE2eDeps({
        acquireLock: async () => {
          return async () => { released = true }
        },
        browserCheckResult: undefined, // will be overridden below
      })
      deps.runBrowserCheck = vi.fn(async () => { throw new Error('browser crashed') })

      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-lock-release'))

      // Must not throw — arc verdict is best-effort only
      const verdict = await runArcVerification('origin-lock-release', { cwd: '/repo', e2eDeps: deps })
      expect(verdict.ok).toBe(true) // arc verdict unchanged
      expect(released).toBe(true)   // lock released
    })

    it('[e2e-pass:no-tooling] runBrowserCheck NOT called when tooling unavailable', async () => {
      probeE2eToolingMock.mockReturnValueOnce({
        available: false,
        runner: 'none',
        missing: ['playwright not installed'],
        setupSteps: ['npm install @playwright/test'],
      })
      const { deps, runBrowserCheckSpy } = makeE2eDeps()
      getDefaultTaskStoreMock.mockResolvedValue(makeArcDoneStore('origin-no-tooling'))

      await runArcVerification('origin-no-tooling', { cwd: '/repo', e2eDeps: deps })

      expect(runBrowserCheckSpy).not.toHaveBeenCalled()
    })
  })

  // ── Steward workflow-patch proposal ──────────────────────────────────────
  //
  // After CONSECUTIVE_TOOLING_MISS_THRESHOLD consecutive arcs where tooling is
  // unavailable, the verifier proposes removing the behaviour-verify step from
  // the workflow file so the operator can decide whether to fix the environment
  // or drop the step. Behavioural FAILs (tooling available, static criterion
  // contradicted) reset the counter and must never trigger a proposal.

  describe('Steward workflow-patch proposal', () => {
    // Minimal workflow source that includes a behaviour-verify step.
    // Must end with '\n' so that git apply context matching works (no
    // "no newline at end of file" edge case in the generated diff).
    const WORKFLOW_SRC_WITH_BV = [
      "import { defineWorkflow } from 'mars/workflow'",
      "import { behaviourVerify } from 'mars/workflow'",
      '',
      'export default defineWorkflow({',
      '  async fn(ctx) {',
      "    await ctx.step('setup', () => {})",
      "    await ctx.step('code', () => {})",
      "    await ctx.step('behaviour-verify', () => behaviourVerify(ctx))",
      "    return await ctx.step('merge', () => {})",
      '  },',
      '})',
      '', // trailing newline
    ].join('\n')

    /** Minimal arc-done store for steward tests. */
    const makeStewardStore = (originId: string) =>
      makeStore(
        { status: 'arc-done', tasks: [{ id: originId, status: 'done' }], landedCommits: ['sha-s'] },
        [{ id: originId, branch: null }],
        new Map([[originId, makeTask(originId)]]),
      )

    /** Build injectable steward deps with sensible defaults. */
    const makeStewardDeps = (overrides: {
      propose?: ReturnType<typeof vi.fn>
      findAwaiting?: ReturnType<typeof vi.fn>
      readFile?: ReturnType<typeof vi.fn>
    } = {}) => ({
      proposeWorkflowPatch:
        overrides.propose ?? vi.fn(async () => ({ proposalId: 'p1', threadId: 't1' })),
      findAwaitingProposalForPath:
        overrides.findAwaiting ?? vi.fn(async (_p: string): Promise<string | null> => null),
      readWorkflowFile:
        overrides.readFile ?? vi.fn(async (_p: string) => WORKFLOW_SRC_WITH_BV),
    })

    beforeEach(() => {
      // Tooling unavailable by default for all steward tests.
      probeE2eToolingMock.mockReturnValue({
        available: false,
        runner: 'none',
        missing: ['@playwright/test not installed'],
        setupSteps: ['npm install --save-dev @playwright/test'],
      })
      // Static Claude check always passes so we isolate the tooling / steward branch.
      runHeadlessProviderMock.mockResolvedValue({
        exitCode: 0,
        stdout: '{"ok":true,"findings":[]}',
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })
      listActionQueueItemsMock.mockResolvedValue([])
    })

    it(`[threshold] ${CONSECUTIVE_TOOLING_MISS_THRESHOLD} consecutive tooling-missing arcs trigger exactly one proposal`, async () => {
      const propose = vi.fn(async () => ({ proposalId: 'p1', threadId: 't1' }))
      const stewardDeps = makeStewardDeps({ propose })

      for (let i = 1; i <= CONSECUTIVE_TOOLING_MISS_THRESHOLD; i++) {
        getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore(`origin-thresh-${i}`))
        await runArcVerification(`origin-thresh-${i}`, { cwd: '/repo', stewardDeps })
      }

      expect(propose).toHaveBeenCalledTimes(1)
      expect(propose).toHaveBeenCalledWith(
        expect.objectContaining({ workflowPath: '.mars/workflows/task-workflow.js' }),
      )
    })

    it('[threshold-rationale] rationale names the miss count, CAN\'T-VERIFY, and missing tool', async () => {
      const propose = vi.fn(async () => ({ proposalId: 'p1', threadId: 't1' }))
      const stewardDeps = makeStewardDeps({ propose })

      for (let i = 1; i <= CONSECUTIVE_TOOLING_MISS_THRESHOLD; i++) {
        getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore(`origin-rationale-${i}`))
        await runArcVerification(`origin-rationale-${i}`, { cwd: '/repo', stewardDeps })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callArg = (propose.mock.calls as any)[0]?.[0] as
        | { workflowPath: string; unifiedDiff: string; rationale: string }
        | undefined
      const rationale = callArg?.rationale ?? ''
      expect(rationale).toContain(`${CONSECUTIVE_TOOLING_MISS_THRESHOLD} consecutive`)
      expect(rationale).toContain("CAN'T-VERIFY")
      expect(rationale).toContain('@playwright/test not installed')
    })

    it('[no-duplicate] 4th miss does not produce a second proposal when one is already awaiting-human', async () => {
      const propose = vi.fn(async () => ({ proposalId: 'p1', threadId: 't1' }))
      const findAwaiting = vi.fn(async (_p: string): Promise<string | null> => null)
      const stewardDeps = makeStewardDeps({ propose, findAwaiting })

      // Misses 1-3: no existing proposal → proposal created on the 3rd.
      for (let i = 1; i <= CONSECUTIVE_TOOLING_MISS_THRESHOLD; i++) {
        getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore(`origin-nodup-${i}`))
        await runArcVerification(`origin-nodup-${i}`, { cwd: '/repo', stewardDeps })
      }
      expect(propose).toHaveBeenCalledTimes(1)

      // Miss 4: proposal now exists in awaiting-human → must not create another.
      findAwaiting.mockResolvedValue('existing-proposal-id')
      getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore('origin-nodup-4'))
      await runArcVerification('origin-nodup-4', { cwd: '/repo', stewardDeps })

      expect(propose).toHaveBeenCalledTimes(1)
    })

    it('[reset] counter resets on a tooling-available arc; 2 further misses do not trigger a proposal', async () => {
      const propose = vi.fn(async () => ({ proposalId: 'p1', threadId: 't1' }))
      const stewardDeps = makeStewardDeps({ propose })

      // 2 misses — below threshold.
      for (let i = 1; i <= CONSECUTIVE_TOOLING_MISS_THRESHOLD - 1; i++) {
        getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore(`origin-reset-miss-${i}`))
        await runArcVerification(`origin-reset-miss-${i}`, { cwd: '/repo', stewardDeps })
      }

      // Tooling available → counter resets to 0.
      probeE2eToolingMock.mockReturnValueOnce({
        available: true,
        runner: 'playwright' as const,
        missing: [],
        setupSteps: [],
      })
      getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore('origin-reset-avail'))
      await runArcVerification('origin-reset-avail', { cwd: '/repo', stewardDeps })

      // 2 more misses — fresh start, still below threshold.
      for (let i = 1; i <= CONSECUTIVE_TOOLING_MISS_THRESHOLD - 1; i++) {
        getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore(`origin-reset-miss2-${i}`))
        await runArcVerification(`origin-reset-miss2-${i}`, { cwd: '/repo', stewardDeps })
      }

      expect(propose).not.toHaveBeenCalled()
    })

    it('[behavioural-fails-excluded] tooling-available arcs (even with static FAIL) reset the counter', async () => {
      const propose = vi.fn(async () => ({ proposalId: 'p1', threadId: 't1' }))
      const stewardDeps = makeStewardDeps({ propose })

      // 2 tooling-missing arcs (below threshold).
      for (let i = 1; i <= CONSECUTIVE_TOOLING_MISS_THRESHOLD - 1; i++) {
        getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore(`origin-bv-miss-${i}`))
        await runArcVerification(`origin-bv-miss-${i}`, { cwd: '/repo', stewardDeps })
      }

      // "Behavioural FAIL" arc: tooling available but static criteria check fails.
      // The tooling-available branch always resets the counter.
      probeE2eToolingMock.mockReturnValueOnce({
        available: true,
        runner: 'playwright' as const,
        missing: [],
        setupSteps: [],
      })
      runHeadlessProviderMock.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"ok":false,"findings":["criterion not met by the arc"]}',
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })
      getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore('origin-bv-behavioural'))
      await runArcVerification('origin-bv-behavioural', { cwd: '/repo', stewardDeps })

      // 2 more misses — counter restarted from 0, still below threshold.
      for (let i = 1; i <= CONSECUTIVE_TOOLING_MISS_THRESHOLD - 1; i++) {
        getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore(`origin-bv-after-${i}`))
        await runArcVerification(`origin-bv-after-${i}`, { cwd: '/repo', stewardDeps })
      }

      expect(propose).not.toHaveBeenCalled()
    })

    it('[git-apply] emitted unified diff passes git apply --check in a real git repo', async () => {
      const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
      const { join: pathJoin } = await import('node:path')
      const { tmpdir } = await import('node:os')
      const { execFileSync } = await import('node:child_process')

      const repoDir = await mkdtemp(pathJoin(tmpdir(), 'mars-arc-gitapply-'))
      try {
        // Bootstrap a minimal git repo with the workflow file committed.
        execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' })
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir })
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir })

        const workflowDir = pathJoin(repoDir, '.mars', 'workflows')
        await mkdir(workflowDir, { recursive: true })
        await writeFile(pathJoin(workflowDir, 'task-workflow.js'), WORKFLOW_SRC_WITH_BV)

        execFileSync('git', ['add', '.'], { cwd: repoDir })
        execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' })

        // Capture the unified diff from the proposal.
        let capturedDiff: string | null = null
        const propose = vi.fn(async (input: { workflowPath: string; unifiedDiff: string; rationale: string }) => {
          capturedDiff = input.unifiedDiff
          return { proposalId: 'p1', threadId: 't1' }
        })
        // readWorkflowFile must return the same content that is committed.
        const stewardDeps = makeStewardDeps({
          propose,
          readFile: vi.fn(async () => WORKFLOW_SRC_WITH_BV),
        })

        // Run N arcs to reach the threshold.
        for (let i = 1; i <= CONSECUTIVE_TOOLING_MISS_THRESHOLD; i++) {
          getDefaultTaskStoreMock.mockResolvedValue(makeStewardStore(`origin-gitapply-${i}`))
          await runArcVerification(`origin-gitapply-${i}`, { cwd: repoDir, stewardDeps })
        }

        expect(capturedDiff).not.toBeNull()

        // Write the captured diff and verify it applies cleanly.
        const patchFile = pathJoin(repoDir, 'steward.patch')
        await writeFile(patchFile, capturedDiff!)
        expect(() =>
          execFileSync('git', ['apply', '--check', patchFile], { cwd: repoDir }),
        ).not.toThrow()
      } finally {
        await rm(repoDir, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
})
