/**
 * CLI tests for `mars verify-gate check` (PRD 1f9fa15c, slice 4).
 *
 * Covers:
 *   (a) declared == live           → "in sync" message, exit 0
 *   (b) declared has extra gate    → "missing from verify_gates:" section, exit 1
 *   (c) live has manifest-sourced gate absent from manifest → "orphaned" section, exit 1
 *   (d) live has operator-sourced gate absent from manifest → ignored, exit 0
 *
 * Each test writes a real temp manifest JSON file and passes it via --manifest,
 * following the pattern in seed-verify-gates.test.ts. The verify_gates DB is
 * real (initialised by loadDeps), consistent with the rest of the CLI test suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-vgc-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Initialise all DB tables (including verify_gates) and return deps.
 * Must be called after vi.resetModules() so every singleton is fresh.
 */
const loadDeps = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const { ensureSchema } = await import('../../../core/lib/pg-schema')
  const { resolveStateClient } = await import('../../../core/store/state-client')
  await ensureSchema(resolveStateClient())

  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')

  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

const run = async (
  argv: readonly string[],
  opts: InProcessOptions,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, opts)
}

const makeFake = async () => {
  const { makeFakeDaemon } = await import('../../test-adapter')
  return makeFakeDaemon()
}

beforeEach(() => {
  repo = setupRepo()
  vi.resetModules()
  process.env.MARS_REPO = repo
})

afterEach(() => {
  delete process.env.MARS_REPO
  vi.restoreAllMocks()
  rmSync(repo, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// (a) in sync — empty manifest, empty table → exit 0
// ---------------------------------------------------------------------------

describe('mars verify-gate check — in sync', () => {
  it('prints in-sync message and exits 0 when declared and live match', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const manifestPath = resolve(repo, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ supervisors: [] }), 'utf8')

    const r = await run(
      ['verify-gate', 'check', '--manifest', manifestPath],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('verify-gates in sync with supervisor manifest')
  })
})

// ---------------------------------------------------------------------------
// (b) missing gates — manifest declares a gate absent from verify_gates
// ---------------------------------------------------------------------------

describe('mars verify-gate check — missing gates', () => {
  it('prints missing section with scope/name lines and exits 1', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const manifestPath = resolve(repo, 'manifest.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        supervisors: [
          {
            scope: 'orchestrator',
            verify: [
              { name: 'typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], required: true },
            ],
          },
        ],
      }),
      'utf8',
    )

    // Do NOT add the gate to the DB — it should appear as missing.
    const r = await run(
      ['verify-gate', 'check', '--manifest', manifestPath],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(1)
    const out = r.out.join('\n')
    expect(out).toContain('missing from verify_gates:')
    expect(out).toContain('orchestrator/typecheck')
  })
})

// ---------------------------------------------------------------------------
// (c) orphaned gates — verify_gates has a manifest-sourced row absent from manifest
// ---------------------------------------------------------------------------

describe('mars verify-gate check — orphaned gates (source=manifest)', () => {
  it('prints orphaned section with scope/name lines and exits 1', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    // Insert a manifest-sourced gate directly into the DB.
    const { addVerifyGate } = await import('../../../core/verify-gates')
    await addVerifyGate({
      scope: 'orchestrator',
      name: 'typecheck',
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      required: true,
      tier: 'task',
      source: 'manifest',
    })

    // Manifest does NOT declare this gate.
    const manifestPath = resolve(repo, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ supervisors: [] }), 'utf8')

    const r = await run(
      ['verify-gate', 'check', '--manifest', manifestPath],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(1)
    const out = r.out.join('\n')
    expect(out).toContain('orphaned in verify_gates (source=manifest):')
    expect(out).toContain('orchestrator/typecheck')
  })
})

// ---------------------------------------------------------------------------
// (d) operator-sourced gates are ignored — not treated as orphans
// ---------------------------------------------------------------------------

describe('mars verify-gate check — operator-sourced gates are ignored', () => {
  it('exits 0 and ignores operator-sourced gates absent from manifest', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    // Add an operator-sourced gate via the CLI (source='operator').
    await run(
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'lint', '--cmd', 'eslint'],
      { store, ctx, daemon },
    )

    // Manifest is empty — the operator gate should NOT appear as an orphan.
    const manifestPath = resolve(repo, 'manifest.json')
    writeFileSync(manifestPath, JSON.stringify({ supervisors: [] }), 'utf8')

    const r = await run(
      ['verify-gate', 'check', '--manifest', manifestPath],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('verify-gates in sync with supervisor manifest')
  })
})
