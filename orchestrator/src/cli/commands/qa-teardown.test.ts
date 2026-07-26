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
 *
 * A single PGlite instance is shared across all tests via beforeAll/afterAll.
 * PGlite WASM cannot safely run multiple simultaneous instances in the same
 * Node.js process, so vi.resetModules() is NOT used per-test here — modules
 * are loaded once and shared for the lifetime of this test file.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
import type { enqueueTask, updateTask, getTask, resolveQueueClient } from '../../core/queue'
import type { handleTaskFailureWithFixTask } from '../../core/queue-fix-tasks'
import type { recipes } from '../../core/lib/fix-recipes'
import type { createTaskStore } from '../../core/store/task-store'
import type { resolveContext } from '../../core/context'

// ---------------------------------------------------------------------------
// Repo setup helpers
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
// Shared module state — initialised once in beforeAll
// ---------------------------------------------------------------------------

let store: DomainTaskStore
let ctx: OrchestratorContext
let q: {
  enqueueTask: typeof enqueueTask
  updateTask: typeof updateTask
  getTask: typeof getTask
  resolveQueueClient: typeof resolveQueueClient
}
let ft: { handleTaskFailureWithFixTask: typeof handleTaskFailureWithFixTask }
let rc: { recipes: typeof recipes }
let sharedRepo: string
const allWorktrees: string[] = []

beforeAll(async () => {
  sharedRepo = setupRepo()
  process.env.MARS_REPO = sharedRepo

  q = await import('../../core/queue')
  // Warm the schema explicitly so the first test doesn't pay cold-start cost
  const { ensureQueueSchema } = q as unknown as { ensureQueueSchema: () => Promise<void> }
  await ensureQueueSchema()

  ft = await import('../../core/queue-fix-tasks')
  rc = await import('../../core/lib/fix-recipes')

  const storeModule = await import('../../core/store/task-store')
  const ctxModule = await import('../../core/context')
  store = (storeModule as unknown as { createTaskStore: typeof createTaskStore }).createTaskStore(
    q.resolveQueueClient(),
  )
  ctx = (ctxModule as unknown as { resolveContext: typeof resolveContext }).resolveContext(
    sharedRepo,
  )
})

afterAll(() => {
  // Do NOT call db.close() here — explicitly closing a file-backed PGlite
  // instance via its PostgreSQL End packet leaves the WASM runtime in a
  // "terminated" state that prevents subsequent test files from creating new
  // PGlite instances in the same fork. Let the GC reclaim the instance
  // (the same approach used by every other vi.resetModules()-per-test suite).
  delete process.env.MARS_REPO
  rmSync(sharedRepo, { recursive: true, force: true })
  for (const wt of allWorktrees) {
    rmSync(wt, { recursive: true, force: true })
  }
})

// Clean up any per-test spy / mock state.
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a task in awaiting-human with the given currentStepName and leaseOwner. */
const makeAwaitingHumanTask = async (
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

/** Register a synthetic recipe that returns a deterministic base prompt. */
const registerTestRecipe = (
  sig: string,
  basePrompt = 'base recovery prompt',
): (() => void) => {
  const typedRc = rc as { recipes: Record<string, { signature: string; title: () => string; buildPrompt: () => string }> }
  typedRc.recipes[sig] = {
    signature: sig,
    title: () => `test: ${sig}`,
    buildPrompt: () => basePrompt,
  }
  return () => {
    delete typedRc.recipes[sig]
  }
}

// Per-test worktree tracker (cleaned in afterAll above via allWorktrees).
let currentWorktrees: string[] = []

beforeEach(() => {
  currentWorktrees = []
})

afterEach(() => {
  for (const wt of currentWorktrees) {
    rmSync(wt, { recursive: true, force: true })
  }
  currentWorktrees = []
})

const newWorktree = (): string => {
  const wt = setupCleanWorktree()
  currentWorktrees.push(wt)
  allWorktrees.push(wt)
  return wt
}

// ===========================================================================
// (a) mars step done — preview.teardown wiring
// ===========================================================================

describe('mars step done — preview.teardown wiring', () => {
  it('calls preview.teardown before step-done when currentStepName is "review"', async () => {
    const wt = newWorktree()
    const id = await makeAwaitingHumanTask({ currentStepName: 'review', worktreePath: wt })

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
    const wt = newWorktree()
    const id = await makeAwaitingHumanTask({ currentStepName: 'code', worktreePath: wt })

    const fake = makeFakeDaemon(() => undefined)
    const r = await runCommandInProcess(['step', 'done', id], { store, ctx, daemon: fake })

    expect(r.code).toBe(0)
    expect(fake.calls).toHaveLength(1)
    expect((fake.calls[0] as { op: string }).op).toBe('step-done')
  })

  it('swallows preview.teardown errors and still sends step-done', async () => {
    const wt = newWorktree()
    const id = await makeAwaitingHumanTask({ currentStepName: 'review', worktreePath: wt })

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
    const wt = newWorktree()
    const id = await makeAwaitingHumanTask({ currentStepName: null, worktreePath: wt })

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
    const wt = newWorktree()
    const id = await makeAwaitingHumanTask({ worktreePath: wt })

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
    const task = await q.enqueueTask('original task', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'running',
      branch: `task/${task.id}`,
    })

    const sig = `qa-note-test-${task.id}`
    const basePrompt = 'base recovery prompt from recipe'
    const teardown = registerTestRecipe(sig, basePrompt)

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
    const wt = newWorktree()
    const id = await makeAwaitingHumanTask({ worktreePath: wt })

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
    const task = await q.enqueueTask('original task no-note', undefined, { skipTriage: true })
    await q.updateTask(task.id, {
      status: 'running',
      branch: `task/${task.id}`,
    })

    const sig = `no-note-test-${task.id}`
    const teardown = registerTestRecipe(sig, 'base prompt without note')

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
