/**
 * Arc-verifier reachability — end-to-end integration test.
 *
 * Exercises the full trigger → assemble → judge → emit chain against three
 * synthetic Proposal Arc fixtures, asserting on Action queue items without
 * making real network calls.
 *
 * Fixture A: four user stories all mentioning "in the admin interface"; slices
 *   touch only API routes and database — no UI affordance shipped.
 *   Expected: exactly one arc-verification-failed Action queue item whose body
 *   names one of the four user stories verbatim.
 *
 * Fixture B: same PRD, but "admin interface" declared in out_of_scope.
 *   Expected: zero reachability-related Action queue items (stories deferred).
 *
 * Fixture C: PRD with zero user stories, arbitrary merged result.
 *   Expected: zero reachability-related Action queue items (check is skipped).
 *
 * System boundaries stubbed at the same seams as the unit tests:
 *   - runHeadlessProvider  — LLM calls (judgeReachableSurfaces + main verifier)
 *   - raiseActionQueueItem — Action queue DB write
 *   - getDefaultTaskStore  — task DB read
 *   - getProposal / findOpenDraftByKpiTag / createProposal — proposals DB
 *   - collectAssistantText — reflector helper (returns '' → stdout fallback)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RaiseActionQueueItem } from '../action-queue.js'

// ── Fixture PRD user stories ──────────────────────────────────────────────────
//
// All four stories mention "in the admin interface"; the synthetic arc's slices
// only touch API routes and a database table — no UI affordance is ever shipped.

const ADMIN_STORIES = [
  'As an admin, I can view all registered users in the admin interface',
  'As an admin, I can suspend a user account in the admin interface',
  'As an admin, I can review flagged content in the admin interface',
  'As an admin, I can export audit logs in the admin interface',
] as const

// ── Mock raiseActionQueueItem ─────────────────────────────────────────────────

const raiseSpy = vi.hoisted(() =>
  vi.fn(async (_item: RaiseActionQueueItem): Promise<string> => 'mock-aq-id'),
)
vi.mock('../action-queue.js', async (importActual) => {
  const actual = await importActual<typeof import('../action-queue.js')>()
  return { ...actual, raiseActionQueueItem: raiseSpy }
})

// ── Mock runHeadlessProvider ─────────────────────────────────────────────────
//
// The seam for the LLM call.  runArcVerification makes two consecutive calls:
//   call 1 — main done-criteria verifier (returns `{"ok":true,"findings":[]}`)
//   call 2 — judgeReachableSurfaces reachability check (stubbed per fixture)
//
// Stubbing runHeadlessProvider here is equivalent to stubbing at the
// judgeReachableSurfaces seam because judgeReachableSurfaces is the sole
// caller of runHeadlessProvider for the reachability verdict.

const runHeadlessProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    stdout: '{"ok":true,"findings":[]}',
    stderr: '',
    sessionId: null,
    conversation: [] as unknown[],
    quotaRejected: null,
  })),
)
vi.mock('../../workers/providers.js', () => ({
  runHeadlessProvider: runHeadlessProviderMock,
}))

// ── Mock collectAssistantText ─────────────────────────────────────────────────
// Returns '' so the code falls back to stdout, which the provider mock controls.

vi.mock('../reflector.js', () => ({
  collectAssistantText: vi.fn((_conversation: unknown[]) => ''),
}))

// ── Mock getDefaultTaskStore ──────────────────────────────────────────────────

const makeSliceTask = (id: string) => ({
  id,
  status: 'done',
  prompt: `Implement ${id}`,
  spec: {
    verifyCmd: null,
    doneCriteria: [] as string[],
    files: [] as string[],
    mergeMode: 'auto' as const,
  },
})

/** Build a minimal store that reports arc-done with one landed commit. */
const makeArcStore = (originId: string, sliceIds: string[]) => ({
  arcStatus: vi.fn(async () => ({
    status: 'arc-done',
    tasks: sliceIds.map((id) => ({ id, status: 'done' })),
    landedCommits: ['sha-arc-fixture'],
  })),
  listArcMembers: vi.fn(async () =>
    sliceIds.map((id) => ({ id, branch: null })),
  ),
  getTask: vi.fn(async (id: string) =>
    sliceIds.includes(id) ? makeSliceTask(id) : null,
  ),
})

const getDefaultTaskStoreMock = vi.hoisted(() => vi.fn())
vi.mock('../../store/task-store.js', () => ({
  getDefaultTaskStore: getDefaultTaskStoreMock,
}))

// ── Mock proposals ────────────────────────────────────────────────────────────

const getProposalMock = vi.hoisted(() =>
  vi.fn(async (_id: string) =>
    null as { id: string; userStories: string[]; outOfScope: string } | null,
  ),
)
const findOpenDraftByKpiTagMock = vi.hoisted(() =>
  vi.fn(async (_tag: string) => null as { id: string } | null),
)
const createProposalMock = vi.hoisted(() =>
  vi.fn(async (_title: string, _opts?: unknown) => ({ id: 'prop-draft', title: 'mock' })),
)
vi.mock('../../proposals.js', () => ({
  createProposal: createProposalMock,
  findOpenDraftByKpiTag: findOpenDraftByKpiTagMock,
  getProposal: getProposalMock,
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const { runArcVerification, triggerArcVerification, _clearTriggeredForTests } =
  await import('../arc-verifier.js')

// ─────────────────────────────────────────────────────────────────────────────

describe('arc-verifier reachability — end-to-end chain (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearTriggeredForTests()
    // Proposals dedup: no existing open draft so emitArcE2eProposalIfNew always writes.
    findOpenDraftByKpiTagMock.mockResolvedValue(null)
  })

  afterEach(() => {
    delete process.env.MARS_ARC_VERIFY_DISABLED
  })

  // ── Fixture A ───────────────────────────────────────────────────────────────
  //
  // PRD promises four user stories all mentioning "in the admin interface".
  // The merged arc only ships two API routes and a database table — no
  // UI affordance, no CLI command, no bot command.  The judge returns all
  // four stories as unsatisfied.  The pipeline must emit exactly one
  // arc-verification-failed Action queue item whose body names at least one
  // of the four stories verbatim.

  it('[fixture-a] full chain produces exactly one AQ item naming an admin-interface story verbatim', async () => {
    const proposalId = 'prop-fixture-a'

    // Arc: two slice tasks (API route + DB migration); no UI slice
    getDefaultTaskStoreMock.mockResolvedValue(
      makeArcStore(proposalId, ['slice-api', 'slice-db']),
    )

    // PRD carries four admin-interface user stories; nothing is out of scope
    getProposalMock.mockResolvedValueOnce({
      id: proposalId,
      userStories: [...ADMIN_STORIES],
      outOfScope: '',
    })

    // Stub both LLM calls deterministically — no network traffic
    runHeadlessProviderMock
      // Call 1: main done-criteria verifier — passes (API + DB land correctly)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"ok":true,"findings":[]}',
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })
      // Call 2: judgeReachableSurfaces — all four stories unsatisfied
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          unsatisfiedStories: ADMIN_STORIES.map((story) => ({
            story,
            humanCannotDo:
              'No admin interface page, CLI command, or bot command was delivered; only a REST API endpoint exists.',
          })),
          deferredStories: [],
        }),
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })

    // ── Trigger: admission gate ───────────────────────────────────────────────
    const triggerResult = triggerArcVerification(proposalId)
    expect(triggerResult).toBe('triggered')

    // ── Assemble + judge + emit ───────────────────────────────────────────────
    const verdict = await runArcVerification(proposalId, { cwd: '/tmp' })

    // Verdict is failing: admin interface was promised but not shipped
    expect(verdict.ok).toBe(false)

    // Exactly one Action queue item of the failing-verdict kind
    expect(raiseSpy).toHaveBeenCalledTimes(1)
    const raised = raiseSpy.mock.calls[0][0] as RaiseActionQueueItem
    expect(raised.kind).toBe('arc-verification-failed')

    // Body names at least one of the four user stories verbatim
    const bodyText = raised.body
    const namedStory = ADMIN_STORIES.find((story) => bodyText.includes(story))
    expect(namedStory).toBeDefined()
  })

  // ── Fixture B ───────────────────────────────────────────────────────────────
  //
  // Same PRD, but "admin interface" is declared in out_of_scope.  The judge
  // returns all stories as deferred.  The pipeline must produce zero
  // reachability-related Action queue items.

  it('[fixture-b] produces zero AQ items when admin interface is in out_of_scope', async () => {
    const proposalId = 'prop-fixture-b'

    getDefaultTaskStoreMock.mockResolvedValue(
      makeArcStore(proposalId, ['slice-api', 'slice-db']),
    )

    // Same stories; admin interface explicitly out of scope
    getProposalMock.mockResolvedValueOnce({
      id: proposalId,
      userStories: [...ADMIN_STORIES],
      outOfScope: 'admin interface\nAdmin panel features',
    })

    runHeadlessProviderMock
      // Call 1: main done-criteria verifier — passes
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '{"ok":true,"findings":[]}',
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })
      // Call 2: judgeReachableSurfaces — all stories deferred, none unsatisfied
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          unsatisfiedStories: [],
          deferredStories: [...ADMIN_STORIES],
        }),
        stderr: '',
        sessionId: null,
        conversation: [],
        quotaRejected: null,
      })

    const triggerResult = triggerArcVerification(proposalId)
    expect(triggerResult).toBe('triggered')

    const verdict = await runArcVerification(proposalId, { cwd: '/tmp' })

    // Done-criteria pass + no unsatisfied stories → verdict ok
    expect(verdict.ok).toBe(true)
    // Zero Action queue items
    expect(raiseSpy).not.toHaveBeenCalled()
  })

  // ── Fixture C ───────────────────────────────────────────────────────────────
  //
  // PRD carries zero user stories.  The reachability check is skipped entirely
  // (judgeReachableSurfaces returns immediately when userStories is empty).
  // The pipeline must produce zero reachability-related Action queue items,
  // and the second LLM call must never be made.

  it('[fixture-c] produces zero AQ items when user_stories is empty', async () => {
    const proposalId = 'prop-fixture-c'

    getDefaultTaskStoreMock.mockResolvedValue(
      makeArcStore(proposalId, ['task-alpha']),
    )

    // PRD with zero user stories
    getProposalMock.mockResolvedValueOnce({
      id: proposalId,
      userStories: [],
      outOfScope: '',
    })

    // Only one provider call expected — no second call for reachability
    runHeadlessProviderMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"ok":true,"findings":[]}',
      stderr: '',
      sessionId: null,
      conversation: [],
      quotaRejected: null,
    })

    const triggerResult = triggerArcVerification(proposalId)
    expect(triggerResult).toBe('triggered')

    const verdict = await runArcVerification(proposalId, { cwd: '/tmp' })

    expect(verdict.ok).toBe(true)
    // Provider called exactly once — reachability check was skipped
    expect(runHeadlessProviderMock).toHaveBeenCalledTimes(1)
    // Zero Action queue items
    expect(raiseSpy).not.toHaveBeenCalled()
  })
})
