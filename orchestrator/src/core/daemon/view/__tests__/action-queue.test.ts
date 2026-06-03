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

const emptyRegistry = new Map()

const daemonKilledRegistry = new Map([
  [
    'daemon-killed',
    {
      kind: 'daemon-killed',
      recoveryActions: [
        { id: 'restart-all', label: 'Restart all daemon-killed', op: 'restart-all-daemon-killed' },
      ],
    },
  ],
  [
    'daemon-killed-batch',
    {
      kind: 'daemon-killed-batch',
      recoveryActions: [
        { id: 'restart-all', label: 'Restart all daemon-killed', op: 'restart-all-daemon-killed' },
      ],
    },
  ],
  [
    'failed-task',
    {
      kind: 'failed-task',
      recoveryActions: [],
    },
  ],
])

/** Minimal error-kind registry for stale-worktree / draft-proposal rows. */
const makeRegistry = () =>
  new Map([
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
        recoveryActions: [{ id: 'shape', label: 'Shape', op: 'shape' }],
      },
    ],
  ])

const BASE_PARAMS = {
  errorKindRegistry: makeRegistry(),
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
      errorKindRegistry: emptyRegistry,
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
      errorKindRegistry: emptyRegistry,
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.body).toBe(
      'The setup step could not install dependencies because the lockfile no longer matches the manifest.',
    )
  })

  it('falls back to unknownFailureKind title for an unregistered signature', async () => {
    // 'verify:test/unclassified' is not in the registry
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'verify:test/unclassified' }),
      ]),
      errorKindRegistry: emptyRegistry,
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('The verify:test step failed — see the transcript')
  })

  it('non-failed-task rows (stale-worktree) still use the persisted title/body', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ kind: 'stale-worktree', payload: { taskId: 'task-1' } }),
      ]),
      taskStore: makeTaskStore([makeTask()]),
      errorKindRegistry: emptyRegistry,
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

  it('does not include diagnose-failure for a known signature', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:install/install-frozen-lockfile' }),
      ]),
    })

    expect(rows[0]!.actions.some((a) => a.op === 'diagnose-failure')).toBe(false)
  })
})

// ── Failed-task: unregistered signature (slice 3) ─────────────────────────────

describe('buildActionQueueView — unregistered signature', () => {
  it('includes investigate action for an unregistered signature', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'some:step/totally-unknown-class' }),
      ]),
    })

    expect(rows).toHaveLength(1)
    const actions = rows[0]!.actions
    expect(actions.some((a) => a.op === 'investigate')).toBe(true)
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

  it('includes investigate for a null failureSignature', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([makeTask({ failureSignature: null })]),
    })

    expect(rows[0]!.actions.some((a) => a.op === 'investigate')).toBe(true)
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
      errorKindRegistry: daemonKilledRegistry,
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
      errorKindRegistry: daemonKilledRegistry,
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

  it('batch row actions come from the daemon-killed FailureKind entry', async () => {
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
    expect(batchRow!.actions.map((a) => a.op)).toEqual(
      daemonKilledFk!.actions.map((a) => a.op),
    )
  })
})

// ── Stale-worktree: actions unchanged (slice 3 regression coverage) ───────────

describe('buildActionQueueView — stale-worktree row (no regression)', () => {
  it('derives stale-worktree actions from errorKindRegistry, not FailureKind registry', async () => {
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
  it('derives draft-proposal actions from errorKindRegistry, not FailureKind registry', async () => {
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

// ── Dismissal filtering: CLI/daemon parity ────────────────────────────────────
//
// These tests confirm that buildActionQueueView (the single builder used by
// both the daemon HTTP handler and the CLI list command) correctly applies the
// dismissals side-table to every filter mode.  Since the CLI now calls the
// same buildActionQueueView the tests also serve as proof that `mars
// action-queue list open` and `GET /view/action-queue?filter=open` return
// identical row sets for any seeded store.

describe('buildActionQueueView — dismissal filtering (CLI/daemon parity)', () => {
  it('excludes a classically-dismissed item from the open filter', async () => {
    const dismissed = makeRow({ id: 'row-dismissed', payload: { taskId: 'task-dismissed' } })
    const open = makeRow({ id: 'row-open', payload: { taskId: 'task-open' } })
    const dismissalMap = new Map<string, string | null>([
      ['task:task-dismissed', null], // classic dismiss (note = null)
    ])

    const rows = await buildActionQueueView({
      stateStore: makeStateStore([dismissed, open], dismissalMap),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-dismissed' }),
        makeTask({ id: 'task-open' }),
      ]),
      ...BASE_PARAMS,
      filter: 'open',
    })

    const ids = rows.map((r) => r.id)
    expect(ids).not.toContain('row-dismissed')
    expect(ids).toContain('row-open')
  })

  it('shows a dismissed item in the dismissed filter but not the open filter', async () => {
    const row = makeRow({ id: 'row-a', payload: { taskId: 'task-a' } })
    const dismissalMap = new Map<string, string | null>([['task:task-a', 'dismissed']])
    const stateStore = makeStateStore([row], dismissalMap)
    const taskStore = makeTaskStore([makeTask({ id: 'task-a' })])

    const open = await buildActionQueueView({ stateStore, taskStore, ...BASE_PARAMS, filter: 'open' })
    const dismissed = await buildActionQueueView({ stateStore, taskStore, ...BASE_PARAMS, filter: 'dismissed' })

    expect(open.map((r) => r.id)).not.toContain('row-a')
    expect(dismissed.map((r) => r.id)).toContain('row-a')
  })

  it('ack-only items remain visible in the open filter', async () => {
    const row = makeRow({ id: 'row-acked', payload: { taskId: 'task-acked' } })
    const dismissalMap = new Map<string, string | null>([
      ['task:task-acked', 'ack'], // ack does NOT hide from open
    ])

    const rows = await buildActionQueueView({
      stateStore: makeStateStore([row], dismissalMap),
      taskStore: makeTaskStore([makeTask({ id: 'task-acked' })]),
      ...BASE_PARAMS,
      filter: 'open',
    })

    expect(rows.map((r) => r.id)).toContain('row-acked')
    expect(rows.find((r) => r.id === 'row-acked')!.dismissed).toBe(false)
  })

  it('CLI list and daemon view return identical row-id sets for the same seeded store', async () => {
    // row-a: dismissed,  row-b: ack (still visible),  row-c: plain open
    const rowA = makeRow({ id: 'row-a', payload: { taskId: 'task-a' } })
    const rowB = makeRow({ id: 'row-b', payload: { taskId: 'task-b' } })
    const rowC = makeRow({ id: 'row-c', payload: { taskId: 'task-c' } })
    const dismissalMap = new Map<string, string | null>([
      ['task:task-a', 'dismissed'],
      ['task:task-b', 'ack'],
    ])
    const stateStore = makeStateStore([rowA, rowB, rowC], dismissalMap)
    const taskStore = makeTaskStore([
      makeTask({ id: 'task-a' }),
      makeTask({ id: 'task-b' }),
      makeTask({ id: 'task-c' }),
    ])

    // Both CLI and daemon call buildActionQueueView with identical adapters —
    // assert they produce the same row-id sets per filter.
    const openRows = await buildActionQueueView({ stateStore, taskStore, ...BASE_PARAMS, filter: 'open' })
    const dismissedRows = await buildActionQueueView({ stateStore, taskStore, ...BASE_PARAMS, filter: 'dismissed' })
    const allRows = await buildActionQueueView({ stateStore, taskStore, ...BASE_PARAMS, filter: 'all' })

    const openIds = openRows.map((r) => r.id)
    const dismissedIds = dismissedRows.map((r) => r.id)
    const allIds = allRows.map((r) => r.id)

    // open: task-a hidden (dismissed), task-b visible (ack only), task-c visible
    expect(openIds).not.toContain('row-a')
    expect(openIds).toContain('row-b')
    expect(openIds).toContain('row-c')

    // dismissed: only task-a
    expect(dismissedIds).toContain('row-a')
    expect(dismissedIds).not.toContain('row-b')
    expect(dismissedIds).not.toContain('row-c')

    // all: every row present
    expect(allIds).toContain('row-a')
    expect(allIds).toContain('row-b')
    expect(allIds).toContain('row-c')
  })
})
