/**
 * Unit tests for the human-in-the-loop preview gate inside `merge()`.
 *
 * Defect fixed (mars-560687df):
 *   When `startDevServer` failed/threw, the code never reached
 *   `raiseActionQueueItem`, so the task entered `awaiting-validation` with
 *   NO open action-queue row — silently stranding it.
 *
 * Fix: `startDevServer` is now wrapped in try-catch. On failure, `merge()`
 *   still parks the task as `awaiting-validation` and raises a row with title
 *   "preview failed to boot", then throws the `WorkflowTerminalError`
 *   sentinel exactly as the happy path does.
 *
 * Coverage:
 *   1. Happy path: server starts → row title carries the preview URL.
 *   2. Failure path: server fails → row title says "preview failed to boot".
 *   3. Signature: both paths use the same `${taskId}:awaiting-validation` key
 *      (idempotent raises / dedup require a stable signature).
 *   4. Gate skip: when `previewValidated=true` the gate is bypassed entirely —
 *      `startDevServer` is never called.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __resetContextCacheForTests } from '../../../core/context'

// ---------------------------------------------------------------------------
// Hoisted mocks — accessible inside vi.mock() factories AND in test bodies.
// ---------------------------------------------------------------------------

const { mockStartDevServer, mockRaiseActionQueueItem, mockUpdateTask, mockGetTask } =
  vi.hoisted(() => ({
    mockStartDevServer: vi.fn(),
    mockRaiseActionQueueItem: vi.fn().mockResolvedValue('aq-item-id'),
    mockUpdateTask: vi.fn().mockResolvedValue(undefined),
    mockGetTask: vi.fn(),
  }))

// ---------------------------------------------------------------------------
// Module mocks — registered before any import of the module under test.
// ---------------------------------------------------------------------------

vi.mock('../../../core/queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/queue')>()
  return { ...orig, updateTask: mockUpdateTask, getTask: mockGetTask }
})

vi.mock('../../../core/lib/action-queue', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/action-queue')>()
  return { ...orig, raiseActionQueueItem: mockRaiseActionQueueItem }
})

vi.mock('../../../core/lib/dev-server', () => ({
  startDevServer: mockStartDevServer,
  killDevServer: vi.fn().mockResolvedValue(undefined),
  isDevServerAlive: vi.fn().mockReturnValue(false),
  allocatePort: vi.fn().mockResolvedValue(4242),
}))

vi.mock('../../../core/context', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/context')>()
  return {
    ...orig,
    resolveContext: () => ({
      repoRoot: '/tmp/test-repo',
      stateDir: '/tmp/test-repo/.mars',
      supervisorsManifest: [],
    }),
    getStateDir: () => '/tmp/test-repo/.mars',
    getRepoRoot: () => '/tmp/test-repo',
  }
})

vi.mock('../../../core/lib/origin', () => ({
  resolveOriginIdForTask: async (id: string) => id,
  Arc: { load: () => ({ originId: null }) },
}))

// Stub out the span wrapper so merge() can complete without a real trace store.
vi.mock('../../../core/lib/run-worker-with-span', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../core/lib/run-worker-with-span')>()
  return {
    ...orig,
    runNonLlmStepWithSpan: async <T>(opts: { fn: () => Promise<T> }) => opts.fn(),
  }
})

// ---------------------------------------------------------------------------
// Import the module under test AFTER vi.mock() calls are hoisted.
// ---------------------------------------------------------------------------

const { merge } = await import('../index')
const { WorkflowTerminalError } = await import('../../../core/lib/workflow-terminal-error')

// ---------------------------------------------------------------------------
// Sandbox + shared setup
// ---------------------------------------------------------------------------

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mars-preview-gate-test-'))
})

afterAll(() => {
  delete process.env.MARS_REPO
  __resetContextCacheForTests()
})

beforeEach(() => {
  process.env.MARS_REPO = tmpDir
  __resetContextCacheForTests()
  vi.clearAllMocks()
  // Default: raiseActionQueueItem resolves without error.
  mockRaiseActionQueueItem.mockResolvedValue('aq-item-id')
})

/**
 * Minimal MarsCtx stub. Passes `opts.worktree` to `merge()` to bypass
 * `resolveWorktree`'s fallback (which would try to read from the task store).
 */
const makeCtx = (taskId: string) =>
  ({
    runId: taskId,
    workflowId: 'task',
    input: { taskId, kind: 'task', integrationBranch: 'main' },
    logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
    signal: new AbortController().signal,
    services: {
      store: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
        batch: vi.fn().mockResolvedValue([]),
        atomic: vi.fn().mockResolvedValue(undefined),
      },
      traceStore: null,
    },
    currentStep: null,
    emit: vi.fn(),
    step: vi.fn(),
  }) as never

/** A minimal task row with a preview command and previewValidated=false. */
const makeTaskWithPreview = (
  taskId: string,
  overrides: { previewValidated?: boolean } = {},
) => ({
  id: taskId,
  status: 'queued',
  prompt: 'test task',
  error: null,
  worktreePath: `/tmp/test-wt-${taskId}`,
  branch: `task/${taskId}`,
  previewValidated: false,
  spec: {
    previewCmd: 'npm run dev',
    files: [],
    verifyCmd: null,
    doneCriteria: [],
    taskType: 'auto',
  },
  ...overrides,
})

const worktreeOpts = (taskId: string) => ({
  worktree: { path: `/tmp/test-wt-${taskId}`, branch: `task/${taskId}` },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('preview gate — happy path (server boots)', () => {
  it('raises awaiting-validation row with the preview URL in the title', async () => {
    const taskId = 'task-preview-ok'
    mockGetTask.mockResolvedValue(makeTaskWithPreview(taskId))
    mockStartDevServer.mockResolvedValue({
      url: 'http://127.0.0.1:3456',
      pid: 42,
      logPath: '/tmp/dev.log',
      port: 3456,
    })

    await expect(
      merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toMatchObject({ kind: 'preview-gate' })

    expect(mockRaiseActionQueueItem).toHaveBeenCalledOnce()
    const [raised] = mockRaiseActionQueueItem.mock.calls[0]
    expect(raised.kind).toBe('awaiting-validation')
    expect(raised.title).toContain('http://127.0.0.1:3456')
    expect(raised.title).toContain(taskId)
    expect(raised.payload.devServerUrl).toBe('http://127.0.0.1:3456')
  })
})

describe('preview gate — failure path (server fails to boot)', () => {
  it('raises awaiting-validation row saying "preview failed to boot"', async () => {
    const taskId = 'task-preview-fail'
    mockGetTask.mockResolvedValue(makeTaskWithPreview(taskId))
    mockStartDevServer.mockRejectedValue(new Error('ENOENT: stale pid file'))

    await expect(
      merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toMatchObject({ kind: 'preview-gate' })

    expect(mockRaiseActionQueueItem).toHaveBeenCalledOnce()
    const [raised] = mockRaiseActionQueueItem.mock.calls[0]
    expect(raised.kind).toBe('awaiting-validation')
    expect(raised.title).toMatch(/preview failed to boot/i)
    expect(raised.title).toContain(taskId)
    expect(raised.payload.devServerUrl).toBeNull()
  })

  it('raised row uses the same signature as the happy-path row', async () => {
    const taskId = 'task-sig-check'
    mockGetTask.mockResolvedValue(makeTaskWithPreview(taskId))
    mockStartDevServer.mockRejectedValue(new Error('boot failed'))

    await expect(
      merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) }),
    ).rejects.toMatchObject({ kind: 'preview-gate' })

    const [raised] = mockRaiseActionQueueItem.mock.calls[0]
    // Both paths must use the same signature so level-triggered dedup works.
    expect(raised.signature).toBe(`${taskId}:awaiting-validation`)
    expect(raised.originTaskId).toBe(taskId)
  })
})

describe('preview gate — gate skip (already validated)', () => {
  it('does not raise a row or start dev server when previewValidated is true', async () => {
    const taskId = 'task-already-validated'
    mockGetTask.mockResolvedValue(makeTaskWithPreview(taskId, { previewValidated: true }))
    // startDevServer should never be called; configure it to help detect if it is.
    mockStartDevServer.mockRejectedValue(new Error('should not be called'))

    // The gate is skipped. merge() continues to git operations which will fail
    // because there is no real repo. Catch and ignore — we only care that the
    // gate did NOT run.
    await merge(makeCtx(taskId), { kind: 'task', ...worktreeOpts(taskId) }).catch(
      () => undefined,
    )

    expect(mockStartDevServer).not.toHaveBeenCalled()
    const awaitingValidationCalls = mockRaiseActionQueueItem.mock.calls.filter(
      ([arg]) => arg?.kind === 'awaiting-validation',
    )
    expect(awaitingValidationCalls).toHaveLength(0)
  })
})
