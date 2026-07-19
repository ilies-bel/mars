/**
 * Tests for tool-benchmark.ts.
 *
 * Tests verify observable behaviour through the public interface:
 * - `runBenchmark` transitions an attempt to 'benchmarked' and persists
 *   non-null JSON in benchmark_before / benchmark_after with decided_at null.
 * - A second call on an already-benchmarked row is idempotent (no double-write).
 * - A call for an unknown attempt id throws.
 *
 * The arc-replayer is stubbed via a closure; the DB is an isolated temp-file
 * libsql instance (`:memory:` avoided — known libsql write-transaction issue).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Client } from '@libsql/client'
import { openLibsql } from '../libsql'
import { runBenchmark } from '../tool-benchmark'
import type { ArcRunResult, ArcReplayer } from '../tool-benchmark'
import {
  insertAttempt,
  getAttempt,
} from '../../store/tool-promotion-store'

// ── DDL ───────────────────────────────────────────────────────────────────────

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

// ── Test fixtures ─────────────────────────────────────────────────────────────

let db: Client
let tmpDir: string

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mars-tool-bench-'))
  db = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
  await db.execute(TOOL_PROMOTION_ATTEMPTS_DDL)
})

afterEach(async () => {
  await db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Insert a proposed attempt with given arc ids. */
const insertProposedAttempt = (
  id: string,
  arcIds: string[],
): Promise<void> =>
  insertAttempt(db, {
    id,
    helperKey: `helper:test-${id}`,
    motivatingArcIds: arcIds,
    createdAt: 1_700_000_000,
  }).then(() => undefined)

/**
 * Stub arc-replayer factory.
 * Returns configurable per-mode metrics and exposes a spy for call assertions.
 */
const makeReplayer = (
  baselineResult: ArcRunResult,
  treatmentResult: ArcRunResult,
): { replayer: ArcReplayer; calls: Array<{ arcId: string; mode: string }> } => {
  const calls: Array<{ arcId: string; mode: string }> = []
  const replayer: ArcReplayer = async (arcId, mode) => {
    calls.push({ arcId, mode })
    return mode === 'baseline' ? baselineResult : treatmentResult
  }
  return { replayer, calls }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runBenchmark', () => {
  describe('successful benchmark run', () => {
    it('transitions status to benchmarked with non-null benchmark JSON and null decided_at', async () => {
      await insertProposedAttempt('attempt-1', ['arc-a', 'arc-b'])

      const { replayer } = makeReplayer(
        { tokensIn: 100, tokensOut: 200, wallMs: 1500, exitOk: false },
        { tokensIn: 80, tokensOut: 160, wallMs: 1200, exitOk: true },
      )

      const result = await runBenchmark(db, 'attempt-1', { arcReplayer: replayer })

      // Return value carries non-empty JSON strings
      expect(result.before).toBeTruthy()
      expect(result.after).toBeTruthy()
      const before = JSON.parse(result.before) as ArcRunResult[]
      const after = JSON.parse(result.after) as ArcRunResult[]
      expect(before).toHaveLength(2)
      expect(after).toHaveLength(2)

      // Persisted row reflects the new status
      const row = await getAttempt(db, 'attempt-1')
      expect(row).not.toBeNull()
      expect(row!.status).toBe('benchmarked')
      expect(row!.benchmarkBefore).not.toBeNull()
      expect(row!.benchmarkAfter).not.toBeNull()
      // decided_at must remain null after benchmarking
      expect(row!.decidedAt).toBeNull()
    })

    it('calls the replayer once per arc in baseline then treatment order', async () => {
      await insertProposedAttempt('attempt-2', ['arc-x', 'arc-y'])

      const { replayer, calls } = makeReplayer(
        { tokensIn: 50, tokensOut: 100, wallMs: 500, exitOk: true },
        { tokensIn: 40, tokensOut: 80, wallMs: 400, exitOk: true },
      )

      await runBenchmark(db, 'attempt-2', { arcReplayer: replayer })

      // 2 arcs × 2 modes = 4 replayer calls
      expect(calls).toHaveLength(4)
      expect(calls[0]).toEqual({ arcId: 'arc-x', mode: 'baseline' })
      expect(calls[1]).toEqual({ arcId: 'arc-x', mode: 'treatment' })
      expect(calls[2]).toEqual({ arcId: 'arc-y', mode: 'baseline' })
      expect(calls[3]).toEqual({ arcId: 'arc-y', mode: 'treatment' })
    })

    it('stores the replayer metrics in the persisted JSON', async () => {
      await insertProposedAttempt('attempt-3', ['arc-z'])

      const { replayer } = makeReplayer(
        { tokensIn: 300, tokensOut: 600, wallMs: 3000, exitOk: false },
        { tokensIn: 150, tokensOut: 300, wallMs: 1500, exitOk: true },
      )

      await runBenchmark(db, 'attempt-3', { arcReplayer: replayer })

      const row = await getAttempt(db, 'attempt-3')
      const before = JSON.parse(row!.benchmarkBefore!) as Array<ArcRunResult & { arcId: string }>
      const after = JSON.parse(row!.benchmarkAfter!) as Array<ArcRunResult & { arcId: string }>

      expect(before[0]).toMatchObject({ arcId: 'arc-z', tokensIn: 300, tokensOut: 600, wallMs: 3000, exitOk: false })
      expect(after[0]).toMatchObject({ arcId: 'arc-z', tokensIn: 150, tokensOut: 300, wallMs: 1500, exitOk: true })
    })
  })

  describe('idempotency', () => {
    it('returns existing data without writing again when already benchmarked', async () => {
      await insertProposedAttempt('attempt-4', ['arc-idempotent'])

      const { replayer, calls } = makeReplayer(
        { tokensIn: 100, tokensOut: 200, wallMs: 1000, exitOk: true },
        { tokensIn: 80, tokensOut: 160, wallMs: 800, exitOk: true },
      )

      // First call — benchmarks and persists
      const first = await runBenchmark(db, 'attempt-4', { arcReplayer: replayer })
      expect(calls).toHaveLength(2) // 1 arc × 2 modes

      // Second call — row is already benchmarked; must not invoke the replayer again
      const secondReplayer = vi.fn<ArcReplayer>()
      const second = await runBenchmark(db, 'attempt-4', { arcReplayer: secondReplayer })

      expect(secondReplayer).not.toHaveBeenCalled()
      // Returned data is identical to the first run's output
      expect(second.before).toBe(first.before)
      expect(second.after).toBe(first.after)

      // Row in the DB has not changed
      const row = await getAttempt(db, 'attempt-4')
      expect(row!.status).toBe('benchmarked')
      expect(row!.decidedAt).toBeNull()
    })
  })

  describe('error handling', () => {
    it('throws when the attempt id does not exist', async () => {
      const { replayer } = makeReplayer(
        { tokensIn: 0, tokensOut: 0, wallMs: 0, exitOk: true },
        { tokensIn: 0, tokensOut: 0, wallMs: 0, exitOk: true },
      )

      await expect(
        runBenchmark(db, 'nonexistent-id', { arcReplayer: replayer }),
      ).rejects.toThrow('tool-benchmark: attempt not found: nonexistent-id')
    })
  })
})
