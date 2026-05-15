import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

interface QueueModule {
  enqueueTask: typeof import('../../queue').enqueueTask
  updateTask: typeof import('../../queue').updateTask
  getTask: typeof import('../../queue').getTask
  getClient: typeof import('../../queue').getClient
  initQueue: typeof import('../../queue').initQueue
  addBlockers: typeof import('../../queue').addBlockers
  dropTask: typeof import('../../queue').dropTask
}

interface FixTasksModule {
  upsertFixTask: typeof import('../../queue-fix-tasks').upsertFixTask
}

interface RecipesModule {
  recipes: typeof import('../fix-recipes').recipes
}

const setupRepo = (): string => {
  const repo = mkdtempSync(resolve(tmpdir(), 'mars-drop-task-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  return repo
}

const loadModules = async (
  repo: string,
): Promise<{ q: QueueModule; ft: FixTasksModule; rc: RecipesModule }> => {
  vi.resetModules()
  process.env.MARS_REPO = repo
  const q = (await import('../../queue')) as unknown as QueueModule
  await q.initQueue()
  const ft = (await import(
    '../../queue-fix-tasks'
  )) as unknown as FixTasksModule
  const rc = (await import('../fix-recipes')) as unknown as RecipesModule
  return { q, ft, rc }
}

const registerTestRecipe = (
  rc: RecipesModule,
  signature: string,
): (() => void) => {
  rc.recipes[signature] = {
    signature,
    title: () => `test recipe: ${signature}`,
    buildPrompt: () => `synthetic recovery prompt for ${signature}`,
  }
  return () => {
    delete rc.recipes[signature]
  }
}

describe('dropTask (universal deletion)', () => {
  let repo: string

  beforeEach(() => {
    repo = setupRepo()
  })

  afterEach(() => {
    delete process.env.MARS_REPO
    delete process.env.MARS_FIX_RETRY_BUDGET
    rmSync(repo, { recursive: true, force: true })
  })

  it('drops a queued task that is referenced by a queued recovery (clears fix_for_task_id on the dependent row)', async () => {
    // Reproduces the symptom from the task brief:
    //   parent task in queued/failed, child fix task in queued status with
    //   fix_for_task_id -> parent. `mars purge <parent>` fails with FK error
    //   (in the relaxed-fk world here, the conceptual dangling-pointer
    //   problem). `dropTask(parent)` should null out the child's pointer
    //   instead of erroring.
    process.env.MARS_FIX_RETRY_BUDGET = '5'
    const { q, ft, rc } = await loadModules(repo)
    const cleanup = registerTestRecipe(rc, 'sig-drop')
    const parent = await q.enqueueTask('parent', undefined, {
      skipTriage: true,
    })
    const r = await ft.upsertFixTask({
      sourceTaskId: parent.id,
      failureSignature: 'sig-drop',
      failingStep: 'verify:typecheck',
      truncatedError: 'TS2304',
      branch: 'task/x',
      recipeContext: {
        targetPath: '/tmp/x',
        statusOutput: 'TS2304',
        targetBranch: 'task/x',
        originalPrompt: '',
      },
    })
    expect(r.created).toBe(true)
    // sanity: the upsert blocked the parent
    const reloadedParent = await q.getTask(parent.id)
    expect(reloadedParent?.status).toBe('blocked')

    const result = await q.dropTask(parent.id)

    expect(result.taskId).toBe(parent.id)
    expect(result.previousStatus).toBe('blocked')
    expect(result.fixForRefsCleared).toEqual([r.fixTaskId])
    // The parent had one incoming task_blockers edge (the fix task waits
    // on... no, the fix task is the blocker; the parent has an *outgoing*
    // edge as task_id -> blocker_task_id=fix). Either way both should be 1.
    expect(
      result.edgesRemoved.incoming + result.edgesRemoved.outgoing,
    ).toBeGreaterThanOrEqual(1)

    // Parent row is gone.
    expect(await q.getTask(parent.id)).toBeNull()

    // Child row survives, with fix_for_task_id nulled out.
    const child = await q.getTask(r.fixTaskId)
    expect(child).not.toBeNull()
    expect(child?.fixForTaskId).toBeNull()

    // No leftover task_blockers edges mentioning the dropped id.
    const leftover = await q.getClient().execute({
      sql: `SELECT COUNT(*) AS n FROM task_blockers WHERE task_id = ? OR blocker_task_id = ?`,
      args: [parent.id, parent.id],
    })
    expect(
      Number((leftover.rows[0] as unknown as { n: number | bigint }).n),
    ).toBe(0)
    cleanup()
  })

  it('drops a plain queued task with no edges', async () => {
    const { q } = await loadModules(repo)
    const t = await q.enqueueTask('do thing', undefined, { skipTriage: true })
    const result = await q.dropTask(t.id)
    expect(result.taskId).toBe(t.id)
    expect(result.previousStatus).toBe('queued')
    expect(result.edgesRemoved).toEqual({ incoming: 0, outgoing: 0 })
    expect(result.fixForRefsCleared).toEqual([])
    expect(await q.getTask(t.id)).toBeNull()
  })

  it('drops a blocked task and clears every outgoing task_blockers edge', async () => {
    const { q } = await loadModules(repo)
    const a = await q.enqueueTask('a', undefined, { skipTriage: true })
    const b = await q.enqueueTask('b', undefined, { skipTriage: true })
    const c = await q.enqueueTask('c', undefined, { skipTriage: true })
    await q.addBlockers(a.id, [b.id, c.id])

    const result = await q.dropTask(a.id)
    expect(result.edgesRemoved.outgoing).toBe(2)
    expect(result.edgesRemoved.incoming).toBe(0)

    // Blockers themselves untouched.
    expect((await q.getTask(b.id))?.id).toBe(b.id)
    expect((await q.getTask(c.id))?.id).toBe(c.id)
  })

  it('throws if the task does not exist', async () => {
    const { q } = await loadModules(repo)
    await expect(q.dropTask('mars-deadbeef')).rejects.toThrow(
      /task mars-deadbeef not found/,
    )
  })
})
