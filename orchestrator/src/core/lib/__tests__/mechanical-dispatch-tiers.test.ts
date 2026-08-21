/**
 * Mechanical-dispatch-tier contract tests.
 *
 * Observable behaviour under test:
 *   Each mechanical dispatch site — commit-correction, failure-reflector,
 *   reflector, deep-reflector arc, deep-reflector session — must dispatch at
 *   the fast tier. Sites that still call the provider directly assert
 *   `modelTier: 'fast'` on the call; sites routed through the Worker layer
 *   (commit-correction, reflector) assert the dispatched Worker's pinned tier.
 *
 * runHeadlessProvider and runWorkerWithSpan are spied at the dispatch seam.
 * No real provider process is started.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { ReflectCorpus } from '../reflect-query'
import type { DeepReflectArc, SessionArcsResult } from '../deep-reflect-query'

// ── Hoisted mock functions ────────────────────────────────────────────────────

const {
  mockRunHeadlessProvider,
  mockRunWorkerWithSpan,
  mockUpdateTask,
  mockHandleTaskFailureWithFixTask,
  mockResolveOriginIdForTask,
  mockCleanWorktreeIfNoCommitsAhead,
  mockFetchLessonsForTask,
  mockListMergedWorkers,
  mockRecordSignals,
  mockRaiseActionQueueItem,
  mockSyncWorktreeToIntegration,
  mockRecordFailureReflectionOccurrence,
} = vi.hoisted(() => ({
  mockRunHeadlessProvider: vi.fn(),
  mockRunWorkerWithSpan: vi.fn(),
  mockUpdateTask: vi.fn().mockResolvedValue(undefined),
  mockHandleTaskFailureWithFixTask: vi.fn().mockResolvedValue({ outcome: 'fix-task-spawned' }),
  mockResolveOriginIdForTask: vi.fn().mockImplementation(async (id: string) => id),
  mockCleanWorktreeIfNoCommitsAhead: vi
    .fn()
    .mockResolvedValue({ cleaned: false, reason: 'skipped for test', output: '' }),
  mockFetchLessonsForTask: vi.fn().mockResolvedValue([]),
  mockListMergedWorkers: vi.fn().mockReturnValue([]),
  mockRecordSignals: vi.fn().mockResolvedValue(undefined),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue(undefined),
  mockSyncWorktreeToIntegration: vi.fn().mockResolvedValue({ kind: 'already-current' }),
  mockRecordFailureReflectionOccurrence: vi.fn().mockResolvedValue(true),
}))

// ── Module-level mocks ────────────────────────────────────────────────────────

// Provider boundary — intercepted for reflector, deep-reflector, failure-reflector.
// Preserve all other exports so modules that import resolveProviderName etc. still work.
vi.mock('../../workers/providers', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../workers/providers')>()
  return { ...orig, runHeadlessProvider: mockRunHeadlessProvider }
})

// Worker boundary — intercepted for commit-correction and the reflector
vi.mock('../run-worker-with-span', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../run-worker-with-span')>()
  return { ...orig, runWorkerWithSpan: mockRunWorkerWithSpan }
})

// The reflector opens a trace store for its span; keep that off the real DB so
// the tier assertion does not pay a PGlite cold start.
vi.mock('../trace-events-store', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../trace-events-store')>()
  return { ...orig, openTraceEventStore: vi.fn().mockResolvedValue(undefined) }
})

// Proposals — bypass DB for failure-reflector admission control
vi.mock('../../proposals', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../proposals')>()
  return {
    ...orig,
    recordFailureReflectionOccurrence: mockRecordFailureReflectionOccurrence,
    createProposal: vi.fn().mockResolvedValue('test-proposal-id'),
    addProposalUserStory: vi.fn().mockResolvedValue(undefined),
    initProposals: vi.fn().mockResolvedValue(undefined),
  }
})

// runAgent dependencies
vi.mock('../git/worktree', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../git/worktree')>()
  return { ...orig, syncWorktreeToIntegration: mockSyncWorktreeToIntegration }
})

vi.mock('../../queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../queue')>()
  return { ...orig, updateTask: mockUpdateTask }
})

vi.mock('../../queue-fix-tasks', () => ({
  handleTaskFailureWithFixTask: mockHandleTaskFailureWithFixTask,
}))

vi.mock('../origin', () => ({
  resolveOriginIdForTask: mockResolveOriginIdForTask,
}))

vi.mock('../git/verify', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../git/verify')>()
  return { ...orig, cleanWorktreeIfNoCommitsAhead: mockCleanWorktreeIfNoCommitsAhead }
})

vi.mock('../../store/memory-packet-store', () => ({
  resolveTaskDomains: vi.fn().mockReturnValue([]),
  fetchLessonsForTask: mockFetchLessonsForTask,
}))

vi.mock('../../workers/persisted-registry', () => ({
  listMergedWorkers: mockListMergedWorkers,
}))

vi.mock('../reflect-signals', () => ({
  recordSignals: mockRecordSignals,
  isReflectDisabled: vi.fn().mockReturnValue(false),
}))

vi.mock('../action-queue', () => ({
  raiseActionQueueItem: mockRaiseActionQueueItem,
}))

// ── Shared fixtures ───────────────────────────────────────────────────────────

/** Minimal RunAgentResult returned by mocked provider calls. */
const makeProviderResult = () => ({
  stdout: '',
  stderr: '',
  conversation: [] as Array<{ type: string; [k: string]: unknown }>,
  exitCode: 0,
  sessionId: null as string | null,
  quotaRejected: null as { resetsAt: number } | null,
})

/** Minimal RunAgentResult for coder (runWorkerWithSpan) calls. */
const makeCoderResult = () => ({
  ...makeProviderResult(),
  sessionId: 'sess-test',
})

const EMPTY_COST_SUMMARY = {
  totalWeightedTokens: 0,
  taskCount: 1,
  successCount: 1,
  failureCount: 0,
  baselineCaughtCount: 0,
  blockedCount: 0,
  droppedCount: 0,
  cacheHitRatio: 0,
  rateLimitRejections: 0,
  topTokenHeavyTasks: [] as ReadonlyArray<{
    taskId: string
    status: string
    weightedTokens: number
    timesMedian: number
  }>,
  topExpensiveSteps: [] as ReadonlyArray<{
    taskId: string
    stepId: string
    weightedTokens: number
    inputTokens: number
    outputTokens: number
    cacheCreateTokens: number
    cacheReadTokens: number
  }>,
  tokensByStep: [] as ReadonlyArray<{
    stepId: string
    totalWeightedTokens: number
    invocations: number
    avgWeightedTokens: number
  }>,
}

const ONE_ENTRY_CORPUS: ReflectCorpus = {
  entries: [
    {
      taskId: 'fixture-1',
      status: 'done',
      promptPrefix: 'do the thing',
      errorTail: null,
      createdAt: '2026-05-01T00:00:00Z',
      failureSignature: null,
      failureReasonCode: null,
      failedPhase: null,
      kind: null,
      fixForTaskId: null,
      originId: null,
      toolErrorCount: 0,
      topErrorTool: null,
      baselineCaught: false,
      signals: [],
      scorerResults: [],
      totals: {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        cacheHitRatio: 0,
      },
    },
  ],
  costSummary: EMPTY_COST_SUMMARY,
}

const MINIMAL_ARC: DeepReflectArc = {
  originId: 'test-origin',
  tasks: [],
  statusMix: {},
  taskCount: 0,
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalWeightedTokens: 0,
    cacheHitRatio: 0,
    eventCount: 0,
  },
  lastActivity: '2026-01-01T00:00:00Z',
  stepTimeline: [],
  toolInvokedErrors: [],
  operatorContext: null,
}

const MINIMAL_SESSION_RESULT: SessionArcsResult = {
  sessionId: 'test-session-id',
  originIds: [],
  arcs: [],
  stepRuns: [],
}

// ── Shared repo setup ─────────────────────────────────────────────────────────

let baseRepo: string

beforeAll(() => {
  // A bare temp directory is enough for reflector/failure-reflector/deep-reflector tests
  // (they only need getRepoRoot() to return a valid path for the mocked provider call).
  baseRepo = mkdtempSync(resolve(tmpdir(), 'mars-mech-tier-base-'))
  mkdirSync(resolve(baseRepo, '.mars'), { recursive: true })
  process.env.MARS_REPO = baseRepo
})

afterAll(async () => {
  delete process.env.MARS_REPO
  const { __resetContextCacheForTests } = await import('../../context')
  __resetContextCacheForTests()
  rmSync(baseRepo, { recursive: true, force: true })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('failure-reflector dispatch tier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunHeadlessProvider.mockResolvedValue(makeProviderResult())
    mockRecordFailureReflectionOccurrence.mockResolvedValue(true)
  })

  it('reaches runHeadlessProvider with modelTier fast', async () => {
    const { spawnFailureReflector } = await import('../failure-reflector')
    await spawnFailureReflector({
      taskId: 'test-task-fr',
      lastStep: 'verify:test-failed',
      lastErrorSignature: 'verify:test-failed:typecheck',
      recoverySpawnedCount: 1,
      worktreePath: null,
      branch: null,
    })

    expect(mockRunHeadlessProvider).toHaveBeenCalledOnce()
    expect(mockRunHeadlessProvider.mock.calls[0]![1]).toMatchObject({ modelTier: 'fast' })
  })
})

describe('reflector dispatch tier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunWorkerWithSpan.mockResolvedValue(makeProviderResult())
  })

  // The reflector dispatches through the Worker layer, so its tier comes from
  // the pinned `Reflector` Worker rather than a per-call `modelTier` argument.
  it('reaches runWorkerWithSpan on the fast-tier Reflector Worker', async () => {
    const { runReflector } = await import('../reflector')
    await runReflector(ONE_ENTRY_CORPUS)

    expect(mockRunWorkerWithSpan).toHaveBeenCalledOnce()
    const dispatch = mockRunWorkerWithSpan.mock.calls[0]![0] as {
      worker: { config: { name: string; modelTier?: string } }
      stepName: string
    }
    expect(dispatch.stepName).toBe('reflect')
    expect(dispatch.worker.config.name).toBe('Reflector')
    expect(dispatch.worker.config.modelTier).toBe('fast')
  })
})

describe('deep-reflector arc dispatch tier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunHeadlessProvider.mockResolvedValue(makeProviderResult())
  })

  it('reaches runHeadlessProvider with modelTier fast', async () => {
    const { runDeepReflectorArc } = await import('../deep-reflector')
    await runDeepReflectorArc(MINIMAL_ARC, 5_000)

    expect(mockRunHeadlessProvider).toHaveBeenCalledOnce()
    expect(mockRunHeadlessProvider.mock.calls[0]![1]).toMatchObject({ modelTier: 'fast' })
  })
})

describe('deep-reflector session dispatch tier', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunHeadlessProvider.mockResolvedValue(makeProviderResult())
  })

  it('reaches runHeadlessProvider with modelTier fast', async () => {
    const { runSessionReflector } = await import('../deep-reflector')
    await runSessionReflector(MINIMAL_SESSION_RESULT, 5_000)

    expect(mockRunHeadlessProvider).toHaveBeenCalledOnce()
    expect(mockRunHeadlessProvider.mock.calls[0]![1]).toMatchObject({ modelTier: 'fast' })
  })
})

describe('commit-correction dispatch tier', () => {
  let gitRepo: string

  beforeEach(async () => {
    // Build a real git repo so detectPostCoderState can inspect it.
    gitRepo = mkdtempSync(resolve(tmpdir(), 'mars-mech-tier-git-'))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRepo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: gitRepo })
    writeFileSync(resolve(gitRepo, 'README'), 'hello\n')
    execFileSync('git', ['add', 'README'], { cwd: gitRepo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: gitRepo })
    execFileSync('git', ['checkout', '-q', '-b', 'task/test-task', 'main'], { cwd: gitRepo })

    // Point MARS_REPO at the git repo and flush the cached context.
    process.env.MARS_REPO = gitRepo
    const { __resetContextCacheForTests } = await import('../../context')
    __resetContextCacheForTests()

    vi.clearAllMocks()
    // Default: every runWorkerWithSpan call succeeds without committing.
    mockRunWorkerWithSpan.mockResolvedValue(makeCoderResult())
    mockUpdateTask.mockResolvedValue(undefined)
    mockHandleTaskFailureWithFixTask.mockResolvedValue({ outcome: 'fix-task-spawned' })
    mockResolveOriginIdForTask.mockImplementation(async (id: string) => id)
    mockCleanWorktreeIfNoCommitsAhead.mockResolvedValue({ cleaned: false, reason: 'test', output: '' })
    mockFetchLessonsForTask.mockResolvedValue([])
    mockListMergedWorkers.mockReturnValue([])
    mockRecordSignals.mockResolvedValue(undefined)
    mockRaiseActionQueueItem.mockResolvedValue(undefined)
    mockSyncWorktreeToIntegration.mockResolvedValue({ kind: 'already-current' })
  })

  afterEach(async () => {
    // Restore MARS_REPO to the base repo and reset context cache.
    process.env.MARS_REPO = baseRepo
    const { __resetContextCacheForTests } = await import('../../context')
    __resetContextCacheForTests()
    rmSync(gitRepo, { recursive: true, force: true })
  })

  it('reaches runWorkerWithSpan with modelTier fast on the commit-correction turn', async () => {
    // Leave an uncommitted file — this triggers the commit-correction turn.
    writeFileSync(resolve(gitRepo, 'feature.ts'), 'export const x = 1\n')

    const { runAgent } = await import('../../../workflows/primitives/index')
    await runAgent(
      {
        runId: 'test-task',
        workflowId: 'task',
        input: {
          taskId: 'test-task',
          kind: 'task',
          prompt: 'implement it',
          tags: ['coder'],
        },
        logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
        signal: new AbortController().signal,
        services: {
          store: {
            getTask: vi.fn().mockResolvedValue(null),
            query: vi.fn().mockResolvedValue({ rows: [] }),
            execute: vi.fn().mockResolvedValue({ rows: [] }),
            batch: vi.fn().mockResolvedValue([]),
          },
          traceStore: null,
          onPid: vi.fn(),
        },
        currentStep: null,
        emit: vi.fn(),
        step: vi.fn(),
      } as never,
      { worktree: { path: gitRepo, branch: 'task/test-task' } },
    )

    // runWorkerWithSpan must have been called at least twice:
    //   call[0] — primary coder run
    //   call[1] — commit-correction turn
    expect(mockRunWorkerWithSpan.mock.calls.length).toBeGreaterThanOrEqual(2)

    const correctionCall = mockRunWorkerWithSpan.mock.calls.find(
      (args) => (args[0] as { stepName?: string }).stepName === 'commit-correction',
    )
    expect(correctionCall).toBeDefined()
    expect(correctionCall![0]).toMatchObject({ stepName: 'commit-correction', modelTier: 'fast' })
  })
})
