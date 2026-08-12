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
import type { DbClient } from '../../../lib/db.js'

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
