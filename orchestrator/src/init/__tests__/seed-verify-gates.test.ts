/**
 * Tests for seed-verify-gates.ts — materialising verify gates from the
 * supervisors manifest into the verify_gates table.
 *
 * Covers:
 * - empty manifest → 0 inserted, 0 skipped
 * - manifest with two scopes × two gates each → 4 inserted, 0 skipped
 * - running the seed twice → second run inserts 0 and skips 4 (idempotent)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

let repo: string
let dbModule: typeof import('../../core/lib/db.js')

const EMPTY_MANIFEST = JSON.stringify({ supervisors: [] }, null, 2)

const TWO_SCOPES_MANIFEST = JSON.stringify(
  {
    supervisors: [
      {
        scope: 'orchestrator',
        verify: [
          { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
          { name: 'test', cmd: 'npm', args: ['test'], required: true, tier: 'integration' },
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
  repo = mkdtempSync(resolve(tmpdir(), 'mars-svg-test-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo })
  mkdirSync(resolve(repo, '.mars'), { recursive: true })
  vi.resetModules()
  process.env.MARS_REPO = repo

  dbModule = await import('../../core/lib/db.js')
  const client = dbModule.openDb(resolve(repo, '.mars'))
  const { ensureVerifyGatesSchema } = await import('../../core/verify-gates.js')
  await ensureVerifyGatesSchema(client)
})

afterEach(async () => {
  await dbModule.__resetDbRegistryForTests()
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

describe('seedVerifyGatesFromManifest — empty manifest', () => {
  it('returns 0 inserted and 0 skipped', async () => {
    const manifestPath = resolve(repo, 'manifest.json')
    writeFileSync(manifestPath, EMPTY_MANIFEST, 'utf8')
    const { seedVerifyGatesFromManifest } = await import('../seed-verify-gates.js')

    const result = await seedVerifyGatesFromManifest(manifestPath)

    expect(result).toEqual({ inserted: 0, skipped: 0 })
  })
})

describe('seedVerifyGatesFromManifest — two scopes × two gates', () => {
  it('inserts all 4 gates with source=manifest on first run', async () => {
    const manifestPath = resolve(repo, 'manifest.json')
    writeFileSync(manifestPath, TWO_SCOPES_MANIFEST, 'utf8')
    const { seedVerifyGatesFromManifest } = await import('../seed-verify-gates.js')
    const { listVerifyGates } = await import('../../core/verify-gates.js')

    const result = await seedVerifyGatesFromManifest(manifestPath)

    expect(result).toEqual({ inserted: 4, skipped: 0 })
    const gates = await listVerifyGates()
    expect(gates).toHaveLength(4)
    expect(gates.every((g) => g.source === 'manifest')).toBe(true)
  })
})

describe('seedVerifyGatesFromManifest — idempotent on second run', () => {
  it('inserts 0 and skips 4 when all gates already exist', async () => {
    const manifestPath = resolve(repo, 'manifest.json')
    writeFileSync(manifestPath, TWO_SCOPES_MANIFEST, 'utf8')
    const { seedVerifyGatesFromManifest } = await import('../seed-verify-gates.js')

    // First run — seeds the gates
    const first = await seedVerifyGatesFromManifest(manifestPath)
    expect(first).toEqual({ inserted: 4, skipped: 0 })

    // Second run — all gates already present
    const second = await seedVerifyGatesFromManifest(manifestPath)
    expect(second).toEqual({ inserted: 0, skipped: 4 })
  })
})
