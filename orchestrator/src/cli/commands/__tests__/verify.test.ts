/**
 * CLI tests for `mars verify list/add/remove` (slice 11).
 *
 * Covers:
 *   1. `verify` group → exit 2 with usage
 *   2. `verify list` with no gates → "(no verify gates configured)"
 *   3. `verify list` with gates → table shows scope, name, cmd, args, tier, required, source
 *   4. `verify add <name>` happy path → prints generated id
 *   5. `verify add` missing name → exit 2
 *   6. `verify add` missing --cmd → exit 2
 *   7. `verify add` with --args → stored as gate args
 *   8. `verify add` with --optional → stored as required=false
 *   9. `verify add` with --tier integration → stored correctly
 *  10. `verify add` duplicate (scope,name) → exit 1 with helpful message
 *  11. `verify remove <name>` by name → removes gate
 *  12. `verify remove <id>` by UUID → removes gate
 *  13. `verify remove` with no args → exit 2
 *  14. `verify remove` unknown name → silent exit 0 (idempotent)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

// ---------------------------------------------------------------------------
// Repo fixture helpers
// ---------------------------------------------------------------------------

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-verify-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

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

describe('mars verify — group command', () => {
  it('exits 2 and mentions subcommands on stderr', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    const errText = r.err.join('\n')
    expect(errText).toContain('list')
    expect(errText).toContain('add')
    expect(errText).toContain('remove')
  })
})

// ---------------------------------------------------------------------------
// 2. verify list — empty table
// ---------------------------------------------------------------------------

describe('mars verify list — empty table', () => {
  it('prints "(no verify gates configured)"', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify', 'list'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('no verify gates configured')
  })
})

// ---------------------------------------------------------------------------
// 3. verify list — with gates
// ---------------------------------------------------------------------------

describe('mars verify list — with gates', () => {
  it('prints header columns and a data row per gate', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify', 'add', 'typecheck', '--cmd', 'npx', '--args', 'tsc', '--args', '--noEmit'],
      { store, ctx, daemon },
    )

    const r = await run(['verify', 'list'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('scope')
    expect(out).toContain('name')
    expect(out).toContain('cmd')
    expect(out).toContain('args')
    expect(out).toContain('tier')
    expect(out).toContain('required')
    expect(out).toContain('source')
    // Data values
    expect(out).toContain('typecheck')
    expect(out).toContain('npx')
  })
})

// ---------------------------------------------------------------------------
// 4. verify add — happy path
// ---------------------------------------------------------------------------

describe('mars verify add — happy path', () => {
  it('inserts a gate and prints the generated UUID', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify', 'add', 'typecheck', '--cmd', 'npx'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    expect(r.out[0]).toMatch(/^[0-9a-f-]{36}$/)
  })
})

// ---------------------------------------------------------------------------
// 5. verify add — missing name
// ---------------------------------------------------------------------------

describe('mars verify add — missing name', () => {
  it('exits 2 with usage error', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify', 'add', '--cmd', 'npx'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    expect(r.err.join('\n').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 6. verify add — missing --cmd
// ---------------------------------------------------------------------------

describe('mars verify add — missing --cmd', () => {
  it('exits 2 with error mentioning --cmd', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify', 'add', 'typecheck'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('--cmd')
  })
})

// ---------------------------------------------------------------------------
// 7. verify add — --args flag stores gate args
// ---------------------------------------------------------------------------

describe('mars verify add — --args flag', () => {
  it('stores gate args passed via --args', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify', 'add', 'typecheck', '--cmd', 'npx', '--args', 'tsc', '--args', '--noEmit'],
      { store, ctx, daemon },
    )

    const listR = await run(['verify', 'list'], { store, ctx, daemon })
    expect(listR.code).toBe(0)
    const out = listR.out.join('\n')
    expect(out).toContain('tsc')
    expect(out).toContain('--noEmit')
  })
})

// ---------------------------------------------------------------------------
// 8. verify add — --optional sets required=false
// ---------------------------------------------------------------------------

describe('mars verify add — --optional flag', () => {
  it('stores the gate as required=false when --optional is provided', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify', 'add', 'lint', '--cmd', 'eslint', '--optional'],
      { store, ctx, daemon },
    )

    const listR = await run(['verify', 'list'], { store, ctx, daemon })
    expect(listR.code).toBe(0)
    expect(listR.out.join('\n')).toContain('false')
  })
})

// ---------------------------------------------------------------------------
// 9. verify add — --tier integration
// ---------------------------------------------------------------------------

describe('mars verify add — --tier integration', () => {
  it('stores tier as integration when --tier integration is provided', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify', 'add', 'e2e', '--cmd', 'npm', '--tier', 'integration'],
      { store, ctx, daemon },
    )

    const listR = await run(['verify', 'list'], { store, ctx, daemon })
    expect(listR.code).toBe(0)
    expect(listR.out.join('\n')).toContain('integration')
  })
})

// ---------------------------------------------------------------------------
// 10. verify add — duplicate (scope,name)
// ---------------------------------------------------------------------------

describe('mars verify add — duplicate (scope,name)', () => {
  it('exits 1 with a message naming the duplicate pair', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r1 = await run(
      ['verify', 'add', 'typecheck', '--cmd', 'npx'],
      { store, ctx, daemon },
    )
    expect(r1.code).toBe(0)

    const r2 = await run(
      ['verify', 'add', 'typecheck', '--cmd', 'tsc'],
      { store, ctx, daemon },
    )

    expect(r2.code).toBe(1)
    const errText = r2.err.join('\n')
    expect(errText).toContain('already exists')
    expect(errText).toContain('typecheck')
  })
})

// ---------------------------------------------------------------------------
// 11. verify remove — by name
// ---------------------------------------------------------------------------

describe('mars verify remove — by name', () => {
  it('removes the gate and exits 0', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(['verify', 'add', 'typecheck', '--cmd', 'npx'], { store, ctx, daemon })

    const removeR = await run(['verify', 'remove', 'typecheck'], { store, ctx, daemon })
    expect(removeR.code).toBe(0)

    // Gate is gone
    const listR = await run(['verify', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('no verify gates configured')
  })
})

// ---------------------------------------------------------------------------
// 12. verify remove — by UUID id
// ---------------------------------------------------------------------------

describe('mars verify remove — by UUID', () => {
  it('removes the gate by UUID and exits 0', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify', 'add', 'typecheck', '--cmd', 'npx'],
      { store, ctx, daemon },
    )
    expect(addR.code).toBe(0)
    const id = addR.out[0]!

    const removeR = await run(['verify', 'remove', id], { store, ctx, daemon })
    expect(removeR.code).toBe(0)

    const listR = await run(['verify', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('no verify gates configured')
  })
})

// ---------------------------------------------------------------------------
// 13. verify remove — no args
// ---------------------------------------------------------------------------

describe('mars verify remove — no args', () => {
  it('exits 2 with usage error', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify', 'remove'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    expect(r.err.join('\n').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 14. verify remove — unknown name (idempotent)
// ---------------------------------------------------------------------------

describe('mars verify remove — unknown name', () => {
  it('exits 0 silently when the name does not match any gate', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify', 'remove', 'nonexistent-gate'], { store, ctx, daemon })

    expect(r.code).toBe(0)
    expect(r.err).toHaveLength(0)
  })
})
