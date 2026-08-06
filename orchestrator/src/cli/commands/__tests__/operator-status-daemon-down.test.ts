import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
  repo = mkdtempSync(resolve(tmpdir(), 'mars-operator-status-daemon-down-test-'))
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

describe('mars operator status when the daemon is down', () => {
  it('reports every persisted lever and DB-backed burn without querying the daemon', async () => {
    vi.doMock('../../../core/daemon/paths', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../core/daemon/paths')>()),
      isDaemonAlive: vi.fn().mockResolvedValue({ alive: false, reason: 'pid file missing' }),
    }))
    const deps = await loadDeps()
    const { makeFakeDaemon, runCommandInProcess } = await import('../../test-adapter')
    const daemon = makeFakeDaemon()

    for (const [lever, value] of [
      ['recovery', 'off'],
      ['scoring', 'off'],
      ['auto-reflect', 'off'],
      ['budget-window', '4h'],
      ['budget-window-tokens', '5000000'],
      ['budget-arc-tokens', '750000'],
    ]) {
      await runCommandInProcess(['operator', 'set', lever, value], { ...deps, daemon })
    }
    const { persistPaused } = await import('../../../core/daemon/config')
    persistPaused(true)
    const task = await deps.store.enqueueTask('record budget spend while daemon is down')
    // Use a timestamp 1 hour ago so the event falls inside the 4h budget window
    // regardless of when the test runs.
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    await deps.store.execute({
      sql: `INSERT INTO trace_events (id, timestamp, kind, task_id, payload)
            VALUES (?, ?, 'step_ended', ?, ?)`,
      args: [
        'operator-status-daemon-down-event',
        oneHourAgo,
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

    const statusDaemon = makeFakeDaemon()
    const result = await runCommandInProcess(['operator', 'status'], {
      ...deps,
      daemon: statusDaemon,
    })

    expect(result.code).toBe(0)
    expect(result.err).toEqual([])
    expect(result.out).toEqual([
      'recovery: off',
      'scoring: off',
      'auto-reflect: off',
      'auto-trigger: off',
      'dispatch: paused  in-flight: unavailable (daemon down)',
      'window:  900.0k / 5.0M weighted tokens over 4h (18.0% — good)',
      '  top contributing arcs:',
      `    ${task.id}  900.0k`,
      'per-arc ceiling: 750.0k weighted tokens',
      '  top live arcs by lifetime spend:',
      `    ${task.id}  900.0k (120.0%)  ⚠ OVER CEILING`,
      'open budget rows: none',
    ])
    expect(statusDaemon.calls).toEqual([])
  })

  it('shows auto-trigger: on when selfEvolve.autoTrigger is enabled via env var', async () => {
    process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER = 'true'
    vi.doMock('../../../core/daemon/paths', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../core/daemon/paths')>()),
      isDaemonAlive: vi.fn().mockResolvedValue({ alive: false, reason: 'pid file missing' }),
    }))
    const deps = await loadDeps()
    const { makeFakeDaemon, runCommandInProcess } = await import('../../test-adapter')

    const result = await runCommandInProcess(['operator', 'status'], {
      ...deps,
      daemon: makeFakeDaemon(),
    })

    const outText = result.out.join('\n')
    expect(outText).toContain('auto-trigger: on')
    delete process.env.MARS_SELF_EVOLVE_AUTO_TRIGGER
  })
})
