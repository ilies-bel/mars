/**
 * Arc-verifier unit tests.
 *
 * Verifies observable behaviours:
 *   1. trigger dedup — one admission per originId (subsequent calls return skipped-dedup)
 *   2. no-merge arcs skipped — arc with no landed commits → no agent call, no AQ item
 *   3. failing verdict → exactly one arc-verification-failed AQ item
 *   4. kill-switch flag suppresses all runs
 *   5. arc E2E pass — always CAN'T-VERIFY (no live surface):
 *      - origin task with done criteria → draft proposal emitted (source='arc-verifier')
 *      - origin task with no done criteria → arc-verifier draft proposal emitted
 *      - fingerprint already exists → no duplicate proposal created
 *
 * System boundaries mocked:
 *   - raiseActionQueueItem (action-queue DB write)
 *   - runHeadlessProvider (selected provider subprocess)
 *   - getDefaultTaskStore (mars.db read)
 *   - createProposal / findOpenDraftByKpiTag (proposals DB write)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RaiseActionQueueItem } from '../action-queue'

// ── Mock raiseActionQueueItem ─────────────────────────────────────────────────

const raiseSpy = vi.hoisted(() =>
  vi.fn(async (_item: RaiseActionQueueItem): Promise<string> => 'mock-item-id'),
)
vi.mock('../action-queue', async (importActual) => {
  const actual = await importActual<typeof import('../action-queue')>()
  return { ...actual, raiseActionQueueItem: raiseSpy }
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

// ── Mock createProposal / findOpenDraftByKpiTag / getProposal ─────────────────

const createProposalMock = vi.hoisted(() =>
  vi.fn(async (_title: string, _opts?: unknown) => ({ id: 'proposal-1', title: 'mock' } as { id: string; title: string })),
)
const findOpenDraftByKpiTagMock = vi.hoisted(() =>
  vi.fn(async (_tag: string) => null as { id: string } | null),
)
const getProposalMock = vi.hoisted(() =>
  vi.fn(async (_id: string) => null as { id: string; userStories: string[]; outOfScope: string } | null),
)
vi.mock('../../proposals', () => ({
  createProposal: createProposalMock,
  findOpenDraftByKpiTag: findOpenDraftByKpiTagMock,
  getProposal: getProposalMock,
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const {
  triggerArcVerification,
  runArcVerification,
  isArcVerifyDisabled,
  arcE2eProposalFingerprint,
  loadPrdReachabilityContext,
  _clearTriggeredForTests,
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

      // Exactly one action-queue item raised.
      expect(raiseSpy).toHaveBeenCalledTimes(1)
      const raised = raiseSpy.mock.calls[0][0] as RaiseActionQueueItem
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
      expect(raiseSpy).not.toHaveBeenCalled()
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
      // Still raises one item.
      expect(raiseSpy).toHaveBeenCalledTimes(1)
      expect(raiseSpy.mock.calls[0][0].kind).toBe('arc-verification-failed')
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

      // raiseActionQueueItem is called twice, but the action-queue dedup (via
      // signature) collapses them into one row. Our test just asserts the
      // kind and signature are correct both times.
      expect(raiseSpy).toHaveBeenCalledTimes(2)
      for (const call of raiseSpy.mock.calls) {
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

      beforeEach(() => {
        findOpenDraftByKpiTagMock.mockResolvedValue(null)
      })

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
        expect(raiseSpy).toHaveBeenCalledTimes(1)
        expect(raiseSpy.mock.calls[0][0].kind).toBe('arc-verification-failed')
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
        expect(raiseSpy).not.toHaveBeenCalled()
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
        expect(raiseSpy).not.toHaveBeenCalled()
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
        // Exactly one AQ item raised.
        expect(raiseSpy).toHaveBeenCalledTimes(1)
        expect(raiseSpy.mock.calls[0][0].kind).toBe('arc-verification-failed')
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

    // ── arc E2E pass — always CAN'T-VERIFY (no live surface) ─────────────────
    //
    // After the static Claude spot-check, runArcVerification always emits a
    // arc-verifier draft proposal (source='arc-verifier') because no per-task preview
    // command exists (removed in PRD f354b404 slice 1). The arc is never failed
    // for this infrastructure gap.

    describe("arc E2E pass — always CAN'T-VERIFY", () => {
      /** Make a store where the origin task has the given spec. */
      const makeE2eStore = (
        originId: string,
        spec: { verifyCmd?: string | null; doneCriteria?: string[] } = {},
      ) => {
        const task = makeTask(originId, spec)
        return makeStore(
          { status: 'arc-done', tasks: [{ id: originId, status: 'done' }], landedCommits: ['sha-e2e'] },
          [{ id: originId, branch: null }],
          new Map([[originId, task]]),
        )
      }

      beforeEach(() => {
        // Static Claude check always passes so we isolate the E2E branch.
        runHeadlessProviderMock.mockResolvedValue({
          exitCode: 0,
          stdout: '{"ok":true,"findings":[]}',
          stderr: '',
          sessionId: null,
          conversation: [],
          quotaRejected: null,
        })
        findOpenDraftByKpiTagMock.mockResolvedValue(null)
      })

      it('[e2e-has-criteria] emits an arc-verifier draft proposal (source=arc-verifier) when origin task has done criteria', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-e2e-criteria', { doneCriteria: ['Feature works'] }),
        )

        const verdict = await runArcVerification('origin-e2e-criteria', { cwd: '/tmp' })

        // Static check passes, no live surface → verdict unchanged.
        expect(verdict).toEqual({ ok: true, findings: [] })
        // An arc-verifier draft proposal was emitted.
        expect(createProposalMock).toHaveBeenCalledOnce()
        const proposalOpts = (createProposalMock.mock.calls as unknown as Array<[string, { source: string }]>)[0][1]
        expect(proposalOpts.source).toBe('arc-verifier')
        // No AQ item — arc is not failed.
        expect(raiseSpy).not.toHaveBeenCalled()
      })

      it('[e2e-no-criteria] emits an arc-verifier draft proposal when origin task has no done criteria', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-e2e-no-criteria', { doneCriteria: [] }),
        )

        const verdict = await runArcVerification('origin-e2e-no-criteria', { cwd: '/tmp' })

        expect(verdict).toEqual({ ok: true, findings: [] })
        expect(createProposalMock).toHaveBeenCalledOnce()
        expect(((createProposalMock.mock.calls as unknown as Array<[string, { source: string }]>)[0][1]).source).toBe('arc-verifier')
        expect(raiseSpy).not.toHaveBeenCalled()
      })

      it('[e2e-dedup-proposal] does not create duplicate proposals when fingerprint already exists', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-dedup-proposal', { doneCriteria: ['works'] }),
        )
        // Simulate existing open proposal.
        findOpenDraftByKpiTagMock.mockResolvedValue({ id: 'existing-proposal' })

        const verdict = await runArcVerification('origin-dedup-proposal', { cwd: '/tmp' })

        expect(verdict).toEqual({ ok: true, findings: [] })
        // findOpenDraftByKpiTag was called, found an existing one → no createProposal.
        expect(createProposalMock).not.toHaveBeenCalled()
      })

      it('[e2e-fingerprint] arcE2eProposalFingerprint is stable and contains originId', () => {
        const fp = arcE2eProposalFingerprint('origin-xyz')
        expect(fp).toContain('origin-xyz')
        // Called twice with the same id → same result.
        expect(fp).toBe(arcE2eProposalFingerprint('origin-xyz'))
      })
    })
  })
})
