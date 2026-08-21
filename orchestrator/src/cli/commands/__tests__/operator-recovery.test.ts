/**
 * Tests for the `mars operator status` and `mars operator set` commands
 * (PRD e9f6f2b9 slice 1) and for the control-lever persistence contract.
 *
 * Acceptance criteria:
 *   1. `operator status` prints `recovery: on` by default (no daemon.json)
 *   2. `operator set recovery off` persists and prints `recovery: off`
 *   3. `operator set recovery on` persists and prints `recovery: on`
 *   4. write → simulated restart resolves recovery disabled with a clean env
 *   5. write off → write on resolves recovery enabled again
 *   6. MARS_RECOVERY_DISABLED=1 overrides a persisted `on`
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
// 4. Persistence contract: write 'off' → simulated restart → recovery disabled
// ---------------------------------------------------------------------------

describe('control-lever persistence (simulated daemon restart)', () => {
  it('resolves recovery off after write off → restart, with no env involved', async () => {
    const { writeControlLever } = await import('../../../core/daemon/config')
    const { resolveControlLevers, isRecoveryDisabled } = await import(
      '../../../core/config/levers'
    )

    writeControlLever('recovery', 'off')

    // Simulate daemon restart: a brand-new process with a clean env. The
    // hold survives because it lives in daemon.json, not in process.env.
    delete process.env.MARS_RECOVERY_DISABLED
    expect(isRecoveryDisabled(resolveControlLevers())).toBe(true)
  })

  it('resolves recovery on after write off → write on', async () => {
    const { writeControlLever } = await import('../../../core/daemon/config')
    const { resolveControlLevers, isRecoveryDisabled } = await import(
      '../../../core/config/levers'
    )

    writeControlLever('recovery', 'off')
    writeControlLever('recovery', 'on')

    expect(isRecoveryDisabled(resolveControlLevers())).toBe(false)
  })

  it('lets MARS_RECOVERY_DISABLED=1 force recovery off over a persisted on', async () => {
    const { writeControlLever } = await import('../../../core/daemon/config')
    const { resolveControlLevers, isRecoveryDisabled } = await import(
      '../../../core/config/levers'
    )

    writeControlLever('recovery', 'on')

    expect(
      isRecoveryDisabled(resolveControlLevers({ MARS_RECOVERY_DISABLED: '1' })),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. Invalid inputs — non-zero exit
// ---------------------------------------------------------------------------

describe('mars operator set — invalid inputs', () => {
  it('exits non-zero for an unknown lever, names it, and lists valid levers', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'badlever', 'off'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    const errText = r.err.join('\n')
    // Names the rejected token
    expect(errText).toContain('badlever')
    // Distinguishes "unknown lever" from "bad value"
    expect(errText).toContain('unknown lever')
    // Lists the valid levers so the operator can self-correct
    expect(errText).toContain('valid levers')
  })

  it('exits non-zero for an invalid value on a control lever, naming the token', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'recovery', 'maybe'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    const errText = r.err.join('\n')
    // Names the rejected value
    expect(errText).toContain('maybe')
    // Does NOT say "unknown lever" — the lever is known, only the value is wrong
    expect(errText).not.toContain('unknown lever')
  })

  it('exits non-zero for an invalid value on dispatch, naming the token', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'dispatch', 'maybe'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    const errText = r.err.join('\n')
    // Names the rejected value
    expect(errText).toContain('maybe')
    // Does NOT say "unknown lever" — dispatch is a valid lever
    expect(errText).not.toContain('unknown lever')
  })

  it('exits non-zero when no args given', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set'], { ...deps, daemon: fake })

    expect(r.code).not.toBe(0)
  })
})
