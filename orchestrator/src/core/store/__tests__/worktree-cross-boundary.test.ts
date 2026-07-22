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
 *      <stateDir>/worktrees/<id>/ AND MARS_REPO is not explicitly set, throw
 *      before any write reaches the DB. When MARS_REPO is explicit (or --repo
 *      has been propagated into it by makeProductionDeps), the caller
 *      deliberately chose the target; the guard is bypassed.
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

  afterEach(() => {
    cwdSpy?.mockRestore()
    delete process.env.MARS_REPO
    vi.resetModules()
    rmSync(parentDir, { recursive: true, force: true })
  })

  it('getDefaultTaskStore() refuses when CWD is inside .mars/worktrees/<id>/ with NO explicit MARS_REPO (implicit CWD-derived path)', async () => {
    // No MARS_REPO set — the stateDir is inferred from CWD, which is the
    // implicit foot-gun the guard exists to prevent.
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

  it('getDefaultTaskStore() succeeds when CWD is inside .mars/worktrees/<id>/ BUT MARS_REPO is explicitly set (--repo / live-session use case)', async () => {
    // Explicit MARS_REPO = the caller deliberately chose the target repo.
    // This is the live-session pattern: attach → worktree CWD →
    // mars --repo <root> show / task note / task check / step done.
    // makeProductionDeps() writes --repo into MARS_REPO before accessing
    // the store; here we do the same directly.
    process.env.MARS_REPO = parentDir
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(worktreeCwd)

    vi.resetModules()
    const { getDefaultTaskStore, __resetDefaultTaskStoreForTests } = await import(
      '../task-store'
    )
    // Import resolveQueueClient from the same fresh module set so we can
    // close PGLite before afterEach removes parentDir.
    const { resolveQueueClient } = await import('../../queue')
    __resetDefaultTaskStoreForTests()

    // Should not throw — explicit binding is honoured.
    const store = await getDefaultTaskStore()
    expect(store).toBeDefined()

    // Close PGLite before afterEach removes parentDir. Without this, PGLite's
    // background WASM processes (WAL writer, autovacuum) race with rmSync and
    // produce an ENOENT unhandled rejection.
    await resolveQueueClient().close()
  })

  it('getDefaultDomainTaskStore() refuses when CWD is inside .mars/worktrees/<id>/ with NO explicit MARS_REPO', async () => {
    // No MARS_REPO — implicit CWD-derived path → guard fires.
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(worktreeCwd)

    vi.resetModules()
    const { getDefaultDomainTaskStore } = await import('../task-store')

    expect(() => getDefaultDomainTaskStore()).toThrow(
      /getDefaultDomainTaskStore\(\) refused.*worktree/,
    )

    expect(existsSync(decoyDb)).toBe(false)
  })

  it('getDefaultDomainTaskStore() succeeds when CWD is inside .mars/worktrees/<id>/ BUT MARS_REPO is explicitly set', async () => {
    // Explicit MARS_REPO — caller chose the target deliberately; guard is bypassed.
    process.env.MARS_REPO = parentDir
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(worktreeCwd)

    vi.resetModules()
    const { getDefaultDomainTaskStore } = await import('../task-store')
    // Import resolveQueueClient from the same fresh module set so we can close
    // PGLite before afterEach removes parentDir.
    const { resolveQueueClient } = await import('../../queue')

    // Should not throw.
    const store = getDefaultDomainTaskStore()
    expect(store).toBeDefined()

    // Close PGLite before afterEach removes parentDir. getDefaultDomainTaskStore()
    // triggers openDb() → new PGlite(dataDir) whose async WASM init continues in
    // the background; awaiting close() drains that init before rmSync fires.
    await resolveQueueClient().close()
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

    // Close PGLite before afterEach removes parentDir. Without this, PGLite's
    // background WASM processes (WAL writer, autovacuum) race with rmSync and
    // produce an ENOENT unhandled rejection.
    await queueModule.resolveQueueClient().close()
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
    // Import resolveQueueClient from the same fresh module set so we can
    // close PGLite before removing the temp directory.
    const { resolveQueueClient } = await import('../../queue')
    __resetDefaultTaskStoreForTests()

    // Should resolve without throwing.
    const store = await getDefaultTaskStore()
    expect(store).toBeDefined()

    // Close PGLite before removing the temp directory. Without this, PGLite's
    // background WASM processes (WAL writer, autovacuum) race with rmSync and
    // produce an ENOENT unhandled rejection.
    await resolveQueueClient().close()
    rmSync(repo, { recursive: true, force: true })
  })
})
