/**
 * Tests for GET /view/todo — draft proposals + open stale-worktree alerts.
 *
 * The endpoint is a pure read; deps.viewTodo() is injected so the test
 * exercises the HTTP layer without touching a real database.
 */
import { describe, it, expect } from 'vitest'
import type { HttpServerDeps, DraftFeature, StaleWorktreeAlert } from '../http-server'
import type { FailureReasonCatalog } from '../../lib/failure-reasons'
import type { RecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const nullFailureReasonCatalog: FailureReasonCatalog = {
  get: () => ({ code: 'unknown', userMessage: '', recipe: null, availableActions: [] }),
  list: () => [],
}
const nullRecipeCatalog: RecipeCatalog = {
  get: () => null,
  list: () => [],
}

/** Minimal deps factory — every non-viewTodo dep is a safe no-op. */
const makeDeps = (overrides: Partial<HttpServerDeps> = {}): HttpServerDeps => ({
  restartTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  failureReasonCatalog: nullFailureReasonCatalog,
  recipeCatalog: nullRecipeCatalog,
  traceStore: nullTraceStore,
  viewTasks: async () => ({ tasks: [] }),
  viewProgress: async () => ({ tasks: [], proposals: [] }),
  actionQueueAck: async () => {},
  actionQueueResolve: async () => {},
  actionQueueDismiss: async () => {},
  todoDismiss: async () => {},
  viewActionQueue: async () => [],
  viewTodo: async () => ({ drafts: [], staleWorktrees: [] }),
  viewTerminalEvents: async () => ({ events: [] }),
  viewFrameworkUpdate: async () => ({
    installed: '0.1.0',
    latest: '0.1.0',
    available: false,
    checkedAt: null,
    releaseUrl: null,
  }),
  ...overrides,
})

describe('GET /view/todo', () => {
  it('returns {drafts:[], staleWorktrees:[]} when proposals table does not exist', async () => {
    // proposalsTableExists() === false maps to viewTodo returning empty arrays
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewTodo: async () => ({ drafts: [], staleWorktrees: [] }) }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/todo`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as { drafts: unknown[]; staleWorktrees: unknown[] }
      expect(body.drafts).toEqual([])
      expect(body.staleWorktrees).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns populated drafts and staleWorktrees from viewTodo', async () => {
    const draft: DraftFeature = {
      id: 'prop-1',
      title: 'Add SSO',
      problem: 'Users cannot sign in with Google.',
      solution: 'Integrate OAuth2.',
      status: 'draft',
      source: 'human',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_001_000,
      acceptanceCount: 2,
    }
    const stale: StaleWorktreeAlert = {
      taskId: 'task-abc',
      status: 'queued',
      ageHours: 36,
      updatedAt: '2024-01-15T10:00:00.000Z',
      prompt: 'Implement feature X',
      error: null,
      branch: 'task/task-abc',
      blockerTaskId: null,
    }
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewTodo: async () => ({ drafts: [draft], staleWorktrees: [stale] }) }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/todo`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        drafts: DraftFeature[]
        staleWorktrees: StaleWorktreeAlert[]
      }
      expect(body.drafts).toHaveLength(1)
      expect(body.drafts[0]).toMatchObject({
        id: 'prop-1',
        title: 'Add SSO',
        source: 'human',
        acceptanceCount: 2,
      })
      expect(body.staleWorktrees).toHaveLength(1)
      expect(body.staleWorktrees[0]).toMatchObject({
        taskId: 'task-abc',
        ageHours: 36,
        branch: 'task/task-abc',
      })
    } finally {
      await close()
    }
  })

  it('surfaces errors from viewTodo as 500', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewTodo: async () => {
          throw new Error('db locked')
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/todo`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('db locked')
    } finally {
      await close()
    }
  })
})
