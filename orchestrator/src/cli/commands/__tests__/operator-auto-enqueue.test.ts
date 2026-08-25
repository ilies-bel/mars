/**
 * Tests verifying that the removed auto-enqueue and task-confidence-threshold
 * levers are no longer present in the operator surface.
 *
 * ADR-0038 / DEC-17: the framework never auto-enqueues tasks from reflection.
 * The `auto-enqueue` and `task-confidence-threshold` levers were gates on dead
 * code; they have been fully removed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

vi.setConfig({ testTimeout: 30_000 })

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-operator-auto-enqueue-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadDeps = async (): Promise<Omit<InProcessOptions, 'daemon' | 'stateStore'>> => {
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
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('removed auto-enqueue lever', () => {
  it('operator status does not mention auto-enqueue', async () => {
    vi.doMock('../../../core/daemon/paths', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../core/daemon/paths')>()),
      isDaemonAlive: vi.fn().mockResolvedValue({ alive: false, reason: 'pid file missing' }),
    }))
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).not.toContain('auto-enqueue')
  })

  it('operator set auto-enqueue on → unknown lever error (code 2)', async () => {
    vi.doMock('../../../core/daemon/paths', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../core/daemon/paths')>()),
      isDaemonAlive: vi.fn().mockResolvedValue({ alive: false, reason: 'pid file missing' }),
    }))
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'auto-enqueue', 'on'], { ...deps, daemon: fake })

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('unknown lever')
  })

  it('operator set task-confidence-threshold 0.8 → unknown lever error (code 2)', async () => {
    vi.doMock('../../../core/daemon/paths', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../core/daemon/paths')>()),
      isDaemonAlive: vi.fn().mockResolvedValue({ alive: false, reason: 'pid file missing' }),
    }))
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'task-confidence-threshold', '0.8'], { ...deps, daemon: fake })

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('unknown lever')
  })

  it('loadDaemonConfig().selfEvolve has no autoEnqueue property', async () => {
    const { loadDaemonConfig } = await import('../../../core/daemon/config')
    const cfg = loadDaemonConfig()
    expect('autoEnqueue' in cfg.selfEvolve).toBe(false)
    expect('taskConfidenceThreshold' in cfg.selfEvolve).toBe(false)
  })
})
