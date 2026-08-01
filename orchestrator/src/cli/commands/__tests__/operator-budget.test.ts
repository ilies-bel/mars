import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InProcessOptions } from '../../test-adapter'

let repo: string

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

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-operator-budget-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('mars operator set budget-window', () => {
  it('persists a parsed duration to daemon.json', async () => {
    const deps = await loadDeps()
    const { makeFakeDaemon, runCommandInProcess } = await import('../../test-adapter')

    const result = await runCommandInProcess(
      ['operator', 'set', 'budget-window', '4h'],
      { ...deps, daemon: makeFakeDaemon() },
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(resolve(repo, '.mars', 'daemon.json'), 'utf8'))).toMatchObject({
      budget: { windowMs: 14_400_000 },
    })
  })
})

describe('mars operator set budget-window-tokens', () => {
  it('persists the rolling-window token threshold to daemon.json', async () => {
    const deps = await loadDeps()
    const { makeFakeDaemon, runCommandInProcess } = await import('../../test-adapter')

    const result = await runCommandInProcess(
      ['operator', 'set', 'budget-window-tokens', '5000000'],
      { ...deps, daemon: makeFakeDaemon() },
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(resolve(repo, '.mars', 'daemon.json'), 'utf8'))).toMatchObject({
      budget: { windowTokens: 5_000_000 },
    })
  })
})

describe('mars operator set budget-arc-tokens', () => {
  it('persists the per-arc token ceiling to daemon.json', async () => {
    const deps = await loadDeps()
    const { makeFakeDaemon, runCommandInProcess } = await import('../../test-adapter')

    const result = await runCommandInProcess(
      ['operator', 'set', 'budget-arc-tokens', '750000'],
      { ...deps, daemon: makeFakeDaemon() },
    )

    expect(result.code).toBe(0)
    expect(JSON.parse(readFileSync(resolve(repo, '.mars', 'daemon.json'), 'utf8'))).toMatchObject({
      budget: { arcTokens: 750_000 },
    })
  })
})

describe('mars operator set budget levers — validation', () => {
  it.each([
    ['budget-window', 'later', 'invalid duration'],
    ['budget-window-tokens', '0', 'positive integer'],
    ['budget-arc-tokens', '-1', 'positive integer'],
  ])('rejects %s %s without changing daemon.json', async (lever, value, message) => {
    const deps = await loadDeps()
    const { makeFakeDaemon, runCommandInProcess } = await import('../../test-adapter')
    const configPath = resolve(repo, '.mars', 'daemon.json')

    await runCommandInProcess(['operator', 'set', 'budget-window', '4h'], {
      ...deps,
      daemon: makeFakeDaemon(),
    })
    const before = readFileSync(configPath, 'utf8')
    const result = await runCommandInProcess(['operator', 'set', lever, value], {
      ...deps,
      daemon: makeFakeDaemon(),
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain(message)
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })
})

describe('mars operator status', () => {
  it('renders the shared window, per-arc ceiling, and live-arc status', async () => {
    const deps = await loadDeps()
    const { makeFakeDaemon, runCommandInProcess } = await import('../../test-adapter')
    const daemon = makeFakeDaemon()

    await runCommandInProcess(['operator', 'set', 'budget-window', '4h'], { ...deps, daemon })
    await runCommandInProcess(['operator', 'set', 'budget-window-tokens', '5000000'], { ...deps, daemon })
    await runCommandInProcess(['operator', 'set', 'budget-arc-tokens', '750000'], { ...deps, daemon })
    const task = await deps.store.enqueueTask('record budget status spend')
    await deps.store.execute({
      sql: `INSERT INTO trace_events (id, timestamp, kind, task_id, payload)
            VALUES (?, ?, 'step_ended', ?, ?)`,
      args: [
        'operator-budget-status-event',
        Date.parse('2026-07-31T21:53:48.275Z'),
        task.id,
        JSON.stringify({
          usageSignals: {
            inputTokens: 900_000,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0,
          },
        }),
      ],
    })
    const result = await runCommandInProcess(['operator', 'status'], { ...deps, daemon })

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toContain('window:')
    expect(result.out.join('\n')).toContain('per-arc ceiling:')
    expect(result.out.join('\n')).toContain('top live arcs by lifetime spend:')
  })
})
