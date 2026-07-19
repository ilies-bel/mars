import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Client } from '@libsql/client'
import { openLibsql } from '../libsql'
import { scanForRecurringHelperGaps } from '../tool-forge-scanner'
import { listAttemptsByStatus } from '../../store/tool-promotion-store'

// ── Minimal schemas ───────────────────────────────────────────────────────────
// Only the columns the scanner reads are required; `workflow` is added so the
// enqueue stub can write a verifiable marker.

const TASKS_DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT    PRIMARY KEY,
    prompt      TEXT    NOT NULL DEFAULT 'do the thing',
    status      TEXT    NOT NULL,
    error       TEXT,
    origin_id   TEXT,
    created_at  TEXT    NOT NULL DEFAULT '2026-01-01T00:00:00Z',
    updated_at  TEXT    NOT NULL DEFAULT '2026-01-01T00:00:00Z',
    workflow    TEXT
  )
`

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

// ── Test helpers ──────────────────────────────────────────────────────────────

let db: Client
let tmpDir: string

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mars-tool-forge-'))
  db = openLibsql({ url: `file:${join(tmpDir, 'test.db')}` })
  await db.execute(TASKS_DDL)
  await db.execute(TOOL_PROMOTION_ATTEMPTS_DDL)
})

afterEach(async () => {
  await db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Insert a failed task row with the given error text. */
const insertFailedTask = async (
  id: string,
  errorText: string,
  opts: { originId?: string } = {},
): Promise<void> => {
  await db.execute({
    sql: `INSERT INTO tasks (id, status, error, origin_id)
          VALUES (?, 'failed', ?, ?)`,
    args: [id, errorText, opts.originId ?? null],
  })
}

/**
 * Build an `enqueue` stub that inserts a `workflow='tool-forge'` task row so
 * the test can assert on the row.  Returns both the stub function and an
 * accessor for all task ids it created.
 */
const makeEnqueueStub = (
  client: Client,
): [
  enqueue: (prompt: string, arcIds: string[]) => Promise<string>,
  getIds: () => string[],
] => {
  const ids: string[] = []
  const enqueue = async (prompt: string, _arcIds: string[]): Promise<string> => {
    const id = `forge-task-${ids.length + 1}`
    await client.execute({
      sql: `INSERT INTO tasks (id, status, prompt, workflow)
            VALUES (?, 'queued', ?, 'tool-forge')`,
      args: [id, prompt],
    })
    ids.push(id)
    return id
  }
  return [enqueue, () => ids]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('scanForRecurringHelperGaps', () => {
  describe('when threshold is met', () => {
    it('inserts exactly one proposed ledger row and enqueues exactly one task', async () => {
      // ≥3 failed tasks all matching 'helper:rg'
      await insertFailedTask('t1', 'rg: command not found')
      await insertFailedTask('t2', 'rg: command not found')
      await insertFailedTask('t3', 'rg: command not found')

      const [enqueue, getIds] = makeEnqueueStub(db)
      const result = await scanForRecurringHelperGaps(db, { threshold: 3, enqueue })

      // Scanner return value
      expect(result.enqueued).toHaveLength(1)
      expect(result.thresholdCrossed).toContain('helper:rg')
      expect(result.matchesPerKey['helper:rg']).toBe(3)

      // One tool_promotion_attempts row with status='proposed'
      const attempts = await listAttemptsByStatus(db, 'proposed')
      expect(attempts).toHaveLength(1)
      expect(attempts[0].helperKey).toBe('helper:rg')
      expect(attempts[0].status).toBe('proposed')

      // Enqueue called exactly once
      expect(getIds()).toHaveLength(1)

      // Task row with workflow='tool-forge' actually landed in the DB
      const taskRows = await db.execute(
        `SELECT id, workflow FROM tasks WHERE workflow = 'tool-forge'`,
      )
      expect(taskRows.rows).toHaveLength(1)
      expect(String(taskRows.rows[0].workflow)).toBe('tool-forge')
    })
  })

  describe('idempotency', () => {
    it('second scan with unchanged data enqueues 0 tasks and inserts 0 new ledger rows', async () => {
      await insertFailedTask('t1', 'rg: command not found')
      await insertFailedTask('t2', 'rg: command not found')
      await insertFailedTask('t3', 'rg: command not found')

      const [enqueue, getIds] = makeEnqueueStub(db)

      // First scan
      const r1 = await scanForRecurringHelperGaps(db, { threshold: 3, enqueue })
      expect(r1.enqueued).toHaveLength(1)

      // Second scan — same data, same DB
      const r2 = await scanForRecurringHelperGaps(db, { threshold: 3, enqueue })
      expect(r2.enqueued).toHaveLength(0)

      // Still exactly one ledger row
      const attempts = await listAttemptsByStatus(db, 'proposed')
      expect(attempts).toHaveLength(1)

      // Enqueue called only once across both runs
      expect(getIds()).toHaveLength(1)
    })
  })

  describe('when threshold is not met', () => {
    it('does not create any ledger rows or enqueue any tasks', async () => {
      // Only 2 tasks, threshold = 3
      await insertFailedTask('t1', 'rg: command not found')
      await insertFailedTask('t2', 'rg: command not found')

      const [enqueue, getIds] = makeEnqueueStub(db)
      const result = await scanForRecurringHelperGaps(db, { threshold: 3, enqueue })

      expect(result.enqueued).toHaveLength(0)
      expect(result.thresholdCrossed).toHaveLength(0)

      const attempts = await listAttemptsByStatus(db, 'proposed')
      expect(attempts).toHaveLength(0)

      expect(getIds()).toHaveLength(0)
    })
  })

  describe('multiple helperKeys', () => {
    it('creates one ledger row per key that crosses the threshold independently', async () => {
      // 3 tasks for 'helper:rg'
      await insertFailedTask('t1', 'rg: command not found')
      await insertFailedTask('t2', 'rg: command not found')
      await insertFailedTask('t3', 'rg: command not found')
      // 3 tasks for a module key
      await insertFailedTask('t4', "Cannot find module 'some-pkg'")
      await insertFailedTask('t5', "Cannot find module 'some-pkg'")
      await insertFailedTask('t6', "Cannot find module 'some-pkg'")
      // Only 2 tasks for another command key — below threshold
      await insertFailedTask('t7', 'jq: command not found')
      await insertFailedTask('t8', 'jq: command not found')

      const [enqueue, getIds] = makeEnqueueStub(db)
      const result = await scanForRecurringHelperGaps(db, { threshold: 3, enqueue })

      expect(result.thresholdCrossed).toHaveLength(2)
      expect(result.thresholdCrossed).toContain('helper:rg')
      expect(result.thresholdCrossed).toContain('some-pkg')
      expect(result.enqueued).toHaveLength(2)

      const attempts = await listAttemptsByStatus(db, 'proposed')
      expect(attempts).toHaveLength(2)

      expect(getIds()).toHaveLength(2)
    })
  })
})
