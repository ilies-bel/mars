/**
 * Slice 4 — Inconclusive verdict parks the original task failed with exactly
 * one actionable inbox item.
 *
 * NOTE: The source modules live under src/core/ (the canonical location since
 * the mastra→core rename). This test file sits under src/mastra/ only because
 * the task brief's <verify> command references that path; imports navigate to
 * the real code via relative paths.
 *
 * Acceptance criteria verified here:
 *   AC1  An inconclusive verdict transitions the original task to failed and
 *        creates no fix attempt.
 *   AC2  Exactly one inbox item is raised, carrying what-was-checked and
 *        why-not-scoped from the verdict.
 *   AC3  Re-processing the same inconclusive outcome deduplicates onto the
 *        existing inbox item rather than creating a second one.
 *   AC4  The inbox item, when read, reflects the original task's current
 *        failed state rather than an earlier in-progress snapshot (liveTaskStatus).
 *   AC5  The raised item is actionable and resolvable by the operator following
 *        the established one-item-per-failure model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// Module-interface types — typed stubs so TypeScript tracks what each import
// surface provides without importing at module scope (we need vi.resetModules()
// to give each test a fresh singleton state).

interface QueueModule {
  enqueueTask: typeof import('../../../core/queue').enqueueTask
  updateTask: typeof import('../../../core/queue').updateTask
  getTask: typeof import('../../../core/queue').getTask
  getClient: typeof import('../../../core/queue').getClient
  initQueue: typeof import('../../../core/queue').initQueue
  addBlockers: typeof import('../../../core/queue').addBlockers
}

interface DiagnoseModule {
  setDiagnosis: typeof import('../../../core/lib/diagnose').setDiagnosis
}

interface FollowupModule {
  runDiagnoseFollowup: typeof import('../../../core/lib/diagnose-followup').runDiagnoseFollowup
}

interface ActionQueueModule {
  getActionQueueItem: typeof import('../../../core/lib/action-queue').getActionQueueItem
  listActionQueueItems: typeof import('../../../core/lib/action-queue').listActionQueueItems
  setActionQueueState: typeof import('../../../core/lib/action-queue').setActionQueueState
}

const setupRepo = (): string => {
  const repo = mkdtempSync(
    resolve(tmpdir(), 'mars-diagnose-inconclusive-inbox-test-'),
  )
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{
  q: QueueModule
  d: DiagnoseModule
  f: FollowupModule
  actionQueue: ActionQueueModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../../core/queue')) as unknown as QueueModule
  await q.initQueue()
  const d = (await import('../../../core/lib/diagnose')) as unknown as DiagnoseModule
  const f = (await import('../../../core/lib/diagnose-followup')) as unknown as FollowupModule
  const actionQueue = (await import(
    '../../../core/lib/action-queue'
  )) as unknown as ActionQueueModule
  return { q, d, f, actionQueue }
}

/**
 * Build the canonical "parent task parked behind a done diagnose Chore" state
 * that the implement workflow creates before the followup fires.
 */
const seedParkedParent = async (
  q: QueueModule,
  parentPrompt = 'do the original work',
): Promise<{ parentId: string; choreId: string }> => {
  const parent = await q.enqueueTask(parentPrompt, undefined, {
    skipTriage: true,
  })
  const chore = await q.enqueueTask(
    '# Diagnose-only Chore for ' + parent.id,
    undefined,
    { skipTriage: true, kind: 'diagnose', originId: parent.id },
  )
  // Mark the Chore as done — the daemon stamps this before runDiagnoseFollowup
  // fires; the test reproduces the same sequence.
  await q.updateTask(chore.id, { status: 'done' })
  // Park the parent behind the Chore exactly the way the implement workflow's
  // too-hard branch does it.
  await q.addBlockers(parent.id, [chore.id])
  await q.updateTask(parent.id, { status: 'blocked', failedPhase: 'code' })
  return { parentId: parent.id, choreId: chore.id }
}

describe('diagnose inconclusive inbox', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    delete process.env.MARS_REPO
  })

  // AC1: inconclusive verdict → original task goes to failed, no fix spawned
  it('inconclusive verdict transitions the original task to failed and creates no fix attempt', async () => {
    const { q, d, f } = await loadModules(repo)
    const { parentId, choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'inconclusive',
      whatChecked: 'scanned src/core and src/lib for the missing symbol',
      whyUnscoped: 'the referenced module does not exist in the repository',
    })

    const outcome = await f.runDiagnoseFollowup(choreId)

    expect(outcome.action).toBe('action-queue-raised')
    // No fix was dispatched.
    expect(outcome.fixTaskId).toBeUndefined()

    const parent = await q.getTask(parentId)
    expect(parent?.status).toBe('failed')

    // Only the original parent + the diagnose Chore exist — no fix task spawned.
    const allTasks = await q
      .getClient()
      .execute({ sql: 'SELECT id FROM tasks', args: [] })
    expect(allTasks.rows).toHaveLength(2)
  })

  // AC2: inbox item carries what-was-checked and why-not-scoped verbatim
  it('raises exactly one inbox item carrying what-was-checked and why-not-scoped from the verdict', async () => {
    const { q, d, f, actionQueue } = await loadModules(repo)
    const { choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'inconclusive',
      whatChecked: 'checked files A, B, and C for the bug',
      whyUnscoped: 'no matching entry point found in the codebase',
    })

    const outcome = await f.runDiagnoseFollowup(choreId)
    expect(outcome.actionQueueItemId).toBeDefined()

    const item = await actionQueue.getActionQueueItem(outcome.actionQueueItemId!)
    expect(item).not.toBeNull()
    expect(item?.kind).toBe('diagnose-inconclusive')
    expect(item?.body).toContain('checked files A, B, and C for the bug')
    expect(item?.body).toContain('no matching entry point found in the codebase')

    // Exactly one diagnose-inconclusive item in the open queue.
    const openItems = await actionQueue.listActionQueueItems('open')
    const diagnoseItems = openItems.filter(
      (i) => i.kind === 'diagnose-inconclusive',
    )
    expect(diagnoseItems).toHaveLength(1)
  })

  // AC3: re-processing the same dead end deduplicates onto the existing item
  it('re-processing the same inconclusive outcome deduplicates onto the existing inbox item', async () => {
    const { q, d, f, actionQueue } = await loadModules(repo)
    const { parentId, choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'inconclusive',
      whatChecked: 'x',
      whyUnscoped: 'y',
    })

    const first = await f.runDiagnoseFollowup(choreId)
    expect(first.action).toBe('action-queue-raised')

    // Simulate daemon restart: re-add the blocker edge so the followup can fire
    // a second time against the same dead end.
    await q.getClient().execute({
      sql: `INSERT OR IGNORE INTO task_blockers
              (task_id, blocker_task_id, created_at)
            VALUES (?, ?, ?)`,
      args: [parentId, choreId, new Date().toISOString()],
    })
    const second = await f.runDiagnoseFollowup(choreId)
    expect(second.action).toBe('action-queue-raised')

    // Both invocations return the same item id — no duplicate was created.
    expect(second.actionQueueItemId).toBe(first.actionQueueItemId)

    const openItems = await actionQueue.listActionQueueItems('open')
    const diagnoseItems = openItems.filter(
      (i) => i.kind === 'diagnose-inconclusive',
    )
    expect(diagnoseItems).toHaveLength(1)
  })

  // AC4: liveTaskStatus is fetched at read time — never a raise-time snapshot
  it('inbox item liveTaskStatus reflects the task current state at read time, not a snapshot from when it was raised', async () => {
    const { q, d, f, actionQueue } = await loadModules(repo)
    const { parentId, choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'inconclusive',
      whatChecked: 'inspected all relevant files',
      whyUnscoped: 'task scope is ambiguous',
    })

    const outcome = await f.runDiagnoseFollowup(choreId)
    const itemId = outcome.actionQueueItemId!

    // Immediately after followup the parent is failed; item must reflect that.
    const itemWhenFailed = await actionQueue.getActionQueueItem(itemId)
    expect(itemWhenFailed?.liveTaskStatus).toBe('failed')

    // Operator re-scopes and marks the task done via external means — the item
    // must reflect the NEW state without being re-raised.
    await q.updateTask(parentId, { status: 'done' })
    const itemAfterDone = await actionQueue.getActionQueueItem(itemId)
    expect(itemAfterDone?.liveTaskStatus).toBe('done')
  })

  // AC5: the raised item is actionable (open) and resolvable by the operator
  it('raised item is actionable and resolvable by the operator following the one-item-per-failure model', async () => {
    const { q, d, f, actionQueue } = await loadModules(repo)
    const { choreId } = await seedParkedParent(q)
    await d.setDiagnosis(choreId, {
      kind: 'inconclusive',
      whatChecked: 'scanned the entire codebase',
      whyUnscoped: 'task references a non-existent module',
    })

    const outcome = await f.runDiagnoseFollowup(choreId)
    const itemId = outcome.actionQueueItemId!

    // Item starts as open — the operator can act on it.
    const openItem = await actionQueue.getActionQueueItem(itemId)
    expect(openItem?.state).toBe('open')

    // Operator resolves explicitly (e.g. decides to drop the task).
    await actionQueue.setActionQueueState(itemId, 'resolved', {
      note: 'task dropped — module does not exist',
      by: 'operator',
    })

    const resolvedItem = await actionQueue.getActionQueueItem(itemId)
    expect(resolvedItem?.state).toBe('resolved')
    expect(resolvedItem?.resolutionDetails).not.toBeNull()
    expect(resolvedItem?.resolutionDetails?.note).toBe(
      'task dropped — module does not exist',
    )
    expect(resolvedItem?.resolutionDetails?.resolvedBy).toBe('operator')
  })
})
