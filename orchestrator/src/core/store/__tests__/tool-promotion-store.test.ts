/**
 * Tests for the tool-promotion-store module.
 *
 * Each CRUD function accepts an explicit `db: Client` argument, so test
 * isolation is straightforward: create a temp-file libsql database, apply
 * the DDL, run the assertions, then tear down. No module resets needed.
 *
 * `:memory:` is avoided — it has known incompatibilities with libsql write
 * transactions in this project (see fix-recipes.ts for details).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createClient } from '@libsql/client'
import type { Client } from '@libsql/client'
import {
  insertAttempt,
  getAttempt,
  listAttemptsByStatus,
  updateAttemptStatus,
} from '../tool-promotion-store'

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * The exact DDL for tool_promotion_attempts, mirrored here so tests can
 * bootstrap an isolated db without going through initToolPromotionAttempts()
 * (which binds to the process-wide state client).
 */
const TOOL_PROMOTION_ATTEMPTS_DDL = `
  CREATE TABLE IF NOT EXISTS tool_promotion_attempts (
    id                 TEXT    PRIMARY KEY,
    helper_key         TEXT    NOT NULL,
    motivating_arc_ids TEXT    NOT NULL,
    status             TEXT    NOT NULL CHECK(status IN ('proposed','benchmarked','promoted','retired')),
    benchmark_before   TEXT,
    benchmark_after    TEXT,
    created_at         INTEGER NOT NULL,
    decided_at         INTEGER
  )
`

const setupDb = async (): Promise<{ db: Client; tempDir: string }> => {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'mars-tool-promo-test-'))
  mkdirSync(resolve(tempDir, '.mars'), { recursive: true })
  const db = createClient({ url: `file:${resolve(tempDir, '.mars', 'mars.db')}` })
  await db.execute(TOOL_PROMOTION_ATTEMPTS_DDL)
  return { db, tempDir }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tool-promotion-store', () => {
  let db: Client
  let tempDir: string

  beforeEach(async () => {
    ;({ db, tempDir } = await setupDb())
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── insertAttempt / getAttempt ────────────────────────────────────────────

  it('inserts an attempt with status proposed and retrieves it by id', async () => {
    const input = {
      id: 'tpa-001',
      helperKey: 'retry-with-backoff',
      motivatingArcIds: ['arc-aaa', 'arc-bbb'],
      createdAt: 1_700_000_000,
    }

    const inserted = await insertAttempt(db, input)

    expect(inserted.id).toBe('tpa-001')
    expect(inserted.helperKey).toBe('retry-with-backoff')
    expect(inserted.motivatingArcIds).toEqual(['arc-aaa', 'arc-bbb'])
    expect(inserted.status).toBe('proposed')
    expect(inserted.benchmarkBefore).toBeNull()
    expect(inserted.benchmarkAfter).toBeNull()
    expect(inserted.createdAt).toBe(1_700_000_000)
    expect(inserted.decidedAt).toBeNull()
  })

  it('returns null for a missing id', async () => {
    const result = await getAttempt(db, 'does-not-exist')
    expect(result).toBeNull()
  })

  it('getAttempt returns the same row as insertAttempt', async () => {
    await insertAttempt(db, {
      id: 'tpa-get',
      helperKey: 'parse-error-extractor',
      motivatingArcIds: ['arc-x'],
      createdAt: 1_700_000_500,
    })

    const fetched = await getAttempt(db, 'tpa-get')
    expect(fetched).not.toBeNull()
    expect(fetched!.helperKey).toBe('parse-error-extractor')
    expect(fetched!.motivatingArcIds).toEqual(['arc-x'])
    expect(fetched!.status).toBe('proposed')
  })

  // ── listAttemptsByStatus ──────────────────────────────────────────────────

  it('lists only attempts matching the given status', async () => {
    await insertAttempt(db, {
      id: 'tpa-a',
      helperKey: 'helper-a',
      motivatingArcIds: ['arc-1'],
      createdAt: 1_700_000_001,
    })
    await insertAttempt(db, {
      id: 'tpa-b',
      helperKey: 'helper-b',
      motivatingArcIds: ['arc-2'],
      createdAt: 1_700_000_002,
    })

    const proposed = await listAttemptsByStatus(db, 'proposed')
    expect(proposed).toHaveLength(2)
    expect(proposed.map((a) => a.id)).toEqual(['tpa-a', 'tpa-b'])

    const benchmarked = await listAttemptsByStatus(db, 'benchmarked')
    expect(benchmarked).toHaveLength(0)
  })

  // ── Full round-trip ───────────────────────────────────────────────────────

  it('exercises insert → list(proposed) → updateStatus(benchmarked, payload) → list(benchmarked) round-trip', async () => {
    // 1. Insert
    await insertAttempt(db, {
      id: 'tpa-roundtrip',
      helperKey: 'parse-error-extractor',
      motivatingArcIds: ['arc-x', 'arc-y', 'arc-z'],
      createdAt: 1_700_000_100,
    })

    // 2. list('proposed') — should include the new row
    const beforeUpdate = await listAttemptsByStatus(db, 'proposed')
    expect(beforeUpdate.map((a) => a.id)).toContain('tpa-roundtrip')

    // 3. updateStatus to 'benchmarked' with benchmark payloads
    const benchmarkBefore = JSON.stringify({ p50ms: 120, tokens: 800 })
    const benchmarkAfter = JSON.stringify({ p50ms: 95, tokens: 620 })
    await updateAttemptStatus(db, 'tpa-roundtrip', 'benchmarked', {
      benchmarkBefore,
      benchmarkAfter,
      decidedAt: 1_700_001_000,
    })

    // 4. list('benchmarked') — should now contain the updated row
    const afterUpdate = await listAttemptsByStatus(db, 'benchmarked')
    expect(afterUpdate).toHaveLength(1)

    const row = afterUpdate[0]
    expect(row.id).toBe('tpa-roundtrip')
    expect(row.status).toBe('benchmarked')
    expect(JSON.parse(row.benchmarkBefore!)).toMatchObject({ p50ms: 120, tokens: 800 })
    expect(JSON.parse(row.benchmarkAfter!)).toMatchObject({ p50ms: 95, tokens: 620 })
    expect(row.decidedAt).toBe(1_700_001_000)

    // The row must no longer appear under 'proposed'
    const stillProposed = await listAttemptsByStatus(db, 'proposed')
    expect(stillProposed.map((a) => a.id)).not.toContain('tpa-roundtrip')
  })
})
