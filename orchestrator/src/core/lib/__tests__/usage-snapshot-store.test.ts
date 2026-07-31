/**
 * Behavioural tests for usage-snapshot-store.ts and the `mars daemon usage`
 * CLI command.
 *
 * All tests share one PGlite instance (single beforeAll / afterAll) to avoid
 * the WASM filesystem re-initialisation error that can occur when multiple
 * describe blocks each spin up their own PGlite instance in the same vitest
 * worker.
 *
 * The tests cover observable behaviour through the public interface only:
 *   - getLatestUsageSnapshot returns null on an empty table.
 *   - insertUsageSnapshot → getLatestUsageSnapshot round-trips correctly.
 *   - The latest row wins when multiple rows exist.
 *   - `mars daemon usage` prints the latest row as JSON via the CLI seam.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// ── Shared fixture ────────────────────────────────────────────────────────────

let repo: string
let storeModule: typeof import('../usage-snapshot-store.js')
let queueModule: typeof import('../../queue.js')

beforeAll(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-usage-snapshot-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })

  vi.resetModules()
  process.env.MARS_REPO = repo
  process.env.MARS_DB_BACKEND = 'pglite'

  queueModule = await import('../../queue.js')
  await queueModule.migrateQueueSchema()
  storeModule = await import('../usage-snapshot-store.js')
})

afterAll(() => {
  delete process.env.MARS_REPO
  delete process.env.MARS_DB_BACKEND
  rmSync(repo, { recursive: true, force: true })
})

// ── Store behaviour ───────────────────────────────────────────────────────────

describe('usage-snapshot-store', () => {
  it('getLatestUsageSnapshot returns null when no snapshot exists', async () => {
    const client = queueModule.resolveQueueClient()
    const result = await storeModule.getLatestUsageSnapshot(client)
    expect(result).toBeNull()
  })

  it('insertUsageSnapshot → getLatestUsageSnapshot round-trips correctly', async () => {
    const client = queueModule.resolveQueueClient()

    await storeModule.insertUsageSnapshot(
      {
        capturedAt: '2026-07-27T12:00:00.000Z',
        inputTokens: 1234,
        outputTokens: 567,
        windowKind: 'rolling',
        rawJson: { messageCount: 3 },
      },
      client,
    )

    const row = await storeModule.getLatestUsageSnapshot(client)

    expect(row).not.toBeNull()
    expect(row!.inputTokens).toBe(1234)
    expect(row!.outputTokens).toBe(567)
    expect(row!.windowKind).toBe('rolling')
    expect(row!.rawJson).toMatchObject({ messageCount: 3 })
    expect(typeof row!.id).toBe('number')
  })

  it('returns the most recent snapshot when multiple rows exist', async () => {
    const client = queueModule.resolveQueueClient()

    // Insert an older row (earlier captured_at).
    await storeModule.insertUsageSnapshot(
      {
        capturedAt: '2026-07-27T10:00:00.000Z',
        inputTokens: 100,
        outputTokens: 50,
        windowKind: 'rolling',
        rawJson: {},
      },
      client,
    )
    // Insert the newer row (later captured_at).
    await storeModule.insertUsageSnapshot(
      {
        capturedAt: '2026-07-27T13:00:00.000Z',
        inputTokens: 9999,
        outputTokens: 888,
        windowKind: 'rolling',
        rawJson: {},
      },
      client,
    )

    const row = await storeModule.getLatestUsageSnapshot(client)

    expect(row).not.toBeNull()
    expect(row!.inputTokens).toBe(9999)
    expect(row!.outputTokens).toBe(888)
  })
})

// ── CLI: mars daemon usage ────────────────────────────────────────────────────

describe('mars daemon usage CLI command', () => {
  it('prints the latest snapshot as JSON (code 0)', async () => {
    // Insert a known snapshot.
    const client = queueModule.resolveQueueClient()
    await storeModule.insertUsageSnapshot(
      {
        capturedAt: '2026-07-27T14:00:00.000Z',
        inputTokens: 9000,
        outputTokens: 1500,
        windowKind: 'rolling',
        rawJson: { messageCount: 7 },
      },
      client,
    )

    // Invoke the CLI command in-process via the same module context.
    const { runCommandInProcess, makeFakeDaemon } = await import('../../../cli/test-adapter.js')
    const result = await runCommandInProcess(
      ['daemon', 'usage'],
      {
        store: {} as never,
        daemon: makeFakeDaemon(),
        ctx: {
          repoRoot: repo,
          stateDir: resolve(repo, '.mars'),
          queueDbPath: resolve(repo, '.mars', 'queue.db'),
          observabilityDbPath: resolve(repo, '.mars', 'obs.db'),
          stateDbPath: resolve(repo, '.mars', 'state.db'),
        },
      },
    )

    expect(result.code).toBe(0)
    const printed = result.out.join('\n')
    const parsed = JSON.parse(printed) as Record<string, unknown>
    expect(parsed['inputTokens']).toBe(9000)
    expect(parsed['outputTokens']).toBe(1500)
    expect(parsed['windowKind']).toBe('rolling')
  })
})
