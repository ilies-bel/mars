import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-classifier-test-'))
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
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('mars classifier list', () => {
  it('prints nothing to stdout when no custom classifiers are registered', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['classifier', 'list'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(0)
  })

  it('prints each entry as tab-separated name/match/matchFull/guidance columns', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(
      [
        'classifier',
        'add',
        'jest-failure',
        '--match',
        'Tests:\\s+\\d+ failed',
        '--guidance',
        'Look at assertion diffs',
      ],
      { ...deps, daemon: fake },
    )
    // Reset modules so list picks up the written daemon.json
    vi.resetModules()
    const deps2 = await loadDeps()
    const fake2 = await makeFake()

    const r = await run(['classifier', 'list'], { ...deps2, daemon: fake2 })

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    expect(r.out[0]).toBe(
      'jest-failure\tTests:\\s+\\d+ failed\t\tLook at assertion diffs',
    )
  })
})

describe('mars classifier add', () => {
  it('writes a valid customClassifiers entry to daemon.json', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['classifier', 'add', 'jest-failure', '--match', 'Tests:\\s+\\d+ failed'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('classifier added: "jest-failure"')

    const raw = JSON.parse(
      readFileSync(resolve(repo, '.mars', 'daemon.json'), 'utf8'),
    ) as { customClassifiers?: Array<{ name: string; match?: string }> }
    expect(raw.customClassifiers).toHaveLength(1)
    expect(raw.customClassifiers?.[0]?.name).toBe('jest-failure')
    expect(raw.customClassifiers?.[0]?.match).toBe('Tests:\\s+\\d+ failed')
  })

  it('persists the guidance field when --guidance is supplied', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(
      [
        'classifier',
        'add',
        'jest-failure',
        '--match',
        'Tests:\\s+\\d+ failed',
        '--guidance',
        'Look at assertion diffs',
      ],
      { ...deps, daemon: fake },
    )

    const raw = JSON.parse(
      readFileSync(resolve(repo, '.mars', 'daemon.json'), 'utf8'),
    ) as {
      customClassifiers?: Array<{ name: string; guidance?: string }>
    }
    expect(raw.customClassifiers?.[0]?.guidance).toBe('Look at assertion diffs')
  })

  it('rejects an invalid regex with a descriptive error and non-zero exit', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['classifier', 'add', 'bad-pattern', '--match', '[invalid(regex'],
      { ...deps, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toMatch(/--match is not a valid regex/)
  })

  it('rejects a duplicate name with a descriptive error and non-zero exit', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(
      ['classifier', 'add', 'jest-failure', '--match', 'Tests:\\s+\\d+ failed'],
      { ...deps, daemon: fake },
    )
    vi.resetModules()
    const deps2 = await loadDeps()
    const fake2 = await makeFake()

    const r = await run(
      ['classifier', 'add', 'jest-failure', '--match', 'something else'],
      { ...deps2, daemon: fake2 },
    )

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toMatch(/already exists/)
  })

  it('rejects when neither --match nor --match-full is supplied', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['classifier', 'add', 'no-pattern'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toMatch(/--match/)
  })

  it('accepts --match-full and validates its regex', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['classifier', 'add', 'full-pattern', '--match-full', 'FAILED.*suite'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(0)
    const raw = JSON.parse(
      readFileSync(resolve(repo, '.mars', 'daemon.json'), 'utf8'),
    ) as {
      customClassifiers?: Array<{ name: string; matchFull?: string }>
    }
    expect(raw.customClassifiers?.[0]?.matchFull).toBe('FAILED.*suite')
  })
})

describe('mars classifier remove', () => {
  it('removes a named entry and leaves other entries intact', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(
      ['classifier', 'add', 'jest-failure', '--match', 'Tests:\\s+\\d+ failed'],
      { ...deps, daemon: fake },
    )
    vi.resetModules()
    const deps2 = await loadDeps()
    const fake2 = await makeFake()
    await run(
      ['classifier', 'add', 'ts-error', '--match', 'error TS'],
      { ...deps2, daemon: fake2 },
    )
    vi.resetModules()
    const deps3 = await loadDeps()
    const fake3 = await makeFake()

    const r = await run(['classifier', 'remove', 'jest-failure'], {
      ...deps3,
      daemon: fake3,
    })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('classifier removed: "jest-failure"')

    const raw = JSON.parse(
      readFileSync(resolve(repo, '.mars', 'daemon.json'), 'utf8'),
    ) as { customClassifiers?: Array<{ name: string }> }
    expect(raw.customClassifiers).toHaveLength(1)
    expect(raw.customClassifiers?.[0]?.name).toBe('ts-error')
  })

  it('exits non-zero with an error when the name does not exist', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['classifier', 'remove', 'nonexistent'], {
      ...deps,
      daemon: fake,
    })

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toMatch(/no classifier named "nonexistent" found/)
  })
})
