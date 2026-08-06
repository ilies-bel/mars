/**
 * Tests for GET /view/proposals — draft proposals + open stale-worktree alerts.
 *
 * The endpoint is a pure read; deps.viewProposals() is injected so the test
 * exercises the HTTP layer without touching a real database.
 */
import { describe, it, expect } from 'vitest'
import type { HttpServerDeps, DraftFeature, StaleWorktreeAlert } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import type { RecipeCatalog } from '../../lib/recipes'
import { nullTraceStore } from '../../lib/run-tool'

const nullRecipeCatalog: RecipeCatalog = {
  get: () => null,
  list: () => [],
}

/** Minimal deps factory — every non-viewProposals use-case is a safe no-op. */
const makeDeps = (
  appServicesOverrides: Partial<AppServices> = {},
): HttpServerDeps => ({
  restartTask: async () => {},
  remergeTask: async () => {},
  unblockTask: async () => {},
  purgeTask: async () => {},
  pruneWorktree: async () => {},
  dismissProposal: async () => {},
  promoteProposal: async () => {},
  validateTask: async () => {},
  rejectTask: async () => {},
  landWork: async () => {},
  investigateWorktree: async () => ({ explanation: '' }),
  diagnoseFailure: async () => ({ diagnosis: '' }),
  restartDaemon: async () => {},
  continueAllDaemonKilled: async () => ({ continued: [], degraded: [], skipped: [] }),
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},

  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: nullRecipeCatalog,
  traceStore: nullTraceStore,
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

describe('GET /view/proposals', () => {
  it('returns {drafts:[], staleWorktrees:[]} when proposals table does not exist', async () => {
    // proposalsTableExists() === false maps to viewProposals returning empty arrays
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({ viewProposals: async () => ({ drafts: [], staleWorktrees: [] }) }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/proposals`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const body = (await res.json()) as { drafts: unknown[]; staleWorktrees: unknown[] }
      expect(body.drafts).toEqual([])
      expect(body.staleWorktrees).toEqual([])
    } finally {
      await close()
    }
  })

  it('returns populated drafts and staleWorktrees from viewProposals', async () => {
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
      userStories: [],
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
      makeDeps({ viewProposals: async () => ({ drafts: [draft], staleWorktrees: [stale] }) }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/proposals`)
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

  it('surfaces errors from viewProposals as 500', async () => {
    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewProposals: async () => {
          throw new Error('db locked')
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/proposals`)
      expect(res.status).toBe(500)
      const body = (await res.json()) as { ok: boolean; error: string }
      expect(body.ok).toBe(false)
      expect(body.error).toBe('db locked')
    } finally {
      await close()
    }
  })
})
