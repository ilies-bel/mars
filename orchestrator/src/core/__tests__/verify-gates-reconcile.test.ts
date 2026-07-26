/**
 * Tests for verify-gates-reconcile.ts — daemon-startup backfill of verify_gates
 * from the supervisors manifest.
 *
 * Covers:
 * - idempotency: two runs with 4 manifest gates → exactly 4 rows in DB; the
 *   second run does not log (nothing new to insert).
 * - non-manifest rows are left untouched: a row with source='operator' survives
 *   a reconcile run whose manifest would otherwise declare the same (scope, name).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let repo: string
let dbModule: typeof import('../lib/db.js')

/** Supervisors manifest with two scopes × two gates (4 total). */
const FOUR_GATES_MANIFEST = JSON.stringify(
  {
    supervisors: [
      {
        scope: 'orchestrator',
        verify: [
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
          { name: 'test', cmd: 'npm', args: ['test'], required: true },
        ],
      },
      {
        scope: 'ui',
        verify: [
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
          { name: 'test', cmd: 'npm', args: ['test'], required: false },
        ],
      },
    ],
  },
  null,
  2,
)

beforeEach(async () => {
  repo = mkdtempSync(resolve(tmpdir(), 'mars-vgr-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo

  dbModule = await import('../lib/db.js')
  const client = dbModule.openDb(resolve(repo, '.mars'))
  const { ensureVerifyGatesSchema } = await import('../verify-gates.js')
  await ensureVerifyGatesSchema(client)
})

afterEach(async () => {
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('reconcileVerifyGatesOnStartup — idempotent backfill', () => {
  it('inserts all 4 gates on first run and skips on second; only the first run logs', async () => {
    const manifestPath = resolve(repo, 'supervisors-manifest.json')
    writeFileSync(manifestPath, FOUR_GATES_MANIFEST, 'utf8')

    const { reconcileVerifyGatesOnStartup } = await import('../verify-gates-reconcile.js')
    const client = dbModule.openDb(resolve(repo, '.mars'))

    // First run — should insert 4 gates and log
    const firstLog = vi.fn()
    await reconcileVerifyGatesOnStartup(manifestPath, firstLog)
    expect(firstLog).toHaveBeenCalledOnce()
    expect(firstLog.mock.calls[0][0]).toBe('verify-gates backfilled from manifest: 4')

    const afterFirst = await client.execute(`SELECT count(*) AS cnt FROM verify_gates`)
    expect(afterFirst.rows[0]).toMatchObject({ cnt: 4 })

    // Second run — all gates already present, should not log
    const secondLog = vi.fn()
    await reconcileVerifyGatesOnStartup(manifestPath, secondLog)
    expect(secondLog).not.toHaveBeenCalled()

    const afterSecond = await client.execute(`SELECT count(*) AS cnt FROM verify_gates`)
    expect(afterSecond.rows[0]).toMatchObject({ cnt: 4 })
  })
})

describe('reconcileVerifyGatesOnStartup — preserves non-manifest rows', () => {
  it('does not overwrite a row whose source is operator even when the manifest declares the same gate', async () => {
    // Pre-insert a gate with source='operator'
    const { addVerifyGate, listVerifyGates } = await import('../verify-gates.js')
    await addVerifyGate({
      scope: 'orchestrator',
      name: 'gate-x',
      cmd: 'npx',
      args: ['tsc'],
      source: 'operator',
    })

    // Manifest declares the same (scope=orchestrator, name=gate-x) gate
    const manifestWithGateX = JSON.stringify(
      {
        supervisors: [
          {
            scope: 'orchestrator',
            verify: [{ name: 'gate-x', cmd: 'npm', args: ['test'], required: true }],
          },
        ],
      },
      null,
      2,
    )
    const manifestPath = resolve(repo, 'manifest-with-gate-x.json')
    writeFileSync(manifestPath, manifestWithGateX, 'utf8')

    const { reconcileVerifyGatesOnStartup } = await import('../verify-gates-reconcile.js')
    await reconcileVerifyGatesOnStartup(manifestPath)

    // The operator gate must survive unchanged
    const gates = await listVerifyGates()
    const gateX = gates.find((g) => g.name === 'gate-x')
    expect(gateX).toBeDefined()
    expect(gateX!.source).toBe('operator')
    // And only the one row exists — no duplicate was inserted
    expect(gates).toHaveLength(1)
  })
})
