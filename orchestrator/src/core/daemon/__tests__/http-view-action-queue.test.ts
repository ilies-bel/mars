/**
 * Tests for the daemon's actionQueue view builder (`buildActionQueueView`) and the
 * GET /view/action-queue HTTP route wired through `startHttpServer`.
 *
 * Every test exercises behaviour through the public API — the shape and
 * content of the returned ActionQueueRow[]. Internal implementation details
 * (helper functions, intermediate maps) are never asserted.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import {
  buildActionQueueView,
  type ActionQueueRow,
  type ActionQueueStateStore,
  type ActionQueueTaskStore,
  type PersistedActionQueueRow,
  type TaskForActionQueue,
} from '../view/action-queue.js'

// ── Test helpers ─────────────────────────────────────────────────────────────

const makeRow = (
  overrides: Partial<PersistedActionQueueRow> = {},
): PersistedActionQueueRow => ({
  id: 'row-1',
  kind: 'failed',
  priority: 'high',
  title: 'Task failed',
  body: 'Some error occurred',
  payload: { taskId: 'task-1' },
  context: {},
  raisedAt: '2024-01-01T00:00:00.000Z',
  lastSeenAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

const makeTask = (overrides: Partial<TaskForActionQueue> = {}): TaskForActionQueue => ({
  id: 'task-1',
  status: 'failed',
  prompt: 'Do something useful',
  blockedBy: [],
  parentProposalId: null,
  failureSignature: null,
  branch: null,
  updatedAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

/** Minimal error-kind registry for most tests. */
const makeRegistry = () =>
  new Map([
    [
      'failed-task',
      {
        kind: 'failed-task',
        recoveryActions: [
          { id: 'diagnose-failure', label: 'Investigate', op: 'diagnose-failure' },
          { id: 'restart', label: 'Restart', op: 'restart' },
          { id: 'purge', label: 'Purge', op: 'purge' },
        ],
      },
    ],
    [
      'daemon-killed',
      {
        kind: 'daemon-killed',
        recoveryActions: [
          { id: 'requeue', label: 'Requeue now', op: 'restart' },
        ],
      },
    ],
    [
      'daemon-killed-batch',
      {
        kind: 'daemon-killed-batch',
        recoveryActions: [
          {
            id: 'restart-all',
            label: 'Restart all daemon-killed',
            op: 'restart-all-daemon-killed',
          },
        ],
      },
    ],
    [
      'stale-worktree',
      {
        kind: 'stale-worktree',
        recoveryActions: [
          { id: 'investigate', label: 'Investigate', op: 'investigate' },
          { id: 'prune', label: 'Prune worktree', op: 'prune-worktree' },
        ],
      },
    ],
    [
      'draft-proposal',
      {
        kind: 'draft-proposal',
        recoveryActions: [
          { id: 'shape', label: 'Shape', op: 'shape' },
        ],
      },
    ],
  ])

const makeStateStore = (
  rows: PersistedActionQueueRow[] = [],
  dismissals: Map<string, string | null> = new Map(),
): ActionQueueStateStore => ({
  listOpenActionQueueItems: async () => rows,
  listActionQueueDismissals: async () => dismissals,
})

const makeTaskStore = (tasks: TaskForActionQueue[] = []): ActionQueueTaskStore => ({
  listTasks: async () => tasks,
})

// ── /buildActionQueueView: failed-task row + DAG ────────────────────────────────

describe('buildActionQueueView — failed-task row', () => {
  it('returns a row with the correct ActionQueueRow shape', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([makeTask()]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.id).toBe('row-1')
    expect(row.kind).toBe('failed-task')
    expect(row.entityId).toBe('task-1')
    expect(row.priority).toBe('high')
    // title and body are now derived from the Failure kind registry; with
    // failureSignature: null the unknownFailureKind fallback is used.
    expect(row.title).toBe('The unknown step failed — see the transcript')
    expect(row.body).toContain('The unknown step failed')
    expect(row.dismissed).toBe(false)
    expect(row.ackState).toBeNull()
    expect(row.errorKind).toBe('failed-task')
    expect(row.staleWorktreeDetail).toBeNull()
    expect(row.diagnosis).toBeNull()
    expect(row.failureReasonCode).toBeNull()
  })

  it('enriches DAG with blockers and blocking tasks', async () => {
    const blockerTask = makeTask({ id: 'blocker-1', status: 'failed', prompt: 'Blocker' })
    const mainTask = makeTask({
      id: 'task-1',
      blockedBy: ['blocker-1'],
      parentProposalId: 'prop-123',
    })
    const dependentTask = makeTask({
      id: 'dep-1',
      status: 'blocked',
      prompt: 'Dependent task',
      blockedBy: ['task-1'],
    })

    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow({ payload: { taskId: 'task-1' } })]),
      taskStore: makeTaskStore([blockerTask, mainTask, dependentTask]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows).toHaveLength(1)
    const dag = rows[0]!.dag!
    expect(dag.blockers).toHaveLength(1)
    expect(dag.blockers[0]!.id).toBe('blocker-1')
    expect(dag.blockers[0]!.status).toBe('failed')
    expect(dag.blocking).toHaveLength(1)
    expect(dag.blocking[0]!.id).toBe('dep-1')
    expect(dag.proposalId).toBe('prop-123')
  })

  it('includes failureReasonCode from payload', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ payload: { taskId: 'task-1', failureReasonCode: 'verify:typecheck' } }),
      ]),
      taskStore: makeTaskStore([makeTask()]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.failureReasonCode).toBe('verify:typecheck')
  })

  it('surfaces diagnosis from payload', async () => {
    const diagnosis = { text: 'Root cause: missing import', diagnosedAt: '2024-01-02T00:00:00.000Z' }
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ payload: { taskId: 'task-1', diagnosis } }),
      ]),
      taskStore: makeTaskStore([makeTask()]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.diagnosis).toEqual(diagnosis)
  })
})

// ── Action assembly: actions sourced from FailureKind registry ────────────────

describe('buildActionQueueView — action assembly', () => {
  it('includes investigate for an unregistered signature', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'some:unknown/signature' }),
      ]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const actions = rows[0]!.actions
    expect(actions.some((a) => a.op === 'investigate')).toBe(true)
    // diagnose-failure is no longer surfaced — investigate replaces it.
    expect(actions.some((a) => a.op === 'diagnose-failure')).toBe(false)
  })

  it('does not include diagnose-failure for a registered signature', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:install/install-frozen-lockfile' }),
      ]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const actions = rows[0]!.actions
    expect(actions.some((a) => a.op === 'diagnose-failure')).toBe(false)
    // Registered actions (restart + purge) are present.
    expect(actions.some((a) => a.op === 'restart')).toBe(true)
  })

  it('does not include diagnose-failure for daemon-killed signature', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ kind: 'daemon-killed', payload: { taskId: 'task-1' } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'daemon-killed' }),
      ]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const actions = rows[0]!.actions
    expect(actions.some((a) => a.op === 'diagnose-failure')).toBe(false)
  })
})

// ── Stale-worktree row ───────────────────────────────────────────────────────

describe('buildActionQueueView — stale-worktree row', () => {
  it('returns staleWorktreeDetail with empty=false when path does not exist', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({
          id: 'row-sw',
          kind: 'stale-worktree',
          priority: 'normal',
          title: 'Stale worktree',
          body: 'Worktree is stale',
          payload: {
            prompt: 'Original task prompt',
            ageHours: 48,
            branch: 'task/abc',
          },
          context: { taskId: 'wt-task-1' },
        }),
      ]),
      taskStore: makeTaskStore([
        makeTask({
          id: 'wt-task-1',
          status: 'done',
          prompt: 'Task prompt',
          branch: 'task/abc',
        }),
      ]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent/repo',
      filter: 'open',
    })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind).toBe('stale-worktree')
    expect(row.entityId).toBe('wt-task-1')
    expect(row.staleWorktreeDetail).not.toBeNull()
    expect(row.staleWorktreeDetail!.empty).toBe(false)
    expect(row.staleWorktreeDetail!.status).toBe('done')
    expect(row.staleWorktreeDetail!.ageHours).toBe(48)
    expect(row.staleWorktreeDetail!.branch).toBe('task/abc')
    expect(row.dag).toBeNull()
  })

  describe('with real git worktree', () => {
    let repoRoot: string
    let taskId: string
    let worktreePath: string

    beforeAll(() => {
      repoRoot = mkdtempSync(resolvePath(tmpdir(), 'mars-actionQueue-view-test-'))
      taskId = 'clean-wt-abc'
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot })
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoRoot })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot })
      // Create initial commit on main so worktrees can branch from it.
      writeFileSync(join(repoRoot, 'README.md'), 'init\n')
      execFileSync('git', ['add', '.'], { cwd: repoRoot })
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot })
      // Add the worktree as a git-managed worktree on a fresh branch.
      const wtDir = join(repoRoot, '.mars', 'worktrees')
      mkdirSync(wtDir, { recursive: true })
      worktreePath = join(wtDir, taskId)
      execFileSync(
        'git',
        ['worktree', 'add', worktreePath, '-b', `task/${taskId}`],
        { cwd: repoRoot },
      )
    })

    afterAll(() => {
      try {
        rmSync(repoRoot, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    })

    it('returns empty=true for a clean worktree with no changes vs main', async () => {
      const rows = await buildActionQueueView({
        stateStore: makeStateStore([
          makeRow({
            id: 'row-clean-wt',
            kind: 'stale-worktree',
            priority: 'normal',
            title: 'Clean stale worktree',
            body: 'No changes',
            payload: {},
            context: { taskId },
          }),
        ]),
        taskStore: makeTaskStore([
          makeTask({ id: taskId, status: 'done', prompt: 'Build something' }),
        ]),
        errorKindRegistry: makeRegistry(),
          repoRoot,
        filter: 'open',
      })

      expect(rows).toHaveLength(1)
      expect(rows[0]!.staleWorktreeDetail!.empty).toBe(true)
    })

    it('returns empty=false when worktree has an untracked file', async () => {
      // Add an untracked file to the worktree.
      writeFileSync(join(worktreePath, 'untracked.txt'), 'some work\n')

      const rows = await buildActionQueueView({
        stateStore: makeStateStore([
          makeRow({
            id: 'row-dirty-wt',
            kind: 'stale-worktree',
            priority: 'normal',
            title: 'Dirty stale worktree',
            body: 'Has untracked files',
            payload: {},
            context: { taskId },
          }),
        ]),
        taskStore: makeTaskStore([
          makeTask({ id: taskId, status: 'done', prompt: 'Build something' }),
        ]),
        errorKindRegistry: makeRegistry(),
          repoRoot,
        filter: 'open',
      })

      expect(rows).toHaveLength(1)
      expect(rows[0]!.staleWorktreeDetail!.empty).toBe(false)
    })
  })
})

// ── Draft-proposal row ───────────────────────────────────────────────────────

describe('buildActionQueueView — draft-proposal row', () => {
  it('returns a draft-proposal row with the correct kind and entityId', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({
          id: 'row-dp',
          kind: 'draft-proposal',
          priority: 'normal',
          title: 'New proposal',
          body: 'Shape this proposal',
          payload: { proposalId: 'prop-42' },
          context: {},
        }),
      ]),
      taskStore: makeTaskStore([]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind).toBe('draft-proposal')
    expect(row.entityId).toBe('prop-42')
    expect(row.errorKind).toBe('draft-proposal')
    expect(row.dag).toBeNull()
    expect(row.staleWorktreeDetail).toBeNull()
  })
})

// ── Daemon-killed-batch synthesis ────────────────────────────────────────────

describe('buildActionQueueView — daemon-killed-batch', () => {
  const makeDaemonKilledRow = (id: string, taskId: string, at: string): PersistedActionQueueRow => ({
    id,
    kind: 'daemon-killed',
    priority: 'high',
    title: `Task ${taskId} killed`,
    body: 'Daemon was killed',
    payload: { taskId },
    context: {},
    raisedAt: at,
    lastSeenAt: at,
  })

  it('does NOT prepend a batch row when fewer than 2 daemon-killed rows', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeDaemonKilledRow('row-1', 'task-1', '2024-01-01T00:00:00.000Z'),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: 'daemon-killed' }),
      ]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.errorKind).toBe('daemon-killed')
    expect(rows.find((r) => r.entityId === '__daemon-killed-batch__')).toBeUndefined()
  })

  it('prepends a batch row when ≥2 daemon-killed rows are visible', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeDaemonKilledRow('row-1', 'task-1', '2024-01-02T00:00:00.000Z'),
        makeDaemonKilledRow('row-2', 'task-2', '2024-01-01T00:00:00.000Z'),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: 'daemon-killed' }),
        makeTask({ id: 'task-2', failureSignature: 'daemon-killed' }),
      ]),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    // 3 rows: batch + task-1 + task-2
    expect(rows).toHaveLength(3)
    const batchRow = rows[0]!
    expect(batchRow.id).toBe('failed-task:__daemon-killed-batch__')
    expect(batchRow.entityId).toBe('__daemon-killed-batch__')
    expect(batchRow.errorKind).toBe('daemon-killed-batch')
    expect(batchRow.priority).toBe('high')
    expect(batchRow.title).toContain('2')
    expect(batchRow.actions[0]!.op).toBe('restart-all-daemon-killed')
    expect(batchRow.dismissed).toBe(false)
    expect(batchRow.ackState).toBeNull()
  })
})

// ── filter parameter ─────────────────────────────────────────────────────────

describe('buildActionQueueView — filter', () => {
  const dismissalMap = new Map([['task:task-1', 'resolved'], ['task:task-2', null]])

  const twoRows: PersistedActionQueueRow[] = [
    makeRow({ id: 'row-1', payload: { taskId: 'task-1' } }),
    makeRow({ id: 'row-2', payload: { taskId: 'task-2' } }),
  ]
  const twoTasks: TaskForActionQueue[] = [
    makeTask({ id: 'task-1' }),
    makeTask({ id: 'task-2' }),
  ]

  it('filter=open returns only non-dismissed rows', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore(twoRows, dismissalMap),
      taskStore: makeTaskStore(twoTasks),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'open',
    })
    // task-1 is resolved (dismissed=true) → hidden
    // task-2 is dismissed (dismissed=true) → hidden
    // Both are hidden — 0 visible rows
    expect(rows.every((r) => !r.dismissed)).toBe(true)
    expect(rows.find((r) => r.entityId === 'task-1')).toBeUndefined()
  })

  it('filter=dismissed returns only dismissed rows', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore(twoRows, dismissalMap),
      taskStore: makeTaskStore(twoTasks),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'dismissed',
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.dismissed)).toBe(true)
  })

  it('filter=all returns all rows regardless of dismissed state', async () => {
    // Use a mix: one open, one dismissed
    const mixedDismissals = new Map([['task:task-1', 'resolved']])
    const rows = await buildActionQueueView({
      stateStore: makeStateStore(twoRows, mixedDismissals),
      taskStore: makeTaskStore(twoTasks),
      errorKindRegistry: makeRegistry(),
      repoRoot: '/nonexistent',
      filter: 'all',
    })
    // Both rows returned — one dismissed, one not
    expect(rows).toHaveLength(2)
    const dismissed = rows.filter((r) => r.dismissed)
    const open = rows.filter((r) => !r.dismissed)
    expect(dismissed).toHaveLength(1)
    expect(open).toHaveLength(1)
  })
})

// ── HTTP route: GET /view/action-queue ──────────────────────────────────────────────

describe('GET /view/action-queue via HTTP server', () => {
  let httpServer: { port: number; close: () => Promise<void> } | null = null

  beforeEach(async () => {
    const { startHttpServer } = await import('../http-server.js')
    const { loadFailureReasonCatalog } = await import(
      '../../lib/failure-reasons.js'
    )
    const { loadRecipeCatalog } = await import('../../lib/recipes.js')
    const { nullTraceStore } = await import('../../lib/run-tool.js')

    const stateDir = mkdtempSync(resolvePath(tmpdir(), 'mars-http-view-actionQueue-'))
    const failureReasonCatalog = await loadFailureReasonCatalog(stateDir)
    const recipeCatalog = await loadRecipeCatalog(stateDir)

    httpServer = await startHttpServer({
      restartTask: async () => {},
      unblockTask: async () => {},
      purgeTask: async () => {},
      pruneWorktree: async () => {},
      investigateWorktree: async () => ({ explanation: '' }),
      diagnoseFailure: async () => ({ diagnosis: '' }),
      restartDaemon: async () => {},
      restartAllDaemonKilled: async () => [],
      isAcceptingWork: () => true,
      failureReasonCatalog,
      recipeCatalog,
      traceStore: nullTraceStore,
      viewTasks: async () => ({ tasks: [] }),
      viewProgress: async () => ({ tasks: [], proposals: [] }),
      actionQueueAck: async () => {},
      actionQueueResolve: async () => {},
      actionQueueDismiss: async () => {},
      todoDismiss: async () => {},
      viewTodo: async () => ({ drafts: [], staleWorktrees: [] }),
      viewTerminalEvents: async () => ({ events: [] }),
      viewStepSpans: async () => ({ spans: [] }),
      viewFrameworkUpdate: async () => ({
        installed: '0.1.0',
        latest: '0.1.0',
        available: false,
        checkedAt: null,
        releaseUrl: null,
      }),
      viewActionQueue: async (filter) => {
        // Return a predictable payload based on filter.
        const row: ActionQueueRow = {
          id: 'test-row',
          kind: 'failed-task',
          entityId: 'task-x',
          priority: 'high',
          title: `Test row (filter=${filter})`,
          body: 'body',
          at: '2024-01-01T00:00:00.000Z',
          dag: null,
          dismissed: filter === 'dismissed',
          ackState: null,
          errorKind: 'failed-task',
          actions: [],
          staleWorktreeDetail: null,
          diagnosis: null,
          failureReasonCode: null,
        }
        // For filter=dismissed, return an empty array (no dismissed rows in stub).
        if (filter === 'dismissed') return []
        if (filter === 'all') return [row]
        return [row]
      },
    })
  })

  afterEach(async () => {
    await httpServer?.close()
    httpServer = null
  })

  it('returns 200 with ActionQueueRow[] for GET /view/action-queue', async () => {
    const url = `http://127.0.0.1:${httpServer!.port}/view/action-queue`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActionQueueRow[]
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]!.id).toBe('test-row')
    expect(body[0]!.title).toContain('filter=open')
  })

  it('passes filter=dismissed param to viewActionQueue', async () => {
    const url = `http://127.0.0.1:${httpServer!.port}/view/action-queue?filter=dismissed`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActionQueueRow[]
    expect(Array.isArray(body)).toBe(true)
    // Stub returns [] for dismissed.
    expect(body).toHaveLength(0)
  })

  it('passes filter=all param to viewActionQueue', async () => {
    const url = `http://127.0.0.1:${httpServer!.port}/view/action-queue?filter=all`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActionQueueRow[]
    expect(body[0]!.title).toContain('filter=all')
  })
})
