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
import { stubAppServices, stubChatRunner } from './app-services-stub'

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
  raisedAt: Date.parse('2024-01-01T00:00:00.000Z'),
  lastSeenAt: Date.parse('2024-01-01T00:00:00.000Z'),
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

const makeStateStore = (
  rows: PersistedActionQueueRow[] = [],
): ActionQueueStateStore => ({
  listOpenActionQueueItems: async () => rows,
  listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
})

const makeTaskStore = (tasks: TaskForActionQueue[] = []): ActionQueueTaskStore => ({
  listTasksForActionQueueItems: async () => tasks,
})

// ── /buildActionQueueView: failed-task row + DAG ────────────────────────────────

describe('buildActionQueueView — failed-task row', () => {
  it('returns a row with the correct ActionQueueRow shape', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.id).toBe('row-1')
    expect(row.kind).toBe('failed')
    expect(row.entityId).toBe('task-1')
    expect(row.priority).toBe('high')
    // With failureSignature: null the registry can only produce the generic
    // label, so the raiser's persisted copy is kept — and tagged with the
    // failed task's id so the row is still identifiable.
    expect(row.title).toBe('Task failed [task task-1]')
    expect(row.body).toBe('Some error occurred')
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
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.diagnosis).toEqual(diagnosis)
  })
})

// ── Action assembly: actions sourced from FailureKind registry ────────────────

describe('buildActionQueueView — action assembly', () => {
  it('includes diagnose-failure for an unregistered signature', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'some:unknown/signature' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const actions = rows[0]!.actions
    // ADR-0042 folds the error-kind failed-task menu into the FailureKind
    // record, so unknown failures offer Investigate (diagnose-failure).
    expect(actions.some((a) => a.op === 'diagnose-failure')).toBe(true)
  })

  it('includes diagnose-failure for a registered signature', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:install/install-frozen-lockfile' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const actions = rows[0]!.actions
    expect(actions.some((a) => a.op === 'diagnose-failure')).toBe(true)
    // Registered actions (restart + purge) are present too.
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
          repoRoot,
        filter: 'open',
      })

      expect(rows).toHaveLength(1)
      expect(rows[0]!.staleWorktreeDetail!.empty).toBe(false)
    })

    it('degrades to empty=false when a git probe hangs, without blocking /view/action-queue', async () => {
      // Simulate a wedged worktree by placing a fake `git` that sleeps 30s on PATH.
      // The 3-second timeout added to execFileSync must kill it and fall through
      // to the conservative empty=false default — the whole call must resolve
      // well within the sleep duration.
      const fakeGitDir = mkdtempSync(resolvePath(tmpdir(), 'mars-fake-git-'))
      const fakeGit = join(fakeGitDir, 'git')
      writeFileSync(fakeGit, '#!/bin/sh\nexec sleep 30\n')
      execFileSync('chmod', ['+x', fakeGit])

      // The worktree directory must exist so the code enters the git-probe branch.
      const fakeWtTaskId = 'wedged-wt-task'
      const fakeWtDir = join(fakeGitDir, '.mars', 'worktrees', fakeWtTaskId)
      mkdirSync(fakeWtDir, { recursive: true })

      const originalPath = process.env.PATH
      try {
        // Prepend the fake git directory so `execFileSync('git', ...)` finds it first.
        process.env.PATH = `${fakeGitDir}:${String(originalPath)}`

        const start = Date.now()
        const rows = await buildActionQueueView({
          stateStore: makeStateStore([
            makeRow({
              id: 'row-wedged-git',
              kind: 'stale-worktree',
              priority: 'normal',
              title: 'Wedged git',
              body: 'Git hangs',
              payload: {},
              context: { taskId: fakeWtTaskId },
            }),
          ]),
          taskStore: makeTaskStore([
            makeTask({ id: fakeWtTaskId, status: 'done', prompt: 'Wedged task' }),
          ]),
          repoRoot: fakeGitDir,
          filter: 'open',
        })
        const elapsed = Date.now() - start

        // Must return within ~5 s (3 s timeout + buffer) — not block for 30 s.
        expect(elapsed).toBeLessThan(5000)
        // The timed-out probe must fall through to the conservative default.
        expect(rows[0]!.staleWorktreeDetail!.empty).toBe(false)
      } finally {
        process.env.PATH = originalPath
        try { rmSync(fakeGitDir, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    }, 8000) // allow up to 8 s: 3 s git timeout + overhead
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
  const makeDaemonKilledRow = (id: string, taskId: string, at: number): PersistedActionQueueRow => ({
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
        makeDaemonKilledRow('row-1', 'task-1', Date.parse('2024-01-01T00:00:00.000Z')),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: 'daemon-killed' }),
      ]),
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
        makeDaemonKilledRow('row-1', 'task-1', Date.parse('2024-01-02T00:00:00.000Z')),
        makeDaemonKilledRow('row-2', 'task-2', Date.parse('2024-01-01T00:00:00.000Z')),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: 'daemon-killed' }),
        makeTask({ id: 'task-2', failureSignature: 'daemon-killed' }),
      ]),
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
    expect(batchRow.actions[0]!.op).toBe('continue-all-daemon-killed')
  })
})

// ── arcGoal derivation ───────────────────────────────────────────────────────

describe('buildActionQueueView — arcGoal derivation', () => {
  it('sets arcGoal to the origin task prompt for a non-recovery failed-task row', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([makeTask({ prompt: 'Implement the caching layer' })]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })
    expect(rows[0]!.arcGoal).toBe('Implement the caching layer')
  })

  it('sets arcGoal from the origin task prompt when the row is a recovery/fix task', async () => {
    const originTask = makeTask({
      id: 'origin-1',
      prompt: 'Add rate limiting to the API gateway',
      status: 'failed',
    })
    const fixTask = makeTask({
      id: 'fix-1',
      fixForTaskId: 'origin-1',
      prompt: 'Fix: retry the integration gate step',
    })
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow({ payload: { taskId: 'fix-1' } })]),
      taskStore: makeTaskStore([originTask, fixTask]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })
    expect(rows[0]!.arcGoal).toBe('Add rate limiting to the API gateway')
  })

  it('truncates long prompts in arcGoal to at most 80 characters', async () => {
    const longPrompt = 'Implement '.repeat(20)
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([makeTask({ prompt: longPrompt })]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })
    const goal = rows[0]!.arcGoal!
    expect(goal.length).toBeLessThanOrEqual(80)
    expect(goal.endsWith('…')).toBe(true)
  })

  it('sets arcGoal to null for a draft-proposal row (non-task-backed)', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({
          id: 'row-dp',
          kind: 'draft-proposal',
          payload: { proposalId: 'prop-42' },
          context: {},
        }),
      ]),
      taskStore: makeTaskStore([]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })
    expect(rows[0]!.arcGoal).toBeNull()
  })
})

// ── HTTP route: GET /view/action-queue ──────────────────────────────────────────────

describe('GET /view/action-queue via HTTP server', () => {
  let httpServer: { port: number; close: () => Promise<void> } | null = null

  beforeEach(async () => {
    const { startHttpServer } = await import('../http-server.js')
    const { loadRecipeCatalog } = await import('../../lib/recipes.js')
    const { nullTraceStore } = await import('../../lib/run-tool.js')

    const stateDir = mkdtempSync(resolvePath(tmpdir(), 'mars-http-view-actionQueue-'))
    const recipeCatalog = await loadRecipeCatalog(stateDir)

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
          }
          return [row]
        },
      }),
      chatRunner: stubChatRunner(),
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

  it('passes filter=all param to viewActionQueue', async () => {
    const url = `http://127.0.0.1:${httpServer!.port}/view/action-queue?filter=all`
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ActionQueueRow[]
    expect(body[0]!.title).toContain('filter=all')
  })
})
