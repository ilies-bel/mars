/**
 * Tests for the action-queue history view:
 *   - `listResolvedActionQueueItems` in the state store returns resolved rows
 *     newest-first with correct cursor pagination.
 *   - `buildActionQueueHistoryView` maps resolved rows to ActionQueueRow[]
 *     with resolution metadata and empty actions.
 *   - GET /view/action-queue/history returns a { rows, nextCursor } payload.
 *
 * Tests exercise observable behaviour through public interfaces only.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import {
  buildActionQueueHistoryView,
  type ActionQueueRow,
  type ActionQueueStateStore,
  type ActionQueueTaskStore,
  type PersistedActionQueueRow,
  type TaskForActionQueue,
} from '../view/action-queue.js'
import { stubAppServices, stubChatRunner } from './app-services-stub'

// ── Test helpers ──────────────────────────────────────────────────────────────

const makeResolvedRow = (
  overrides: Partial<PersistedActionQueueRow> = {},
): PersistedActionQueueRow => ({
  id: 'row-resolved-1',
  kind: 'failed',
  priority: 'high',
  title: 'Task failed',
  body: 'Some error occurred',
  payload: { taskId: 'task-1' },
  context: {},
  raisedAt: Date.parse('2024-01-01T00:00:00.000Z'),
  lastSeenAt: Date.parse('2024-01-01T00:00:00.000Z'),
  resolvedAt: Date.parse('2024-01-02T00:00:00.000Z'),
  resolution: 'superseded',
  resolutionNote: 'origin-done',
  rootCause: null,
  resolvedBy: 'daemon:auto-supersede',
  ...overrides,
})

const makeTask = (overrides: Partial<TaskForActionQueue> = {}): TaskForActionQueue => ({
  id: 'task-1',
  status: 'done',
  prompt: 'Do something useful',
  blockedBy: [],
  parentProposalId: null,
  failureSignature: null,
  branch: null,
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

const makeStateStore = (
  resolvedRows: PersistedActionQueueRow[] = [],
): ActionQueueStateStore => ({
  listOpenActionQueueItems: async () => [],
  listResolvedActionQueueItems: async ({ limit = 50, cursor } = {}) => {
    // Simulate cursor: items after the cursor index.
    const start = cursor ? parseInt(cursor, 10) : 0
    const page = resolvedRows.slice(start, start + limit)
    const hasMore = start + limit < resolvedRows.length
    return {
      items: page,
      nextCursor: hasMore ? String(start + limit) : null,
    }
  },
})

const makeTaskStore = (tasks: TaskForActionQueue[] = []): ActionQueueTaskStore => ({
  listTasksForActionQueueItems: async () => tasks,
})

// ── buildActionQueueHistoryView ───────────────────────────────────────────────

describe('buildActionQueueHistoryView — resolved row shape', () => {
  it('returns a row with the correct ActionQueueRow shape and resolution metadata', async () => {
    const result = await buildActionQueueHistoryView({
      stateStore: makeStateStore([makeResolvedRow()]),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      limit: 50,
    })

    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]!
    expect(row.id).toBe('row-resolved-1')
    expect(row.kind).toBe('failed')
    expect(row.entityId).toBe('task-1')
    expect(row.priority).toBe('high')
    expect(row.actions).toEqual([]) // Resolved rows have no actions.
    expect(row.resolution).not.toBeNull()
    expect(row.resolution!.resolvedAt).toBe('2024-01-02T00:00:00.000Z')
    expect(row.resolution!.resolution).toBe('superseded')
    expect(row.resolution!.resolutionNote).toBe('origin-done')
    expect(row.resolution!.resolvedBy).toBe('daemon:auto-supersede')
    expect(row.resolution!.rootCause).toBeNull()
  })

  it('returns nextCursor=null when there are no more rows', async () => {
    const result = await buildActionQueueHistoryView({
      stateStore: makeStateStore([makeResolvedRow()]),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      limit: 50,
    })

    expect(result.nextCursor).toBeNull()
  })

  it('returns nextCursor when more rows exist', async () => {
    const rows = [
      makeResolvedRow({ id: 'row-1' }),
      makeResolvedRow({ id: 'row-2' }),
      makeResolvedRow({ id: 'row-3' }),
    ]

    const result = await buildActionQueueHistoryView({
      stateStore: makeStateStore(rows),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      limit: 2,
    })

    expect(result.rows).toHaveLength(2)
    expect(result.nextCursor).not.toBeNull()
  })

  it('maps draft-proposal resolved row to draft-proposal kind with resolution', async () => {
    const row = makeResolvedRow({
      id: 'proposal-row',
      kind: 'draft-proposal',
      payload: { proposalId: 'prop-1' },
      context: {},
      resolution: 'dismissed',
      resolutionNote: null,
      resolvedBy: 'user:dismiss',
    })

    const result = await buildActionQueueHistoryView({
      stateStore: makeStateStore([row]),
      taskStore: makeTaskStore([]),
      repoRoot: '/nonexistent',
      limit: 50,
    })

    expect(result.rows).toHaveLength(1)
    const r = result.rows[0]!
    expect(r.kind).toBe('draft-proposal')
    expect(r.entityId).toBe('prop-1')
    expect(r.actions).toEqual([])
    expect(r.resolution!.resolution).toBe('dismissed')
    expect(r.resolution!.resolvedBy).toBe('user:dismiss')
  })

  it('returns empty rows when state store returns nothing', async () => {
    const result = await buildActionQueueHistoryView({
      stateStore: makeStateStore([]),
      taskStore: makeTaskStore([]),
      repoRoot: '/nonexistent',
      limit: 50,
    })

    expect(result.rows).toHaveLength(0)
    expect(result.nextCursor).toBeNull()
  })

  it('preserves the store order (newest-first) in the returned rows', async () => {
    // The store returns rows newest-first (ORDER BY resolved_at DESC).
    // buildActionQueueHistoryView must not reorder them.
    const rows = [
      makeResolvedRow({ id: 'newest', resolvedAt: Date.parse('2024-01-03T00:00:00.000Z') }),
      makeResolvedRow({ id: 'middle', resolvedAt: Date.parse('2024-01-02T00:00:00.000Z'), payload: { taskId: 'task-1' } }),
      makeResolvedRow({ id: 'oldest', resolvedAt: Date.parse('2024-01-01T00:00:00.000Z'), payload: { taskId: 'task-1' } }),
    ]

    const result = await buildActionQueueHistoryView({
      stateStore: makeStateStore(rows),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      limit: 50,
    })

    expect(result.rows).toHaveLength(3)
    // Verify order is preserved: newest first.
    expect(result.rows[0]!.id).toBe('newest')
    expect(result.rows[1]!.id).toBe('middle')
    expect(result.rows[2]!.id).toBe('oldest')
  })

  it('first page returns the newest rows and nextCursor points past them', async () => {
    // Simulate 5 rows ordered newest-first; fetch first page of 2.
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeResolvedRow({
        id: `row-${i}`,
        resolvedAt: Date.parse(`2024-01-0${5 - i}T00:00:00.000Z`),
        payload: { taskId: 'task-1' },
      }),
    )

    const page1 = await buildActionQueueHistoryView({
      stateStore: makeStateStore(rows),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      limit: 2,
      cursor: undefined,
    })

    // First page: 2 rows, cursor for next page.
    expect(page1.rows).toHaveLength(2)
    expect(page1.rows[0]!.id).toBe('row-0')
    expect(page1.rows[1]!.id).toBe('row-1')
    expect(page1.nextCursor).not.toBeNull()

    // Second page: 2 rows, cursor for next page.
    const page2 = await buildActionQueueHistoryView({
      stateStore: makeStateStore(rows),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      limit: 2,
      cursor: page1.nextCursor,
    })

    expect(page2.rows).toHaveLength(2)
    expect(page2.rows[0]!.id).toBe('row-2')
    expect(page2.rows[1]!.id).toBe('row-3')
    expect(page2.nextCursor).not.toBeNull()

    // Third page: 1 row, no nextCursor.
    const page3 = await buildActionQueueHistoryView({
      stateStore: makeStateStore(rows),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      limit: 2,
      cursor: page2.nextCursor,
    })

    expect(page3.rows).toHaveLength(1)
    expect(page3.rows[0]!.id).toBe('row-4')
    expect(page3.nextCursor).toBeNull()
  })
})

// ── HTTP route: GET /view/action-queue/history ────────────────────────────────

describe('GET /view/action-queue/history via HTTP server', () => {
  let httpServer: { port: number; close: () => Promise<void> } | null = null
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(resolvePath(tmpdir(), 'mars-aq-hist-'))
    mkdirSync(tmpDir, { recursive: true })
    // Set up a temp git repo so git commands in git probe have something to work with.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmpDir })

    const { startHttpServer } = await import('../http-server.js')
    const { loadRecipeCatalog } = await import('../../lib/recipes.js')
    const { nullTraceStore } = await import('../../lib/run-tool.js')

    const recipeCatalog = await loadRecipeCatalog(tmpDir)

    const historyRow: ActionQueueRow = {
      id: 'hist-row-1',
      kind: 'failed-task',
      entityId: 'task-hist',
      priority: 'normal',
      title: 'Resolved task',
      body: 'body text',
      at: '2024-01-01T00:00:00.000Z',
      dag: null,
      errorKind: 'failed-task',
      actions: [],
      staleWorktreeDetail: null,
      devServerUrl: null,
      leaseState: null,
      diagnosis: null,
      failureReasonCode: null,
      humanSummary: 'Test alert',
      humanDetail: {},
      verbs: [],
      resolution: {
        resolvedAt: '2024-01-02T00:00:00.000Z',
        resolution: 'superseded',
        resolutionNote: 'origin-done',
        rootCause: null,
        resolvedBy: 'daemon:auto-supersede',
      },
    }

    httpServer = await startHttpServer({
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
      recipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices({
        viewActionQueueHistory: async ({ cursor }) => ({
          rows: cursor ? [] : [historyRow],
          nextCursor: cursor ? null : 'cursor-token-1',
        }),
      }),
      chatRunner: stubChatRunner(),
    })
  })

  afterEach(async () => {
    await httpServer?.close()
    httpServer = null
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 200 with { rows, nextCursor } for GET /view/action-queue/history', async () => {
    const url = `http://127.0.0.1:${httpServer!.port}/view/action-queue/history`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: ActionQueueRow[]; nextCursor: string | null }
    expect(Array.isArray(body.rows)).toBe(true)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]!.id).toBe('hist-row-1')
    expect(body.rows[0]!.resolution).not.toBeNull()
    expect(body.rows[0]!.resolution!.resolvedAt).toBe('2024-01-02T00:00:00.000Z')
    expect(body.nextCursor).toBe('cursor-token-1')
  })

  it('passes cursor param to viewActionQueueHistory', async () => {
    const url = `http://127.0.0.1:${httpServer!.port}/view/action-queue/history?cursor=cursor-token-1`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: ActionQueueRow[]; nextCursor: string | null }
    expect(body.rows).toHaveLength(0)
    expect(body.nextCursor).toBeNull()
  })

  it('returns an empty page when AppServices.viewActionQueueHistory has no rows', async () => {
    // The history use-case always exists on AppServices now (ADR-0055); the
    // route returns whatever it yields. The default stub yields an empty page.
    const { startHttpServer } = await import('../http-server.js')
    const { loadRecipeCatalog } = await import('../../lib/recipes.js')
    const { nullTraceStore } = await import('../../lib/run-tool.js')
    const recipeCatalog = await loadRecipeCatalog(tmpDir)

    const serverEmptyHistory = await startHttpServer({
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
      recipeCatalog,
      traceStore: nullTraceStore,
      appServices: stubAppServices(),
      chatRunner: stubChatRunner(),
    })

    try {
      const url = `http://127.0.0.1:${serverEmptyHistory.port}/view/action-queue/history`
      const res = await fetch(url)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { rows: unknown[]; nextCursor: null }
      expect(body.rows).toEqual([])
      expect(body.nextCursor).toBeNull()
    } finally {
      await serverEmptyHistory.close()
    }
  })
})
