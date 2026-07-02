/**
 * Proves that the store-layer cross-boundary guard prevents dispatched Workers
 * from writing to the parent/production `.mars/mars.db` when their test suite
 * calls the default-resolution store path.
 *
 * Forensic context (2026-07-02 22:47 UTC): eight rows appeared in the
 * production task queue within 1.1 s because a Worker's vitest run called
 * the default task store, which — via MARS_REPO inherited from the daemon
 * env — resolved to the parent repo's .mars/mars.db rather than an isolated
 * temp store.
 *
 * Three-layer defence:
 *   1. buildWorkerEnv() strips MARS_REPO (claude.ts) so Workers no longer
 *      inherit the repo-root binding.
 *   2. Store-layer worktree guard (task-store.ts): if process.cwd() is inside
 *      <stateDir>/worktrees/<id>/, throw before any write reaches the DB.
 *   3. Vitest hermetic guard (task-store.ts): when VITEST is set, the resolved
 *      stateDir must be inside os.tmpdir(); an out-of-temp path throws.
 *
 * The tests below exercise layers 2 and 3 directly and confirm that the decoy
 * parent DB remains untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a directory layout that mimics a real project with a worktree. */
const setupDecoyParent = (): {
  parentDir: string
  worktreeCwd: string
  decoyDb: string
} => {
  const parentDir = mkdtempSync(resolve(tmpdir(), 'mars-boundary-parent-'))
  const marsDir = resolve(parentDir, '.mars')
  const worktreeCwd = resolve(marsDir, 'worktrees', 'mars-testworker')
  mkdirSync(worktreeCwd, { recursive: true })
  return { parentDir, worktreeCwd, decoyDb: resolve(marsDir, 'mars.db') }
}

// ── Layer 2: worktree CWD guard ───────────────────────────────────────────────

describe('store-layer worktree cross-boundary guard', () => {
  let parentDir: string
  let worktreeCwd: string
  let decoyDb: string
  let cwdSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    ;({ parentDir, worktreeCwd, decoyDb } = setupDecoyParent())
  })

  afterEach(async () => {
    cwdSpy?.mockRestore()
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(parentDir, { recursive: true, force: true })
  })

  it('getDefaultTaskStore() refuses when CWD is inside .mars/worktrees/<id>/ and zero rows land in the decoy parent DB', async () => {
    // Simulate the MARS_REPO env var that the daemon used to leak into Workers
    // before buildWorkerEnv() was fixed to strip it.
    process.env.MARS_REPO = parentDir
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(worktreeCwd)

    vi.resetModules()
    const { getDefaultTaskStore, __resetDefaultTaskStoreForTests } = await import(
      '../task-store'
    )
    __resetDefaultTaskStoreForTests()

    await expect(getDefaultTaskStore()).rejects.toThrow(
      /getDefaultTaskStore\(\) refused.*worktree/,
    )

    // The decoy production DB must NOT have been created or written to.
    expect(existsSync(decoyDb)).toBe(false)
  })

  it('getDefaultDomainTaskStore() refuses when CWD is inside .mars/worktrees/<id>/', async () => {
    process.env.MARS_REPO = parentDir
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(worktreeCwd)

    vi.resetModules()
    const { getDefaultDomainTaskStore } = await import('../task-store')

    expect(() => getDefaultDomainTaskStore()).toThrow(
      /getDefaultDomainTaskStore\(\) refused.*worktree/,
    )

    expect(existsSync(decoyDb)).toBe(false)
  })

  it('createTaskStore() is unguarded and works from a worktree CWD (escape hatch for hermetic test stores)', async () => {
    // createTaskStore() is intentionally NOT guarded: tests that want an
    // isolated store should pass their own :memory: or file-URL client.
    process.env.MARS_REPO = parentDir
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(worktreeCwd)

    vi.resetModules()
    const queueModule = await import('../../queue')
    const { createTaskStore } = await import('../task-store')

    await queueModule.migrateQueueSchema()
    const store = createTaskStore(queueModule.resolveQueueClient())

    // Should not throw — and should be able to enqueue / read back.
    const task = await store.enqueueTask('isolated test task', undefined, {
      skipTriage: true,
    })
    const fetched = await store.getTask(task.id)
    expect(fetched?.prompt).toBe('isolated test task')
  })
})

// ── Layer 3: vitest hermetic guard ────────────────────────────────────────────

describe('vitest hermetic store guard', () => {
  afterEach(() => {
    delete process.env.MARS_REPO
    vi.resetModules()
  })

  it('getDefaultTaskStore() throws when VITEST is set and stateDir resolves outside tmpdir', async () => {
    // Simulate a Worker that inherited MARS_REPO pointing to the real project
    // root (a path that is NOT inside os.tmpdir()).
    // We use a plausible-looking non-temp path; the guard checks the string,
    // no stat is needed.
    process.env.MARS_REPO = '/usr/local/fake-production-repo'

    vi.resetModules()
    const { getDefaultTaskStore, __resetDefaultTaskStoreForTests } = await import(
      '../task-store'
    )
    __resetDefaultTaskStoreForTests()

    // VITEST env var is set by the test runner, so the guard applies here.
    await expect(getDefaultTaskStore()).rejects.toThrow(/NOT inside the system temp/)
  })

  it('getDefaultTaskStore() succeeds when MARS_REPO points inside tmpdir', async () => {
    const repo = mkdtempSync(resolve(tmpdir(), 'mars-hermetic-ok-'))
    mkdirSync(resolve(repo, '.mars'), { recursive: true })
    process.env.MARS_REPO = repo

    vi.resetModules()
    const { getDefaultTaskStore, __resetDefaultTaskStoreForTests } = await import(
      '../task-store'
    )
    __resetDefaultTaskStoreForTests()

    // Should resolve without throwing.
    const store = await getDefaultTaskStore()
    expect(store).toBeDefined()

    rmSync(repo, { recursive: true, force: true })
  })
})
