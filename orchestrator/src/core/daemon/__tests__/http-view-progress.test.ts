/**
 * Tests for GET /view/progress — the daemon-side Progress view endpoint.
 *
 * Covers:
 *   - clusterFor: each cluster bucket (all failed tasks always in scope)
 *   - HTTP endpoint: response shape (tasks + proposals forwarded verbatim)
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import type { AppServices } from '../../app-services'
import { stubAppServices, stubChatRunner } from './app-services-stub'
import { loadRecipeCatalog } from '../../lib/recipes'
import {
  clusterFor,
  type ProgressTask,
  type ProposalNode,
} from '../view/progress'
import type { TraceEventStore } from '../../lib/trace-events-store'

let cachedRecipeCatalog: Awaited<
  ReturnType<typeof loadRecipeCatalog>
> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-progress-cat-'))
  cachedRecipeCatalog = await loadRecipeCatalog(tmpDir)
})

const stubTraceStore: TraceEventStore = {
  record: async () => {},
  query: async () => [],
  close: async () => {},
}

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
  restartAllDaemonKilled: async () => [],
  isAcceptingWork: () => true,
  inFlightCount: () => 0,
  selfUpdate: async () => {},

  runReflect: async () => ({ proposalsRaised: 0 }),
  enableAutoReflect: async () => {},
  stepDone: async () => ({ next: null as string | null }),
  snoozeItem: async () => {},
  recipeCatalog: cachedRecipeCatalog as Awaited<
    ReturnType<typeof loadRecipeCatalog>
  >,
  traceStore: stubTraceStore,
  appServices: stubAppServices(appServicesOverrides),
  chatRunner: stubChatRunner(),
})

// ── clusterFor — each cluster bucket ─────────────────────────────────────────

describe('clusterFor', () => {
  describe('Queued cluster', () => {
    it('returns Queued for queued status', () => {
      expect(clusterFor('queued')).toBe('Queued')
    })
  })

  describe('In progress cluster', () => {
    it('returns In progress for running', () => {
      expect(clusterFor('running')).toBe('In progress')
    })

    it('returns In progress for verifying', () => {
      expect(clusterFor('verifying')).toBe('In progress')
    })

    it('returns In progress for merging', () => {
      expect(clusterFor('merging')).toBe('In progress')
    })

    it('returns In progress for vega-reconciling', () => {
      expect(clusterFor('vega-reconciling')).toBe('In progress')
    })
  })

  describe('Blocked cluster', () => {
    it('returns Blocked for blocked status', () => {
      expect(clusterFor('blocked')).toBe('Blocked')
    })
  })

  describe('Failed cluster — always in scope', () => {
    it('returns Failed for a failed task', () => {
      expect(clusterFor('failed')).toBe('Failed')
    })
  })

  describe('Excluded statuses', () => {
    it('returns null for draft', () => {
      expect(clusterFor('draft')).toBeNull()
    })

    it('returns Done for done (completed origin remains visible for arc grouping)', () => {
      expect(clusterFor('done')).toBe('Done')
    })

    it('returns null for dropped', () => {
      expect(clusterFor('dropped')).toBeNull()
    })

    it('returns null for triaging', () => {
      expect(clusterFor('triaging')).toBeNull()
    })
  })
})

// ── GET /view/progress HTTP endpoint ─────────────────────────────────────────

describe('GET /view/progress', () => {
  it('returns 200 and invokes viewProgress', async () => {
    let called = false

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewProgress: async () => {
          called = true
          return { tasks: [], proposals: [], aggregates: { doneToday: 0, doneTotal: 0, failedOpen: 0 } }
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/progress`)
      expect(res.status).toBe(200)
      expect(called).toBe(true)
    } finally {
      await close()
    }
  })

  it('returns tasks and proposals from viewProgress verbatim', async () => {
    const mockTasks: ProgressTask[] = [
      {
        id: 'task-1',
        prompt: 'do the thing',
        intent: null,
        status: 'queued',
        priority: 0,
        cluster: 'Queued',
        plan: null,
        branch: null,
        worktreePath: null,
        error: null,
        failureSignature: null,
        dropReason: null,
        retryCount: 0,
        blockerTaskId: null,
        blockedBy: [],
        parentProposalId: 'prop-1',
        spec: null,
        originId: null,
        fixForTaskId: null,
        kind: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    ]
    const mockProposals: ProposalNode[] = [
      { id: 'prop-1', title: 'My Proposal', source: 'human', status: 'draft' },
    ]

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewProgress: async () => ({
          tasks: mockTasks,
          proposals: mockProposals,
          aggregates: { doneToday: 12, doneTotal: 1422, failedOpen: 2 },
        }),
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/progress`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        tasks: ProgressTask[]
        proposals: ProposalNode[]
        aggregates: { doneToday: number; doneTotal: number; failedOpen: number }
      }
      expect(body.tasks).toHaveLength(1)
      expect(body.tasks[0]!.id).toBe('task-1')
      expect(body.tasks[0]!.priority).toBe(0)
      expect(body.tasks[0]!.cluster).toBe('Queued')
      expect(body.tasks[0]!.parentProposalId).toBe('prop-1')
      expect(body.proposals).toHaveLength(1)
      expect(body.proposals[0]!.id).toBe('prop-1')
      expect(body.aggregates).toEqual({ doneToday: 12, doneTotal: 1422, failedOpen: 2 })
    } finally {
      await close()
    }
  })
})
