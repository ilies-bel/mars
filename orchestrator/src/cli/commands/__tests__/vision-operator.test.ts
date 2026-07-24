/**
 * Tests for `mars vision` and `mars operator` CLI commands.
 *
 * Covers the acceptance criteria for slice 1 of PRD f122a60b:
 *   1. `vision set "<prose>"` — exits 0, persists to app_settings
 *   2. `vision show`          — prints stored value; exits 1 with clear message when absent
 *   3. `operator name-set "<name>"` and `operator name-show` mirror the same pattern
 *
 * Isolation: `vi.resetModules()` + a fresh temp-dir git repo per test group so
 * every test gets a private module-cache and DB, matching the pattern used by
 * `notifications.test.ts` and `preferences.test.ts`.
 *
 * The vision/operator commands import resolveStateClient dynamically inside their
 * `run`, so the module-cache populated by `loadDeps()` here is the same cache
 * the command will see — no separate client injection is required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The first test in this file pays a one-time module-compile cost (transform
// cache is cold). 30 s gives ample headroom; subsequent tests are <2 s.
vi.setConfig({ testTimeout: 30_000 })
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-vision-operator-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Initialise the DB schemas (queue + state) and return the deps the test
 * adapter needs. All imports are dynamic so they share the fresh module-cache
 * created by `vi.resetModules()` in `beforeEach`.
 */
const loadDeps = async (): Promise<Omit<InProcessOptions, 'daemon' | 'stateStore'>> => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  const stateStoreModule = await import('../../../core/store/state-store')
  // Creates the app_settings table (migration 0002) and sets the
  // resolveStateClient singleton to point at the temp-dir DB — the command's
  // run() will call resolveStateClient() and get the same singleton.
  await stateStoreModule.migrateStateSchema()
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, opts)
}

const makeFake = async () => {
  const { makeFakeDaemon } = await import('../../test-adapter')
  return makeFakeDaemon()
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// vision set
// ---------------------------------------------------------------------------

describe('mars vision set', () => {
  it('exits 0 when a vision string is provided', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['vision', 'set', 'north star'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.err).toHaveLength(0)
  })

  it('exits 2 with a usage line when no argument is given', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['vision', 'set'], { ...deps, daemon: fake })

    expect(r.code).toBe(2)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('usage')
  })
})

// ---------------------------------------------------------------------------
// vision show
// ---------------------------------------------------------------------------

describe('mars vision show', () => {
  it('prints the stored vision after "vision set"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['vision', 'set', 'north star'], { ...deps, daemon: fake })
    const r = await run(['vision', 'show'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('north star')
  })

  it('exits 1 with "no vision set" when nothing has been stored', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['vision', 'show'], { ...deps, daemon: fake })

    expect(r.code).toBe(1)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('no vision set')
  })

  it('reflects an overwritten vision after a second set', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['vision', 'set', 'first draft'], { ...deps, daemon: fake })
    await run(['vision', 'set', 'north star'], { ...deps, daemon: fake })
    const r = await run(['vision', 'show'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('north star')
  })
})

// ---------------------------------------------------------------------------
// operator name-set
// ---------------------------------------------------------------------------

describe('mars operator name-set', () => {
  it('exits 0 when a name is provided', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'name-set', 'Alex'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.err).toHaveLength(0)
  })

  it('exits 2 with a usage line when no argument is given', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'name-set'], { ...deps, daemon: fake })

    expect(r.code).toBe(2)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('usage')
  })
})

// ---------------------------------------------------------------------------
// operator name-show
// ---------------------------------------------------------------------------

describe('mars operator name-show', () => {
  it('prints the stored operator name after "operator name-set"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['operator', 'name-set', 'Alex'], { ...deps, daemon: fake })
    const r = await run(['operator', 'name-show'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('Alex')
  })

  it('exits 1 with "no operator name set" when nothing has been stored', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'name-show'], { ...deps, daemon: fake })

    expect(r.code).toBe(1)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('no operator name set')
  })

  it('vision and operator name are stored independently', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['vision', 'set', 'north star'], { ...deps, daemon: fake })
    await run(['operator', 'name-set', 'Alex'], { ...deps, daemon: fake })

    const vr = await run(['vision', 'show'], { ...deps, daemon: fake })
    const or = await run(['operator', 'name-show'], { ...deps, daemon: fake })

    expect(vr.out.join('\n')).toContain('north star')
    expect(or.out.join('\n')).toContain('Alex')
  })
})
