/**
 * Regression test: `makeProductionDeps` must bind `deps.store` to the
 * `--repo` path, not to `CWD` / `MARS_REPO`.
 *
 * Reproduces the bug where `mars --repo <repoB> list` printed repoA's tasks
 * because `getDefaultDomainTaskStore()` was called eagerly (before context
 * resolution) and the queue client singleton initialised against the wrong DB.
 *
 * Fix: `deps.store` is now a lazy getter that resolves `deps.ctx` first,
 * ensuring the context singleton (and therefore `resolveQueueClient()`) are
 * seeded with the correct DB path before the queue client is created.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-repo-flag-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Migrate the mars.db schema for `repoPath` and optionally insert a task row
 * with the given prompt. Uses `vi.resetModules()` so each call starts with
 * fresh module singletons (clientSingleton, cached context).
 */
const initRepo = async (
  repoPath: string,
  taskPrompt?: string,
): Promise<void> => {
  vi.resetModules()
  process.env.MARS_REPO = repoPath
  const queueModule = await import('../../core/queue')
  await queueModule.migrateQueueSchema()

  if (taskPrompt) {
    // Insert a minimal row directly via the composition-root client so we
    // avoid the Arc event machinery (which needs a running daemon). All
    // required-NOT-NULL columns without database defaults are supplied; the
    // rest default at the DB level.
    const client = queueModule.resolveQueueClient()
    const now = new Date().toISOString()
    await client.execute({
      sql: `INSERT INTO tasks
              (id, prompt, status, priority, origin_id, tags_json, kind, intent, retry_count, created_at, updated_at)
            VALUES (?, ?, 'queued', 0, ?, '["coder"]', 'task', ?, 0, ?, ?)`,
      args: [
        `test-${repoPath.slice(-6)}`,
        taskPrompt,
        `test-${repoPath.slice(-6)}`,
        taskPrompt,
        now,
        now,
      ],
    })
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let repoA: string
let repoB: string
let origMarsRepo: string | undefined

beforeEach(() => {
  origMarsRepo = process.env.MARS_REPO
  repoA = makeRepo()
  repoB = makeRepo()
})

afterEach(() => {
  vi.resetModules()
  if (origMarsRepo === undefined) {
    delete process.env.MARS_REPO
  } else {
    process.env.MARS_REPO = origMarsRepo
  }
  rmSync(repoA, { recursive: true, force: true })
  rmSync(repoB, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeProductionDeps --repo flag', () => {
  it('binds deps.store to the --repo path, not to MARS_REPO', async () => {
    // Set up both repos: repoA is the "default" (MARS_REPO), repoB is the
    // target of an explicit --repo flag. Only repoB has a task.
    await initRepo(repoA)
    await initRepo(repoB, 'task-in-repoB')

    // Simulate CLI start: MARS_REPO points at repoA, but the user passed
    // --repo pointing at repoB.  Reset modules so makeProductionDeps gets
    // fresh singleton state.
    vi.resetModules()
    process.env.MARS_REPO = repoA

    const { makeProductionDeps } = await import('../dispatch')
    const deps = await makeProductionDeps(repoB)

    const tasks = await deps.store.listTasks()

    // Must see repoB's task (the one we inserted).
    expect(tasks.some((t) => t.prompt === 'task-in-repoB')).toBe(true)
    // Must NOT see any tasks from repoA (which has none).
    expect(tasks.every((t) => t.prompt !== 'task-in-repoA')).toBe(true)
    // And the context itself should point at repoB.
    expect(deps.ctx.queueDbPath).toBe(resolve(repoB, '.mars', 'mars.db'))
  })

  it('still binds store to CWD/MARS_REPO when no --repo is given', async () => {
    // Without --repo, the store must bind to MARS_REPO (repoA here).
    // repoA gets a task; repoB stays empty.
    await initRepo(repoA, 'task-in-repoA')
    await initRepo(repoB)

    vi.resetModules()
    process.env.MARS_REPO = repoA

    const { makeProductionDeps } = await import('../dispatch')
    const deps = await makeProductionDeps(undefined) // no --repo

    const tasks = await deps.store.listTasks()

    expect(tasks.some((t) => t.prompt === 'task-in-repoA')).toBe(true)
    expect(deps.ctx.queueDbPath).toBe(resolve(repoA, '.mars', 'mars.db'))
  })
})
