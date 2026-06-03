/**
 * Tests for the verdict-driven dispatch that fires when a diagnose Chore
 * reaches `done`. Acceptance criteria (PRD 06e677fb, slice 3/6):
 *
 *  - The orchestrator reads the verdict from the structured store, never
 *    from the Chore's prose output.
 *  - A root-cause verdict produces exactly one fix attempt, idempotent.
 *  - The fix attempt's prompt contains the recorded evidence, involved
 *    files, and fix direction verbatim.
 *  - The original task is re-parked blocked behind the fix attempt.
 *  - Non-root-cause verdicts (inconclusive / no-verdict) produce no fix
 *    attempt and park the parent failed with one actionable actionQueue item.
 *  - onBlockerTaskCompleted delegates to verdict-driven dispatch for any
 *    task with kind='diagnose', never running the generic re-queue path.
 *  - A failing diagnose Chore never spawns a fix task or investigator
 *    (the terminality invariant; prevents recursion).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  addBlockers: typeof import('../../queue').addBlockers
  resolveQueueClient: typeof import('../../queue').resolveQueueClient
  migrateQueueSchema: typeof import('../../queue').migrateQueueSchema
}

interface DiagnoseModule {
  setDiagnosis: typeof import('../diagnose').setDiagnosis
}

interface ActionQueueModule {
  initActionQueue: typeof import('../action-queue').initActionQueue
}

interface FollowupModule {
  runDiagnoseFollowup: typeof import('../diagnose-followup').runDiagnoseFollowup
}

interface BlockerModule {
  onBlockerTaskCompleted: typeof import('../../blocker-resolution').onBlockerTaskCompleted
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('../../queue-fix-tasks').handleTaskFailureWithFixTask
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-diagnose-dispatch-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

let templateRepo: string

const TEMPLATE_DB_FILES = ['queue.db', 'state.db'] as const

const cloneTemplateDbs = (destRepo: string): void => {
  for (const file of TEMPLATE_DB_FILES) {
    const src = resolve(templateRepo, '.mars', file)
    if (!existsSync(src)) continue
    copyFileSync(src, resolve(destRepo, '.mars', file))
  }
}

const loadModules = async (repo: string) => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.migrateQueueSchema()
  const diagn = (await import('../diagnose')) as unknown as DiagnoseModule
  const followup = (await import(
    '../diagnose-followup'
  )) as unknown as FollowupModule
  const br = (await import(
    '../../blocker-resolution'
  )) as unknown as BlockerModule
  const ft = (await import(
    '../../queue-fix-tasks'
  )) as unknown as FixTasksModule
  return { q, diagn, followup, br, ft }
}

describe('diagnose root-cause dispatch', () => {
  let repo: string

  beforeAll(async () => {
    templateRepo = setupRepo()
    vi.resetModules()
    process.env.MARS_REPO = templateRepo
    const q = (await import('../../queue')) as unknown as QueueModule
    await q.migrateQueueSchema()
    const actionQueue = (await import('../action-queue')) as unknown as ActionQueueModule
    await actionQueue.initActionQueue()
    // Seed the diagnoses table into the template so clones already have it.
    const { getDiagnosis } = (await import('../diagnose')) as unknown as {
      getDiagnosis: (id: string) => Promise<unknown>
    }
    await getDiagnosis('template-seed')
    delete process.env.MARS_REPO
    vi.resetModules()
  })

  afterAll(() => {
    rmSync(templateRepo, { recursive: true, force: true })
  })

  beforeEach(() => {
    repo = setupRepo()
    cloneTemplateDbs(repo)
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    rmSync(repo, { recursive: true, force: true })
  })

  // ── Tracer bullet ────────────────────────────────────────────────────
  it('root-cause verdict dispatches exactly one fix attempt seeded with the diagnosis', async () => {
    const { q, diagn, followup } = await loadModules(repo)

    const parent = await q.enqueueTask('original task prompt', undefined, {
      skipTriage: true,
    })
    await q.updateTask(parent.id, { status: 'blocked' })

    const chore = await q.enqueueTask('diagnose chore prompt', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    await q.updateTask(chore.id, { status: 'done' })
    await q.addBlockers(parent.id, [chore.id])

    await diagn.setDiagnosis(chore.id, {
      kind: 'root-cause-found',
      evidence: 'foo() throws TypeError on null input at line 42',
      involvedFiles: ['src/foo.ts'],
      fixDirection: 'add null guard before calling foo',
    })

    const result = await followup.runDiagnoseFollowup(chore.id)

    expect(result.action).toBe('fix-dispatched')
    expect(result.fixTaskId).toBeTruthy()
    expect(result.parentTaskId).toBe(parent.id)
    expect(result.verdictKind).toBe('root-cause-found')

    const fix = await q.getTask(result.fixTaskId!)
    expect(fix?.status).toBe('queued')
  })

  // ── Fix prompt carries diagnosis verbatim ─────────────────────────────
  it('fix task prompt contains evidence, involved files, and fix direction verbatim', async () => {
    const { q, diagn, followup } = await loadModules(repo)

    const parent = await q.enqueueTask('parent task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(parent.id, { status: 'blocked' })

    const chore = await q.enqueueTask('diagnose chore', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    await q.updateTask(chore.id, { status: 'done' })
    await q.addBlockers(parent.id, [chore.id])

    const evidence =
      'widget.render() throws TypeError: cannot read properties of undefined (reading "mount")'
    const fixDirection =
      'initialise widget before calling render in the setup phase'

    await diagn.setDiagnosis(chore.id, {
      kind: 'root-cause-found',
      evidence,
      involvedFiles: ['src/widget.ts', 'src/setup.ts'],
      fixDirection,
    })

    const result = await followup.runDiagnoseFollowup(chore.id)
    expect(result.action).toBe('fix-dispatched')

    const fix = await q.getTask(result.fixTaskId!)
    expect(fix?.prompt).toContain(evidence)
    expect(fix?.prompt).toContain('src/widget.ts')
    expect(fix?.prompt).toContain('src/setup.ts')
    expect(fix?.prompt).toContain(fixDirection)
  })

  // ── Parent re-parked behind fix, not re-queued ───────────────────────
  it('parent is parked blocked behind the new fix task and is not re-queued', async () => {
    const { q, diagn, followup } = await loadModules(repo)

    const parent = await q.enqueueTask('parent task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(parent.id, { status: 'blocked' })

    const chore = await q.enqueueTask('diagnose chore', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    await q.updateTask(chore.id, { status: 'done' })
    await q.addBlockers(parent.id, [chore.id])

    await diagn.setDiagnosis(chore.id, {
      kind: 'root-cause-found',
      evidence: 'handler throws on malformed input',
      involvedFiles: ['src/handler.ts'],
      fixDirection: 'validate input before processing',
    })

    const result = await followup.runDiagnoseFollowup(chore.id)
    expect(result.action).toBe('fix-dispatched')

    const updatedParent = await q.getTask(parent.id)
    expect(updatedParent?.status).toBe('blocked')

    // The parent should be blocked behind the new fix task, not the Chore
    const blockers = await q.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [parent.id],
    })
    const blockerIds = (
      blockers.rows as unknown as Array<{ blocker_task_id: string }>
    ).map((r) => r.blocker_task_id)
    expect(blockerIds).toContain(result.fixTaskId)
    expect(blockerIds).not.toContain(chore.id)
  })

  // ── Idempotency: second completion is a no-op ─────────────────────────
  it('second completion call produces no additional fix task', async () => {
    const { q, diagn, followup } = await loadModules(repo)

    const parent = await q.enqueueTask('parent task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(parent.id, { status: 'blocked' })

    const chore = await q.enqueueTask('diagnose chore', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    await q.updateTask(chore.id, { status: 'done' })
    await q.addBlockers(parent.id, [chore.id])

    await diagn.setDiagnosis(chore.id, {
      kind: 'root-cause-found',
      evidence: 'some evidence',
      involvedFiles: ['src/x.ts'],
      fixDirection: 'fix direction',
    })

    const first = await followup.runDiagnoseFollowup(chore.id)
    expect(first.action).toBe('fix-dispatched')

    // Second call: the Chore blocker edge is gone, so this is a no-op
    const second = await followup.runDiagnoseFollowup(chore.id)
    expect(second.action).toBe('noop')

    // Exactly one blocker remains (the fix task from the first call)
    const blockers = await q.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [parent.id],
    })
    expect(
      (blockers.rows as unknown as Array<{ blocker_task_id: string }>).length,
    ).toBe(1)
  })

  // ── Inconclusive verdict: parent fails, no fix ────────────────────────
  it('inconclusive verdict raises actionQueue item and parks parent failed with no fix task', async () => {
    const { q, diagn, followup } = await loadModules(repo)

    const parent = await q.enqueueTask('parent task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(parent.id, { status: 'blocked' })

    const chore = await q.enqueueTask('diagnose chore', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    await q.updateTask(chore.id, { status: 'done' })
    await q.addBlockers(parent.id, [chore.id])

    await diagn.setDiagnosis(chore.id, {
      kind: 'inconclusive',
      whatChecked: 'read all test files and source; ran tests locally',
      whyUnscoped: 'task references a feature not yet present in the repo',
    })

    const result = await followup.runDiagnoseFollowup(chore.id)

    expect(result.action).toBe('action-queue-raised')
    expect(result.actionQueueItemId).toBeTruthy()
    expect(result.verdictKind).toBe('inconclusive')
    expect(result.parentTaskId).toBe(parent.id)

    const updatedParent = await q.getTask(parent.id)
    expect(updatedParent?.status).toBe('failed')
  })

  // ── No-verdict: same treatment as inconclusive ─────────────────────────
  it('no-verdict (Chore done without recording) parks parent failed with no fix task', async () => {
    const { q, followup } = await loadModules(repo)

    const parent = await q.enqueueTask('parent task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(parent.id, { status: 'blocked' })

    const chore = await q.enqueueTask('diagnose chore', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    await q.updateTask(chore.id, { status: 'done' })
    await q.addBlockers(parent.id, [chore.id])

    // No setDiagnosis call — Chore completed without recording a verdict

    const result = await followup.runDiagnoseFollowup(chore.id)

    expect(result.action).toBe('action-queue-raised')
    expect(result.verdictKind).toBe('no-verdict')

    const updatedParent = await q.getTask(parent.id)
    expect(updatedParent?.status).toBe('failed')
  })

  // ── Integration: onBlockerTaskCompleted delegates for diagnose Chores ──
  it('onBlockerTaskCompleted uses verdict-driven dispatch for diagnose Chores, not generic re-queue', async () => {
    const { q, diagn, br } = await loadModules(repo)

    const parent = await q.enqueueTask('parent task', undefined, {
      skipTriage: true,
    })
    await q.updateTask(parent.id, { status: 'blocked' })

    const chore = await q.enqueueTask('diagnose chore', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    await q.updateTask(chore.id, { status: 'done' })
    await q.addBlockers(parent.id, [chore.id])

    await diagn.setDiagnosis(chore.id, {
      kind: 'root-cause-found',
      evidence: 'NPE in request handler at line 88',
      involvedFiles: ['src/handler.ts'],
      fixDirection: 'add null check before accessing req.body',
    })

    // Trigger through the public blocker-resolution entry point
    const completion = await br.onBlockerTaskCompleted(chore.id)
    expect(completion.blockerTaskId).toBe(chore.id)

    // Parent must NOT have been re-queued — verdict-driven path parks it
    // blocked behind the new fix task instead.
    const updatedParent = await q.getTask(parent.id)
    expect(updatedParent?.status).toBe('blocked')

    const blockers = await q.resolveQueueClient().execute({
      sql: `SELECT blocker_task_id FROM task_blockers WHERE task_id = ?`,
      args: [parent.id],
    })
    const blockerIds = (
      blockers.rows as unknown as Array<{ blocker_task_id: string }>
    ).map((r) => r.blocker_task_id)
    // Chore edge must be gone; exactly one blocker remains (the new fix task)
    expect(blockerIds).not.toContain(chore.id)
    expect(blockerIds.length).toBe(1)
    const fixTask = await q.getTask(blockerIds[0])
    expect(fixTask?.status).toBe('queued')
  })

  // ── Terminality: failing diagnose Chore never spawns fix/investigator ──
  it('a failing diagnose Chore is marked failed without spawning a fix task or investigator', async () => {
    const { q, ft } = await loadModules(repo)

    const chore = await q.enqueueTask('diagnose chore', undefined, {
      skipTriage: true,
      kind: 'diagnose',
    })
    // Chore fails during execution
    await q.updateTask(chore.id, { status: 'running' })

    const result = await ft.handleTaskFailureWithFixTask({
      taskId: chore.id,
      failingStep: 'code',
      errorOutput: 'timeout exceeded while reading source files',
    })

    // Outcome must be 'failed', never 'blocked', 'no-recipe', or 'escalated'
    expect(result.outcome).toBe('failed')

    // No child tasks spawned for the diagnose Chore
    const children = await q.resolveQueueClient().execute({
      sql: `SELECT id FROM tasks WHERE fix_for_task_id = ? OR origin_id = ? AND id != ?`,
      args: [chore.id, chore.id, chore.id],
    })
    expect(
      (children.rows as unknown as Array<{ id: string }>).length,
    ).toBe(0)
  })
})
