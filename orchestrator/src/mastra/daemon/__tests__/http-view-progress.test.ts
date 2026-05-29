/**
 * Tests for GET /view/progress — the daemon-side Progress view endpoint.
 *
 * Covers:
 *   - clusterFor: each cluster bucket and the failedWindow filter
 *   - HTTP endpoint: failedWindow param parsing (default 24h, "all", numeric)
 *   - HTTP endpoint: response shape (tasks + proposals forwarded verbatim)
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { HttpServerDeps } from '../http-server'
import { loadFailureReasonCatalog } from '../../lib/failure-reasons'
import { loadRecipeCatalog } from '../../lib/recipes'
import {
  clusterFor,
  type ProgressTask,
  type ProposalNode,
} from '../view/progress'
import type { TraceEventStore } from '../../lib/trace-events-store'

let cachedCatalog: Awaited<ReturnType<typeof loadFailureReasonCatalog>> | null =
  null
let cachedRecipeCatalog: Awaited<
  ReturnType<typeof loadRecipeCatalog>
> | null = null

beforeAll(async () => {
  const tmpDir = mkdtempSync(resolve(tmpdir(), 'mars-http-progress-cat-'))
  cachedCatalog = await loadFailureReasonCatalog(tmpDir)
  cachedRecipeCatalog = await loadRecipeCatalog(tmpDir)
})

const stubTraceStore: TraceEventStore = {
  record: async () => {},
  query: async () => [],
  close: async () => {},
}

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
  failureReasonCatalog: cachedCatalog as Awaited<
    ReturnType<typeof loadFailureReasonCatalog>
  >,
  recipeCatalog: cachedRecipeCatalog as Awaited<
    ReturnType<typeof loadRecipeCatalog>
  >,
  traceStore: stubTraceStore,
  viewTasks: async () => ({ tasks: [] }),
  viewProgress: async () => ({ tasks: [], proposals: [] }),
  inboxAck: async () => {},
  inboxResolve: async () => {},
  inboxDismiss: async () => {},
  todoDismiss: async () => {},
  viewInbox: async () => [],
  viewTodo: async () => ({ drafts: [], staleWorktrees: [] }),
  ...overrides,
})

// ── clusterFor — each cluster bucket and failedWindow filter ─────────────────

describe('clusterFor', () => {
  const NOW = new Date('2024-06-15T12:00:00.000Z').getTime()
  const DEFAULT_WINDOW = 24 * 60 * 60 * 1000

  describe('Queued cluster', () => {
    it('returns Queued for queued status', () => {
      expect(clusterFor('queued', '', NOW, DEFAULT_WINDOW)).toBe('Queued')
    })
  })

  describe('In progress cluster', () => {
    it('returns In progress for running', () => {
      expect(clusterFor('running', '', NOW, DEFAULT_WINDOW)).toBe('In progress')
    })

    it('returns In progress for verifying', () => {
      expect(clusterFor('verifying', '', NOW, DEFAULT_WINDOW)).toBe('In progress')
    })

    it('returns In progress for merging', () => {
      expect(clusterFor('merging', '', NOW, DEFAULT_WINDOW)).toBe('In progress')
    })

    it('returns In progress for vega-reconciling', () => {
      expect(clusterFor('vega-reconciling', '', NOW, DEFAULT_WINDOW)).toBe(
        'In progress',
      )
    })
  })

  describe('Blocked cluster', () => {
    it('returns Blocked for blocked status', () => {
      expect(clusterFor('blocked', '', NOW, DEFAULT_WINDOW)).toBe('Blocked')
    })
  })

  describe('Failed cluster + failedWindow filter', () => {
    it('returns Failed for a recently failed task within the window', () => {
      const recentUpdatedAt = new Date(NOW - 60_000).toISOString() // 1 min ago
      expect(clusterFor('failed', recentUpdatedAt, NOW, DEFAULT_WINDOW)).toBe(
        'Failed',
      )
    })

    it('returns null for a failed task outside the window', () => {
      const oldUpdatedAt = new Date(NOW - 48 * 60 * 60 * 1000).toISOString() // 48h ago
      expect(clusterFor('failed', oldUpdatedAt, NOW, DEFAULT_WINDOW)).toBeNull()
    })

    it('returns Failed for any failed task when windowMs is null (all mode)', () => {
      const veryOldUpdatedAt = new Date(
        NOW - 30 * 24 * 60 * 60 * 1000,
      ).toISOString() // 30 days ago
      expect(clusterFor('failed', veryOldUpdatedAt, NOW, null)).toBe('Failed')
    })

    it('treats a non-parseable updatedAt as always within window (safe fallback)', () => {
      expect(clusterFor('failed', 'not-a-date', NOW, DEFAULT_WINDOW)).toBe(
        'Failed',
      )
    })
  })

  describe('Excluded statuses', () => {
    it('returns null for draft', () => {
      expect(clusterFor('draft', '', NOW, DEFAULT_WINDOW)).toBeNull()
    })

    it('returns null for done', () => {
      expect(clusterFor('done', '', NOW, DEFAULT_WINDOW)).toBeNull()
    })

    it('returns null for dropped', () => {
      expect(clusterFor('dropped', '', NOW, DEFAULT_WINDOW)).toBeNull()
    })

    it('returns null for triaging', () => {
      expect(clusterFor('triaging', '', NOW, DEFAULT_WINDOW)).toBeNull()
    })
  })
})

// ── GET /view/progress HTTP endpoint ─────────────────────────────────────────

describe('GET /view/progress', () => {
  it('uses default 24h failedWindowMs when no param is supplied', async () => {
    let captured: number | null | undefined

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewProgress: async ({ failedWindowMs }) => {
          captured = failedWindowMs
          return { tasks: [], proposals: [] }
        },
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/progress`)
      expect(res.status).toBe(200)
      expect(captured).toBe(24 * 60 * 60 * 1000)
    } finally {
      await close()
    }
  })

  it('passes null when failedWindow=all', async () => {
    let captured: number | null | undefined

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewProgress: async ({ failedWindowMs }) => {
          captured = failedWindowMs
          return { tasks: [], proposals: [] }
        },
      }),
    )
    try {
      await fetch(`http://127.0.0.1:${port}/view/progress?failedWindow=all`)
      expect(captured).toBeNull()
    } finally {
      await close()
    }
  })

  it('passes a parsed number when failedWindow=<ms>', async () => {
    let captured: number | null | undefined

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewProgress: async ({ failedWindowMs }) => {
          captured = failedWindowMs
          return { tasks: [], proposals: [] }
        },
      }),
    )
    try {
      await fetch(
        `http://127.0.0.1:${port}/view/progress?failedWindow=3600000`,
      )
      expect(captured).toBe(3_600_000)
    } finally {
      await close()
    }
  })

  it('falls back to default when failedWindow value is invalid', async () => {
    let captured: number | null | undefined

    const { startHttpServer } = await import('../http-server')
    const { port, close } = await startHttpServer(
      makeDeps({
        viewProgress: async ({ failedWindowMs }) => {
          captured = failedWindowMs
          return { tasks: [], proposals: [] }
        },
      }),
    )
    try {
      await fetch(
        `http://127.0.0.1:${port}/view/progress?failedWindow=notanumber`,
      )
      expect(captured).toBe(24 * 60 * 60 * 1000)
    } finally {
      await close()
    }
  })

  it('returns tasks and proposals from viewProgress verbatim', async () => {
    const mockTasks: ProgressTask[] = [
      {
        id: 'task-1',
        prompt: 'do the thing',
        status: 'queued',
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
        }),
      }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${port}/view/progress`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        tasks: ProgressTask[]
        proposals: ProposalNode[]
      }
      expect(body.tasks).toHaveLength(1)
      expect(body.tasks[0]!.id).toBe('task-1')
      expect(body.tasks[0]!.cluster).toBe('Queued')
      expect(body.tasks[0]!.parentProposalId).toBe('prop-1')
      expect(body.proposals).toHaveLength(1)
      expect(body.proposals[0]!.id).toBe('prop-1')
    } finally {
      await close()
    }
  })
})
