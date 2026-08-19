/**
 * Unit tests for derived-conditions.ts — specifically the daemon-died derivation
 * and the createConditionItemsSource factory.
 *
 * Regression guard for the ESM-require bug fixed in ADR-0057 follow-up:
 * `require('node:fs')` inside deriveDaemonDiedConditions failed silently
 * (caught by the surrounding try/catch), meaning crash markers were found but
 * their pid/startedAt/crashDetectedAt were never parsed — the item was emitted
 * with placeholder values instead. This test asserts the real values from a
 * written crash marker appear in the returned item.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createConditionItemsSource } from '../derived-conditions.js'
import { humanSummary as recipeHumanSummary } from '../../../lib/action-queue-recipes.js'
import type { DbClient, DbStatement } from '../../../lib/db.js'

// ── Minimal mock DbClient ─────────────────────────────────────────────────────
// daemon-died derivation is filesystem-only; it never touches the DB.
const emptyDbClient: DbClient = {
  execute: async () => ({ rows: [], rowsAffected: 0 }),
  batch: async () => [],
  close: async () => {},
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeTmpDir = (): string => mkdtempSync(resolve(tmpdir(), 'mars-derived-conds-'))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createConditionItemsSource — daemon-died derivation', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when crash marker is absent', async () => {
    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: resolve(tmpDir, 'does-not-exist.json'),
    })
    const rows = await source.derive({ kinds: new Set(['daemon-died']) })
    expect(rows).toEqual([])
  })

  it('returns a daemon-died row when crash marker file exists', async () => {
    const markerPath = resolve(tmpDir, 'daemon.crash.json')
    const crashInfo = {
      pid: 9876,
      startedAt: '2026-08-01T10:00:00.000Z',
      crashDetectedAt: '2026-08-01T10:45:00.000Z',
    }
    writeFileSync(markerPath, JSON.stringify(crashInfo))

    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: markerPath,
    })
    const rows = await source.derive({ kinds: new Set(['daemon-died']) })

    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.kind).toBe('daemon-died')
    expect(row.priority).toBe('high')
    expect(row.title).toBe('Daemon exited unexpectedly')
    // These three assertions fail before the fix because require('node:fs')
    // throws into the catch, leaving pid=0 and startedAt='' in the output.
    expect(row.payload).toMatchObject({
      pid: crashInfo.pid,
      startedAt: crashInfo.startedAt,
      crashDetectedAt: crashInfo.crashDetectedAt,
    })
    expect(row.body).toContain(String(crashInfo.pid))
    expect(row.body).toContain(crashInfo.startedAt)
  })

  it('still returns a row with default values when crash marker is malformed JSON', async () => {
    const markerPath = resolve(tmpDir, 'bad.json')
    writeFileSync(markerPath, 'not-valid-json')

    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: markerPath,
    })
    const rows = await source.derive({ kinds: new Set(['daemon-died']) })

    // A row is still emitted — presence alone is enough.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('daemon-died')
    // pid defaults to 0 (unknown) when JSON is unreadable.
    expect((rows[0]!.payload as { pid: number }).pid).toBe(0)
  })

  it('returns empty array when no kinds match (kinds hint respected)', async () => {
    const markerPath = resolve(tmpDir, 'daemon.crash.json')
    writeFileSync(markerPath, JSON.stringify({ pid: 1, startedAt: '2026-01-01T00:00:00.000Z', crashDetectedAt: '2026-01-01T01:00:00.000Z' }))

    const source = createConditionItemsSource({
      getClient: () => emptyDbClient,
      crashMarkerPath: markerPath,
    })
    // Requesting a kind that daemon-died is not — result must be empty.
    const rows = await source.derive({ kinds: new Set(['failed']) })
    // All DB queries return empty rows, so no 'failed' items either.
    expect(rows).toEqual([])
  })
})

// ── stale-queued: phantom in-flight-status misattribution ──────────────────
//
// Incident shape (mars-6340b827 / mars-d039e664): a hard `mars daemon
// restart` leaves N task rows in an in-flight DB status (running/verifying/
// merging/vega-reconciling) with zero live jobs in the in-memory tracker.
// `deriveStaleQueuedConditions` only suppressed the alert when the *live*
// tracker count reached the implement cap, so it never suppressed — and the
// generic recipe copy blamed "the worker pool may be saturated or the
// dispatcher may be stuck" instead of naming the actual cause. These tests
// assert the row's payload carries `inFlightStatusCount` and that the
// recipe's `humanSummary` names the phantom rows (not the queued task) as
// the cause when the mismatch is present, while staying generic when the
// tracker genuinely holds the in-flight jobs.

const IN_FLIGHT_STATUS_SQL_FRAGMENT = "IN ('running', 'verifying', 'merging', 'vega-reconciling')"

/**
 * A mock DbClient that answers the two queries `deriveStaleQueuedConditions`
 * issues: the in-flight-status COUNT(*) and the queued-tasks SELECT.
 */
const makeStaleQueuedDbClient = (opts: {
  inFlightStatusCount: number
  queuedTasks: Array<{ id: string; updatedAtIso: string; prompt: string }>
}): DbClient => ({
  execute: async (stmt: DbStatement) => {
    const sql = typeof stmt === 'string' ? stmt : stmt.sql
    if (sql.includes(IN_FLIGHT_STATUS_SQL_FRAGMENT)) {
      return { rows: [{ n: opts.inFlightStatusCount }], rowsAffected: 0 }
    }
    if (sql.includes("status = 'queued'")) {
      return {
        rows: opts.queuedTasks.map((t) => ({ id: t.id, updated_at: t.updatedAtIso, prompt: t.prompt })),
        rowsAffected: 0,
      }
    }
    return { rows: [], rowsAffected: 0 }
  },
  batch: async () => [],
  close: async () => {},
})

describe('createConditionItemsSource — stale-queued phantom in-flight attribution', () => {
  const NOW = Date.parse('2026-08-19T12:00:00.000Z')
  const STALE_UPDATED_AT = new Date(NOW - 20 * 60_000).toISOString() // 20 min ago

  it('attributes the alert to phantom in-flight rows when the tracker is empty but the DB shows the cap saturated', async () => {
    const client = makeStaleQueuedDbClient({
      inFlightStatusCount: 5,
      queuedTasks: [{ id: 'mars-stale-1', updatedAtIso: STALE_UPDATED_AT, prompt: 'do the thing' }],
    })
    const source = createConditionItemsSource({
      getClient: () => client,
      getActiveWorkerCount: () => 0,
      getImplementCap: () => 5,
      nowMs: NOW,
    })

    const rows = await source.derive({ kinds: new Set(['stale-queued']) })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.payload['inFlightStatusCount']).toBe(5)
    expect(row.payload['activeWorkerCount']).toBe(0)
    expect(row.payload['implementCap']).toBe(5)

    const summary = recipeHumanSummary('stale-queued', row.payload)
    expect(summary).toContain('stuck in an in-flight status')
    expect(summary).toContain('mars sync')
    expect(summary).not.toContain('the worker pool may be saturated or the dispatcher may be stuck')
  })

  it('keeps the generic message when the tracker genuinely holds the in-flight jobs (no phantom mismatch)', async () => {
    const client = makeStaleQueuedDbClient({
      inFlightStatusCount: 2,
      queuedTasks: [{ id: 'mars-stale-2', updatedAtIso: STALE_UPDATED_AT, prompt: 'do another thing' }],
    })
    const source = createConditionItemsSource({
      getClient: () => client,
      getActiveWorkerCount: () => 2,
      getImplementCap: () => 5,
      nowMs: NOW,
    })

    const rows = await source.derive({ kinds: new Set(['stale-queued']) })
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.payload['inFlightStatusCount']).toBe(2)
    expect(row.payload['activeWorkerCount']).toBe(2)

    const summary = recipeHumanSummary('stale-queued', row.payload)
    expect(summary).toContain('the worker pool may be saturated or the dispatcher may be stuck')
    expect(summary).not.toContain('phantom')
    expect(summary).not.toContain('mars sync')
  })
})
