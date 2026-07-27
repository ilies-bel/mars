import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-operator-scoring-test-'))
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
  delete process.env.MARS_SCORING_DISABLED
})

afterEach(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_SCORING_DISABLED
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('mars operator status — scoring lever', () => {
  it('prints "scoring: on" by default', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('scoring: on')
  })

  it('reflects "scoring: off" after operator set scoring off', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['operator', 'set', 'scoring', 'off'], { ...deps, daemon: fake })

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('scoring: off')
  })
})

describe('mars operator set scoring', () => {
  it('exits 0 and prints "scoring: off"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'scoring', 'off'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('scoring: off')
  })

  it('exits 0 and prints "scoring: on"', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'set', 'scoring', 'on'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('scoring: on')
  })
})

describe('applyControlLevers — scoring persistence (simulated restart)', () => {
  it('sets MARS_SCORING_DISABLED=1 after write off → re-read → apply', async () => {
    const { writeControlLever, readControlLevers, applyControlLevers } =
      await import('../../../core/daemon/config')

    writeControlLever('scoring', 'off')

    delete process.env.MARS_SCORING_DISABLED
    const levers = readControlLevers()
    applyControlLevers(levers)

    expect(process.env.MARS_SCORING_DISABLED).toBe('1')
  })

  it('clears MARS_SCORING_DISABLED after write on → re-read → apply', async () => {
    const { writeControlLever, readControlLevers, applyControlLevers } =
      await import('../../../core/daemon/config')

    writeControlLever('scoring', 'off')
    writeControlLever('scoring', 'on')

    process.env.MARS_SCORING_DISABLED = '1'
    const levers = readControlLevers()
    applyControlLevers(levers)

    expect(process.env.MARS_SCORING_DISABLED).toBeUndefined()
  })
})
