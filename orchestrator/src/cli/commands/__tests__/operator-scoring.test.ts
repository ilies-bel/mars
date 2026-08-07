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

  it('annotates "0 accepted scorers — nothing is graded" when scoring is on but no scorer is accepted', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(
      'scoring: on (0 accepted scorers — nothing is graded)',
    )
  })

  it('shows plain "scoring: on" once a scorer is accepted', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    // Suggest then accept a scorer so the accepted-count is 1.
    const { suggestScorer, acceptScorer } = await import('../../../core/scorers')
    const { scorer } = await suggestScorer({
      workflow: 'task',
      title: 'Test quality dimension',
      rubric: 'Score 0..1 based on test quality',
      originArcId: 'arc-test-id',
      reportPath: null,
      evidence: [],
      confidence: 0.8,
    })
    await acceptScorer(scorer.id)

    const r = await run(['operator', 'status'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    const scoringLine = r.out.find((line) => line.startsWith('scoring:'))
    expect(scoringLine).toBe('scoring: on')
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

describe('mars operator memory-capture lever', () => {
  it('persists off and reports it in status', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const set = await run(['operator', 'set', 'memory-capture', 'off'], {
      ...deps,
      daemon: fake,
    })
    const status = await run(['operator', 'status'], { ...deps, daemon: fake })

    expect(set.code).toBe(0)
    expect(set.out.join('\n')).toContain('memory-capture: off')
    expect(status.code).toBe(0)
    expect(status.out.join('\n')).toContain('memory-capture: off')
  })
})

describe('mars operator auto-run-reflect lever', () => {
  it('persists on and reports it in status', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const set = await run(['operator', 'set', 'auto-run-reflect', 'on'], {
      ...deps,
      daemon: fake,
    })
    const status = await run(['operator', 'status'], { ...deps, daemon: fake })

    expect(set.code).toBe(0)
    expect(set.out.join('\n')).toContain('auto-run-reflect: on')
    expect(status.code).toBe(0)
    expect(status.out.join('\n')).toContain('auto-run-reflect: on')
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
