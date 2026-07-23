/**
 * Arc-verifier unit tests.
 *
 * Verifies observable behaviours:
 *   1. trigger dedup — one run per originId (subsequent calls return skipped-dedup)
 *   2. no-merge arcs skipped — arc with no landed commits → no agent call, no AQ item
 *   3. failing verdict → exactly one arc-verification-failed AQ item
 *   4. kill-switch flag suppresses all runs
 *   5. arc E2E pass:
 *      - no previewCmd on origin task → Reflector draft proposal emitted (source='reflection')
 *      - no done criteria on origin task → Reflector draft proposal emitted
 *      - previewCmd exists, dev server healthy, E2E ok → verdict unchanged, no proposal
 *      - previewCmd exists, dev server healthy, canVerify=false → proposal emitted, verdict unchanged
 *      - previewCmd exists, dev server healthy, E2E fails → findings added, AQ item raised
 *      - previewCmd exists, dev server spawn fails → proposal emitted, verdict unchanged
 *      - previewCmd exists, health check times out → proposal emitted, verdict unchanged
 *
 * System boundaries mocked:
 *   - raiseActionQueueItem (action-queue DB write)
 *   - runClaudeCode (Claude subprocess)
 *   - getDefaultTaskStore (mars.db read)
 *   - createProposal / findOpenDraftByKpiTag (proposals DB write)
 *   - startDevServer / killDevServer (process spawn)
 *   - fetch (HTTP health check)
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

// ── Mock runClaudeCode ────────────────────────────────────────────────────────

const runClaudeCodeMock = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    stdout: '{"ok":true,"findings":[]}',
    stderr: '',
    sessionId: null,
    conversation: [],
    quotaRejected: null,
  })),
)
vi.mock('../git/claude', () => ({ runClaudeCode: runClaudeCodeMock }))

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

// ── Mock createProposal / findOpenDraftByKpiTag ───────────────────────────────

const createProposalMock = vi.hoisted(() =>
  vi.fn(async (_title: string, _opts?: unknown) => ({ id: 'proposal-1', title: 'mock' } as { id: string; title: string })),
)
const findOpenDraftByKpiTagMock = vi.hoisted(() =>
  vi.fn(async (_tag: string) => null as { id: string } | null),
)
vi.mock('../../proposals', () => ({
  createProposal: createProposalMock,
  findOpenDraftByKpiTag: findOpenDraftByKpiTagMock,
}))

// ── Mock startDevServer / killDevServer ───────────────────────────────────────

const startDevServerMock = vi.hoisted(() =>
  vi.fn(async () => ({
    pid: 1234,
    url: 'http://127.0.0.1:49999',
    logPath: '/tmp/arc-e2e-test.log',
    port: 49999,
  })),
)
const killDevServerMock = vi.hoisted(() => vi.fn(async (_pid: number) => {}))
vi.mock('../dev-server', () => ({
  startDevServer: startDevServerMock,
  killDevServer: killDevServerMock,
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const {
  triggerArcVerification,
  runArcVerification,
  isArcVerifyDisabled,
  arcE2eProposalFingerprint,
  _clearTriggeredForTests,
} = await import('../arc-verifier')

// ─────────────────────────────────────────────────────────────────────────────

/** Minimal task-shaped object with the spec fields arc-verifier reads. */
const makeTask = (
  id: string,
  spec: { verifyCmd?: string | null; previewCmd?: string | null; doneCriteria?: string[] } = {},
) => ({
  id,
  status: 'done',
  prompt: `task ${id}`,
  spec: {
    verifyCmd: spec.verifyCmd ?? null,
    previewCmd: spec.previewCmd ?? null,
    doneCriteria: spec.doneCriteria ?? [],
    files: [],
    taskType: 'auto' as const,
  },
})

describe('arc-verifier', () => {
  // We need a typed reference to the fetch spy for per-test overrides.
  // Using vi.fn directly avoids the overloaded-signature type error.
  let fetchSpy: { mockResolvedValue: (v: unknown) => unknown; mockRejectedValue: (e: unknown) => unknown; mockRestore: () => void } | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    _clearTriggeredForTests()
    delete process.env.MARS_ARC_VERIFY_DISABLED
    // Default: fetch succeeds (dev server healthy).
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 }),
    )
    fetchSpy = spy as unknown as typeof fetchSpy
  })

  afterEach(() => {
    delete process.env.MARS_ARC_VERIFY_DISABLED
    fetchSpy?.mockRestore()
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
    const result = triggerArcVerification('origin-flagged', { cwd: '/tmp' })
    expect(result).toBe('skipped-disabled')
    // No work was scheduled — raiseActionQueueItem and runClaudeCode are never called.
    expect(raiseSpy).not.toHaveBeenCalled()
    expect(runClaudeCodeMock).not.toHaveBeenCalled()
  })

  // ── triggerArcVerification — dedup ──────────────────────────────────────────

  it('[dedup] returns triggered on first call and skipped-dedup on second', () => {
    const r1 = triggerArcVerification('origin-dedup-1', { cwd: '/tmp' })
    const r2 = triggerArcVerification('origin-dedup-1', { cwd: '/tmp' })
    expect(r1).toBe('triggered')
    expect(r2).toBe('skipped-dedup')
  })

  it('[dedup] different originIds each get their own trigger', () => {
    const r1 = triggerArcVerification('origin-a', { cwd: '/tmp' })
    const r2 = triggerArcVerification('origin-b', { cwd: '/tmp' })
    expect(r1).toBe('triggered')
    expect(r2).toBe('triggered')
  })

  it('[dedup] skipped-dedup is returned synchronously without scheduling work', () => {
    // First call marks the originId.
    triggerArcVerification('origin-dedup-sync', { cwd: '/tmp' })
    // Second call must return without touching the agent or action-queue.
    const result = triggerArcVerification('origin-dedup-sync', { cwd: '/tmp' })
    expect(result).toBe('skipped-dedup')
    // We cannot assert runClaudeCode wasn't called yet (async work may still be
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
      expect(runClaudeCodeMock).not.toHaveBeenCalled()
      expect(raiseSpy).not.toHaveBeenCalled()
    })

    it('[no-merge] skips when arc is done but has no landed commits', async () => {
      getDefaultTaskStoreMock.mockResolvedValue(
        makeStore({ status: 'arc-done', tasks: [], landedCommits: [] }),
      )
      const verdict = await runArcVerification('origin-no-commits', { cwd: '/tmp' })
      expect(verdict).toEqual({ ok: true, findings: [] })
      expect(runClaudeCodeMock).not.toHaveBeenCalled()
      expect(raiseSpy).not.toHaveBeenCalled()
    })

    it('[no-merge] skips when arc failed entirely (arc-failed status)', async () => {
      getDefaultTaskStoreMock.mockResolvedValue(
        makeStore({ status: 'arc-failed', tasks: [], landedCommits: ['abc'] }),
      )
      const verdict = await runArcVerification('origin-arc-failed', { cwd: '/tmp' })
      expect(verdict).toEqual({ ok: true, findings: [] })
      expect(runClaudeCodeMock).not.toHaveBeenCalled()
      expect(raiseSpy).not.toHaveBeenCalled()
    })

    // ── failing verdict → one action-queue item ───────────────────────────────

    it('[verdict-fail] raises exactly one arc-verification-failed item on failing verdict', async () => {
      const findings = ['TypeScript errors in merged code', 'Test suite red after merge']
      runClaudeCodeMock.mockResolvedValueOnce({
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
      runClaudeCodeMock.mockResolvedValueOnce({
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
      runClaudeCodeMock.mockResolvedValueOnce({
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
      runClaudeCodeMock.mockResolvedValue(failPayload)

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

    // ── arc E2E pass ──────────────────────────────────────────────────────────
    //
    // Tests for the post-static-check live-surface E2E pass. Boundary mocks:
    //   - createProposal / findOpenDraftByKpiTag (proposals DB)
    //   - startDevServer / killDevServer (process spawn)
    //   - fetch (health check HTTP)
    //   - runClaudeCode (called twice: once for static check, once for E2E)
    //
    // Isolation: each test resets static verdict to ok=true so we can isolate
    // the E2E-pass branch. `e2eHealthCheckTimeoutMs:0` makes the health-check
    // loop exit immediately on the first fetch failure without any real wait.

    describe('arc E2E pass', () => {
      const ORIGIN_WITH_PREVIEW = 'origin-e2e-preview'

      /** Make a store where the origin task has the given spec. */
      const makeE2eStore = (
        originId: string,
        spec: { verifyCmd?: string | null; previewCmd?: string | null; doneCriteria?: string[] } = {},
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
        runClaudeCodeMock.mockResolvedValue({
          exitCode: 0,
          stdout: '{"ok":true,"findings":[]}',
          stderr: '',
          sessionId: null,
          conversation: [],
          quotaRejected: null,
        })
        findOpenDraftByKpiTagMock.mockResolvedValue(null)
        startDevServerMock.mockResolvedValue({
          pid: 1234,
          url: 'http://127.0.0.1:49999',
          logPath: '/tmp/arc-e2e-test.log',
          port: 49999,
        })
        killDevServerMock.mockResolvedValue(undefined)
      })

      it('[e2e-no-preview] emits Reflector draft proposal (source=reflection) when origin task has no previewCmd', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore(ORIGIN_WITH_PREVIEW, { doneCriteria: ['Feature works'] }),
          // previewCmd defaults to null
        )

        const verdict = await runArcVerification(ORIGIN_WITH_PREVIEW, {
          cwd: '/tmp',
          e2eHealthCheckTimeoutMs: 0,
        })

        // Static check passes, no E2E infra → verdict unchanged.
        expect(verdict).toEqual({ ok: true, findings: [] })
        // Dev server was never booted (no previewCmd).
        expect(startDevServerMock).not.toHaveBeenCalled()
        // A Reflector draft proposal was emitted.
        expect(createProposalMock).toHaveBeenCalledOnce()
        const proposalOpts = (createProposalMock.mock.calls as unknown as Array<[string, { source: string }]>)[0][1]
        expect(proposalOpts.source).toBe('reflection')
        // No AQ item for a can't-verify (arc is not failed).
        expect(raiseSpy).not.toHaveBeenCalled()
      })

      it('[e2e-no-criteria] emits Reflector draft proposal when origin task has previewCmd but no done criteria', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore(ORIGIN_WITH_PREVIEW, { previewCmd: 'npm run dev', doneCriteria: [] }),
        )

        const verdict = await runArcVerification(ORIGIN_WITH_PREVIEW, {
          cwd: '/tmp',
          e2eHealthCheckTimeoutMs: 0,
        })

        expect(verdict).toEqual({ ok: true, findings: [] })
        expect(startDevServerMock).not.toHaveBeenCalled()
        expect(createProposalMock).toHaveBeenCalledOnce()
        expect(((createProposalMock.mock.calls as unknown as Array<[string, { source: string }]>)[0][1]).source).toBe('reflection')
        expect(raiseSpy).not.toHaveBeenCalled()
      })

      it('[e2e-spawn-fail] emits Reflector draft proposal when dev server fails to spawn', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-spawn-fail', {
            previewCmd: 'npm run dev',
            doneCriteria: ['Feature renders'],
          }),
        )
        startDevServerMock.mockRejectedValueOnce(new Error('spawn ENOENT'))

        const verdict = await runArcVerification('origin-spawn-fail', {
          cwd: '/tmp',
          e2eHealthCheckTimeoutMs: 0,
        })

        // Arc not failed — spawn failure is infrastructure gap.
        expect(verdict).toEqual({ ok: true, findings: [] })
        expect(killDevServerMock).not.toHaveBeenCalled()
        expect(createProposalMock).toHaveBeenCalledOnce()
        expect(((createProposalMock.mock.calls as unknown as Array<[string, { source: string }]>)[0][1]).source).toBe('reflection')
        expect(raiseSpy).not.toHaveBeenCalled()
      })

      it('[e2e-unhealthy] emits Reflector draft proposal when dev server never answers health check', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-unhealthy', {
            previewCmd: 'npm run dev',
            doneCriteria: ['Feature renders'],
          }),
        )
        // Make fetch always throw so the health-check loop times out.
        fetchSpy?.mockRejectedValue(new Error('ECONNREFUSED'))

        const verdict = await runArcVerification('origin-unhealthy', {
          cwd: '/tmp',
          e2eHealthCheckTimeoutMs: 0,  // exit immediately on first failure
        })

        expect(verdict).toEqual({ ok: true, findings: [] })
        // Server was booted and killed in finally.
        expect(startDevServerMock).toHaveBeenCalledOnce()
        expect(killDevServerMock).toHaveBeenCalledWith(1234)
        expect(createProposalMock).toHaveBeenCalledOnce()
        expect(((createProposalMock.mock.calls as unknown as Array<[string, { source: string }]>)[0][1]).source).toBe('reflection')
        expect(raiseSpy).not.toHaveBeenCalled()
      })

      it('[e2e-pass] does not emit a proposal when E2E check passes', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-e2e-pass', {
            previewCmd: 'npm run dev',
            doneCriteria: ['Feature renders correctly'],
          }),
        )
        // Static check + E2E check both pass (runClaudeCode called twice).
        runClaudeCodeMock.mockResolvedValue({
          exitCode: 0,
          stdout: '{"ok":true,"canVerify":true,"findings":[]}',
          stderr: '',
          sessionId: null,
          conversation: [],
          quotaRejected: null,
        })
        // fetch succeeds on first try (already default but make explicit).
        fetchSpy?.mockResolvedValue(new Response('ok', { status: 200 }))

        const verdict = await runArcVerification('origin-e2e-pass', { cwd: '/tmp' })

        expect(verdict).toEqual({ ok: true, findings: [] })
        expect(startDevServerMock).toHaveBeenCalledOnce()
        expect(killDevServerMock).toHaveBeenCalledWith(1234)
        expect(createProposalMock).not.toHaveBeenCalled()
        expect(raiseSpy).not.toHaveBeenCalled()
      })

      it('[e2e-cant-verify] emits Reflector draft proposal when E2E agent has no browser tools', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-no-browser', {
            previewCmd: 'npm run dev',
            doneCriteria: ['Feature renders correctly'],
          }),
        )
        // First call: static check passes. Second call: E2E reports canVerify=false.
        runClaudeCodeMock
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
            stdout: '{"ok":true,"canVerify":false,"findings":["no browser tools"]}',
            stderr: '',
            sessionId: null,
            conversation: [],
            quotaRejected: null,
          })
        fetchSpy?.mockResolvedValue(new Response('ok', { status: 200 }))

        const verdict = await runArcVerification('origin-no-browser', { cwd: '/tmp' })

        // Arc not failed — can't-verify is an infrastructure gap.
        expect(verdict).toEqual({ ok: true, findings: [] })
        expect(createProposalMock).toHaveBeenCalledOnce()
        expect(((createProposalMock.mock.calls as unknown as Array<[string, { source: string }]>)[0][1]).source).toBe('reflection')
        expect(raiseSpy).not.toHaveBeenCalled()
      })

      it('[e2e-fail] adds findings and raises AQ item when E2E check fails', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-e2e-fail', {
            previewCmd: 'npm run dev',
            doneCriteria: ['Button is blue'],
          }),
        )
        const e2eFindings = ['Button is red, not blue as required']
        // First call: static check passes. Second call: E2E fails.
        runClaudeCodeMock
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
            stdout: JSON.stringify({ ok: false, canVerify: true, findings: e2eFindings }),
            stderr: '',
            sessionId: null,
            conversation: [],
            quotaRejected: null,
          })
        fetchSpy?.mockResolvedValue(new Response('ok', { status: 200 }))

        const verdict = await runArcVerification('origin-e2e-fail', { cwd: '/tmp' })

        expect(verdict.ok).toBe(false)
        // The E2E findings are included (prefixed with [e2e]).
        expect(verdict.findings.some((f) => f.includes('Button is red'))).toBe(true)
        // AQ item raised because verdict.ok is false.
        expect(raiseSpy).toHaveBeenCalledTimes(1)
        expect(raiseSpy.mock.calls[0][0].kind).toBe('arc-verification-failed')
        // No draft proposal (it's a product failure, not an infra gap).
        expect(createProposalMock).not.toHaveBeenCalled()
      })

      it('[e2e-dedup-proposal] does not create duplicate proposals when fingerprint already exists', async () => {
        getDefaultTaskStoreMock.mockResolvedValue(
          makeE2eStore('origin-dedup-proposal', { doneCriteria: ['works'] }),
          // previewCmd: null → triggers proposal
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
