/**
 * Tests for `mars release-notes list`, bare `mars release-notes`, and
 * `mars release-notes mark-viewed`.
 *
 * Covers all acceptance criteria for slices mars-2d2728db and mars-562dab0a:
 *   1. Happy path — daemon up, entries returned: one tab-separated line per arc
 *   2. Empty feed — daemon up, zero entries: prints "release notes empty"
 *   3. Daemon down (no port file) — exits non-zero with daemon-not-running message
 *   4. --since filtering — only entries strictly newer than the ISO timestamp
 *   5. --unseen — reads cursor and filters; all entries when cursor is null
 *   6. --since + --unseen conflict — usage error exit 2
 *   7. --mark-viewed — POSTs cursor after listing, prints "marked viewed at <ISO>"
 *   8. mark-viewed subcommand — POSTs cursor, prints timestamp
 *   9. Invalid --since — exits non-zero with usage message
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

/**
 * Stub fetch to dispatch to per-path handlers based on URL substring matching.
 * Keys are sorted by length descending so more-specific paths (e.g.
 * `/view/release-notes-cursor`) match before their prefixes (`/view/release-notes`).
 */
const stubFetchMulti = (
  handlers: Record<string, unknown | (() => Promise<unknown>)>,
): ReturnType<typeof vi.fn> => {
  // Longer keys are more specific; sort descending so they win over prefixes.
  const sortedKeys = Object.keys(handlers).sort((a, b) => b.length - a.length)
  const mock = vi.fn(async (url: string, _init?: RequestInit) => {
    const key = sortedKeys.find((k) => url.includes(k))
    if (key === undefined) throw new Error(`unexpected fetch URL: ${url}`)
    const payload =
      typeof handlers[key] === 'function'
        ? await (handlers[key] as () => Promise<unknown>)()
        : handlers[key]
    return {
      ok: true,
      json: async () => payload,
    }
  })
  vi.stubGlobal('fetch', mock)
  return mock
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

// ---------------------------------------------------------------------------
// 5. --since filtering
// ---------------------------------------------------------------------------

describe('mars release-notes list --since', () => {
  it('filters to entries strictly newer than the given ISO timestamp', async () => {
    writeDaemonPort(repo)
    stubFetch(sampleEntries)
    const deps = await loadDeps()
    const fake = await makeFake()

    // Only the 2026-07-24 entry is newer than 2026-07-23T12:00:00Z
    const r = await run(
      ['release-notes', 'list', '--since', '2026-07-23T12:00:00Z'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    expect(r.out[0]).toContain('Add release notes feed')
  })

  it('prints "release notes empty" when no entries are newer than --since', async () => {
    writeDaemonPort(repo)
    stubFetch(sampleEntries)
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['release-notes', 'list', '--since', '2026-07-25T00:00:00Z'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(r.out).toEqual(['release notes empty'])
  })

  it('shows all entries when --since is older than every entry', async () => {
    writeDaemonPort(repo)
    stubFetch(sampleEntries)
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['release-notes', 'list', '--since', '2026-07-01T00:00:00Z'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(2)
  })

  it('exits non-zero with usage message for an invalid --since value', async () => {
    writeDaemonPort(repo)
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['release-notes', 'list', '--since', 'not-a-date'],
      { ...deps, daemon: fake },
    )

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toContain('usage:')
  })

  it('exits with code 2 for invalid --since (not code 1)', async () => {
    writeDaemonPort(repo)
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['release-notes', 'list', '--since', 'garbage'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 6. --unseen filtering
// ---------------------------------------------------------------------------

describe('mars release-notes list --unseen', () => {
  it('shows all entries when cursor is null (never viewed)', async () => {
    writeDaemonPort(repo)
    stubFetchMulti({
      '/view/release-notes-cursor': { lastViewedAt: null },
      '/view/release-notes': sampleEntries,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'list', '--unseen'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(2)
  })

  it('filters to entries newer than cursor lastViewedAt', async () => {
    writeDaemonPort(repo)
    stubFetchMulti({
      '/view/release-notes-cursor': { lastViewedAt: '2026-07-23T12:00:00.000Z' },
      '/view/release-notes': sampleEntries,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'list', '--unseen'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    expect(r.out[0]).toContain('Add release notes feed')
  })

  it('prints "release notes empty" when all entries are already viewed', async () => {
    writeDaemonPort(repo)
    stubFetchMulti({
      '/view/release-notes-cursor': { lastViewedAt: '2026-07-25T00:00:00.000Z' },
      '/view/release-notes': sampleEntries,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'list', '--unseen'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out).toEqual(['release notes empty'])
  })

  it('GETs the cursor from /view/release-notes-cursor', async () => {
    writeDaemonPort(repo)
    const fetchMock = stubFetchMulti({
      '/view/release-notes-cursor': { lastViewedAt: null },
      '/view/release-notes': sampleEntries,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    await run(['release-notes', 'list', '--unseen'], { ...deps, daemon: fake })

    const calledUrls = (fetchMock.mock.calls as [string][]).map(([url]) => url)
    expect(calledUrls.some((u) => u.includes('/view/release-notes-cursor'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 7. --since + --unseen conflict
// ---------------------------------------------------------------------------

describe('mars release-notes list --since + --unseen conflict', () => {
  it('rejects combining --since and --unseen with usage error and exit 2', async () => {
    writeDaemonPort(repo)
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['release-notes', 'list', '--since', '2026-07-01T00:00:00Z', '--unseen'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('usage:')
  })
})

// ---------------------------------------------------------------------------
// 8. --mark-viewed combined with listing
// ---------------------------------------------------------------------------

describe('mars release-notes list --mark-viewed', () => {
  it('POSTs the cursor after listing and prints "marked viewed at <ISO>"', async () => {
    writeDaemonPort(repo)
    const CURSOR_RESULT = { lastViewedAt: '2026-07-26T12:00:00.000Z' }
    const fetchMock = stubFetchMulti({
      '/view/release-notes': sampleEntries,
      '/view/release-notes-cursor': CURSOR_RESULT,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['release-notes', 'list', '--mark-viewed'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(0)
    // Last output line is the "marked viewed at" confirmation
    const lastLine = r.out[r.out.length - 1]
    expect(lastLine).toBe(`marked viewed at ${CURSOR_RESULT.lastViewedAt}`)

    // Verify that a POST was made to the cursor endpoint
    const calls = fetchMock.mock.calls as [string, RequestInit?][]
    const postCall = calls.find(([url, init]) =>
      url.includes('/view/release-notes-cursor') && init?.method === 'POST',
    )
    expect(postCall).toBeDefined()
  })

  it('entries are still printed before the "marked viewed at" line', async () => {
    writeDaemonPort(repo)
    const CURSOR_RESULT = { lastViewedAt: '2026-07-26T12:00:00.000Z' }
    stubFetchMulti({
      '/view/release-notes': sampleEntries,
      '/view/release-notes-cursor': CURSOR_RESULT,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['release-notes', 'list', '--mark-viewed'],
      { ...deps, daemon: fake },
    )

    // 2 entries + 1 "marked viewed at" line
    expect(r.out).toHaveLength(3)
    expect(r.out[0]).toContain('Add release notes feed')
    expect(r.out[1]).toContain('Fix daemon port lookup')
    expect(r.out[2]).toContain('marked viewed at')
  })

  it('can combine --since with --mark-viewed', async () => {
    writeDaemonPort(repo)
    const CURSOR_RESULT = { lastViewedAt: '2026-07-26T12:00:00.000Z' }
    stubFetchMulti({
      '/view/release-notes': sampleEntries,
      '/view/release-notes-cursor': CURSOR_RESULT,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(
      ['release-notes', 'list', '--since', '2026-07-23T12:00:00Z', '--mark-viewed'],
      { ...deps, daemon: fake },
    )

    expect(r.code).toBe(0)
    // 1 filtered entry + mark-viewed line
    expect(r.out).toHaveLength(2)
    expect(r.out[0]).toContain('Add release notes feed')
    expect(r.out[1]).toContain('marked viewed at')
  })
})

// ---------------------------------------------------------------------------
// 9. `mars release-notes mark-viewed` subcommand
// ---------------------------------------------------------------------------

describe('mars release-notes mark-viewed', () => {
  it('POSTs the cursor and prints the returned timestamp', async () => {
    writeDaemonPort(repo)
    const CURSOR_RESULT = { lastViewedAt: '2026-07-26T15:00:00.000Z' }
    const fetchMock = stubFetchMulti({
      '/view/release-notes-cursor': CURSOR_RESULT,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'mark-viewed'], { ...deps, daemon: fake })

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    expect(r.out[0]).toBe(CURSOR_RESULT.lastViewedAt)

    // Verify a POST was made (not a GET)
    const calls = fetchMock.mock.calls as [string, RequestInit?][]
    const postCall = calls.find(([url, init]) =>
      url.includes('/view/release-notes-cursor') && init?.method === 'POST',
    )
    expect(postCall).toBeDefined()
  })

  it('exits non-zero when daemon is not running', async () => {
    // No port file
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'mark-viewed'], { ...deps, daemon: fake })

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toMatch(/daemon not running/i)
  })

  it('does not print any release-notes entries — only the timestamp', async () => {
    writeDaemonPort(repo)
    const CURSOR_RESULT = { lastViewedAt: '2026-07-26T15:00:00.000Z' }
    stubFetchMulti({
      '/view/release-notes-cursor': CURSOR_RESULT,
    })
    const deps = await loadDeps()
    const fake = await makeFake()

    const r = await run(['release-notes', 'mark-viewed'], { ...deps, daemon: fake })

    // Exactly one output line — the timestamp, nothing else
    expect(r.out).toHaveLength(1)
  })
})
