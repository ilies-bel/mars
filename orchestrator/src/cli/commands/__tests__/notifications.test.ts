/**
 * Tests for the `mars notifications` CLI command (PRD e5c75aa3 slice 4).
 *
 * Covers every acceptance criterion:
 *   1. `notifications on`     — writes enabled=true, exits 0, prints "notifications: on"
 *   2. `notifications off`    — writes enabled=false, exits 0, prints "notifications: off"
 *   3. `notifications status` — prints stored value, defaults to "on" when unset
 *   4. `notifications`        — bare invocation shows status (defaults to "on")
 *   5. `notifications <bad>`  — unknown subcommand exits non-zero with a usage line
 *
 * Isolation: `vi.resetModules()` + a fresh temp-dir git repo per test group so
 * every test gets a private module-cache and DB, matching the pattern used by
 * `preferences.test.ts` and `proposal-take.test.ts`.
 *
 * The notifications command imports `resolveStateClient` dynamically inside its
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
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-notifications-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Initialise the DB schemas (queue + state) and return the deps the test
 * adapter needs. All imports are dynamic so they share the fresh module-cache
 * created by `vi.resetModules()` in `beforeEach`.
 */
const loadDeps = async (): Promise<
  Omit<InProcessOptions, 'daemon' | 'stateStore'>
> => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  const stateStoreModule = await import('../../../core/store/state-store')
  // Creates the `preferences` table and sets the resolveStateClient singleton
  // to point at the temp-dir DB — the command's run() will call
  // resolveStateClient() and get the same singleton.
  await stateStoreModule.migrateStateSchema()
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

/**
 * Run a command in-process using FRESH module instances (shared with the
 * module-cache populated by `loadDeps` above).
 */
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
// 1. notifications on
// ---------------------------------------------------------------------------

describe('mars notifications on', () => {
  it('writes enabled preference, exits 0, and prints "notifications: on"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['notifications', 'on'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('notifications: on')
    expect(r.err).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. notifications off
// ---------------------------------------------------------------------------

describe('mars notifications off', () => {
  it('writes disabled preference, exits 0, and prints "notifications: off"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['notifications', 'off'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('notifications: off')
    expect(r.err).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. notifications status
// ---------------------------------------------------------------------------

describe('mars notifications status', () => {
  it('defaults to "on" when no preference has been stored', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['notifications', 'status'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('notifications: on')
  })

  it('reflects the stored value after "off" is set', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    // Turn off first
    await run(['notifications', 'off'], { ...deps, daemon: fake })

    const r = await run(['notifications', 'status'], { ...deps, daemon: fake })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('notifications: off')
  })

  it('reflects the stored value after "on" is set following "off"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['notifications', 'off'], { ...deps, daemon: fake })
    await run(['notifications', 'on'], { ...deps, daemon: fake })

    const r = await run(['notifications', 'status'], { ...deps, daemon: fake })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('notifications: on')
  })
})

// ---------------------------------------------------------------------------
// 4. bare `mars notifications` — defaults to showing status
// ---------------------------------------------------------------------------

describe('mars notifications (bare)', () => {
  it('shows "on" by default when no preference is stored', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['notifications'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('notifications: on')
  })

  it('shows stored preference after "off"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['notifications', 'off'], { ...deps, daemon: fake })

    const r = await run(['notifications'], { ...deps, daemon: fake })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('notifications: off')
  })
})

// ---------------------------------------------------------------------------
// 5. invalid subcommand — non-zero exit with usage line
// ---------------------------------------------------------------------------

describe('mars notifications <invalid subcommand>', () => {
  it('exits non-zero and emits a usage line for an unrecognised subcommand', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['notifications', 'badcmd'], { ...deps, daemon: fake })

    expect(r.code).not.toBe(0)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('usage')
    expect(combined.toLowerCase()).toContain('notifications')
  })
})
