/**
 * QA step-list flag unit and integration tests.
 *
 * Covers:
 *   1. readQaStepListFlag — reads boolean from daemon.json correctly
 *   2. suggestQaStepListCapability — raises draft-proposal with the right signature
 *   3. Integration via runArcVerification:
 *      - flag off → E2E pass skipped, suggestion raised (once per arc)
 *      - flag on  → E2E pass runs (no suggestion raised)
 *      - second arc with flag off → same global signature (DB deduplication applies)
 *
 * System boundaries mocked:
 *   - raiseActionQueueItem / listActionQueueItems / setActionQueueState
 *   - runHeadlessProvider
 *   - getDefaultTaskStore
 *   - probeE2eTooling (returns available so the tooling-present branch runs)
 *   - getProposal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

// ── Mock provider runner ──────────────────────────────────────────────────────

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

vi.mock('../reflector', () => ({
  collectAssistantText: vi.fn((_conversation: unknown[]) => ''),
}))

const getProposalMock = vi.hoisted(() =>
  vi.fn(async (_id: string) => null as { id: string; userStories: string[]; outOfScope: string } | null),
)
vi.mock('../../proposals', () => ({
  getProposal: getProposalMock,
}))

// ── Mock probeE2eTooling — available by default so the tooling branch runs ───

const probeE2eToolingMock = vi.hoisted(() =>
  vi.fn((_repoRoot: string): E2eToolingReport => ({
    available: true,
    runner: 'playwright',
    missing: [],
    setupSteps: [],
  })),
)
vi.mock('../e2e-tooling', () => ({
  probeE2eTooling: probeE2eToolingMock,
}))

// ── Import after mocks ────────────────────────────────────────────────────────

const {
  readQaStepListFlag,
  suggestQaStepListCapability,
  QA_STEP_LIST_CAPABILITY_SUGGESTION_SIGNATURE,
} = await import('../qa-step-list-flag')

const { runArcVerification, _clearTriggeredForTests, _clearToolingMissCountForTests } =
  await import('../arc-verifier')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a temp directory containing a .mars/daemon.json with the given qaStepList flag. */
function makeTempMarsDir(enabled: boolean): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'qa-flag-test-'))
  const marsDir = join(cwd, '.mars')
  mkdirSync(marsDir, { recursive: true })
  writeFileSync(
    join(marsDir, 'daemon.json'),
    JSON.stringify({ qaStepList: { enabled } }),
    'utf8',
  )
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  }
}

/** Minimal arc-done store with one landed commit. */
function makeDoneStore(originId: string) {
  return makeStore(
    { status: 'arc-done', tasks: [{ id: originId, status: 'done' }], landedCommits: ['sha-abc'] },
    [{ id: originId, branch: null }],
    new Map([[originId, {
      id: originId,
      status: 'done',
      prompt: `task ${originId}`,
      spec: { verifyCmd: null, doneCriteria: [], files: [], mergeMode: 'auto' },
    }]]),
  )
}

/** E2E deps that immediately return "already done" so the pass skips the boot. */
const skipE2eDeps = {
  isE2ePassDone: () => true,
  markE2ePassDone: vi.fn(async () => {}),
  discoverAppBoot: () => null,
  runBrowserCheck: vi.fn(async () => []),
  acquireLock: vi.fn(async () => async () => {}),
}

// ─────────────────────────────────────────────────────────────────────────────

describe('readQaStepListFlag', () => {
  it('returns false when daemon.json is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-flag-absent-'))
    mkdirSync(join(dir, '.mars'), { recursive: true })
    try {
      expect(readQaStepListFlag(join(dir, '.mars'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns false when qaStepList key is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-flag-no-key-'))
    const marsDir = join(dir, '.mars')
    mkdirSync(marsDir, { recursive: true })
    writeFileSync(join(marsDir, 'daemon.json'), JSON.stringify({ controlLevers: {} }), 'utf8')
    try {
      expect(readQaStepListFlag(marsDir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns false when qaStepList.enabled is false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-flag-false-'))
    const marsDir = join(dir, '.mars')
    mkdirSync(marsDir, { recursive: true })
    writeFileSync(join(marsDir, 'daemon.json'), JSON.stringify({ qaStepList: { enabled: false } }), 'utf8')
    try {
      expect(readQaStepListFlag(marsDir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns true when qaStepList.enabled is true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-flag-true-'))
    const marsDir = join(dir, '.mars')
    mkdirSync(marsDir, { recursive: true })
    writeFileSync(join(marsDir, 'daemon.json'), JSON.stringify({ qaStepList: { enabled: true } }), 'utf8')
    try {
      expect(readQaStepListFlag(marsDir)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns false on invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-flag-invalid-'))
    const marsDir = join(dir, '.mars')
    mkdirSync(marsDir, { recursive: true })
    writeFileSync(join(marsDir, 'daemon.json'), 'not-json', 'utf8')
    try {
      expect(readQaStepListFlag(marsDir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('suggestQaStepListCapability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('raises a draft-proposal item with the global dedup signature', async () => {
    await suggestQaStepListCapability('origin-abc123')

    expect(raiseSpy).toHaveBeenCalledOnce()
    const item = raiseSpy.mock.calls[0][0] as RaiseActionQueueItem
    expect(item.kind).toBe('draft-proposal')
    expect(item.signature).toBe(QA_STEP_LIST_CAPABILITY_SUGGESTION_SIGNATURE)
    expect(item.signature).toBe('qa-step-list-capability-suggestion')
  })

  it('includes the arc id (first 8 chars) in the body', async () => {
    await suggestQaStepListCapability('origin-xyz789ab')

    const item = raiseSpy.mock.calls[0][0] as RaiseActionQueueItem
    expect(item.body).toContain('origin-x') // first 8 chars
  })

  it('uses a fixed signature regardless of the origin id', async () => {
    await suggestQaStepListCapability('arc-one')
    await suggestQaStepListCapability('arc-two')

    const sigs = raiseSpy.mock.calls.map((c) => (c[0] as RaiseActionQueueItem).signature)
    expect(sigs[0]).toBe(sigs[1])
    expect(sigs[0]).toBe('qa-step-list-capability-suggestion')
  })
})

// ── Integration tests via runArcVerification ──────────────────────────────────

describe('runArcVerification + qa-step-list flag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _clearTriggeredForTests()
    _clearToolingMissCountForTests()
    // Ensure E2E tooling is reported as available so the tooling-present branch runs.
    probeE2eToolingMock.mockReturnValue({
      available: true,
      runner: 'playwright',
      missing: [],
      setupSteps: [],
    })
  })

  it('[flag off] records qaPass.disabled and raises a draft-proposal suggestion', async () => {
    const { cwd, cleanup } = makeTempMarsDir(false)
    try {
      getDefaultTaskStoreMock.mockResolvedValue(makeDoneStore('origin-flag-off'))

      const verdict = await runArcVerification('origin-flag-off', {
        cwd,
        e2eDeps: skipE2eDeps,
      })

      expect(verdict.ok).toBe(true)
      // qaPass records that the step-list walk was skipped because the capability is disabled.
      expect(verdict.qaPass).toMatchObject({
        ran: false,
        cantRunReason: 'disabled',
        manifest: null,
      })

      // Exactly one draft-proposal suggestion was raised.
      const suggestions = raiseSpy.mock.calls.filter(
        (c) => (c[0] as RaiseActionQueueItem).signature === 'qa-step-list-capability-suggestion',
      )
      expect(suggestions).toHaveLength(1)
      expect(suggestions[0][0].kind).toBe('draft-proposal')
    } finally {
      cleanup()
    }
  })

  it('[flag on] does not raise a capability suggestion and does not set qaPass.disabled', async () => {
    const { cwd, cleanup } = makeTempMarsDir(true)
    try {
      getDefaultTaskStoreMock.mockResolvedValue(makeDoneStore('origin-flag-on'))

      const verdict = await runArcVerification('origin-flag-on', {
        cwd,
        e2eDeps: skipE2eDeps,
      })

      // No capability suggestion should have been raised.
      const suggestions = raiseSpy.mock.calls.filter(
        (c) => (c[0] as RaiseActionQueueItem).signature === 'qa-step-list-capability-suggestion',
      )
      expect(suggestions).toHaveLength(0)
      // qaPass is not set to disabled.
      expect(verdict.qaPass?.cantRunReason).not.toBe('disabled')
    } finally {
      cleanup()
    }
  })

  it('[dedup] second arc with flag off uses the same global signature (DB deduplicates)', async () => {
    const { cwd, cleanup } = makeTempMarsDir(false)
    try {
      getDefaultTaskStoreMock.mockResolvedValue(makeDoneStore('origin-dedup-a'))
      await runArcVerification('origin-dedup-a', { cwd, e2eDeps: skipE2eDeps })

      vi.clearAllMocks()
      getDefaultTaskStoreMock.mockResolvedValue(makeDoneStore('origin-dedup-b'))
      await runArcVerification('origin-dedup-b', { cwd, e2eDeps: skipE2eDeps })

      // Both arcs raised a suggestion, but the signature is the same global one —
      // the action-queue DB deduplicates via the signature, so at most one row exists.
      const suggestions = raiseSpy.mock.calls.filter(
        (c) => (c[0] as RaiseActionQueueItem).signature === 'qa-step-list-capability-suggestion',
      )
      expect(suggestions).toHaveLength(1) // only the second call's batch (clearAllMocks)
      expect(suggestions[0][0].signature).toBe('qa-step-list-capability-suggestion')
    } finally {
      cleanup()
    }
  })
})
