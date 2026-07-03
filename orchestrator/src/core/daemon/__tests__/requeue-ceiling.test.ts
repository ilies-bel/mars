/**
 * Tests for the poll-fallback step-attempt ceiling (Fix 2, mars-c11be862).
 *
 * The ceiling prevents a re-queue loop from spinning indefinitely when a task
 * is stuck: if any step has been attempted REQUEUE_STEP_CEILING times without
 * the run completing, the task is escalated to 'failed' and an operator
 * action-queue item is raised instead of being re-seeded.
 *
 * Root cause of the 2026-07-02 overnight loop: tasks reached 1,014 step
 * attempts at ~2/min because the poll-fallback had no attempt ceiling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { WorkflowStore, StepRecord } from '@mars/workflow'

// ──────────────────────────────────────────────────────────────────────────────
// Module-isolation helpers (vi.resetModules isolates singletons per test)
// ──────────────────────────────────────────────────────────────────────────────

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  getTask: typeof import('../../queue').getTask
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface WorkflowStoreModule {
  createQueueWorkflowStore: typeof import('../../../workflows/queue-workflow-store').createQueueWorkflowStore
}

interface ActionQueueModule {
  listActionQueueItems: typeof import('../../lib/action-queue').listActionQueueItems
}

interface CeilingModule {
  checkAndEscalateRequeueCeiling: typeof import('../requeue-ceiling').checkAndEscalateRequeueCeiling
  REQUEUE_STEP_CEILING: number
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-ceiling-'))
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  ws: WorkflowStoreModule
  aq: ActionQueueModule
  ceiling: CeilingModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const ws = (await import(
    '../../../workflows/queue-workflow-store'
  )) as unknown as WorkflowStoreModule
  const aq = (await import('../../lib/action-queue')) as unknown as ActionQueueModule
  const ceiling = (await import('../requeue-ceiling')) as unknown as CeilingModule
  return { q, ws, aq, ceiling }
}

const makeSilentLog = (): ((msg: string) => void) => () => {}

// Build a minimal StepRecord so tests don't have to spell out all fields.
const makeStepRecord = (
  runId: string,
  name: string,
  attempt: number,
  status: StepRecord['status'] = 'completed',
): StepRecord => ({
  runId,
  name,
  status,
  sha: null,
  startedAt: 0,
  finishedAt: null,
  attempt,
  summary: null,
  errorSummary: null,
  transcriptKey: null,
  resultJson: null,
})

describe('checkAndEscalateRequeueCeiling', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Ceiling escalation ──────────────────────────────────────────────────

  it('escalates to failed and raises action-queue item when max attempt reaches ceiling', async () => {
    const { q, ws, aq, ceiling } = await loadModules(repo)
    const t = await q.enqueueTask('stuck task', undefined, { skipTriage: true })

    const store: WorkflowStore = ws.createQueueWorkflowStore()

    // Seed a run and a step at exactly the ceiling.
    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(
      makeStepRecord(t.id, 'setup-worktree', ceiling.REQUEUE_STEP_CEILING, 'failed'),
    )

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
    )

    // Returns true → caller must NOT re-seed.
    expect(escalated).toBe(true)

    // Task status flipped to failed.
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
    expect(reloaded?.failureReasonCode).toBe('requeue-ceiling-exceeded')
    expect(reloaded?.error).toMatch(/ceiling/)

    // An open action-queue item was raised for this task.
    const items = await aq.listActionQueueItems('open')
    expect(items.some((i) => i.originTaskId === t.id && i.kind === 'failed')).toBe(true)
  })

  it('escalates when max attempt exceeds ceiling (more than REQUEUE_STEP_CEILING)', async () => {
    const { q, ws, ceiling } = await loadModules(repo)
    const t = await q.enqueueTask('very stuck task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    // Simulate the 1,014-attempt overnight scenario (saturated at ceiling for the test).
    await store.putStep(
      makeStepRecord(t.id, 'setup-worktree', ceiling.REQUEUE_STEP_CEILING + 50, 'failed'),
    )

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
    )
    expect(escalated).toBe(true)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
  })

  // ── No escalation ───────────────────────────────────────────────────────

  it('does not escalate when max attempt is below ceiling', async () => {
    const { q, ws, ceiling } = await loadModules(repo)
    const t = await q.enqueueTask('healthy task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    await store.putStep(
      makeStepRecord(t.id, 'setup-worktree', ceiling.REQUEUE_STEP_CEILING - 1),
    )

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
    )
    expect(escalated).toBe(false)

    // Task status must be unchanged (still queued).
    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('does not escalate a task with no step records', async () => {
    // A task that has never been dispatched has no step records — attempt = 0,
    // which is below the ceiling, so it should be re-seeded normally.
    const { q, ws, ceiling } = await loadModules(repo)
    const t = await q.enqueueTask('fresh task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    // No createRun / putStep calls — this task has no workflow run yet.

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
    )
    expect(escalated).toBe(false)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('queued')
  })

  it('uses the maximum attempt across ALL steps (not just the first step)', async () => {
    // If the setup step completed once (attempt 1) but the code step has been
    // attempted REQUEUE_STEP_CEILING times, it's the code step that must trigger
    // escalation.
    const { q, ws, ceiling } = await loadModules(repo)
    const t = await q.enqueueTask('code-stuck task', undefined, { skipTriage: true })
    const store: WorkflowStore = ws.createQueueWorkflowStore()

    await store.createRun({
      id: t.id,
      workflowId: 'implement',
      inputJson: '{}',
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    })
    // Setup completed once — healthy.
    await store.putStep(makeStepRecord(t.id, 'setup-worktree', 1, 'completed'))
    // Code step stuck at ceiling.
    await store.putStep(
      makeStepRecord(t.id, 'code', ceiling.REQUEUE_STEP_CEILING, 'failed'),
    )

    const escalated = await ceiling.checkAndEscalateRequeueCeiling(
      t,
      store,
      makeSilentLog(),
    )
    expect(escalated).toBe(true)

    const reloaded = await q.getTask(t.id)
    expect(reloaded?.status).toBe('failed')
  })
})
