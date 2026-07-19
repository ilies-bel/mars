/**
 * Tests for `mars memory` CLI behaviour (PRD 6544c0a0, slice 2).
 *
 * Covers:
 *   1. `memory` group command → exit 2, subcommand list on stderr
 *   2. `memory add` happy path → prints inserted id
 *   3. `memory add` with explicit salience and origin-arc → round-trips through store
 *   4. `memory add` missing --domain → exit 1
 *   5. `memory add` missing --text → exit 1
 *   6. `memory add` salience out-of-range (Zod) → exit 1, error on stderr
 *   7. `memory list` happy path → table rows contain id / salience / domain / text
 *   8. `memory list` respects --min-salience filter
 *   9. `memory list` respects --limit cap
 *  10. `memory list` missing --domain → exit 1
 *  11. `memory retire` happy path → exit 0, "retired" on stdout
 *  12. `memory retire` unknown id → exit non-zero, error on stderr
 *  13. `memory retire` already-retired → exit non-zero, error on stderr
 *
 * All dispatch uses DYNAMIC imports of test-adapter after vi.resetModules()
 * so every test gets fully fresh module instances (including the
 * memory-packet-store singleton and state-client).
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
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-memory-cmd-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

/**
 * Load the task store + context (for InProcessOptions) AND initialise the
 * memory_packets schema in the temp DB. Dynamically imported AFTER the module
 * cache reset so all instances are fresh and share the same SQLite file.
 */
const loadDeps = async () => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  const { initMemoryPackets } = await import(
    '../../../core/store/memory-packet-store'
  )
  await initMemoryPackets()
  return {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
}

/**
 * Run a command in-process via fresh module instances (post reset).
 */
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
// 1. Group command — exits 2 and lists subcommands
// ---------------------------------------------------------------------------

describe('mars memory — group command', () => {
  it('exits 2 and lists list / add / retire on stderr', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['memory'], { store, ctx, daemon })

    expect(r.code).toBe(2)
    const errText = r.err.join('\n')
    expect(errText).toContain('list')
    expect(errText).toContain('add')
    expect(errText).toContain('retire')
  })
})

// ---------------------------------------------------------------------------
// 2. memory add — happy path with defaults
// ---------------------------------------------------------------------------

describe('mars memory add — happy path', () => {
  it('inserts a packet and prints its id', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'add', '--domain', 'orchestrator', '--text', 'prefer deep modules'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.out).toHaveLength(1)
    expect(r.out[0]).toMatch(/^mp-[0-9a-f]{16}$/)
  })
})

// ---------------------------------------------------------------------------
// 3. memory add — explicit salience and origin-arc round-trip
// ---------------------------------------------------------------------------

describe('mars memory add — explicit salience and origin-arc', () => {
  it('inserts with the given salience and origin-arc, prints the id', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      [
        'memory',
        'add',
        '--domain',
        'coder',
        '--text',
        'avoid nested callbacks',
        '--salience',
        '0.9',
        '--origin-arc',
        'arc-test-001',
      ],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    const id = r.out[0]
    expect(id).toMatch(/^mp-[0-9a-f]{16}$/)

    // Verify the stored packet by listing — confirms round-trip through store
    const listR = await run(
      ['memory', 'list', '--domain', 'coder', '--min-salience', '0'],
      { store, ctx, daemon },
    )
    expect(listR.code).toBe(0)
    const listText = listR.out.join('\n')
    expect(listText).toContain('avoid nested callbacks')
    expect(listText).toContain('0.90')
  })
})

// ---------------------------------------------------------------------------
// 4. memory add — missing --domain
// ---------------------------------------------------------------------------

describe('mars memory add — missing --domain', () => {
  it('exits 1 with error mentioning --domain', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'add', '--text', 'some lesson'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('--domain')
  })
})

// ---------------------------------------------------------------------------
// 5. memory add — missing --text
// ---------------------------------------------------------------------------

describe('mars memory add — missing --text', () => {
  it('exits 1 with error mentioning --text', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'add', '--domain', 'test'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('--text')
  })
})

// ---------------------------------------------------------------------------
// 6. memory add — salience out of range (Zod validation)
// ---------------------------------------------------------------------------

describe('mars memory add — salience out of range', () => {
  it('exits 1 and prints a Zod error on stderr for salience > 1', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'add', '--domain', 'd', '--text', 't', '--salience', '1.5'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('--salience')
  })

  it('exits 1 for salience < 0', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'add', '--domain', 'd', '--text', 't', '--salience', '-0.1'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('--salience')
  })
})

// ---------------------------------------------------------------------------
// 7. memory list — happy path
// ---------------------------------------------------------------------------

describe('mars memory list — happy path', () => {
  it('prints table rows containing id, salience, domain, text, created_at', async () => {
    const { store, ctx } = await loadDeps()
    const { insertMemoryPacket } = await import(
      '../../../core/store/memory-packet-store'
    )
    await insertMemoryPacket({ domain: 'coder', text: 'keep it simple', salience: 0.8 })
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'list', '--domain', 'coder'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('keep it simple')
    expect(out).toContain('coder')
    expect(out).toContain('0.80')
    // Header row presence
    expect(out).toContain('id')
    expect(out).toContain('salience')
    expect(out).toContain('created_at')
  })

  it('prints "no memory packets found" when domain is empty', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'list', '--domain', 'empty-domain'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('no memory packets found')
  })
})

// ---------------------------------------------------------------------------
// 8. memory list — respects --min-salience filter
// ---------------------------------------------------------------------------

describe('mars memory list — min-salience filter', () => {
  it('excludes packets below the threshold', async () => {
    const { store, ctx } = await loadDeps()
    const { insertMemoryPacket } = await import(
      '../../../core/store/memory-packet-store'
    )
    await insertMemoryPacket({ domain: 'test', text: 'high-salience', salience: 0.9 })
    await insertMemoryPacket({ domain: 'test', text: 'low-salience',  salience: 0.3 })
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'list', '--domain', 'test', '--min-salience', '0.5'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    const out = r.out.join('\n')
    expect(out).toContain('high-salience')
    expect(out).not.toContain('low-salience')
  })
})

// ---------------------------------------------------------------------------
// 9. memory list — respects --limit cap
// ---------------------------------------------------------------------------

describe('mars memory list — limit cap', () => {
  it('returns at most --limit rows', async () => {
    const { store, ctx } = await loadDeps()
    const { insertMemoryPacket } = await import(
      '../../../core/store/memory-packet-store'
    )
    await insertMemoryPacket({ domain: 'test', text: 'first',  salience: 0.9 })
    await insertMemoryPacket({ domain: 'test', text: 'second', salience: 0.8 })
    await insertMemoryPacket({ domain: 'test', text: 'third',  salience: 0.7 })
    const daemon = await makeFake()

    const r = await run(
      ['memory', 'list', '--domain', 'test', '--limit', '2', '--min-salience', '0'],
      { store, ctx, daemon },
    )

    expect(r.code).toBe(0)
    // 2 header lines + 2 data lines = 4 total output lines
    // (header, separator, row1, row2)
    const dataLines = r.out.filter(
      (l) => l.includes('first') || l.includes('second') || l.includes('third'),
    )
    expect(dataLines).toHaveLength(2)
    expect(dataLines.some((l) => l.includes('first'))).toBe(true)
    expect(dataLines.some((l) => l.includes('second'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 10. memory list — missing --domain
// ---------------------------------------------------------------------------

describe('mars memory list — missing --domain', () => {
  it('exits 1 with error mentioning --domain', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['memory', 'list'], { store, ctx, daemon })

    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('--domain')
  })
})

// ---------------------------------------------------------------------------
// 11. memory retire — happy path
// ---------------------------------------------------------------------------

describe('mars memory retire — happy path', () => {
  it('exits 0 and prints "retired <id>" on stdout', async () => {
    const { store, ctx } = await loadDeps()
    const { insertMemoryPacket } = await import(
      '../../../core/store/memory-packet-store'
    )
    const p = await insertMemoryPacket({
      domain: 'test',
      text: 'retire me',
      salience: 0.9,
    })
    const daemon = await makeFake()

    const r = await run(['memory', 'retire', p.id], { store, ctx, daemon })

    expect(r.code).toBe(0)
    expect(r.out.join('\n')).toContain('retired')
    expect(r.out.join('\n')).toContain(p.id)
  })

  it('retired packet no longer appears in list', async () => {
    const { store, ctx } = await loadDeps()
    const { insertMemoryPacket } = await import(
      '../../../core/store/memory-packet-store'
    )
    const p = await insertMemoryPacket({
      domain: 'test',
      text: 'gone after retire',
      salience: 0.9,
    })
    const daemon = await makeFake()

    await run(['memory', 'retire', p.id], { store, ctx, daemon })

    const listR = await run(
      ['memory', 'list', '--domain', 'test', '--min-salience', '0'],
      { store, ctx, daemon },
    )
    expect(listR.code).toBe(0)
    expect(listR.out.join('\n')).not.toContain('gone after retire')
  })
})

// ---------------------------------------------------------------------------
// 12. memory retire — unknown id
// ---------------------------------------------------------------------------

describe('mars memory retire — unknown id', () => {
  it('exits non-zero and reports the error on stderr', async () => {
    const { store, ctx } = await loadDeps()
    const daemon = await makeFake()

    const r = await run(['memory', 'retire', 'mp-doesnotexist'], { store, ctx, daemon })

    expect(r.code).not.toBe(0)
    expect(r.err.join('\n')).toContain('unknown or already retired')
  })
})

// ---------------------------------------------------------------------------
// 13. memory retire — already-retired id
// ---------------------------------------------------------------------------

describe('mars memory retire — already retired', () => {
  it('exits non-zero on double-retire', async () => {
    const { store, ctx } = await loadDeps()
    const { insertMemoryPacket } = await import(
      '../../../core/store/memory-packet-store'
    )
    const p = await insertMemoryPacket({
      domain: 'test',
      text: 'retire twice',
      salience: 0.7,
    })
    const daemon = await makeFake()

    // First retire succeeds
    const r1 = await run(['memory', 'retire', p.id], { store, ctx, daemon })
    expect(r1.code).toBe(0)

    // Second retire should fail
    const r2 = await run(['memory', 'retire', p.id], { store, ctx, daemon })
    expect(r2.code).not.toBe(0)
    expect(r2.err.join('\n')).toContain('unknown or already retired')
  })
})
