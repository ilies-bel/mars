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
 *  14. `verify-gate add` whitespace-in-arg guard — rejects "run test:e2e" as single token
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
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture', '--', 'tsc', '--noEmit'],
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
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )
    const { quarantineVerifyGate } = await import('../../../core/verify-gates')
    const { getCompositionRootClient } = await import('../../../core/store/task-store-default')
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
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture', '--', 'tsc', '--noEmit'],
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
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )
    expect(r1.code).toBe(0)

    // Second insert with the same (scope,name) must fail
    const r2 = await run(
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'tsc', '--evidence', 'test: unit test fixture'],
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
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture', '--', 'tsc', '--noEmit'],
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
      ['verify-gate', 'add', '--name', 'lint', '--cmd', 'eslint', '--optional', '--evidence', 'test: unit test fixture'],
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
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
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
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
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
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
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

// ---------------------------------------------------------------------------
// 14. verify-gate add — whitespace-in-arg guard
// ---------------------------------------------------------------------------

describe('mars verify-gate add — whitespace-in-arg guard', () => {
  it('rejects a single-token "run test:e2e" arg for npm (exit 2, helpful error)', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    // Simulate what an agent does when it forgets to split the arg:
    // --cmd npm and then passes "run test:e2e" as one token after --
    const r = await run(
      ['verify-gate', 'add', '--name', 'e2e', '--cmd', 'npm', '--', 'run test:e2e'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(2)
    const errText = r.err.join('\n')
    // Must name the offending arg
    expect(errText).toContain('run test:e2e')
    // Must suggest the split form
    expect(errText.toLowerCase()).toMatch(/split|--args|-- /)
  })

  it('accepts correctly-split args via -- separator: --cmd npm -- run test:e2e', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'add', '--name', 'e2e', '--cmd', 'npm', '--evidence', 'test: unit test fixture', '--', 'run', 'test:e2e'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.out[0]).toMatch(/^[0-9a-f-]{36}$/)
  })
})

// ---------------------------------------------------------------------------
// 15. verify-gate add --timeout → stored and shown in list
// ---------------------------------------------------------------------------

describe('mars verify-gate add — --timeout flag', () => {
  it('stores a custom timeout and list shows it', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--timeout', '45', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.code).toBe(0)
    expect(listR.out.join('\n')).toContain('45')
  })

  it('exits 2 when --timeout is not a positive number', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--timeout', 'bad'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('--timeout')
  })

  it('new gates default to 20 min timeout when --timeout is omitted', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.code).toBe(0)
    // Default timeout 20 should appear
    expect(listR.out.join('\n')).toContain('20')
    // And NOT the unbounded marker
    expect(listR.out.join('\n')).not.toContain('—(default)')
  })
})

// ---------------------------------------------------------------------------
// 16. verify-gate list → shows timeout_min column header
// ---------------------------------------------------------------------------

describe('mars verify-gate list — timeout_min column', () => {
  it('shows timeout_min in the header', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )

    const r = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('timeout_min')
  })
})

// ---------------------------------------------------------------------------
// 17. verify-gate set — update timeout via CLI
// ---------------------------------------------------------------------------

describe('mars verify-gate set — update timeout by id', () => {
  it('updates timeout on an existing gate by id', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )
    expect(addR.code).toBe(0)
    const id = addR.out[0]!

    const setR = await run(
      ['verify-gate', 'set', id, '--timeout', '30'],
      { store, ctx, daemon },
    )
    expect(setR.code).toBe(0)

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('30')
  })

  it('updates timeout on an existing gate by scope/name', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    await run(
      ['verify-gate', 'add', '--scope', 'orchestrator', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )

    const setR = await run(
      ['verify-gate', 'set', '--scope', 'orchestrator', '--name', 'typecheck', '--timeout', '10'],
      { store, ctx, daemon },
    )
    expect(setR.code).toBe(0)

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('10')
  })

  it('exits 1 when the gate id does not exist', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'set', 'non-existent-uuid', '--timeout', '15'],
      { store, ctx, daemon },
    )
    expect(r.code).toBe(1)
    expect(r.err.join('\n').length).toBeGreaterThan(0)
  })

  it('exits 2 when no target is specified', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['verify-gate', 'set', '--timeout', '15'],
      { store, ctx, daemon },
    )
    expect(r.code).toBe(2)
  })

  it('exits 2 when no update flag is specified', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'typecheck', '--cmd', 'npx', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!

    const r = await run(
      ['verify-gate', 'set', id],
      { store, ctx, daemon },
    )
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('at least one flag')
  })

  it('flips a gate to required=true via --required', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'full-suite', '--cmd', 'npm', '--optional', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )
    expect(addR.code).toBe(0)
    const id = addR.out[0]!

    const setR = await run(
      ['verify-gate', 'set', id, '--required'],
      { store, ctx, daemon },
    )
    expect(setR.code).toBe(0)

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    const rows = listR.out.filter((l) => l.includes('full-suite'))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toContain('true')
  })

  it('flips a gate to required=false via --optional', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'full-suite', '--cmd', 'npm', '--required', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )
    expect(addR.code).toBe(0)
    const id = addR.out[0]!

    const setR = await run(
      ['verify-gate', 'set', id, '--optional'],
      { store, ctx, daemon },
    )
    expect(setR.code).toBe(0)

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    const rows = listR.out.filter((l) => l.includes('full-suite'))
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toContain('false')
  })

  it('exits 2 when --required and --optional are both specified', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'full-suite', '--cmd', 'npm', '--evidence', 'test: unit test fixture'],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!

    const r = await run(
      ['verify-gate', 'set', id, '--required', '--optional'],
      { store, ctx, daemon },
    )
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toContain('mutually exclusive')
  })
})

// ---------------------------------------------------------------------------
// 18. verify-gate restore
// ---------------------------------------------------------------------------

describe('mars verify-gate restore', () => {
  const quarantine = async (
    id: string,
    signature = 'verify:x/exit-1',
    originId = 'origin-abc',
  ) => {
    const { quarantineVerifyGate } = await import('../../../core/verify-gates')
    const { getCompositionRootClient } = await import('../../../core/store/task-store-default')
    await quarantineVerifyGate(getCompositionRootClient(), id, signature, originId)
  }

  it('clears quarantine by id when the gate now passes', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'ok', '--cmd', 'node', '--evidence', 'test: unit test fixture', '--', '-e', 'process.exit(0)'],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!
    await quarantine(id)

    const restoreR = await run(['verify-gate', 'restore', id], { store, ctx, daemon })
    expect(restoreR.code).toBe(0)
    expect(restoreR.out.join('\n')).toContain('restored')

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    const out = listR.out.join('\n')
    expect(out).toContain('active')
    expect(out).not.toMatch(/QUARANTINED/)
  })

  it('clears quarantine by --scope/--name when the gate now passes', async () => {
    // A scoped gate runs its command in <repo>/<scope>, so that directory has
    // to exist for the re-verify to spawn at all.
    mkdirSync(resolve(repo, 'orchestrator'), { recursive: true })
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      [
        'verify-gate', 'add', '--scope', 'orchestrator', '--name', 'ok',
        '--cmd', 'node', '--evidence', 'test: unit test fixture', '--', '-e', 'process.exit(0)',
      ],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!
    await quarantine(id)

    const restoreR = await run(
      ['verify-gate', 'restore', '--scope', 'orchestrator', '--name', 'ok'],
      { store, ctx, daemon },
    )
    expect(restoreR.code).toBe(0)

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('active')
  })

  it('refuses to restore a gate that is still failing, and leaves it quarantined', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'broken', '--cmd', 'node', '--evidence', 'test: unit test fixture', '--', '-e', 'process.exit(1)'],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!
    await quarantine(id, 'verify:broken/exit-1')

    const restoreR = await run(['verify-gate', 'restore', id], { store, ctx, daemon })
    expect(restoreR.code).toBe(1)
    expect(restoreR.err.join('\n')).toContain('still failing')

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('QUARANTINED')
  })

  it('--force restores a still-failing gate anyway', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'broken', '--cmd', 'node', '--evidence', 'test: unit test fixture', '--', '-e', 'process.exit(1)'],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!
    await quarantine(id)

    const restoreR = await run(['verify-gate', 'restore', id, '--force'], { store, ctx, daemon })
    expect(restoreR.code).toBe(0)

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    const out = listR.out.join('\n')
    expect(out).toContain('active')
    expect(out).not.toMatch(/QUARANTINED/)
  })

  it('reports a gate whose scope directory is missing as still failing', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    // No `vanished/` directory is ever created in the fixture repo, so the
    // re-verify cannot even spawn. That must read as "still failing", not
    // crash out of the CLI.
    const addR = await run(
      [
        'verify-gate', 'add', '--scope', 'vanished', '--name', 'ok',
        '--cmd', 'node', '--evidence', 'test: unit test fixture', '--', '-e', 'process.exit(0)',
      ],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!
    await quarantine(id)

    const restoreR = await run(['verify-gate', 'restore', id], { store, ctx, daemon })
    expect(restoreR.code).toBe(1)
    expect(restoreR.err.join('\n')).toContain('still failing')

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).toContain('QUARANTINED')
  })

  it('--force restores a gate whose scope directory is missing', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      [
        'verify-gate', 'add', '--scope', 'vanished', '--name', 'ok',
        '--cmd', 'node', '--evidence', 'test: unit test fixture', '--', '-e', 'process.exit(0)',
      ],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!
    await quarantine(id)

    const restoreR = await run(['verify-gate', 'restore', id, '--force'], { store, ctx, daemon })
    expect(restoreR.code).toBe(0)

    const listR = await run(['verify-gate', 'list'], { store, ctx, daemon })
    expect(listR.out.join('\n')).not.toMatch(/QUARANTINED/)
  })

  it('exits 1 for an unknown id', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify-gate', 'restore', 'non-existent-uuid'], { store, ctx, daemon })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('no verify gate')
  })

  it('exits 1 when the gate is not quarantined (already active)', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const addR = await run(
      ['verify-gate', 'add', '--name', 'ok', '--cmd', 'node', '--evidence', 'test: unit test fixture', '--', '-e', 'process.exit(0)'],
      { store, ctx, daemon },
    )
    const id = addR.out[0]!

    const r = await run(['verify-gate', 'restore', id], { store, ctx, daemon })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('not quarantined')
  })

  it('exits 2 when no target is specified', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['verify-gate', 'restore'], { store, ctx, daemon })
    expect(r.code).toBe(2)
  })
})
