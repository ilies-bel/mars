/**
 * Tests for the manual-QA pass/fail wiring:
 *
 *   (a) `mars step done` on a 'review'-step task calls `preview.teardown`
 *       before sending `step-done`; non-review tasks skip teardown entirely.
 *
 *   (b) `mars release --abort --note '<text>'` sends `preview.teardown` then
 *       `release-lease` with abort=true and the note attached; the note lands
 *       verbatim in the recovery fix-task prompt under a `## QA note` heading.
 *
 *   (c) `mars release --abort` (no note) still sends teardown + release-lease;
 *       the recovery fix-task prompt has no `## QA note` section.
 *
 * All CLI-seam tests use the in-process command runner + recording fake daemon
 * (ADR-0023). Prompt-content tests exercise `handleTaskFailureWithFixTask`
 * directly against a real in-process SQLite DB.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  runCommandInProcess,
  makeFakeDaemon,
} from '../test-adapter'
import type { DomainTaskStore } from '../../core/store/task-store'
import type { OrchestratorContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Module type shims (loaded dynamically via vi.resetModules() isolation)
// ---------------------------------------------------------------------------

interface QueueModule {
  enqueueTask: typeof import('../../core/queue').enqueueTask
  updateTask: typeof import('../../core/queue').updateTask
  getTask: typeof import('../../core/queue').getTask
  resolveQueueClient: typeof import('../../core/queue').resolveQueueClient
  ensureQueueSchema: typeof import('../../core/queue').ensureQueueSchema
  migrateQueueSchema: typeof import('../../core/queue').migrateQueueSchema
}

interface FixTasksModule {
  handleTaskFailureWithFixTask: typeof import('../../core/queue-fix-tasks').handleTaskFailureWithFixTask
}

interface RecipesModule {
  recipes: typeof import('../../core/lib/fix-recipes').recipes
}

interface StoreModule {
  createTaskStore: typeof import('../../core/store/task-store').createTaskStore
}

interface ContextModule {
  resolveContext: typeof import('../../core/context').resolveContext
}

// ---------------------------------------------------------------------------
// Repo setup
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-qa-teardown-test-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/** A clean committed worktree that passes the dirty-worktree guard. */
const setupCleanWorktree = (): string => {
  const wt = mkdtempSync(resolve(tmpdir(), 'mars-qa-wt-'))
  execFileSync('git', ['init', '-q'], { cwd: wt })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: wt })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: wt })
  writeFileSync(resolve(wt, 'README.md'), 'hello')
  execFileSync('git', ['add', '.'], { cwd: wt })
  execFileSync('git', ['commit', '-m', 'initial', '--allow-empty'], { cwd: wt })
  return wt
}

// ---------------------------------------------------------------------------
// Dynamic module loader (CLI tests)
// ---------------------------------------------------------------------------

const loadCliModules = async (repo: string): Promise<{
  store: DomainTaskStore
  ctx: OrchestratorContext
  q: QueueModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo

  const q = (await import('../../core/queue')) as unknown as QueueModule
  await q.migrateQueueSchema()

  const storeModule = (await import('../../core/store/task-store')) as unknown as StoreModule
  const ctxModule = (await import('../../core/context')) as unknown as ContextModule

  return {
    q,
    store: storeModule.createTaskStore(q.resolveQueueClient()),
    ctx: ctxModule.resolveContext(repo),
  }
}

/** Create a task in awaiting-human with the given currentStepName and leaseOwner. */
const makeAwaitingHumanTask = async (
  q: QueueModule,
  opts: {
    currentStepName?: string | null
    leaseOwner?: string
    worktreePath?: string | null
  } = {},
): Promise<string> => {
  const task = await q.enqueueTask('test manual qa task', undefined, { skipTriage: true })
  await q.updateTask(task.id, {
    status: 'awaiting-human',
    branch: `task/${task.id}`,
    worktreePath: opts.worktreePath ?? null,
    leaseOwner: opts.leaseOwner ?? 'test@host',
    leasedAt: new Date().toISOString(),
    currentStepName: opts.currentStepName !== undefined ? opts.currentStepName : null,
  })
  return task.id
}

// ---------------------------------------------------------------------------
// Dynamic module loader (DB / prompt tests)
// ---------------------------------------------------------------------------

const loadDbModules = async (repo: string): Promise<{
  q: QueueModule
  ft: FixTasksModule
  rc: RecipesModule
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repo

  const q = (await import('../../core/queue')) as unknown as QueueModule
  await q.ensureQueueSchema()

  const ft = (await import('../../core/queue-fix-tasks')) as unknown as FixTasksModule
  const rc = (await import('../../core/lib/fix-recipes')) as unknown as RecipesModule

  return { q, ft, rc }
}

/** Register a synthetic recipe that returns a deterministic base prompt. */
const registerTestRecipe = (
  rc: RecipesModule,
  sig: string,
  basePrompt = 'base recovery prompt',
): (() => void) => {
  rc.recipes[sig] = {
    signature: sig,
    title: () => `test: ${sig}`,
    buildPrompt: () => basePrompt,
  }
  return () => {
    delete rc.recipes[sig]
  }
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let repo: string
let worktrees: string[] = []

beforeEach(() => {
  repo = setupRepo()
  worktrees = []
})

afterEach(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
  for (const wt of worktrees) {
    rmSync(wt, { recursive: true, force: true })
  }
})

// ===========================================================================
// (a) mars step done — preview.teardown wiring
// ===========================================================================

describe('mars step done — preview.teardown wiring', () => {
  it('calls preview.teardown before step-done when currentStepName is "review"', async () => {
    const wt = setupCleanWorktree()
    worktrees.push(wt)

    const { store, ctx, q } = await loadCliModules(repo)
    const id = await makeAwaitingHumanTask(q, { currentStepName: 'review', worktreePath: wt })

    const fake = makeFakeDaemon(() => undefined)
    const r = await runCommandInProcess(['step', 'done', id], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(2)
    // teardown fires first
    expect((fake.calls[0] as { op: string; taskId: string }).op).toBe('preview.teardown')
    expect((fake.calls[0] as { op: string; taskId: string }).taskId).toBe(id)
    // then step-done
    expect((fake.calls[1] as { op: string }).op).toBe('step-done')
  })

  it('does NOT call preview.teardown when currentStepName is not "review"', async () => {
    const wt = setupCleanWorktree()
    worktrees.push(wt)

    const { store, ctx, q } = await loadCliModules(repo)
    const id = await makeAwaitingHumanTask(q, { currentStepName: 'code', worktreePath: wt })

    const fake = makeFakeDaemon(() => undefined)
    const r = await runCommandInProcess(['step', 'done', id], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { op: string }).op).toBe('step-done')
  })

  it('swallows preview.teardown errors and still sends step-done', async () => {
    const wt = setupCleanWorktree()
    worktrees.push(wt)

    const { store, ctx, q } = await loadCliModules(repo)
    const id = await makeAwaitingHumanTask(q, { currentStepName: 'review', worktreePath: wt })

    // preview.teardown throws; step-done must still go out
    const fake = makeFakeDaemon((req) => {
      if ((req as { op: string }).op === 'preview.teardown') {
        throw new Error('preview not registered')
      }
    })
    const r = await runCommandInProcess(['step', 'done', id], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    // teardown was attempted
    const ops = (fake.calls as Array<{ op: string }>).map((c) => c.op)
    expect(ops).toContain('preview.teardown')
    expect(ops).toContain('step-done')
  })

  it('does NOT call preview.teardown when currentStepName is null', async () => {
    const wt = setupCleanWorktree()
    worktrees.push(wt)

    const { store, ctx, q } = await loadCliModules(repo)
    const id = await makeAwaitingHumanTask(q, { currentStepName: null, worktreePath: wt })

    const fake = makeFakeDaemon(() => undefined)
    const r = await runCommandInProcess(['step', 'done', id], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { op: string }).op).toBe('step-done')
  })
})

// ===========================================================================
// (b) mars release --abort --note — CLI wiring
// ===========================================================================

describe('mars release --abort --note — CLI wiring', () => {
  it('sends preview.teardown then release-lease with abort=true and note', async () => {
    const wt = setupCleanWorktree()
    worktrees.push(wt)

    const { store, ctx, q } = await loadCliModules(repo)
    const id = await makeAwaitingHumanTask(q, { worktreePath: wt })

    const fake = makeFakeDaemon(() => undefined)
    const r = await runCommandInProcess(
      ['release', '--abort', '--note', 'button is broken on mobile', id],
      { store, ctx, daemon: fake },
    )

    expect(r.code).toBe(0)
    // preview.teardown fires before release-lease
    expect(fake.calls).toHaveLength(2)
    expect((fake.calls[0] as { op: string }).op).toBe('preview.teardown')
    const req = fake.calls[1] as { op: string; id: string; abort: boolean; note?: string }
    expect(req.op).toBe('release-lease')
    expect(req.id).toBe(id)
    expect(req.abort).toBe(true)
    expect(req.note).toBe('button is broken on mobile')
  })
})

// ===========================================================================
// (b) QA note propagation — fix-task prompt content
// ===========================================================================

describe('handleTaskFailureWithFixTask — qaNote propagates into fix-task prompt', () => {
  it('fix-task prompt contains the QA note under ## QA note heading', async () => {
    const { q, ft, rc } = await loadDbModules(repo)

    const task = await q.enqueueTask('original task', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'running',
      branch: `task/${task.id}`,
    })

    const sig = `qa-note-test-${task.id}`
    const basePrompt = 'base recovery prompt from recipe'
    const teardown = registerTestRecipe(rc, sig, basePrompt)

    try {
      const result = await ft.handleTaskFailureWithFixTask({
        taskId: task.id,
        failingStep: 'code',
        errorOutput: `error: ${sig}`,
        qaNote: 'button is broken on mobile',
      })

      expect(['blocked', 'requeued']).toContain(result.outcome)
      expect(result.fixTaskId).toBeDefined()

      const fixTask = await q.getTask(result.fixTaskId!)
      expect(fixTask).toBeTruthy()
      expect(fixTask!.prompt).toContain('## QA note')
      expect(fixTask!.prompt).toContain('button is broken on mobile')
    } finally {
      teardown()
    }
  })
})

// ===========================================================================
// (c) mars release --abort without note — CLI wiring
// ===========================================================================

describe('mars release --abort (no note) — CLI wiring', () => {
  it('sends preview.teardown then release-lease with abort=true and no note', async () => {
    const wt = setupCleanWorktree()
    worktrees.push(wt)

    const { store, ctx, q } = await loadCliModules(repo)
    const id = await makeAwaitingHumanTask(q, { worktreePath: wt })

    const fake = makeFakeDaemon(() => undefined)
    const r = await runCommandInProcess(['release', '--abort', id], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(2)
    expect((fake.calls[0] as { op: string }).op).toBe('preview.teardown')
    const req = fake.calls[1] as { op: string; id: string; abort: boolean; note?: string }
    expect(req.op).toBe('release-lease')
    expect(req.abort).toBe(true)
    // note must be absent / undefined — no QA note was supplied
    expect(req.note).toBeUndefined()
  })
})

// ===========================================================================
// (c) No QA note — fix-task prompt has no ## QA note section
// ===========================================================================

describe('handleTaskFailureWithFixTask — no qaNote means no ## QA note in prompt', () => {
  it('fix-task prompt has no QA note section when note is absent', async () => {
    const { q, ft, rc } = await loadDbModules(repo)

    const task = await q.enqueueTask('original task no-note', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'running',
      branch: `task/${task.id}`,
    })

    const sig = `no-note-test-${task.id}`
    const teardown = registerTestRecipe(rc, sig, 'base prompt without note')

    try {
      const result = await ft.handleTaskFailureWithFixTask({
        taskId: task.id,
        failingStep: 'code',
        errorOutput: `error: ${sig}`,
        // no qaNote
      })

      expect(['blocked', 'requeued']).toContain(result.outcome)
      expect(result.fixTaskId).toBeDefined()

      const fixTask = await q.getTask(result.fixTaskId!)
      expect(fixTask).toBeTruthy()
      expect(fixTask!.prompt).not.toContain('## QA note')
    } finally {
      teardown()
    }
  })
})
