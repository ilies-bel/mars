/**
 * Tests for the `operator-auto-commit` control lever (PRD
 * ce46f01e-concurrent-writing-on-main-rebase-verify slice 9).
 *
 * This slice is lever-surface only: nothing consumes the value yet. What is
 * under test here is the plumbing a later behavioural slice will build on:
 *
 *   1. `ControlLevers.operatorAutoCommit` defaults to 'on'.
 *   2. `mars operator set operator-auto-commit on|off` is accepted and an
 *      invalid value is rejected with the same error shape as every other
 *      control lever.
 *   3. `mars operator status` prints the lever's current value.
 *   4. The value persists into the `controlLevers` block of `.mars/daemon.json`
 *      and is read back by `resolveControlLevers()` — including across a
 *      simulated daemon restart (clean env, same pattern as
 *      operator-recovery.test.ts).
 *   5. `isOperatorAutoCommitDisabled` follows the injected value.
 *
 * Isolation: vi.resetModules() + a fresh temp-dir git repo per test, same
 * pattern as operator-recovery.test.ts / lever-injection.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../../cli/test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-operator-auto-commit-lever-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadDeps = async (): Promise<
  Omit<InProcessOptions, 'daemon' | 'stateStore'>
> => {
  const queueModule = await import('../../queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../store/task-store')
  const contextModule = await import('../../context')
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../../cli/test-adapter')
  return runCommandInProcess(argv, opts)
}

const makeFake = async () => {
  const { makeFakeDaemon } = await import('../../../cli/test-adapter')
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

describe('ControlLevers.operatorAutoCommit default', () => {
  it('defaults to "on" when daemon.json has no controlLevers block', async () => {
    const { resolveControlLevers } = await import('../levers')

    expect(resolveControlLevers({}).operatorAutoCommit).toBe('on')
  })
})

describe('mars operator status', () => {
  it('prints "operator-auto-commit: on" by default', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('operator-auto-commit: on')
  })

  it('reflects "operator-auto-commit: off" after operator set operator-auto-commit off', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['operator', 'set', 'operator-auto-commit', 'off'], { ...deps, daemon: fake })

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('operator-auto-commit: off')
  })
})

describe('mars operator set operator-auto-commit', () => {
  it('exits 0 and prints "operator-auto-commit: off"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'operator-auto-commit', 'off'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('operator-auto-commit: off')
  })

  it('exits 0 and prints "operator-auto-commit: on"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'operator-auto-commit', 'on'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('operator-auto-commit: on')
  })

  it('exits non-zero for an invalid value, naming the token, without saying "unknown lever"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'operator-auto-commit', 'maybe'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    const errText = r.err.join('\n')
    expect(errText).toContain('maybe')
    expect(errText).not.toContain('unknown lever')
  })

  it('lists operator-auto-commit among the valid levers for an unknown lever error', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'badlever', 'off'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toContain('operator-auto-commit')
  })
})

describe('control-lever persistence (simulated daemon restart)', () => {
  it('resolves operatorAutoCommit off after write off → restart, with no env involved', async () => {
    const { writeControlLever } = await import('../../daemon/config')
    const { resolveControlLevers, isOperatorAutoCommitDisabled } = await import('../levers')

    writeControlLever('operatorAutoCommit', 'off')

    // Simulate daemon restart: a brand-new process with a clean env. The
    // hold survives because it lives in daemon.json, not in process.env.
    expect(isOperatorAutoCommitDisabled(resolveControlLevers({}))).toBe(true)
  })

  it('resolves operatorAutoCommit on after write off → write on', async () => {
    const { writeControlLever } = await import('../../daemon/config')
    const { resolveControlLevers, isOperatorAutoCommitDisabled } = await import('../levers')

    writeControlLever('operatorAutoCommit', 'off')
    writeControlLever('operatorAutoCommit', 'on')

    expect(isOperatorAutoCommitDisabled(resolveControlLevers({}))).toBe(false)
  })

  it('preserves other control levers when persisting operatorAutoCommit', async () => {
    const { writeControlLever, readControlLevers } = await import('../../daemon/config')

    writeControlLever('recovery', 'off')
    writeControlLever('operatorAutoCommit', 'off')

    const levers = readControlLevers()
    expect(levers.recovery).toBe('off')
    expect(levers.operatorAutoCommit).toBe('off')
  })
})
