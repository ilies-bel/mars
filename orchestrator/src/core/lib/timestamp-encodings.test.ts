/**
 * Exhaustiveness tests for FIXTURE_TIMESTAMP_ENCODINGS.
 *
 * The expected set of timestamp columns is DERIVED from the DDL in
 * pg-schema.ts (CREATE TABLE bodies plus ALTER TABLE ... ADD COLUMN), not from
 * a hand-written list, so a new table or column with a timestamp fails here
 * until it is registered in timestamp-encodings.ts.
 *
 * The DDL array is module-private, so the test parses the source text rather
 * than importing it. A column counts as a timestamp when it is declared
 * `bigint` or `timestamptz` AND its name looks like one (`*_at`, `*_ts`, `*_until`, `*_end`,
 * `*_ms`, or exactly `ts`/`at`/`timestamp`). bigint counters, ids and
 * positions are therefore ignored. Text-typed date columns (e.g.
 * learned_recipes.learned_at) are excluded because they use neither encoding.
 * A `*_ms` bigint that is a duration goes in DURATION_MS_COLUMNS below.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { FIXTURE_TIMESTAMP_ENCODINGS } from './timestamp-encodings.js'

const DURATION_MS_COLUMNS = new Set(['requeue_dispatch_uptime_ms', 'threshold_ms'])
const TIMESTAMP_NAME = /(_at|_ts|_ms|_until|_end)$|^(ts|at|timestamp)$/

/** table -> column names declared bigint/timestamptz with timestamp-like names. */
function timestampColumnsFromDdl(): Map<string, Set<string>> {
  const src = readFileSync(fileURLToPath(new URL('./pg-schema.ts', import.meta.url)), 'utf8')
  const out = new Map<string, Set<string>>()
  const add = (table: string, col: string, type: string): void => {
    if (!/^(bigint|timestamptz)$/i.test(type)) return
    if (!TIMESTAMP_NAME.test(col) || DURATION_MS_COLUMNS.has(col)) return
    if (!out.has(table)) out.set(table, new Set())
    out.get(table)!.add(col)
  }
  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\)`/g)) {
    for (const line of m[2]!.split('\n')) {
      const c = line.trim().match(/^(\w+)\s+(\w+)/)
      if (c) add(m[1]!, c[1]!, c[2]!)
    }
  }
  for (const m of src.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) (\w+)/g)) {
    add(m[1]!, m[2]!, m[3]!)
  }
  return out
}

const derived = timestampColumnsFromDdl()

describe('FIXTURE_TIMESTAMP_ENCODINGS', () => {
  it('parses a plausible number of tables from the DDL (guards the parser)', () => {
    expect(derived.size).toBeGreaterThan(40)
    expect(derived.get('task_progress')).toEqual(new Set(['created_at']))
  })

  it('registers every timestamp column declared in the schema DDL', () => {
    const registry: Record<string, Record<string, string>> = FIXTURE_TIMESTAMP_ENCODINGS
    const missing: string[] = []
    for (const [table, cols] of derived) {
      for (const col of cols) {
        if (!registry[table] || !(col in registry[table]!)) missing.push(`${table}.${col}`)
      }
    }
    expect(missing, 'Add these columns to FIXTURE_TIMESTAMP_ENCODINGS in timestamp-encodings.ts').toEqual([])
  })

  it('registers no table or column that the schema DDL does not declare as a timestamp', () => {
    const stale: string[] = []
    for (const [table, cols] of Object.entries(FIXTURE_TIMESTAMP_ENCODINGS)) {
      for (const col of Object.keys(cols)) {
        if (!derived.get(table)?.has(col)) stale.push(`${table}.${col}`)
      }
    }
    expect(stale, 'Remove these stale entries (or fix the DDL parser heuristics)').toEqual([])
  })

  it('every column encoding value is a recognised encoding type', () => {
    const validEncodings = new Set(['iso-8601', 'epoch-millis'])
    for (const [table, columns] of Object.entries(FIXTURE_TIMESTAMP_ENCODINGS)) {
      for (const [col, enc] of Object.entries(columns)) {
        expect(
          validEncodings.has(enc as string),
          `${table}.${col} has unknown encoding "${enc as string}"`,
        ).toBe(true)
      }
    }
  })

  it('merge_jobs uses iso-8601 (timestamptz) for all its timestamp columns', () => {
    const { merge_jobs } = FIXTURE_TIMESTAMP_ENCODINGS
    expect(merge_jobs.created_at).toBe('iso-8601')
    expect(merge_jobs.updated_at).toBe('iso-8601')
    expect(merge_jobs.claimed_at).toBe('iso-8601')
    expect(merge_jobs.started_at).toBe('iso-8601')
    expect(merge_jobs.finished_at).toBe('iso-8601')
  })

  it('proposals uses epoch-millis (bigint) for all its timestamp columns', () => {
    const { proposals } = FIXTURE_TIMESTAMP_ENCODINGS
    expect(proposals.created_at).toBe('epoch-millis')
    expect(proposals.updated_at).toBe('epoch-millis')
  })

  it('tasks uses iso-8601 (timestamptz) for created_at and updated_at', () => {
    const { tasks } = FIXTURE_TIMESTAMP_ENCODINGS
    expect(tasks.created_at).toBe('iso-8601')
    expect(tasks.updated_at).toBe('iso-8601')
  })
})
