/**
 * CLI tests for `mars verify-gate list/add/remove` (PRD 1f9fa15c, slice 1).
 *
 * Covers:
 *   1. `verify-gate` group → exit 2
 *   2. `verify-gate list` with no gates → "(no verify gates configured)"
 *   3. `verify-gate list` with gates → table rows contain expected columns
 *   4. `verify-gate add` happy path → prints generated id
 *   5. `verify-gate add` missing --name → exit 2
 *   6. `verify-gate add` missing --cmd → exit 2
 *   7. `verify-gate add` duplicate (scope,name) → exit 1 with helpful message
 *   8. `verify-gate add` with positional args after -- → stored as gate args
 *   9. `verify-gate add` with --optional → stored as required=false
 *  10. `verify-gate remove` by id → idempotent exit 0
 *  11. `verify-gate remove` by --scope/--name pair → idempotent exit 0
 *  12. `verify-gate remove` with no args → exit 2
 *  13. `verify-gate remove` unknown id → silent exit 0 (idempotent)
 *
 * All tests use dynamic imports after vi.resetModules() to get fresh singleton
 * instances per test, following the pattern in memory.test.ts.
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
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-vg-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Initialize all DB tables (including verify_gates) and return deps for the
 * in-process test adapter. Must be called AFTER vi.resetModules() so every
 * singleton is fresh.
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
// 1. Group command — exits 2
// ---------------------------------------------------------------------------

describe('mars verify-gate — group command', () => {
  it('exits 2 and mentions subcommands on stderr', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify-gate'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    const errText = r.err.join('\n')
    expect(errText).toContain('list')
    expect(errText).toContain('add')
    expect(errText).toContain('remove')
  })
})

describe('mars verify-gate detect', () => {
  it('prints proposed gates without adding them to the registry', async () => {
    writeFileSync(
      resolve(repo, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' } }),
    )
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const detected = await run(['verify-gate', 'detect'], { store, ctx, daemon })
    const listed = await run(['verify-gate', 'list'], { store, ctx, daemon })

    expect(detected.code).toBe(0)
    expect(detected.out.join('\n')).toContain('typecheck')
    expect(detected.out.join('\n')).toContain('test')
    expect(listed.out.join('\n')).toContain('no verify gates configured')
  })

  it('prints a stable JSON proposal array and explains when no gates are found', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const json = await run(['verify-gate', 'detect', '--json'], { store, ctx, daemon })
    const text = await run(['verify-gate', 'detect'], { store, ctx, daemon })

    expect(json.code).toBe(0)
    expect(json.out).toEqual(['[]'])
    expect(text.code).toBe(0)
    expect(text.out).toEqual(['no verify gates detected'])
  })
})

// ---------------------------------------------------------------------------
// 2. verify-gate list — empty table
// ---------------------------------------------------------------------------

describe('mars verify-gate list — empty table', () => {
  it('prints "(no verify gates configured)"', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify-gate', 'list'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('no verify gates configured')
  })
})

// ---------------------------------------------------------------------------
// 3. verify-gate list — with gates
// ---------------------------------------------------------------------------

describe('mars verify-gate list — with gates', () => {
  it('shows gate state and a healthy marker when an active gate has never failed', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    // Add a gate directly so we have something to list
    await run(
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx', '--', 'tsc', '--noEmit'],
      { store, ctx, daemon },
    )

    const r = await run(['verify-gate', 'list'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    // Header columns
    expect(out).toContain('id')
    expect(out).toContain('scope')
    expect(out).toContain('name')
    expect(out).toContain('cmd')
    expect(out).toContain('args')
    expect(out).toContain('required')
    expect(out).toContain('tier')
    expect(out).toContain('source')
    expect(out).toContain('created_at')
    expect(out).toContain('state')
    expect(out).toContain('quarantined_at')
    expect(out).toContain('last_failure')
    expect(out).toContain('last_origin')
    expect(out).toContain('last_failure_at')
    // Data values
    expect(out).toContain('orchestrator')
    expect(out).toContain('typecheck')
    expect(out).toContain('npx')
    expect(out).toContain('active')
    expect(out).toContain('healthy')
  })

  it('shows quarantine and the latest failure evidence for a quarantined gate', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()
    const added = await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx'],
      { store, ctx, daemon },
    )
    const { quarantineVerifyGate } = await import('../../../core/verify-gates')
    const { getCompositionRootClient } = await import('../../../core/store/task-store')
    await quarantineVerifyGate(
      getCompositionRootClient(),
      added.out[0]!,
      'verify:typecheck:exit-1',
      'origin-123',
    )

    const listed = await run(['verify-gate', 'list'], { store, ctx, daemon })
    const output = listed.out.join('\n')

    expect(output).toContain('quarantined')
    expect(output).toContain('verify:typecheck:exit-1')
    expect(output).toContain('origin-123')
    expect(output).not.toContain('healthy')
  })
})

// ---------------------------------------------------------------------------
// 4. verify-gate add — happy path
// ---------------------------------------------------------------------------

describe('mars verify-gate add — happy path', () => {
  it('inserts a gate and prints the generated id', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx', '--', 'tsc', '--noEmit'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    // The generated id is a UUID
    expect(r.out[0]).toMatch(/^[0-9a-f-]{36}$/)
  })
})

// ---------------------------------------------------------------------------
// 5. verify-gate add — missing --name
// ---------------------------------------------------------------------------

describe('mars verify-gate add — missing --name', () => {
  it('exits 2 with error mentioning --name', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'add', '--cmd', 'npx'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('--name')
  })
})

// ---------------------------------------------------------------------------
// 6. verify-gate add — missing --cmd
// ---------------------------------------------------------------------------

describe('mars verify-gate add — missing --cmd', () => {
  it('exits 2 with error mentioning --cmd', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'add', '--name', 'typecheck'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('--cmd')
  })
})

// ---------------------------------------------------------------------------
// 7. verify-gate add — duplicate (scope,name) pair
// ---------------------------------------------------------------------------

describe('mars verify-gate add — duplicate (scope,name)', () => {
  it('exits 1 with a message naming the duplicate pair', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    // First insert succeeds
    const r1 = await run(
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx'],
      { store, ctx, daemon },
    )
    expect(r1.code).toBe(0)

    // Second insert with the same (scope,name) must fail
    const r2 = await run(
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'tsc'],
      { store, ctx, daemon },
    )

    expect(r2.code).toBe(1)
    const errText = r2.err.join('\n')
    expect(errText).toContain('already exists')
    expect(errText).toContain('orchestrator')
    expect(errText).toContain('typecheck')
  })
})

// ---------------------------------------------------------------------------
// 8. verify-gate add — positional args after -- are stored as gate args
// ---------------------------------------------------------------------------

describe('mars verify-gate add — gate args after --', () => {
  it('stores positional args after -- as the gate args', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--', 'tsc', '--noEmit'],
      { store, ctx, daemon },
    )

    // Confirm the stored gate has the right args by listing
    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.code).toBe(0)
    const out = listR.out.join('\n')
    expect(out).toContain('tsc')
    expect(out).toContain('--noEmit')
  })
})

// ---------------------------------------------------------------------------
// 9. verify-gate add — --optional flag makes required=false
// ---------------------------------------------------------------------------

describe('mars verify-gate add — --optional flag', () => {
  it('stores the gate as required=false when --optional is provided', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify-gate', 'add', '--name', 'lint', '--cmd', 'eslint', '--optional'],
      { store, ctx, daemon },
    )

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.code).toBe(0)
    // The 'required' column should show 'false'
    expect(listR.out.join('\n')).toContain('false')
  })
})

// ---------------------------------------------------------------------------
// 10. verify-gate remove — by id (idempotent)
// ---------------------------------------------------------------------------

describe('mars verify-gate remove — by id', () => {
  it('exits 0 and silently removes the gate', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx'],
      { store, ctx, daemon },
    )
    expect(addR.code).toBe(0)
    const id = addR.out[0]!

    const removeR = await run(['verify-gate', 'remove', id], { store, ctx, daemon })
    expect(removeR.code).toBe(0)

    // Confirm the gate is gone
    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('no verify gates configured')
  })

  it('is idempotent — removing same id twice exits 0 both times', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx'],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!

    await run(['verify-gate', 'remove', id], { store, ctx, daemon })
    const r2 = await run(['verify-gate', 'remove', id], { store, ctx, daemon })
    expect(r2.code).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 11. verify-gate remove — by --scope/--name pair (idempotent)
// ---------------------------------------------------------------------------

describe('mars verify-gate remove — by scope/name', () => {
  it('exits 0 and removes the gate', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx'],
      { store, ctx, daemon },
    )

    const removeR = await run(
      ['verify-gate', 'remove', '--scope', 'orchestrator', '--name', 'typecheck'],
      { store, ctx, daemon },
    )
    expect(removeR.code).toBe(0)

    // Gate is gone
    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('no verify gates configured')
  })

  it('is idempotent — removing non-existent scope/name pair exits 0', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'remove', '--scope', 'nowhere', '--name', 'nothing'],
      { store, ctx, daemon },
    )
    expect(r.code).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 12. verify-gate remove — no args → usage error
// ---------------------------------------------------------------------------

describe('mars verify-gate remove — no args', () => {
  it('exits 2 with usage error', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify-gate', 'remove'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    expect(r.err.join('\n').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 13. verify-gate remove — unknown id → silent exit 0
// ---------------------------------------------------------------------------

describe('mars verify-gate remove — unknown id', () => {
  it('exits 0 silently when the id does not match any gate', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'remove', 'non-existent-id-00000000-0000'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.err).toHaveLength(0)
  })
})
