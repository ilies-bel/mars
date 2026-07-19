/**
 * Behavioural tests for `mars tool-promotion approve/reject/list`.
 *
 * Covers:
 *   (a) approve: files copied to templates dir, ledger row promoted, AQ row resolved
 *   (b) reject:  ledger row retired, no files copied, AQ row resolved
 *   (c) double-approve is rejected (only 'benchmarked' attempts accepted)
 *   (d) `mars tool-promotion list --status retired` prints the row
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runCommandInProcess, makeFakeDaemon } from '../test-adapter'
import type { InProcessOptions } from '../test-adapter'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-tool-promo-cmd-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Reset modules, set MARS_REPO, init the tool_promotion_attempts schema via
 * the store module (so it uses the correct column layout), and build
 * InProcessOptions for runCommandInProcess.
 *
 * We do NOT call migrateQueueSchema here: the store module creates the
 * tool_promotion_attempts table with the correct schema (benchmark_before,
 * benchmark_after, decided_at) via initToolPromotionAttempts(). Calling
 * migrateQueueSchema first would create the table with the older queue.ts
 * schema (before_data, after_data, no decided_at) and make initToolPromotionAttempts
 * a no-op (CREATE TABLE IF NOT EXISTS is idempotent).
 */
const loadOpts = async (
  repoDir: string,
): Promise<{
  opts: InProcessOptions
  resolveStateClient: () => import('@libsql/client').Client
  initToolPromotionAttempts: () => Promise<void>
  insertAttempt: (input: {
    id: string
    helperKey: string
    status: string
    createdAt: number
  }) => Promise<void>
  getAttempt: (id: string) => Promise<Record<string, unknown> | null>
}> => {
  vi.resetModules()
  process.env.MARS_REPO = repoDir

  // init the correct schema first
  const storeModule = await import('../../core/store/tool-promotion-store')
  await storeModule.initToolPromotionAttempts()

  const stateClientModule = await import('../../core/store/state-client')
  const db = stateClientModule.resolveStateClient()

  const contextModule = await import('../../core/context')
  const ctx = contextModule.resolveContext(repoDir)

  // A minimal store (the commands under test don't use the task store)
  const taskStoreModule = await import('../../core/store/task-store')
  const queueModule = await import('../../core/queue')
  const store = taskStoreModule.createTaskStore(queueModule.resolveQueueClient())

  const opts: InProcessOptions = {
    store,
    daemon: makeFakeDaemon(),
    ctx,
  }

  const insertAttempt = async (input: {
    id: string
    helperKey: string
    status: string
    createdAt: number
  }): Promise<void> => {
    await db.execute({
      sql: `INSERT INTO tool_promotion_attempts
              (id, helper_key, motivating_arc_ids, status, created_at)
            VALUES (?, ?, '[]', ?, ?)`,
      args: [input.id, input.helperKey, input.status, input.createdAt],
    })
  }

  const getAttempt = async (id: string): Promise<Record<string, unknown> | null> => {
    const r = await db.execute({
      sql: `SELECT * FROM tool_promotion_attempts WHERE id = ?`,
      args: [id],
    })
    if (r.rows.length === 0) return null
    return r.rows[0] as unknown as Record<string, unknown>
  }

  return {
    opts,
    resolveStateClient: stateClientModule.resolveStateClient,
    initToolPromotionAttempts: storeModule.initToolPromotionAttempts,
    insertAttempt,
    getAttempt,
  }
}

// ---------------------------------------------------------------------------
// Per-test lifecycle
// ---------------------------------------------------------------------------

let repo: string
let srcBase: string
let destBase: string

beforeEach(() => {
  repo = setupRepo()
  // Temp dirs for source tools and destination templates
  srcBase = mkdtempSync(resolve(tmpdir(), 'mars-tp-src-'))
  destBase = mkdtempSync(resolve(tmpdir(), 'mars-tp-dest-'))
  process.env.MARS_TOOL_FORGE_SRC_DIR = srcBase
  process.env.MARS_TOOL_FORGE_TEMPLATES_TOOLS_DIR = destBase
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.MARS_REPO
  delete process.env.MARS_TOOL_FORGE_SRC_DIR
  delete process.env.MARS_TOOL_FORGE_TEMPLATES_TOOLS_DIR
  rmSync(repo, { recursive: true, force: true })
  rmSync(srcBase, { recursive: true, force: true })
  rmSync(destBase, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// (a) approve — files copied, ledger row promoted
// ---------------------------------------------------------------------------

describe('tool-promotion approve', () => {
  it('copies helper files to templates dir and sets status=promoted with decidedAt', async () => {
    const { opts, insertAttempt, getAttempt } = await loadOpts(repo)
    const attemptId = 'attempt-approve-001'
    const helperKey = 'fastParser'

    // Stub source: create a helper directory with one file
    const helperSrcDir = join(srcBase, helperKey)
    mkdirSync(helperSrcDir, { recursive: true })
    writeFileSync(join(helperSrcDir, 'index.ts'), 'export const fastParser = () => {}')

    await insertAttempt({ id: attemptId, helperKey, status: 'benchmarked', createdAt: 1_000_000 })

    const r = await runCommandInProcess(['tool-promotion', 'approve', attemptId], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(`approved: ${attemptId}`)
    expect(r.out.join('\n')).toContain(helperKey)

    // Files must be in the destination
    const destFile = join(destBase, helperKey, 'index.ts')
    expect(existsSync(destFile)).toBe(true)

    // DB row must have status='promoted' and decided_at set
    const row = await getAttempt(attemptId)
    expect(row).not.toBeNull()
    expect(row!['status']).toBe('promoted')
    expect(typeof row!['decided_at']).toBe('number')
    expect((row!['decided_at'] as number)).toBeGreaterThan(0)
  })

  it('returns code 1 when the attempt does not exist', async () => {
    const { opts } = await loadOpts(repo)

    const r = await runCommandInProcess(['tool-promotion', 'approve', 'nonexistent-id'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not found')
  })

  it('returns code 1 when the source directory does not exist', async () => {
    const { opts, insertAttempt } = await loadOpts(repo)
    await insertAttempt({
      id: 'attempt-no-src',
      helperKey: 'missingHelper',
      status: 'benchmarked',
      createdAt: 1_000_001,
    })

    // No source files created — approve must fail
    const r = await runCommandInProcess(['tool-promotion', 'approve', 'attempt-no-src'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('source directory not found')
  })
})

// ---------------------------------------------------------------------------
// (b) reject — ledger row retired, no files copied
// ---------------------------------------------------------------------------

describe('tool-promotion reject', () => {
  it('sets status=retired with decidedAt and copies no files', async () => {
    const { opts, insertAttempt, getAttempt } = await loadOpts(repo)
    const attemptId = 'attempt-reject-001'
    const helperKey = 'slowHelper'

    await insertAttempt({ id: attemptId, helperKey, status: 'benchmarked', createdAt: 1_000_002 })

    const r = await runCommandInProcess(['tool-promotion', 'reject', attemptId], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain(`rejected: ${attemptId}`)

    // No files should have been copied to the destination
    const destDir = join(destBase, helperKey)
    expect(existsSync(destDir)).toBe(false)

    // DB row must have status='retired' and decided_at set
    const row = await getAttempt(attemptId)
    expect(row).not.toBeNull()
    expect(row!['status']).toBe('retired')
    expect(typeof row!['decided_at']).toBe('number')
    expect((row!['decided_at'] as number)).toBeGreaterThan(0)
  })

  it('returns code 1 when the attempt does not exist', async () => {
    const { opts } = await loadOpts(repo)

    const r = await runCommandInProcess(['tool-promotion', 'reject', 'nonexistent-id'], opts)

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not found')
  })
})

// ---------------------------------------------------------------------------
// (c) double-approve is rejected
// ---------------------------------------------------------------------------

describe('tool-promotion approve — double-approve guard', () => {
  it('rejects a second approve on an already-promoted attempt', async () => {
    const { opts, insertAttempt } = await loadOpts(repo)
    const attemptId = 'attempt-double-001'
    const helperKey = 'stableHelper'

    const helperSrcDir = join(srcBase, helperKey)
    mkdirSync(helperSrcDir, { recursive: true })
    writeFileSync(join(helperSrcDir, 'index.ts'), 'export const stableHelper = () => {}')

    await insertAttempt({ id: attemptId, helperKey, status: 'benchmarked', createdAt: 1_000_003 })

    // First approve — must succeed
    const first = await runCommandInProcess(['tool-promotion', 'approve', attemptId], opts)
    expect(first.code).toBe(0)

    // Second approve — must fail because status is now 'promoted', not 'benchmarked'
    const second = await runCommandInProcess(['tool-promotion', 'approve', attemptId], opts)
    expect(second.code).toBe(1)
    expect(second.err.join('\n')).toContain("status 'promoted'")
  })
})

// ---------------------------------------------------------------------------
// (d) list --status retired prints retired rows
// ---------------------------------------------------------------------------

describe('tool-promotion list', () => {
  it('prints retired attempts when --status retired is passed', async () => {
    const { opts, insertAttempt } = await loadOpts(repo)
    const attemptId = 'attempt-retired-001'
    const helperKey = 'oldHelper'

    // Insert a row directly with status='retired'
    await insertAttempt({ id: attemptId, helperKey, status: 'retired', createdAt: 1_000_004 })

    const r = await runCommandInProcess(
      ['tool-promotion', 'list', '--status', 'retired'],
      opts,
    )

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain(attemptId)
    expect(out).toContain(helperKey)
    expect(out).toContain('retired')
  })

  it('prints "no attempts" when no retired rows exist', async () => {
    const { opts } = await loadOpts(repo)

    const r = await runCommandInProcess(
      ['tool-promotion', 'list', '--status', 'retired'],
      opts,
    )

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain("no attempts with status 'retired'")
  })

  it('defaults to listing benchmarked attempts when --status is omitted', async () => {
    const { opts, insertAttempt } = await loadOpts(repo)
    await insertAttempt({
      id: 'attempt-bench-list',
      helperKey: 'benchHelper',
      status: 'benchmarked',
      createdAt: 1_000_005,
    })

    const r = await runCommandInProcess(['tool-promotion', 'list'], opts)

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('attempt-bench-list')
  })
})
