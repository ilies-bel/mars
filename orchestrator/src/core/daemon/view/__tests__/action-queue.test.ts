/**
 * Unit tests for buildActionQueueView covering two complementary aspects of
 * the failure-kinds PRD:
 *
 *   - slice 2: title/body derivation for failed-task rows from the Failure
 *     kind registry (warmTitle / verboseReason).
 *   - slice 3: failed-task action assembly from the matched FailureKind
 *     record (not the errorKindRegistry), including the unregistered-signature
 *     `investigate` action and the daemon-killed batch row.
 *
 * Tests exercise observable behaviour through the public interface only:
 * the ActionQueueRow[] returned by buildActionQueueView.
 */

import { describe, expect, it } from 'vitest'
import {
  buildActionQueueView,
  type ActionQueueStateStore,
  type ActionQueueTaskStore,
  type PersistedActionQueueRow,
  type TaskForActionQueue,
} from '../action-queue.js'
import { lookupFailureKind } from '../../../lib/failure-kinds.js'
import { DAEMON_KILLED_SIGNATURE } from '../../../lib/retry-budget.js'

// ── Test helpers ──────────────────────────────────────────────────────────────

const makeRow = (
  overrides: Partial<PersistedActionQueueRow> = {},
): PersistedActionQueueRow => ({
  id: 'row-1',
  kind: 'failed',
  priority: 'high',
  title: 'Legacy persisted title',
  body: 'Legacy persisted body',
  payload: { taskId: 'task-1' },
  context: {},
  raisedAt: '2024-01-01T00:00:00.000Z',
  lastSeenAt: '2024-01-01T00:00:00.000Z',
  ...overrides,
})

const makeTask = (
  overrides: Partial<TaskForActionQueue> = {},
): TaskForActionQueue => ({
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
  dismissals: Map<string, string | null> = new Map(),
): ActionQueueStateStore => ({
  listOpenActionQueueItems: async () => rows,
  listActionQueueDismissals: async () => dismissals,
})

const makeTaskStore = (
  tasks: TaskForActionQueue[] = [],
): ActionQueueTaskStore => ({
  listTasks: async () => tasks,
})

const BASE_PARAMS = {
  repoRoot: '/nonexistent',
  filter: 'open' as const,
}

// ── title/body derivation from Failure kind registry (slice 2) ───────────────

describe('buildActionQueueView — failure-kind title/body derivation', () => {
  it('derives title from the warmTitle for a known failure signature', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:install/install-frozen-lockfile' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('The coding environment could not be set up')
  })

  it('derives body from verboseReason for a known failure signature', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:install/install-frozen-lockfile' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.body).toBe(
      'The setup step could not install dependencies because the lockfile no longer matches the manifest.',
    )
  })

  it('falls back to unknownFailureKind title for an unregistered signature', async () => {
    // 'verify:test/unclassified' is not in the registry; the fallback maps
    // verify:* steps to a plain-English verification title (no raw step id).
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'verify:test/unclassified' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('A verification check did not pass')
  })

  it('non-failed-task rows (stale-worktree) still use the persisted title/body', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ kind: 'stale-worktree', payload: { taskId: 'task-1' } }),
      ]),
      taskStore: makeTaskStore([makeTask()]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('Legacy persisted title')
    expect(rows[0]!.body).toBe('Legacy persisted body')
  })
})

// ── Failed-task: actions from FailureKind registry (slice 3) ──────────────────

describe('buildActionQueueView — failed-task action assembly', () => {
  it('derives actions from the FailureKind entry for setup:install/install-frozen-lockfile', async () => {
    const registeredFk = lookupFailureKind('setup:install/install-frozen-lockfile')
    expect(registeredFk).not.toBeNull()

    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:install/install-frozen-lockfile' }),
      ]),
    })

    expect(rows).toHaveLength(1)
    const actions = rows[0]!.actions
    // Actions must exactly match the FailureKind registry entry — not the errorKindRegistry.
    expect(actions.map((a) => a.op)).toEqual(
      registeredFk!.actions.map((a) => a.op),
    )
    expect(actions.map((a) => a.id)).toEqual(
      registeredFk!.actions.map((a) => a.id),
    )
  })

  it('includes diagnose-failure for a known signature (folded error-kind failed-task menu)', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:install/install-frozen-lockfile' }),
      ]),
    })

    // ADR-0042 folds the error-kind `failed-task` menu into the FailureKind
    // record, so every failed-task row offers Investigate (diagnose-failure).
    expect(rows[0]!.actions.some((a) => a.op === 'diagnose-failure')).toBe(true)
  })
})

// ── Failed-task: unregistered signature (slice 3) ─────────────────────────────

describe('buildActionQueueView — unregistered signature', () => {
  it('includes diagnose-failure action for an unregistered signature', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'some:step/totally-unknown-class' }),
      ]),
    })

    expect(rows).toHaveLength(1)
    const actions = rows[0]!.actions
    expect(actions.some((a) => a.op === 'diagnose-failure')).toBe(true)
  })

  it('still includes restart and purge for an unregistered signature', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'some:step/totally-unknown-class' }),
      ]),
    })

    const ops = rows[0]!.actions.map((a) => a.op)
    expect(ops).toContain('restart')
    expect(ops).toContain('purge')
  })

  it('includes diagnose-failure for a null failureSignature', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([makeTask({ failureSignature: null })]),
    })

    expect(rows[0]!.actions.some((a) => a.op === 'diagnose-failure')).toBe(true)
  })
})

// ── daemon-killed batch row (slices 2 + 3) ────────────────────────────────────

describe('buildActionQueueView — daemon-killed batch row', () => {
  it('renders the batch row title from the daemon-killed Failure kind entry', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ id: 'row-1', kind: 'daemon-killed', payload: { taskId: 'task-1' } }),
        makeRow({ id: 'row-2', kind: 'daemon-killed', payload: { taskId: 'task-2' } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: DAEMON_KILLED_SIGNATURE }),
        makeTask({ id: 'task-2', failureSignature: DAEMON_KILLED_SIGNATURE }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const batchRow = rows.find((r) => r.entityId === '__daemon-killed-batch__')
    expect(batchRow).toBeDefined()
    // Title must come from the registry's warmTitle — not a hardcoded string
    expect(batchRow!.title).toContain('Mars was shut down while this task was still running')
  })

  it('individual daemon-killed rows use the daemon-killed warmTitle', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ id: 'row-1', kind: 'daemon-killed', payload: { taskId: 'task-1' } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: DAEMON_KILLED_SIGNATURE }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    // Only 1 daemon-killed row → no batch synthesis, just the individual row
    const taskRow = rows.find((r) => r.entityId === 'task-1')
    expect(taskRow).toBeDefined()
    expect(taskRow!.title).toBe('Mars was shut down while this task was still running')
  })

  it('exposes restart-all-daemon-killed on the synthetic batch row', async () => {
    // Build two daemon-killed rows to trigger the batch synthesis.
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([
        makeRow({
          id: 'row-1',
          kind: 'daemon-killed',
          payload: { taskId: 'task-1' },
        }),
        makeRow({
          id: 'row-2',
          kind: 'daemon-killed',
          payload: { taskId: 'task-2' },
        }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: DAEMON_KILLED_SIGNATURE }),
        makeTask({ id: 'task-2', failureSignature: DAEMON_KILLED_SIGNATURE }),
      ]),
    })

    const batchRow = rows.find((r) => r.entityId === '__daemon-killed-batch__')
    expect(batchRow).toBeDefined()
    expect(
      batchRow!.actions.some((a) => a.op === 'restart-all-daemon-killed'),
    ).toBe(true)
  })

  it('batch row surfaces only the batch verb from the daemon-killed FailureKind entry', async () => {
    const daemonKilledFk = lookupFailureKind(DAEMON_KILLED_SIGNATURE)
    expect(daemonKilledFk).not.toBeNull()

    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([
        makeRow({
          id: 'row-1',
          kind: 'daemon-killed',
          payload: { taskId: 'task-1' },
        }),
        makeRow({
          id: 'row-2',
          kind: 'daemon-killed',
          payload: { taskId: 'task-2' },
        }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: DAEMON_KILLED_SIGNATURE }),
        makeTask({ id: 'task-2', failureSignature: DAEMON_KILLED_SIGNATURE }),
      ]),
    })

    const batchRow = rows.find((r) => r.entityId === '__daemon-killed-batch__')
    // The batch row carries only the `restart-all-daemon-killed` verb, filtered
    // from the daemon-killed Failure kind's full menu.
    expect(batchRow!.actions.map((a) => a.op)).toEqual([
      'restart-all-daemon-killed',
    ])
  })
})

// ── Stale-worktree: actions unchanged (slice 3 regression coverage) ───────────

describe('buildActionQueueView — stale-worktree row (no regression)', () => {
  it('derives stale-worktree actions from the derived-row menu, not the FailureKind registry', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([
        makeRow({
          id: 'sw-row',
          kind: 'stale-worktree',
          payload: { taskId: 'task-1', ageHours: 24 },
          context: { taskId: 'task-1' },
        }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', status: 'done' }),
      ]),
    })

    const swRow = rows.find((r) => r.kind === 'stale-worktree')
    expect(swRow).toBeDefined()
    const ops = swRow!.actions.map((a) => a.op)
    expect(ops).toContain('investigate')
    expect(ops).toContain('prune-worktree')
  })
})

// ── Draft-proposal: actions unchanged (slice 3 regression coverage) ───────────

describe('buildActionQueueView — draft-proposal row (no regression)', () => {
  it('derives draft-proposal actions from the derived-row menu, not the FailureKind registry', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([
        makeRow({
          id: 'dp-row',
          kind: 'draft-proposal',
          payload: { proposalId: 'prop-1' },
          context: {},
        }),
      ]),
      taskStore: makeTaskStore([]),
    })

    const dpRow = rows.find((r) => r.kind === 'draft-proposal')
    expect(dpRow).toBeDefined()
    expect(dpRow!.actions.some((a) => a.op === 'shape')).toBe(true)
  })
})

// ── dag.descendants enrichment (arc-keyed render, finding #4) ─────────────────

describe('buildActionQueueView — dag.descendants enrichment', () => {
  it('populates descendants with fix tasks that point at the failed origin', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ payload: { taskId: 'origin-task' } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'origin-task', status: 'failed', failureSignature: 'verify:test/unclassified' }),
        makeTask({ id: 'fix-task-1', status: 'queued', fixForTaskId: 'origin-task', prompt: 'Fix the failing tests in the worktree' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const originRow = rows.find((r) => r.entityId === 'origin-task')
    expect(originRow).toBeDefined()
    expect(originRow!.dag).not.toBeNull()
    expect(originRow!.dag!.descendants).toHaveLength(1)
    expect(originRow!.dag!.descendants[0]!.id).toBe('fix-task-1')
    expect(originRow!.dag!.descendants[0]!.status).toBe('queued')
  })

  it('descendants summary is derived from the fix task prompt', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ payload: { taskId: 'origin-task' } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'origin-task', status: 'failed', failureSignature: 'verify:test/unclassified' }),
        makeTask({ id: 'fix-task-1', status: 'queued', fixForTaskId: 'origin-task', prompt: 'Fix the failing tests in the worktree' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const originRow = rows.find((r) => r.entityId === 'origin-task')
    expect(originRow!.dag!.descendants[0]!.summary).toBe('Fix the failing tests in the worktree')
  })

  it('sets fixForTaskId on a recovery task row', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ id: 'row-fix', payload: { taskId: 'fix-task-1' } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'origin-task', status: 'failed' }),
        makeTask({ id: 'fix-task-1', status: 'failed', fixForTaskId: 'origin-task', failureSignature: 'verify:test/unclassified' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const fixRow = rows.find((r) => r.entityId === 'fix-task-1')
    expect(fixRow).toBeDefined()
    expect(fixRow!.fixForTaskId).toBe('origin-task')
  })

  it('fixForTaskId is null for a non-recovery origin task', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ payload: { taskId: 'origin-task' } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'origin-task', status: 'failed', failureSignature: 'verify:test/unclassified' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const originRow = rows.find((r) => r.entityId === 'origin-task')
    expect(originRow).toBeDefined()
    expect(originRow!.fixForTaskId ?? null).toBeNull()
  })
})
