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
): ActionQueueStateStore => ({
  listOpenActionQueueItems: async () => rows,
  listResolvedActionQueueItems: async () => ({ items: [], nextCursor: null }),
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

  it('no-recipe row: leads with the full failure signature for an unregistered signature', async () => {
    // 'verify:test/unclassified' is not in the registry and has no recipe.
    // The title must lead with the signature so the operator sees WHAT failed
    // rather than a generic group label or a recovery-agent prompt.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'verify:test/unclassified' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('no recipe for verify:test/unclassified')
  })

  it('no-recipe row: merge-step unregistered signature leads with the signature', async () => {
    // 'merge:unknown/unclassified' is not in the registry — verify that the
    // unregistered-signature fallback ("no recipe for <sig>") fires for merge-step
    // failures too, not just verify-step ones.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'merge:unknown/unclassified' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('no recipe for merge:unknown/unclassified')
  })

  it('known-recipe row: still uses the registry warmTitle, not the signature prefix', async () => {
    // 'setup:install/install-frozen-lockfile' has both a FailureKind and a recipe.
    // The warmTitle must be used — the signature prefix is for no-recipe rows only.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:install/install-frozen-lockfile' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).not.toMatch(/^no recipe for/)
    expect(rows[0]!.title).toBe('The coding environment could not be set up')
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

// ── entityId fallback: never empty for non-task-keyed rows ───────────────────

describe('buildActionQueueView — entityId is never empty', () => {
  // Regression for the `/api/origins/?project=…` → 400 bug: a non-task-keyed
  // failed row (no payload.taskId / context.taskId) must fall back to
  // `signature ?? id`, NEVER ''. An empty entityId reaches OriginTree, which
  // then fetches `/api/origins/` with no id and the UI server returns 400.
  it('falls back to the signature when a failed row has no taskId', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([
        makeRow({
          id: 'row-no-task',
          payload: {},
          context: {},
          signature: 'observability-store-oversize',
        }),
      ]),
      taskStore: makeTaskStore([]),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.entityId).toBe('observability-store-oversize')
  })

  it('falls back to the row id when a failed row has neither taskId nor signature', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([
        makeRow({ id: 'row-bare', payload: {}, context: {}, signature: null }),
      ]),
      taskStore: makeTaskStore([]),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.entityId).toBe('row-bare')
    expect(rows[0]!.entityId).not.toBe('')
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

// ── Draft-proposal: copy + dismiss actions ────────────────────────────────────

describe('buildActionQueueView — draft-proposal row', () => {
  it('derives draft-proposal actions from the derived-row menu, not the FailureKind registry', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([
        makeRow({
          id: 'dp-row',
          kind: 'draft-proposal',
          payload: { proposalId: 'prop-abc' },
          context: {},
        }),
      ]),
      taskStore: makeTaskStore([]),
    })

    const dpRow = rows.find((r) => r.kind === 'draft-proposal')
    expect(dpRow).toBeDefined()

    // Must carry exactly the two new actions: copy (move-forward) + dismiss.
    const ops = dpRow!.actions.map((a) => a.op)
    expect(ops).toContain('copy')
    expect(ops).toContain('dismiss')
    expect(ops).not.toContain('shape')

    // The copy action's hint must include the proposal entity id.
    const copyAction = dpRow!.actions.find((a) => a.op === 'copy')
    expect(copyAction).toBeDefined()
    expect(copyAction!.hint).toContain('prop-abc')

    // The dismiss action must require confirmation.
    const dismissAction = dpRow!.actions.find((a) => a.op === 'dismiss')
    expect(dismissAction).toBeDefined()
    expect((dismissAction as { needsConfirm?: boolean }).needsConfirm).toBe(true)
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

// ── dag.edges inter-node edges ────────────────────────────────────────────────

describe('buildActionQueueView — dag.edges inter-node edges', () => {
  /**
   * Arc:
   *   outer-task ──blocks──> blocker-a ──blocks──> origin (failed, entity)
   *                 blocker-a ──blocks──> blocker-b ──blocks──> origin
   *   origin ──blocks──> child
   *   fix-task ──recovers──> origin
   *   outer-task is connected to blocker-a but is NOT in the dag node set.
   */
  const makeScenario = () => {
    const stateStore = makeStateStore([
      makeRow({ payload: { taskId: 'origin' } }),
    ])
    const taskStore = makeTaskStore([
      makeTask({
        id: 'origin',
        status: 'failed',
        blockedBy: ['blocker-a', 'blocker-b'],
        failureSignature: null,
        prompt: 'Origin task',
      }),
      makeTask({
        id: 'blocker-a',
        status: 'queued',
        blockedBy: ['outer-task'],
        prompt: 'Blocker A',
      }),
      makeTask({
        id: 'blocker-b',
        status: 'queued',
        blockedBy: ['blocker-a'],
        prompt: 'Blocker B',
      }),
      makeTask({
        id: 'child',
        status: 'queued',
        blockedBy: ['origin'],
        prompt: 'Child task',
      }),
      makeTask({
        id: 'fix-task',
        status: 'queued',
        fixForTaskId: 'origin',
        prompt: 'Fix origin',
      }),
      makeTask({
        id: 'outer-task',
        status: 'queued',
        blockedBy: [],
        prompt: 'Outer task — not in dag node set',
      }),
    ])
    return { stateStore, taskStore }
  }

  it('emits a blocks edge from blocker-a to blocker-b (cross-blocker inter-node edge)', async () => {
    const { stateStore, taskStore } = makeScenario()
    const rows = await buildActionQueueView({ ...BASE_PARAMS, stateStore, taskStore })
    const originRow = rows.find((r) => r.entityId === 'origin')
    expect(originRow?.dag?.edges).toContainEqual({
      from: 'blocker-a',
      to: 'blocker-b',
      kind: 'blocks',
    })
  })

  it('emits a recovers edge from fix-task to origin', async () => {
    const { stateStore, taskStore } = makeScenario()
    const rows = await buildActionQueueView({ ...BASE_PARAMS, stateStore, taskStore })
    const originRow = rows.find((r) => r.entityId === 'origin')
    expect(originRow?.dag?.edges).toContainEqual({
      from: 'fix-task',
      to: 'origin',
      kind: 'recovers',
    })
  })

  it('does not emit an edge to outer-task which is outside the dag node set', async () => {
    const { stateStore, taskStore } = makeScenario()
    const rows = await buildActionQueueView({ ...BASE_PARAMS, stateStore, taskStore })
    const originRow = rows.find((r) => r.entityId === 'origin')
    const edgeEndpoints = (originRow?.dag?.edges ?? []).flatMap((e) => [e.from, e.to])
    expect(edgeEndpoints).not.toContain('outer-task')
  })

  it('edges are sorted deterministically (from, then to, then kind)', async () => {
    const { stateStore, taskStore } = makeScenario()
    const rows = await buildActionQueueView({ ...BASE_PARAMS, stateStore, taskStore })
    const edges = rows.find((r) => r.entityId === 'origin')?.dag?.edges ?? []
    const keys = edges.map((e) => `${e.from}|${e.to}|${e.kind}`)
    expect(keys).toEqual([...keys].sort())
  })

  it('edges are empty when there are no inter-node connections (star shape)', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([makeRow({ payload: { taskId: 'origin' } })]),
      taskStore: makeTaskStore([
        makeTask({
          id: 'origin',
          status: 'failed',
          blockedBy: [],
          failureSignature: null,
          prompt: 'Origin task',
        }),
      ]),
    })
    const originRow = rows.find((r) => r.entityId === 'origin')
    expect(originRow?.dag?.edges).toEqual([])
  })

  it('emits no duplicate edges when a node appears in multiple lists', async () => {
    const { stateStore, taskStore } = makeScenario()
    const rows = await buildActionQueueView({ ...BASE_PARAMS, stateStore, taskStore })
    const edges = rows.find((r) => r.entityId === 'origin')?.dag?.edges ?? []
    const keys = edges.map((e) => `${e.from}|${e.to}|${e.kind}`)
    const uniqueKeys = new Set(keys)
    expect(keys.length).toBe(uniqueKeys.size)
  })
})

// ── hitl-slice-needs-operator: persisted title/body, no failure-registry fallback ──

describe('buildActionQueueView — hitl-slice-needs-operator row', () => {
  const hitlRow = makeRow({
    id: 'hitl-row-1',
    kind: 'hitl-slice-needs-operator',
    title: 'HITL: End-to-end smoke against a real OpenShift cluster',
    body: '**HITL slice:** End-to-end smoke\n\n## Manual checklist\n\n- [ ] Deploy to staging\n',
    payload: {
      proposalId: 'prop-hitl-abc',
      sliceIndex: 2,
      subTaskId: 'sub-task-xyz',
    },
    signature: 'prop-hitl-abc:hitl:2',
  })

  it('uses the persisted title instead of the failure-registry warmTitle', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([hitlRow]),
      taskStore: makeTaskStore([]),
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toBe('HITL: End-to-end smoke against a real OpenShift cluster')
  })

  it('uses the persisted body instead of the failure-registry verboseReason', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([hitlRow]),
      taskStore: makeTaskStore([]),
    })

    expect(rows[0]!.body).toContain('HITL slice')
    expect(rows[0]!.body).not.toContain('pipeline step did not complete')
    expect(rows[0]!.body).not.toContain('A pipeline step')
  })

  it('does NOT use the generic unknown-failure title even without a matching task', async () => {
    // The pathological case: no task matches the entity id, which is what
    // caused the "A pipeline step did not complete" title before the fix.
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([hitlRow]),
      taskStore: makeTaskStore([]),
    })

    // The unknown-failure fallback title that used to appear for this case:
    expect(rows[0]!.title).not.toContain('A pipeline step did not complete')
    expect(rows[0]!.title).not.toBe('A pipeline step did not complete')
  })

  it('does not populate dag (no task-backed DAG for HITL items)', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([hitlRow]),
      taskStore: makeTaskStore([]),
    })

    expect(rows[0]!.dag).toBeNull()
  })

  it('fixForTaskId is null for a HITL row', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([hitlRow]),
      taskStore: makeTaskStore([]),
    })

    expect(rows[0]!.fixForTaskId ?? null).toBeNull()
  })

  it('uses derivedRowActions (not failure-kind registry) for HITL items', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([hitlRow]),
      taskStore: makeTaskStore([]),
    })

    // derivedRowActions for 'hitl-slice-needs-operator' should not include
    // 'diagnose-failure' which is only on the failed-task failure-kind registry path.
    const ops = rows[0]!.actions.map((a) => a.op)
    expect(ops).not.toContain('diagnose-failure')
  })
})
