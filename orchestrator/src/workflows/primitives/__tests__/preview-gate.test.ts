/**
 * Tests for the remote deployment gate wired into the `review` primitive's
 * manual-review path.
 *
 * Coverage:
 *  1. Successful remote deploy  → task_deployments row with status='ready',
 *     action-queue payload includes remoteUrl, WorkflowTerminalError(preview-gate)
 *  2. Failed remote deploy      → task_deployments row with status='failed',
 *     action-queue title carries "remote deploy failed", body carries the error
 *     message, WorkflowTerminalError(preview-gate)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowTerminalError } from '../../../core/lib/workflow-terminal-error'

// ---------------------------------------------------------------------------
// Hoisted mock factories — must be defined before vi.mock() calls.
// ---------------------------------------------------------------------------

const { mockLoadDeployConfig, mockGetProvider, mockRaiseActionQueueItem } = vi.hoisted(() => ({
  mockLoadDeployConfig: vi.fn(),
  mockGetProvider: vi.fn(),
  mockRaiseActionQueueItem: vi.fn().mockResolvedValue('aq-id'),
}))

// Mock loadDeployConfig while preserving the real DeployConfigError class so
// that `instanceof DeployConfigError` checks in production code still work.
vi.mock('../../../core/lib/deployment/config', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/lib/deployment/config')>()
  return { ...original, loadDeployConfig: mockLoadDeployConfig }
})

vi.mock('../../../core/lib/deployment/registry', () => ({
  getProvider: mockGetProvider,
  registerProvider: vi.fn(),
}))

vi.mock('../../../core/lib/action-queue', () => ({
  raiseActionQueueItem: mockRaiseActionQueueItem,
}))

// getStateDir is a singleton backed by process.env.MARS_REPO. Stub it so the
// test does not need a real repo on disk.
vi.mock('../../../core/context', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../core/context')>()
  return { ...original, getStateDir: () => '/fake/state-dir' }
})

// Import the primitive AFTER all vi.mock() calls are registered.
const { review } = await import('../index')

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** Fake worktree passed via opts.worktree to bypass resolveWorktree(). */
const fakeWorktree = { path: '/fake/worktree', branch: 'task/test-task-id' }

/** Deploy config returned by the mocked loadDeployConfig. */
const fakeDeployConfig = { provider: 'fake-provider', env: {} as Record<string, string> }

/** Minimal TaskStore stub extended with deployment methods. */
const makeDeployStore = () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
  batch: vi.fn().mockResolvedValue([]),
  writeDeployment: vi.fn().mockResolvedValue({
    deploymentId: 'dep-abc',
    taskId: 'test-task-id',
    provider: 'fake-provider',
    url: 'https://preview.example.com',
    status: 'ready',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
  updateDeploymentStatus: vi.fn().mockResolvedValue(undefined),
})

/** Minimal MarsCtx stub for preview-gate tests. */
const makeCtx = (store = makeDeployStore()) => ({
  runId: 'test-task-id',
  workflowId: 'task',
  input: { taskId: 'test-task-id', spec: { previewCmd: 'npm run dev' } },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  signal: new AbortController().signal,
  services: { store, traceStore: null },
  currentStep: {
    name: 'preview',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    signal: new AbortController().signal,
    setSha: vi.fn(),
    setTranscriptKey: vi.fn(),
    setSummary: vi.fn(),
  },
  emit: vi.fn(),
  step: vi.fn(),
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('review preview-gate — remote deployment', () => {
  /** Injected fake provider — deploy() return value / rejection is set per suite. */
  const fakeProvider = {
    deploy: vi.fn(),
    status: vi.fn(),
    logs: vi.fn(),
    teardown: vi.fn(),
  }

  beforeEach(() => {
    mockLoadDeployConfig.mockReset()
    mockGetProvider.mockReset()
    mockRaiseActionQueueItem.mockReset()
    mockRaiseActionQueueItem.mockResolvedValue('aq-id')
    fakeProvider.deploy.mockReset()
    // Default: every providerRegistry.get() returns the fake provider.
    mockGetProvider.mockReturnValue(fakeProvider)
  })

  // ── Successful deploy ────────────────────────────────────────────────────

  describe('successful remote deploy', () => {
    beforeEach(() => {
      mockLoadDeployConfig.mockResolvedValue(fakeDeployConfig)
      fakeProvider.deploy.mockResolvedValue({
        deploymentId: 'dep-123',
        url: 'https://preview.example.com',
        status: 'pending',
      })
    })

    it('throws WorkflowTerminalError with kind=preview-gate', async () => {
      const ctx = makeCtx()
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof WorkflowTerminalError && err.kind === 'preview-gate',
      )
    })

    it('task remains parked — WorkflowTerminalError is always thrown on success', async () => {
      const ctx = makeCtx()
      // WorkflowTerminalError must be thrown regardless; the task must not
      // silently merge (the error is the parking signal for the daemon).
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
    })

    it('writes a task_deployments row with status=ready and the deploy url', async () => {
      const store = makeDeployStore()
      const ctx = makeCtx(store)
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
      expect(store.writeDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'test-task-id',
          status: 'ready',
          url: 'https://preview.example.com',
        }),
      )
    })

    it('raises an action-queue item with remoteUrl in the payload', async () => {
      const ctx = makeCtx()
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
      expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ remoteUrl: 'https://preview.example.com' }),
        }),
      )
    })

    it('resolves provider via providerRegistry.get(config.provider)', async () => {
      const ctx = makeCtx()
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
      expect(mockGetProvider).toHaveBeenCalledWith(fakeDeployConfig.provider)
    })
  })

  // ── Failed deploy ────────────────────────────────────────────────────────

  describe('failed remote deploy', () => {
    const providerError = new Error('provider quota exceeded')

    beforeEach(() => {
      mockLoadDeployConfig.mockResolvedValue(fakeDeployConfig)
      fakeProvider.deploy.mockRejectedValue(providerError)
    })

    it('throws WorkflowTerminalError with kind=preview-gate', async () => {
      const ctx = makeCtx()
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toSatisfy(
        (err: unknown) => err instanceof WorkflowTerminalError && err.kind === 'preview-gate',
      )
    })

    it('task remains parked — WorkflowTerminalError is always thrown on failure', async () => {
      const ctx = makeCtx()
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
    })

    it('writes a task_deployments row with status=failed', async () => {
      const store = makeDeployStore()
      const ctx = makeCtx(store)
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
      expect(store.writeDeployment).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'test-task-id',
          status: 'failed',
        }),
      )
    })

    it('persists error detail via updateDeploymentStatus', async () => {
      const store = makeDeployStore()
      const ctx = makeCtx(store)
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
      expect(store.updateDeploymentStatus).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 'failed', error: expect.stringContaining('quota exceeded') }),
      )
    })

    it('raises action-queue item titled "Validate <id>: remote deploy failed"', async () => {
      const ctx = makeCtx()
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
      expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Validate test-task-id: remote deploy failed',
        }),
      )
    })

    it('includes the provider error message in the action-queue item body', async () => {
      const ctx = makeCtx()
      await expect(
        review(ctx as never, { reviewType: 'manual', worktree: fakeWorktree }),
      ).rejects.toBeInstanceOf(WorkflowTerminalError)
      expect(mockRaiseActionQueueItem).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining('provider quota exceeded'),
        }),
      )
    })
  })
})
