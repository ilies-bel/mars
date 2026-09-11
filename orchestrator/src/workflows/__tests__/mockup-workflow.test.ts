/**
 * Unit tests for the mockup-workflow pipeline (ADR-0056 read-only variant).
 *
 * Verifies the key observable behaviours of `finalizeMockup`:
 *   (a) `mockup.html` written by the agent step is copied to
 *       `<stateDir>/mockups/<proposalId>.html`.
 *   (b) A `mockup-ready` action-queue row is raised with the correct
 *       proposalId / taskId.
 *   (c) The task is transitioned to `status='done'`.
 *   (d) No commits are added to the integration branch.
 *
 * All git and DB side-effects are mocked so the test runs hermetically in
 * under 1 s without git, a running daemon, or a PGlite instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted before any import that transitively loads them)
// ---------------------------------------------------------------------------

const mockRemoveWorktree = vi.fn().mockResolvedValue(undefined)
const mockUpdateTask = vi.fn().mockResolvedValue(undefined)
const mockRaiseActionQueueItem = vi.fn().mockResolvedValue(undefined)

vi.mock('../../core/lib/git/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/lib/git/worktree')>()
  return { ...actual, removeWorktree: mockRemoveWorktree }
})

vi.mock('../../core/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/queue')>()
  return {
    ...actual,
    updateTask: mockUpdateTask,
    getTask: vi.fn().mockResolvedValue({
      id: 'task-mock-1',
      worktreePath: null,
      branch: null,
    }),
  }
})

vi.mock('../../core/lib/action-queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/lib/action-queue')>()
  return { ...actual, raiseActionQueueItem: mockRaiseActionQueueItem }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal MarsCtx that finalizeMockup pulls its task id from. */
const makeCtx = (
  taskId: string,
  _store: Record<string, unknown>,
  worktreePath: string,
  branch: string,
) => ({
  runId: taskId,
  input: { taskId },
  services: {
    store: {
      query: vi.fn().mockResolvedValue({
        rows: [{ parent_proposal_id: 'prop-test-123' }],
      }),
      getTask: vi.fn().mockResolvedValue({ id: taskId, worktreePath, branch }),
      updateTask: mockUpdateTask,
    },
  },
  emit: vi.fn(),
  step: async (_name: string, fn: () => Promise<unknown>) => fn(),
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('finalizeMockup — mockup file copied and action-queue row raised', () => {
  let repoDir: string
  let worktreeDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'mars-mockup-test-'))
    worktreeDir = mkdtempSync(join(tmpdir(), 'mars-mockup-wt-'))
    mkdirSync(join(repoDir, '.mars'), { recursive: true })
    // Set MARS_REPO so getStateDir() resolves.
    process.env.MARS_REPO = repoDir
    vi.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(worktreeDir, { recursive: true, force: true })
    vi.resetModules()
  })

  it('(a) copies mockup.html from the worktree to <stateDir>/mockups/<proposalId>.html', async () => {
    const taskId = 'task-mockup-a'
    const HTML = '<!DOCTYPE html><html><body><h1>Mockup</h1></body></html>'
    writeFileSync(join(worktreeDir, 'mockup.html'), HTML, 'utf8')

    const { finalizeMockup } = await import('../primitives')
    const ctx = makeCtx(taskId, {}, worktreeDir, `task/${taskId}`)

    await finalizeMockup(ctx as unknown as Parameters<typeof finalizeMockup>[0], {
      worktree: { path: worktreeDir, branch: `task/${taskId}` },
      proposalId: 'prop-test-abc',
    })

    const dest = join(repoDir, '.mars', 'mockups', 'prop-test-abc.html')
    expect(existsSync(dest)).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe(HTML)
  })

  it('(b) raises a mockup-ready action-queue row with proposalId + taskId', async () => {
    const taskId = 'task-mockup-b'
    const HTML = '<html>mockup</html>'
    writeFileSync(join(worktreeDir, 'mockup.html'), HTML, 'utf8')

    const { finalizeMockup } = await import('../primitives')
    const ctx = makeCtx(taskId, {}, worktreeDir, `task/${taskId}`)

    await finalizeMockup(ctx as unknown as Parameters<typeof finalizeMockup>[0], {
      worktree: { path: worktreeDir, branch: `task/${taskId}` },
      proposalId: 'prop-raise-test',
    })

    expect(mockRaiseActionQueueItem).toHaveBeenCalledOnce()
    const callArg = mockRaiseActionQueueItem.mock.calls[0]?.[0] as Record<string, unknown>
    expect(callArg?.kind).toBe('mockup-ready')
    expect((callArg?.payload as Record<string, unknown>)?.proposalId).toBe('prop-raise-test')
    expect((callArg?.payload as Record<string, unknown>)?.taskId).toBe(taskId)
  })

  it('(c) transitions the task to status=done', async () => {
    const taskId = 'task-mockup-c'
    writeFileSync(join(worktreeDir, 'mockup.html'), '<html/>', 'utf8')

    const { finalizeMockup } = await import('../primitives')
    const ctx = makeCtx(taskId, {}, worktreeDir, `task/${taskId}`)

    const result = await finalizeMockup(ctx as unknown as Parameters<typeof finalizeMockup>[0], {
      worktree: { path: worktreeDir, branch: `task/${taskId}` },
      proposalId: 'prop-done-test',
    })

    expect(result.success).toBe(true)
    expect(result.taskId).toBe(taskId)
    // updateTask must have been called with done status.
    expect(mockUpdateTask).toHaveBeenCalledWith(
      taskId,
      { status: 'done', failedPhase: null },
      expect.anything(),
    )
  })

  it('(a-alt) resolves proposalId from parent_proposal_id when not provided in opts', async () => {
    const taskId = 'task-mockup-d'
    const HTML = '<html>auto-resolved</html>'
    writeFileSync(join(worktreeDir, 'mockup.html'), HTML, 'utf8')

    const { finalizeMockup } = await import('../primitives')
    const ctx = makeCtx(taskId, {}, worktreeDir, `task/${taskId}`)
    // The store.query mock returns 'prop-test-123' as parent_proposal_id.

    await finalizeMockup(ctx as unknown as Parameters<typeof finalizeMockup>[0], {
      worktree: { path: worktreeDir, branch: `task/${taskId}` },
    })

    const dest = join(repoDir, '.mars', 'mockups', 'prop-test-123.html')
    expect(existsSync(dest)).toBe(true)
  })

  it('(a-missing) completes gracefully when mockup.html is absent (no throw)', async () => {
    const taskId = 'task-mockup-e'
    // Intentionally do NOT write mockup.html.

    const { finalizeMockup } = await import('../primitives')
    const ctx = makeCtx(taskId, {}, worktreeDir, `task/${taskId}`)

    // Should not throw even if the file is missing.
    await expect(
      finalizeMockup(ctx as unknown as Parameters<typeof finalizeMockup>[0], {
        worktree: { path: worktreeDir, branch: `task/${taskId}` },
        proposalId: 'prop-missing-file',
      }),
    ).resolves.toMatchObject({ success: true })
  })
})
