/**
 * Tests that `mars operator status` derives "reflection last ran" from arc
 * files on disk rather than from daemon.json (which only records auto-run
 * completions and misses manual `mars arc reflect` invocations).
 *
 * The arc directory is the canonical source — the same one `viewDeepReflections`
 * uses — so the CLI and the Reflections page banner always agree.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** Write a minimal arc JSON file (as `mars arc reflect` would) to the deep-reflections dir. */
const writeArcFile = (deepReflectDir: string, originId: string, recordedAt: string): void => {
  mkdirSync(deepReflectDir, { recursive: true })
  const filename = `arc-${originId}-${recordedAt.replace(/[:.]/g, '-')}.json`
  writeFileSync(
    resolve(deepReflectDir, filename),
    JSON.stringify({
      originId,
      recordedAt,
      status: 'complete',
      report: {
        summary: 'test',
        toolCallStats: { total: 1, byName: {} },
        dissonantCalls: [],
        verifyMismatch: null,
        verifyMismatches: [],
        thrashingPatterns: [],
        rootCause: '',
        suggestions: [],
        scorerSuggestions: [],
        capabilityGapSuggestions: [],
      },
      verdictResult: { saved: 0, absorbed: 0, dropped: 0 },
    }),
    'utf8',
  )
}

beforeEach(() => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-operator-status-reflection-test-'))
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

describe('mars operator status — reflection last ran', () => {
  it('reports "never" when the deep-reflections directory is absent', async () => {
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

    expect(result.code).toBe(0)
    const outText = result.out.join('\n')
    expect(outText).toContain('reflection last ran: never')
  })

  it('reports "never" when the deep-reflections directory exists but is empty', async () => {
    mkdirSync(resolve(repo, '.mars', 'deep-reflections'), { recursive: true })
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

    expect(result.code).toBe(0)
    const outText = result.out.join('\n')
    expect(outText).toContain('reflection last ran: never')
  })

  it('reports the newest recordedAt when arc files exist', async () => {
    const deepReflectDir = resolve(repo, '.mars', 'deep-reflections')
    writeArcFile(deepReflectDir, 'arc-older', '2026-07-10T10:00:00.000Z')
    writeArcFile(deepReflectDir, 'arc-newer', '2026-08-06T21:22:22.077Z')
    writeArcFile(deepReflectDir, 'arc-middle', '2026-07-20T12:51:30.143Z')

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

    expect(result.code).toBe(0)
    // Should report the newest timestamp, not "never", and not an older timestamp
    const outText = result.out.join('\n')
    expect(outText).toContain('reflection last ran: 2026-08-06T21:22:22.077Z')
    expect(outText).not.toContain('reflection last ran: never')
  })

  it('updates the reported timestamp after a manual reflection writes an arc file', async () => {
    vi.doMock('../../../core/daemon/paths', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../core/daemon/paths')>()),
      isDaemonAlive: vi.fn().mockResolvedValue({ alive: false, reason: 'pid file missing' }),
    }))
    const deps = await loadDeps()
    const { makeFakeDaemon, runCommandInProcess } = await import('../../test-adapter')

    // Before any reflection: "never"
    const beforeResult = await runCommandInProcess(['operator', 'status'], {
      ...deps,
      daemon: makeFakeDaemon(),
    })
    expect(beforeResult.out.join('\n')).toContain('reflection last ran: never')

    // Simulate a manual `mars arc reflect` by writing an arc file (no daemon.json update).
    const deepReflectDir = resolve(repo, '.mars', 'deep-reflections')
    writeArcFile(deepReflectDir, 'arc-manual', '2026-08-07T09:00:00.000Z')

    // After: the new timestamp is reported — without any daemon.json mutation
    const afterResult = await runCommandInProcess(['operator', 'status'], {
      ...deps,
      daemon: makeFakeDaemon(),
    })
    expect(afterResult.out.join('\n')).toContain('reflection last ran: 2026-08-07T09:00:00.000Z')
    expect(afterResult.out.join('\n')).not.toContain('reflection last ran: never')
  })

  it('ignores non-JSON files in the deep-reflections directory', async () => {
    const deepReflectDir = resolve(repo, '.mars', 'deep-reflections')
    mkdirSync(deepReflectDir, { recursive: true })
    // Write a non-JSON file — should be ignored
    writeFileSync(resolve(deepReflectDir, 'README.txt'), 'not json', 'utf8')
    // Write one valid arc file
    writeArcFile(deepReflectDir, 'arc-only', '2026-08-01T00:00:00.000Z')

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

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toContain('reflection last ran: 2026-08-01T00:00:00.000Z')
  })
})
