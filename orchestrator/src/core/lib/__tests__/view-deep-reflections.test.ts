/**
 * Behaviour tests for viewDeepReflections (AppServices).
 *
 * These tests drive the real file-system reader through a temp directory
 * to verify three concrete bugs that were measured live:
 *
 *   1. arc- prefix filter silently dropped 13 of 74 reports.
 *   2. Lexical sort by filename produced wrong order when originId, not
 *      ISO timestamp, dominated the sort key.
 *   3. Malformed files were silently swallowed with no signal.
 *
 * All assertions are on observable behaviour (the returned value) through
 * the AppServices public interface.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAppServices } from '../../app-services'
import type { AppServices } from '../../app-services'
import { __resetContextCacheForTests } from '../../context'
import { openTraceEventStore, type TraceEventStore } from '../trace-events-store'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mars-view-deep-ref-'))
  mkdirSync(join(dir, '.mars', 'deep-reflections'), { recursive: true })
  return dir
}

const makeServices = (traceStore: TraceEventStore): AppServices =>
  createAppServices({
    traceStore,
    buildAlertSources: async () => ({
      listFailedArcs: async () => [],
      listStaleWorktrees: async () => [],
      listVerifyUncovered: async () => [],
    }),
    loadWorkerDeclarations: () => [],
    listAwaitingHumanParks: async () => [],
  })

/** Minimal valid report JSON. */
const reportJson = (originId: string, recordedAt: string, status = 'complete') =>
  JSON.stringify({ originId, recordedAt, status })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('viewDeepReflections', () => {
  let repo: string
  let store: TraceEventStore
  let svc: AppServices

  beforeEach(async () => {
    repo = makeRepo()
    __resetContextCacheForTests()
    process.env.MARS_REPO = repo
    store = await openTraceEventStore(join(repo, '.mars', 'mars.db'))
    svc = makeServices(store)
  })

  afterEach(async () => {
    delete process.env.MARS_REPO
    __resetContextCacheForTests()
    await store.close()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns empty with zero counts when the deep-reflections directory does not exist', async () => {
    rmSync(join(repo, '.mars', 'deep-reflections'), { recursive: true })

    const result = await svc.viewDeepReflections()

    expect(result.reports).toHaveLength(0)
    expect(result.totalDiscovered).toBe(0)
    expect(result.unreadableCount).toBe(0)
    expect(result.lastReflectedAt).toBeNull()
  })

  it('includes all .json files regardless of prefix — arc- and non-arc- naming schemes both count', async () => {
    const dir = join(repo, '.mars', 'deep-reflections')

    // Current naming: arc-<originId>-<slug>-<ISO>.json
    writeFileSync(join(dir, 'arc-abc123-2026-08-01T10-00-00-000Z.json'), reportJson('abc123', '2026-08-01T10:00:00.000Z'))
    // Old naming: <originId>-<ISO>.json (13 files on disk use this)
    writeFileSync(join(dir, 'xyz789-2026-07-01T10-00-00-000Z.json'), reportJson('xyz789', '2026-07-01T10:00:00.000Z'))
    // mars- prefix variant also seen in the wild
    writeFileSync(join(dir, 'mars-def456-2026-06-01T10-00-00-000Z.json'), reportJson('def456', '2026-06-01T10:00:00.000Z'))

    const result = await svc.viewDeepReflections()

    expect(result.reports).toHaveLength(3)
    expect(result.totalDiscovered).toBe(3)
    const ids = result.reports.map((r) => r.originId)
    expect(ids).toContain('abc123')
    expect(ids).toContain('xyz789')
    expect(ids).toContain('def456')
  })

  it('orders reports by recordedAt descending, not by filename lexical order', async () => {
    const dir = join(repo, '.mars', 'deep-reflections')
    // Filenames: lexical sort puts arc-zzz... before arc-aaa... (Z > A).
    // But recordedAt is opposite: aaa is newer (2026-08-06 > 2026-07-20).
    writeFileSync(join(dir, 'arc-zzz-2026-07-20T00-00-00-000Z.json'), reportJson('zzz', '2026-07-20T00:00:00.000Z'))
    writeFileSync(join(dir, 'arc-aaa-2026-08-06T00-00-00-000Z.json'), reportJson('aaa', '2026-08-06T00:00:00.000Z'))

    const result = await svc.viewDeepReflections()

    expect(result.reports).toHaveLength(2)
    // aaa (Aug 6) must come first — it has the newer recordedAt
    expect(result.reports[0]?.originId).toBe('aaa')
    expect(result.reports[1]?.originId).toBe('zzz')
  })

  it('sets lastReflectedAt to the true max recordedAt, not the filename-first entry', async () => {
    const dir = join(repo, '.mars', 'deep-reflections')
    // Lexical sort by filename: 'arc-zzz-...' sorts AFTER 'arc-aaa-...' (Z > A),
    // so a reversed lexical sort puts zzz (Jul 20) first — giving the WRONG date.
    // lastReflectedAt must be Aug 6 (the actual newest recordedAt).
    writeFileSync(join(dir, 'arc-zzz-2026-07-20T00-00-00-000Z.json'), reportJson('zzz', '2026-07-20T00:00:00.000Z'))
    writeFileSync(join(dir, 'arc-aaa-2026-08-06T00-00-00-000Z.json'), reportJson('aaa', '2026-08-06T00:00:00.000Z'))

    const result = await svc.viewDeepReflections()

    expect(result.lastReflectedAt).toBe('2026-08-06T00:00:00.000Z')
  })

  it('counts malformed files in unreadableCount and still returns the valid reports', async () => {
    const dir = join(repo, '.mars', 'deep-reflections')
    writeFileSync(join(dir, 'arc-good-2026-08-01T10-00-00-000Z.json'), reportJson('good', '2026-08-01T10:00:00.000Z'))
    writeFileSync(join(dir, 'arc-bad-2026-08-02T10-00-00-000Z.json'), 'not valid json {{{')

    const result = await svc.viewDeepReflections()

    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]?.originId).toBe('good')
    expect(result.totalDiscovered).toBe(2)
    expect(result.unreadableCount).toBe(1)
  })

  it('totalDiscovered reflects all files on disk while limit caps the returned list', async () => {
    const dir = join(repo, '.mars', 'deep-reflections')
    for (let i = 1; i <= 5; i++) {
      const ts = `2026-08-0${i}T00:00:00.000Z`
      writeFileSync(join(dir, `arc-task${i}.json`), reportJson(`task-${i}`, ts))
    }

    const result = await svc.viewDeepReflections({ limit: 3 })

    expect(result.totalDiscovered).toBe(5)
    expect(result.reports).toHaveLength(3)
    // Newest three come first (Aug 5, 4, 3)
    expect(result.reports[0]?.originId).toBe('task-5')
    expect(result.reports[1]?.originId).toBe('task-4')
    expect(result.reports[2]?.originId).toBe('task-3')
  })

  it('lastReflectedAt is the max across all parsed reports, even those outside the limit page', async () => {
    const dir = join(repo, '.mars', 'deep-reflections')
    for (let i = 1; i <= 5; i++) {
      const ts = `2026-08-0${i}T00:00:00.000Z`
      writeFileSync(join(dir, `arc-task${i}.json`), reportJson(`task-${i}`, ts))
    }

    // With limit=2 we only return 2 reports in the page, but lastReflectedAt
    // must still be 2026-08-05 (the overall max), not the older in-page value.
    const result = await svc.viewDeepReflections({ limit: 2 })

    expect(result.lastReflectedAt).toBe('2026-08-05T00:00:00.000Z')
  })
})
