/**
 * Tests for the `mars operator status` and `mars operator set` commands
 * (PRD e9f6f2b9 slice 1) and for the `applyControlLevers` persistence contract.
 *
 * Acceptance criteria:
 *   1. `operator status` prints `recovery: on` by default (no daemon.json)
 *   2. `operator set recovery off` persists and prints `recovery: off`
 *   3. `operator set recovery on` persists and prints `recovery: on`
 *   4. write → simulated restart (re-read + applyControlLevers) leaves
 *      MARS_RECOVERY_DISABLED='1' when recovery='off'
 *   5. write → simulated restart with recovery='on' clears MARS_RECOVERY_DISABLED
 *
 * Isolation: vi.resetModules() + a fresh temp-dir git repo per test so
 * every test gets a private module-cache and daemon.json path, following
 * the same pattern as notifications.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-operator-recovery-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadDeps = async (): Promise<
  Omit<InProcessOptions, 'daemon' | 'stateStore'>
> => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
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
  // Ensure MARS_RECOVERY_DISABLED is unset at the start of each test.
  delete process.env.MARS_RECOVERY_DISABLED
})

afterEach(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_RECOVERY_DISABLED
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. operator status — defaults to recovery: on
// ---------------------------------------------------------------------------

describe('mars operator status', () => {
  it('prints "recovery: on" when no daemon.json exists', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('recovery: on')
    expect(r.err).toHaveLength(0)
  })

  it('reflects "recovery: off" after operator set recovery off', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['operator', 'set', 'recovery', 'off'], { ...deps, daemon: fake })

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('recovery: off')
  })

  it('reflects "recovery: on" after toggling off then on', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['operator', 'set', 'recovery', 'off'], { ...deps, daemon: fake })
    await run(['operator', 'set', 'recovery', 'on'], { ...deps, daemon: fake })

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('recovery: on')
  })
})

// ---------------------------------------------------------------------------
// 2. operator set recovery off — persists and prints
// ---------------------------------------------------------------------------

describe('mars operator set recovery off', () => {
  it('exits 0 and prints "recovery: off"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'recovery', 'off'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('recovery: off')
  })
})

// ---------------------------------------------------------------------------
// 3. operator set recovery on — persists and prints
// ---------------------------------------------------------------------------

describe('mars operator set recovery on', () => {
  it('exits 0 and prints "recovery: on"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'recovery', 'on'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('recovery: on')
  })
})

// ---------------------------------------------------------------------------
// 4. Persistence contract: write 'off' → simulated restart → MARS_RECOVERY_DISABLED='1'
// ---------------------------------------------------------------------------

describe('applyControlLevers persistence (simulated daemon restart)', () => {
  it('leaves MARS_RECOVERY_DISABLED=1 after write off → re-read → applyControlLevers', async () => {
    const { writeControlLever, readControlLevers, applyControlLevers } =
      await import('../../../core/daemon/config')

    writeControlLever('recovery', 'off')

    // Simulate daemon restart: start with a clean env, re-read the file,
    // and re-apply. This is exactly what server.ts boot does.
    delete process.env.MARS_RECOVERY_DISABLED
    const levers = readControlLevers()
    applyControlLevers(levers)

    expect(process.env.MARS_RECOVERY_DISABLED).toBe('1')
  })

  it('clears MARS_RECOVERY_DISABLED after write on → re-read → applyControlLevers', async () => {
    const { writeControlLever, readControlLevers, applyControlLevers } =
      await import('../../../core/daemon/config')

    // First disable, then re-enable
    writeControlLever('recovery', 'off')
    writeControlLever('recovery', 'on')

    process.env.MARS_RECOVERY_DISABLED = '1'
    const levers = readControlLevers()
    applyControlLevers(levers)

    expect(process.env.MARS_RECOVERY_DISABLED).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 5. Invalid inputs — non-zero exit
// ---------------------------------------------------------------------------

describe('mars operator set — invalid inputs', () => {
  it('exits non-zero for an unknown lever', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'badlever', 'off'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('badlever')
  })

  it('exits non-zero for an invalid value', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'recovery', 'maybe'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    const combined = [...r.out, ...r.err].join('\n')
    expect(combined).toContain('maybe')
  })

  it('exits non-zero when no args given', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set'], { ...deps, daemon: fake })

    expect(r.code).not.toBe(0)
  })
})
