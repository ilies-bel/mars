/**
 * Tests for `mars release-notes list` and bare `mars release-notes`.
 *
 * Covers all acceptance criteria for slice mars-2d2728db:
 *   1. Happy path — daemon up, entries returned: one tab-separated line per arc
 *   2. Empty feed — daemon up, zero entries: prints "release notes empty"
 *   3. Daemon down (no port file) — exits non-zero with daemon-not-running message
 *
 * Isolation: `vi.resetModules()` + fresh temp-dir git repo per test group.
 * `fetch` is stubbed via `vi.stubGlobal` so no real HTTP call is made.
 * The `http.port` file in `.mars/` controls whether `readDaemonPort` returns
 * a port (daemon-up) or null (daemon-down).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.setConfig({ testTimeout: 30_000 })

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'
import type { ReleaseNoteEntry } from '../../../core/daemon/view/release-notes'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_PORT = 19999

const sampleEntries: ReleaseNoteEntry[] = [
  {
    originId: 'abcdef1234567890',
    title: 'Add release notes feed',
    landedAt: '2026-07-24T10:00:00.000Z',
    detail: { prompt: 'add the feed', spec: null, recoveryCount: 1 },
  },
  {
    originId: 'bbbbbbbb11111111',
    title: 'Fix daemon port lookup',
    landedAt: '2026-07-23T08:00:00.000Z',
    detail: { prompt: 'fix port', spec: null, recoveryCount: 0 },
  },
]

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-release-notes-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/** Write the port file so readDaemonPort returns FAKE_PORT. */
const writeDaemonPort = (repoDir: string): void => {
  writeFileSync(resolve(repoDir, '.mars', 'http.port'), String(FAKE_PORT))
}

/**
 * Stub fetch to return the given payload as a JSON response.
 * Returns a vi.fn so callers can inspect calls if needed.
 */
const stubFetch = (payload: unknown): ReturnType<typeof vi.fn> => {
  const mock = vi.fn(async () => ({
    ok: true,
    json: async () => payload,
  }))
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Stub fetch to simulate an unreachable daemon (connection refused). */
const stubFetchDown = (): void => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
}

const loadDeps = async (): Promise<Omit<InProcessOptions, 'daemon'>> => {
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
  vi.unstubAllGlobals()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Happy path — entries rendered as tab-separated lines
// ---------------------------------------------------------------------------

describe('mars release-notes list — happy path', () => {
  it('prints one tab-separated line per arc, newest-first', async () => {
    writeDaemonPort(repo)
    stubFetch(sampleEntries)
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'list'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.err).toHaveLength(0)

    const lines = r.out
    expect(lines).toHaveLength(2)

    // First entry: abcdef12 (first 8 chars), recoveryCount=1
    expect(lines[0]).toBe(
      '2026-07-24T10:00:00.000Z\tabcdef12\t1\tAdd release notes feed',
    )
    // Second entry: bbbbbbbb, recoveryCount=0
    expect(lines[1]).toBe(
      '2026-07-23T08:00:00.000Z\tbbbbbbbb\t0\tFix daemon port lookup',
    )
  })

  it('fetches from the correct URL including the daemon port', async () => {
    writeDaemonPort(repo)
    const fetchMock = stubFetch(sampleEntries)
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['release-notes', 'list'], { ...deps, daemon: fake })

    expect(fetchMock).toHaveBeenCalledOnce()
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain(`${FAKE_PORT}`)
    expect(calledUrl).toContain('/view/release-notes')
  })
})

// ---------------------------------------------------------------------------
// 2. Empty feed
// ---------------------------------------------------------------------------

describe('mars release-notes list — empty feed', () => {
  it('prints "release notes empty" and exits 0 when daemon returns no entries', async () => {
    writeDaemonPort(repo)
    stubFetch([])
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'list'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out).toEqual(['release notes empty'])
    expect(r.err).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 3. Daemon down — no port file
// ---------------------------------------------------------------------------

describe('mars release-notes list — daemon not running', () => {
  it('exits non-zero with daemon-not-running message when port file is absent', async () => {
    // Do NOT write the port file — readDaemonPort returns null.
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'list'], { ...deps, daemon: fake })

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toMatch(/daemon not running/i)
  })

  it('exits non-zero with daemon-not-running message when fetch throws', async () => {
    writeDaemonPort(repo)
    stubFetchDown()
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'list'], { ...deps, daemon: fake })

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toMatch(/daemon not running/i)
  })
})

// ---------------------------------------------------------------------------
// 4. Bare `mars release-notes` — alias for list
// ---------------------------------------------------------------------------

describe('mars release-notes (bare) — alias for list', () => {
  it('produces identical output to release-notes list when entries exist', async () => {
    writeDaemonPort(repo)
    const deps = await loadDeps()
    const fake = await makeFake()

    // First call: bare invocation
    stubFetch(sampleEntries)
    const bareResult = await run(['release-notes'], { ...deps, daemon: fake })

    // Second call: explicit list subcommand
    stubFetch(sampleEntries)
    const listResult = await run(['release-notes', 'list'], { ...deps, daemon: fake })

    expect(bareResult.code).toBe(listResult.code)
    expect(bareResult.out).toEqual(listResult.out)
    expect(bareResult.err).toEqual(listResult.err)
  })

  it('prints "release notes empty" via bare invocation', async () => {
    writeDaemonPort(repo)
    stubFetch([])
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out).toEqual(['release notes empty'])
  })

  it('exits non-zero with daemon message via bare invocation when daemon is down', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes'], { ...deps, daemon: fake })

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toMatch(/daemon not running/i)
  })
})
