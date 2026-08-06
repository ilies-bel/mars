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
  raisedAt: Date.parse('2024-01-01T00:00:00.000Z'),
  lastSeenAt: Date.parse('2024-01-01T00:00:00.000Z'),
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
  listTasksForActionQueueItems: async () => tasks,
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
    // The title carries every discriminator that exists: the signature, the
    // warm reason, and the failed task's short id.
    expect(rows[0]!.title).toBe(
      'setup:install/install-frozen-lockfile — The coding environment could not be set up [task task-1]',
    )
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

  it('gives the re-queue time ceiling an operational explanation and recovery actions', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({
          failureSignature: 'requeue:time-bound-exceeded/unclassified',
        }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toContain(
      'The task was repeatedly re-dispatched but did not finish',
    )
    expect(rows[0]!.title).not.toContain('no recipe')
    expect(rows[0]!.body).toContain('paused or restarted')
    expect(rows[0]!.actions.map((action) => action.op)).toEqual([
      'diagnose-failure',
      'restart',
      'purge',
    ])
  })

  it('unregistered signature: uses plain-English headline and keeps the key in detail', async () => {
    // The signature remains available for drill-down, but a non-expert sees
    // the step-family explanation before the technical key.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'verify:test/unclassified' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('A verification check did not pass [task task-1]')
    expect(rows[0]!.body).toContain('Failure signature: verify:test/unclassified.')
  })

  it('unregistered signature: merge failures keep their key in detail too', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'merge:unknown/unclassified' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toContain('The changes could not be merged')
    expect(rows[0]!.title).not.toContain('merge:unknown/unclassified')
    expect(rows[0]!.body).toContain('Failure signature: merge:unknown/unclassified.')
    expect(rows[0]!.title).toContain('[task task-1]')
  })

  it('two failures with different signatures produce two distinguishable titles', async () => {
    // The whole point: an operator triaging a queue of failures must be able
    // to tell the rows apart at a glance.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ id: 'row-1', payload: { taskId: 'task-1' } }),
        makeRow({ id: 'row-2', payload: { taskId: 'task-2' } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ id: 'task-1', failureSignature: 'verify:test/test-assertion-error' }),
        makeTask({ id: 'task-2', failureSignature: 'code/uncommitted-changes' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    const titles = rows.map((r) => r.title)
    expect(new Set(titles).size).toBe(2)
    expect(titles.some((t) => t.includes('verify:test/test-assertion-error'))).toBe(true)
    expect(titles.some((t) => t.includes('code/uncommitted-changes'))).toBe(true)
    expect(titles.every((t) => t !== 'A pipeline step did not complete')).toBe(true)
  })

  it('no signature: falls back to the captured error head plus the task id', async () => {
    // The generic wording alone is the last resort — when the failure has no
    // structured signature, the first line of the captured error still
    // discriminates the row.
    const rows = await buildActionQueueView({
      // A persisted title that carries no information — the generic label the
      // raiser fell back to. Derived copy is free to replace it.
      stateStore: makeStateStore([
        makeRow({ title: 'A pipeline step did not complete' }),
      ]),
      taskStore: makeTaskStore([
        makeTask({
          failureSignature: null,
          lastErrorOutput: '\n  ENOSPC: no space left on device, write\nmore detail\n',
        }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe(
      'Mars could not determine why this task failed: ENOSPC: no space left on device, write [task task-1]',
    )
  })

  it('no signature and no captured error: generic wording, still task-identified', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ title: 'A pipeline step did not complete' }),
      ]),
      taskStore: makeTaskStore([makeTask({ failureSignature: null })]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('Mars could not determine why this task failed [task task-1]')
  })

  it('keeps a purpose-built persisted title on a failed row with no signature', async () => {
    // The merge-preflight raiser writes specific operator copy. With no
    // structured signature the registry can only produce the generic label,
    // so the raiser's title must survive — only the task tag is added.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ title: 'Merge blocked: main has uncommitted changes' }),
      ]),
      taskStore: makeTaskStore([makeTask({ failureSignature: null })]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe(
      'Merge blocked: main has uncommitted changes [task task-1]',
    )
    expect(rows[0]!.body).toBe('Legacy persisted body')
  })
})

// ── purpose-built alert kinds keep their own copy ─────────────────────────────

describe('buildActionQueueView — non-failure kinds keep their raiser copy', () => {
  // toUiKind funnels every unrecognised kind into 'failed-task'. These kinds
  // are alerts, not task failures: their raisers already write specific
  // operator copy, which derived failure copy must never overwrite.

  it('daemon-code-drift keeps the running-vs-head SHA title', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({
          kind: 'daemon-code-drift',
          title: 'Daemon running stale code — a1b2c3d → e4f5g6h',
          body: 'daemon running a1b2c3d, main is at e4f5g6h — run `mars daemon restart`',
          payload: { sourceSha: 'a1b2c3d', currentSha: 'e4f5g6h' },
          signature: 'daemon-code-drift',
        }),
      ]),
      taskStore: makeTaskStore([]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('Daemon running stale code — a1b2c3d → e4f5g6h')
    expect(rows[0]!.title).not.toContain('A pipeline step did not complete')
    expect(rows[0]!.body).toContain('mars daemon restart')
  })

  it('signature-storm derives its title from the renderer (streak + signature, no pause clause when unpaused)', async () => {
    // The signature-storm renderer always derives a fresh title from the payload —
    // it does NOT keep the persisted title. When no pauseState is supplied (or
    // dispatch is running), the "dispatch is paused" clause is omitted.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({
          kind: 'signature-storm',
          title: '3 tasks failed with `code/uncommitted-changes`; dispatch is paused',
          body: 'dispatch paused after 3 consecutive failures',
          payload: { signature: 'code/uncommitted-changes', streak: 3 },
          signature: 'signature-storm:code/uncommitted-changes',
        }),
      ]),
      taskStore: makeTaskStore([]),
      repoRoot: '/nonexistent',
      filter: 'open',
      // No pauseState → defaults to null → dispatch is treated as running
    })

    expect(rows[0]!.title).toBe('3 tasks failed with `code/uncommitted-changes`')
    expect(rows[0]!.title).not.toContain('dispatch is paused')
  })

  it('a task-backed non-failure kind is tagged with its task but not retitled', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({
          kind: 'requeue-ceiling',
          title: 'Re-queue ceiling exceeded',
          payload: { taskId: 'task-1' },
        }),
      ]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'verify:test/test-assertion-error' }),
      ]),
      repoRoot: '/nonexistent',
      filter: 'open',
    })

    expect(rows[0]!.title).toBe('Re-queue ceiling exceeded [task task-1]')
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

    // Only 1 daemon-killed row → no batch synthesis, just the individual row.
    // daemon-killed is a structured task failure, so the registry owns its
    // copy — rendered with the signature and the task id like any other.
    const taskRow = rows.find((r) => r.entityId === 'task-1')
    expect(taskRow).toBeDefined()
    expect(taskRow!.title).toContain(
      'Mars was shut down while this task was still running',
    )
    expect(taskRow!.title).toContain(DAEMON_KILLED_SIGNATURE)
    expect(taskRow!.title).toContain('[task task-1]')
  })

  it('exposes continue-all-daemon-killed on the synthetic batch row', async () => {
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
      batchRow!.actions.some((a) => a.op === 'continue-all-daemon-killed'),
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
    // The batch row carries only the `continue-all-daemon-killed` verb, filtered
    // from the daemon-killed Failure kind's full menu.
    expect(batchRow!.actions.map((a) => a.op)).toEqual([
      'continue-all-daemon-killed',
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

// ── Operational alerts: kind-specific diagnostics ───────────────────────────

describe('buildActionQueueView — operational alert copy', () => {
  it('describes each operational condition with its own actionable title and body', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([
        makeRow({
          id: 'storm',
          kind: 'signature-storm',
          signature: 'signature-storm:code/unclassified',
          payload: { signature: 'code/unclassified', streak: 6 },
        }),
        makeRow({
          id: 'gate',
          kind: 'gate-broken',
          signature: 'gate-broken:verify:test/test-assertion-error',
          payload: { gate: 'test', verdict: 'verify:test/test-assertion-error', streak: 3 },
        }),
        makeRow({
          id: 'daemon',
          kind: 'daemon-died',
          signature: 'daemon-died',
          payload: { pid: 4242, crashDetectedAt: '2026-07-31T09:00:00.000Z' },
        }),
        makeRow({
          id: 'subscriber',
          kind: 'subscriber-stalled',
          signature: 'subscriber-stalled:recovery-spawner:69097',
          raisedAt: Date.parse('2026-07-31T08:55:00.000Z'),
          lastSeenAt: Date.parse('2026-07-31T09:00:00.000Z'),
          payload: {},
        }),
        makeRow({
          id: 'stale',
          kind: 'stale-queued',
          signature: 'mars-stale',
          payload: { taskId: 'mars-stale', queuedAgeMs: 12 * 60_000 },
        }),
        makeRow({
          id: 'summary',
          kind: 'stale-queued-summary',
          signature: 'summary',
          payload: { suppressedCount: 22, queueDepth: 42 },
        }),
        makeRow({
          id: 'phantom',
          kind: 'phantom-task',
          signature: 'mars-phantom',
          payload: {
            taskId: 'mars-phantom',
            previousStatus: 'verifying',
            reason: 'ceiling',
            ageMinutes: 31,
          },
        }),
      ]),
      taskStore: makeTaskStore([]),
    })

    const byId = new Map(rows.map((row) => [row.id, row]))
    expect(byId.get('storm')!.title).toContain('6 tasks failed with `code/unclassified`')
    // With no pauseState supplied (defaults to unpaused), dispatch is NOT claimed to be paused.
    expect(byId.get('storm')!.title).not.toContain('dispatch is paused')
    expect(byId.get('storm')!.body).toContain('.mars/watch.log')
    expect(byId.get('gate')!.title).toContain('Gate test')
    expect(byId.get('gate')!.body).toContain('verify:test/test-assertion-error')
    expect(byId.get('daemon')!.title).toContain('pid 4242')
    expect(byId.get('daemon')!.body).toContain('.mars/watch.log')
    expect(byId.get('subscriber')!.title).toContain('recovery-spawner (pid 69097)')
    expect(byId.get('subscriber')!.body).toContain('5 min')
    expect(byId.get('stale')!.title).toContain('mars-stale has been queued for 12 min')
    expect(byId.get('stale')!.body).toContain('mars-stale')
    expect(byId.get('summary')!.title).toContain('22 queued tasks were suppressed')
    expect(byId.get('summary')!.body).toContain('mars action-queue list open --kind stale-queued')
    expect(byId.get('phantom')!.title).toContain('mars-phantom is stuck in verifying for 31 min')
    expect(byId.get('phantom')!.body).toContain('mars-phantom')

    for (const row of rows) {
      expect(row.title).not.toBe('A pipeline step did not complete')
      expect(row.body).not.toContain('See the transcript for details')
    }
  })
})

// ── signature-storm pause-state projection ────────────────────────────────────

describe('buildActionQueueView — signature-storm pause-state projection', () => {
  const stormRow = makeRow({
    id: 'storm',
    kind: 'signature-storm',
    signature: 'signature-storm:verify:typecheck/unclassified',
    payload: { signature: 'verify:typecheck/unclassified', streak: 3 },
  })

  it('does NOT claim dispatch is paused when pauseState is null', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([stormRow]),
      taskStore: makeTaskStore([]),
      // pauseState omitted — defaults to null (unknown / unpaused)
    })
    const row = rows.find((r) => r.id === 'storm')!
    expect(row.title).not.toContain('dispatch is paused')
    expect(row.body).not.toContain('dispatch is paused')
  })

  it('does NOT claim dispatch is paused when dispatch is running', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([stormRow]),
      taskStore: makeTaskStore([]),
      pauseState: { paused: false, reason: null, since: null, detail: null },
    })
    const row = rows.find((r) => r.id === 'storm')!
    expect(row.title).not.toContain('dispatch is paused')
    expect(row.body).not.toContain('dispatch is paused')
  })

  it('does NOT claim dispatch is paused when paused for a reason other than storm', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([stormRow]),
      taskStore: makeTaskStore([]),
      pauseState: { paused: true, reason: 'operator', since: '2026-08-06T00:00:00.000Z', detail: null },
    })
    const row = rows.find((r) => r.id === 'storm')!
    expect(row.title).not.toContain('dispatch is paused')
  })

  it('DOES claim dispatch is paused when paused with reason storm', async () => {
    const rows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([stormRow]),
      taskStore: makeTaskStore([]),
      pauseState: { paused: true, reason: 'storm', since: '2026-08-06T00:00:00.000Z', detail: null },
    })
    const row = rows.find((r) => r.id === 'storm')!
    expect(row.title).toContain('dispatch is paused')
    expect(row.body).toContain('dispatch is paused')
  })

  it('includes the streak and signature in title regardless of pause state', async () => {
    const runningRows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([stormRow]),
      taskStore: makeTaskStore([]),
      pauseState: { paused: false, reason: null, since: null, detail: null },
    })
    const pausedRows = await buildActionQueueView({
      ...BASE_PARAMS,
      stateStore: makeStateStore([stormRow]),
      taskStore: makeTaskStore([]),
      pauseState: { paused: true, reason: 'storm', since: '2026-08-06T00:00:00.000Z', detail: null },
    })
    expect(runningRows.find((r) => r.id === 'storm')!.title).toContain('3 tasks failed with `verify:typecheck/unclassified`')
    expect(pausedRows.find((r) => r.id === 'storm')!.title).toContain('3 tasks failed with `verify:typecheck/unclassified`')
  })
})
