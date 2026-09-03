/**
 * §9 beat 3: "A failure arrives as an alert you can read cold"
 *
 * Verifies that failed action-queue rows satisfy HR-6 (no machine strings on
 * the card face) and §7 (readable with no prior context):
 *
 *   1. headline: "Task [id] failed at [phase]: [one-sentence summary]"
 *   2. body:     "Continue on the existing worktree, restart from scratch, or drop"
 *
 * The failure signature, verbose reason, and captured error are accessible via
 * the task graph (DEC-18: internals stay behind a disclosure) — they no longer
 * appear in title or body.
 */

import { describe, expect, it } from 'vitest'
import {
  buildActionQueueView,
  type ActionQueueStateStore,
  type ActionQueueTaskStore,
  type PersistedActionQueueRow,
  type TaskForActionQueue,
} from '../view/action-queue.js'

// ── helpers ───────────────────────────────────────────────────────────────────

// Real Mars IDs: 'mars-' prefix + 8 hex chars (13 chars total).
// shortId('mars-a1b2c3d4') = 'mars-a1b2c3d4' (returned unchanged).
const TASK_ID = 'mars-a1b2c3d4'

const makeRow = (
  overrides: Partial<PersistedActionQueueRow> = {},
): PersistedActionQueueRow => ({
  id: 'row-1',
  kind: 'failed',
  priority: 'high',
  title: 'A pipeline step did not complete', // generic — overridable by derived copy
  body: '',
  payload: { taskId: TASK_ID },
  context: {},
  raisedAt: Date.parse('2024-01-01T00:00:00.000Z'),
  lastSeenAt: Date.parse('2024-01-01T00:00:00.000Z'),
  ...overrides,
})

const makeTask = (
  overrides: Partial<TaskForActionQueue> = {},
): TaskForActionQueue => ({
  id: TASK_ID,
  status: 'failed',
  prompt: 'Implement the feature',
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

const BASE = {
  repoRoot: '/nonexistent',
  filter: 'open' as const,
}

// ── §9 beat 3: cold-readable failure alerts ───────────────────────────────────

describe('§9 beat 3 — failed alert reads cold', () => {
  it('headline names task id, phase, and warm summary for a known signature', async () => {
    // "Task mars-a1b2c3d4 failed at verify:test: The changes did not pass the tests"
    // An operator who has never seen this task knows immediately what failed and where.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'verify:test/test-assertion-error' }),
      ]),
      ...BASE,
    })

    expect(rows).toHaveLength(1)
    const title = rows[0]!.title

    // Must contain the short task id so the row is uniquely actionable.
    // shortId('mars-a1b2c3d4') = 'mars-a1b2c3d4' (returned unchanged).
    expect(title).toContain(TASK_ID)

    // Must name the phase — "failed at verify:test" — without a raw step slug.
    expect(title).toContain('failed at verify:test')

    // Must carry a plain-English summary (the warmTitle from the failure-kinds
    // registry), not a machine key like 'test-assertion-error'.
    expect(title).not.toContain('test-assertion-error')
    expect(title).not.toContain('[task') // no old [task …] bracketed form
  })

  it('body names the decision, not the verbose reason or failure signature', async () => {
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'verify:test/test-assertion-error' }),
      ]),
      ...BASE,
    })

    // The body is a plain-language call to action, not a technical explanation.
    expect(rows[0]!.body).toBe(
      'Continue on the existing worktree, restart from scratch, or drop',
    )
    // The failure signature must not appear on the card face.
    expect(rows[0]!.body).not.toContain('verify:test/test-assertion-error')
  })

  it('unregistered signature: body is still the decision, not the raw signature', async () => {
    // Even when the signature has no registry entry, the card face shows the
    // step-family explanation and the decision options — never the raw key.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({ failureSignature: 'setup:some-new-step/brand-new-failure' }),
      ]),
      ...BASE,
    })

    expect(rows[0]!.body).toBe(
      'Continue on the existing worktree, restart from scratch, or drop',
    )
    expect(rows[0]!.body).not.toContain('Failure signature:')
    expect(rows[0]!.body).not.toContain('brand-new-failure')
  })

  it('no-signature row names the task and says it failed with the error head', async () => {
    // When the pipeline captured no structured signature, the operator still
    // sees the task id and the first meaningful line of captured output.
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([makeRow()]),
      taskStore: makeTaskStore([
        makeTask({
          failureSignature: null,
          lastErrorOutput: 'ENOMEM: not enough memory\nfull trace here',
        }),
      ]),
      ...BASE,
    })

    const title = rows[0]!.title
    expect(title).toContain(TASK_ID)
    expect(title).toContain('failed')
    // Decision body still applies even when phase is unknown.
    expect(rows[0]!.body).toBe(
      'Continue on the existing worktree, restart from scratch, or drop',
    )
  })

  it('two failed rows with different tasks produce two distinguishable headlines', async () => {
    // Discrimination: even if two tasks fail with the same failure kind, the
    // task id in each headline makes them uniquely identifiable at a glance.
    // Use proper Mars IDs: 'mars-' + 8 hex chars.
    const ID_A = 'mars-aaaaaaaa'
    const ID_B = 'mars-bbbbbbbb'
    const rows = await buildActionQueueView({
      stateStore: makeStateStore([
        makeRow({ id: 'row-1', payload: { taskId: ID_A } }),
        makeRow({ id: 'row-2', payload: { taskId: ID_B } }),
      ]),
      taskStore: makeTaskStore([
        makeTask({
          id: ID_A,
          failureSignature: 'verify:test/test-assertion-error',
        }),
        makeTask({
          id: ID_B,
          failureSignature: 'verify:test/test-assertion-error',
        }),
      ]),
      ...BASE,
    })

    const [t1, t2] = rows.map((r) => r.title)
    expect(t1).not.toBe(t2)
    expect(t1).toContain(ID_A)
    expect(t2).toContain(ID_B)
  })
})
