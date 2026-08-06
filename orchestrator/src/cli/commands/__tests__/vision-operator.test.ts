/**
 * Tests for `mars vision` and `mars operator` CLI commands.
 *
 * Covers the acceptance criteria for the vision-as-file slice:
 *   1. `vision set "<prose>"` — exits 0, dispatches `vision-write` to the daemon
 *   2. `vision show`          — reads `docs/knowledge/vision.md`; exits 1 with
 *                               "no vision set" when the file is absent
 *   3. `operator name-set "<name>"` and `operator name-show` mirror the same pattern
 *
 * Isolation: `vi.resetModules()` + a fresh temp-dir git repo per test group so
 * every test gets a private module-cache and DB.
 *
 * `vision set` dispatches a `vision-write` RPC to the fake daemon (which does
 * NOT write the file).  Tests that need `vision show` to return a value write
 * `docs/knowledge/vision.md` directly, simulating what the daemon's structured-
 * write pipeline would produce.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The first test in this file pays a one-time module-compile cost (transform
// cache is cold). 30 s gives ample headroom; subsequent tests are <2 s.
vi.setConfig({ testTimeout: 30_000 })
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Write `docs/knowledge/vision.md` inside the test repo so that `vision show`
 * can read it. This simulates the outcome of the daemon's structured-write
 * pipeline without actually running it.
 */
const writeVisionFile = (content: string): void => {
  const dir = resolve(repo, 'docs', 'knowledge')
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, 'vision.md'), content, 'utf8')
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

  it('prints "vision set" on success', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['vision', 'set', 'north star'], { ...deps, daemon: fake })

    expect(r.out.join('\n')).toContain('vision set')
  })

  it('dispatches a vision-write op to the daemon', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['vision', 'set', 'north star'], { ...deps, daemon: fake })

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ op: 'vision-write', content: 'north star' })
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
  it('prints the stored vision when docs/knowledge/vision.md exists', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()
    writeVisionFile('north star')

    const r = await run(['vision', 'show'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('north star')
  })

  it('exits 1 with "no vision set" when the file is absent', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['vision', 'show'], { ...deps, daemon: fake })

    expect(r.code).toBe(1)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('no vision set')
  })

  it('reflects a new value after the file is updated', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()
    writeVisionFile('first draft')

    const first = await run(['vision', 'show'], { ...deps, daemon: fake })
    expect(first.out.join('\n')).toContain('first draft')

    writeVisionFile('north star')
    const second = await run(['vision', 'show'], { ...deps, daemon: fake })
    expect(second.out.join('\n')).toContain('north star')
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
    // Vision comes from the file; operator name from the DB.
    writeVisionFile('north star')
    await run(['operator', 'name-set', 'Alex'], { ...deps, daemon: fake })

    const vr = await run(['vision', 'show'], { ...deps, daemon: fake })
    const or = await run(['operator', 'name-show'], { ...deps, daemon: fake })

    expect(vr.out.join('\n')).toContain('north star')
    expect(or.out.join('\n')).toContain('Alex')
  })
})
