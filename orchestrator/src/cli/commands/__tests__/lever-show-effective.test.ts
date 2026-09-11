/**
 * Behaviour tests for `mars lever show <caps-lever>` when the daemon reports
 * an effective value that differs from `.mars/daemon.json` (steward autotune).
 *
 * Observable behaviour being pinned:
 * - When the daemon reports configured=3 but effective=6, `lever show caps.implement`
 *   must print BOTH values and never print only the configured one.
 * - When the daemon is unreachable, the output must be marked as persisted-only,
 *   not silently presented as the current effective state.
 * - When configured and effective agree, only the single value is printed.
 *
 * Structure: loadDeps() is called once in beforeAll (heavy DB init happens once)
 * and __resetContextCacheForTests() in beforeEach clears the context singleton
 * so readCurrent() picks up the correct daemon.json on each test.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { InProcessOptions } from '../../test-adapter'
import type { DaemonClient } from '../../command'

let repo: string
let sharedDeps: Omit<InProcessOptions, 'daemon'>

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-lever-show-eff-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

beforeAll(async () => {
  repo = setupRepo()
  process.env.MARS_REPO = repo
  // Load deps once — migrateQueueSchema may initialise PGlite WASM which is slow
  // on first load. Doing it in beforeAll avoids per-test cold-start timeouts.
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
  const storeModule = await import('../../../core/store/task-store')
  const contextModule = await import('../../../core/context')
  sharedDeps = {
    store: storeModule.createTaskStore(queueModule.resolveQueueClient()),
    ctx: contextModule.resolveContext(repo),
  }
})

afterAll(() => {
  delete process.env.MARS_REPO
  rmSync(repo, { recursive: true, force: true })
})

beforeEach(async () => {
  // Reset the context cache so readCurrent() re-reads daemon.json from repo
  // on each test (the file content changes between tests; the path does not).
  const { __resetContextCacheForTests } = await import('../../../core/context')
  __resetContextCacheForTests()
})

const run = async (
  argv: readonly string[],
  daemon: DaemonClient,
): Promise<{ code: number; out: string[]; err: string[] }> => {
  const { runCommandInProcess } = await import('../../test-adapter')
  return runCommandInProcess(argv, { ...sharedDeps, daemon })
}

const makeFake = async (
  statusPayload?: { implementCap: { configured: number; effective: number; reason: string | null } } | Error,
): Promise<DaemonClient> => {
  const { makeFakeDaemon } = await import('../../test-adapter')
  return makeFakeDaemon((req) => {
    if (req.op === 'status') {
      if (statusPayload instanceof Error) throw statusPayload
      return statusPayload ?? {}
    }
    return {}
  })
}

// ── drift: configured ≠ effective ────────────────────────────────────────────

describe('lever show caps.implement — steward autotune drift', () => {
  it('surfaces both configured and effective when the daemon reports a higher effective cap', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 3 } }),
    )
    const daemon = await makeFake({
      implementCap: { configured: 3, effective: 6, reason: 'steward autotune raised implement 4 → 6 on sustained backlog' },
    })

    const result = await run(['lever', 'show', 'caps.implement'], daemon)

    expect(result.code).toBe(0)
    const currentLine = result.out.find((l) => l.startsWith('current:'))
    expect(currentLine, 'must include the configured value').toContain('3')
    expect(currentLine, 'must include the effective value').toContain('6')
    // Must NOT print only the configured number without mentioning the effective one
    expect(currentLine, 'must not present only configured without effective').not.toMatch(/^current:\s+3\s*$/)
  })

  it('includes the autotune reason in the output when provided', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 3 } }),
    )
    const daemon = await makeFake({
      implementCap: { configured: 3, effective: 6, reason: 'steward autotune raised implement 4 → 6 on sustained backlog' },
    })

    const result = await run(['lever', 'show', 'caps.implement'], daemon)

    const output = result.out.join('\n')
    expect(output).toContain('steward autotune')
  })

  it('shows a ⚠ marker when configured and effective diverge', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 3 } }),
    )
    const daemon = await makeFake({
      implementCap: { configured: 3, effective: 6, reason: 'steward autotune raised implement 4 → 6 on sustained backlog' },
    })

    const result = await run(['lever', 'show', 'caps.implement'], daemon)

    const currentLine = result.out.find((l) => l.startsWith('current:'))
    expect(currentLine).toContain('⚠')
  })
})

// ── in-sync: configured === effective ─────────────────────────────────────────

describe('lever show caps.implement — in sync with daemon', () => {
  it('shows only the effective value when configured and effective agree', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 5 } }),
    )
    const daemon = await makeFake({
      implementCap: { configured: 5, effective: 5, reason: null },
    })

    const result = await run(['lever', 'show', 'caps.implement'], daemon)

    expect(result.code).toBe(0)
    const currentLine = result.out.find((l) => l.startsWith('current:'))
    expect(currentLine).toContain('5')
    // No warning marker when values agree
    expect(currentLine).not.toContain('⚠')
  })
})

// ── daemon down: persisted-only label ─────────────────────────────────────────

describe('lever show caps.implement — daemon not running', () => {
  it('marks the value as persisted-only rather than presenting it as current effective state', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 3 } }),
    )
    // Daemon throws — simulates daemon not running
    const daemon = await makeFake(new Error('daemon not running'))

    const result = await run(['lever', 'show', 'caps.implement'], daemon)

    expect(result.code).toBe(0)
    const currentLine = result.out.find((l) => l.startsWith('current:'))
    // Must include the configured value
    expect(currentLine).toContain('3')
    // Must be marked as persisted-only, NOT presented as the live effective value
    expect(currentLine, 'must say persisted only').toMatch(/persisted.only/i)
  })

  it('does NOT print a bare configured number without any context when daemon is down', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 7 } }),
    )
    const daemon = await makeFake(new Error('connection refused'))

    const result = await run(['lever', 'show', 'caps.implement'], daemon)

    expect(result.code).toBe(0)
    const currentLine = result.out.find((l) => l.startsWith('current:'))
    // The bare number alone would mislead the operator into thinking it's the live value
    expect(currentLine).not.toMatch(/^current:\s+7\s*$/)
  })
})

// ── non-caps levers are unaffected ────────────────────────────────────────────

describe('lever show — non-caps levers use readCurrent() as before', () => {
  it('provider.default shows the configured provider without querying the daemon', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ defaultProvider: 'gemini' }),
    )
    // The daemon responder would throw if queried, but it should not be queried
    const daemon = await makeFake(new Error('should not be called'))

    const result = await run(['lever', 'show', 'provider.default'], daemon)

    expect(result.code).toBe(0)
    const currentLine = result.out.find((l) => l.startsWith('current:'))
    expect(currentLine).toContain('gemini')
    // No persisted-only label for levers without readEffective
    expect(currentLine).not.toMatch(/persisted.only/i)
  })
})

// ── wiring state ────────────────────────────────────────────────────────────

describe('lever show — wiring state line', () => {
  it('caps.implement shows wired (verified production consumer)', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 5 } }),
    )
    const daemon = await makeFake({ implementCap: { configured: 5, effective: 5, reason: null } })

    const result = await run(['lever', 'show', 'caps.implement'], daemon)

    expect(result.code).toBe(0)
    const wiringLine = result.out.find((l) => l.startsWith('wiring:'))
    expect(wiringLine).toBeDefined()
    expect(wiringLine).toContain('wired')
    // Must include the restart? line since it's wired
    const restartLine = result.out.find((l) => l.startsWith('restart?:'))
    expect(restartLine).toBeDefined()
  })

  it('self-evolve.drift-threshold-pct shows no-consumer and omits restart? line', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ selfEvolve: { driftThresholdPct: 10 } }),
    )
    const daemon = await makeFake()

    const result = await run(['lever', 'show', 'self-evolve.drift-threshold-pct'], daemon)

    expect(result.code).toBe(0)
    const wiringLine = result.out.find((l) => l.startsWith('wiring:'))
    expect(wiringLine).toBeDefined()
    expect(wiringLine).toContain('no-consumer')
    // restart? line must be suppressed for no-consumer levers
    const restartLine = result.out.find((l) => l.startsWith('restart?:'))
    expect(restartLine).toBeUndefined()
  })
})

// ── lever group command usage fallback ───────────────────────────────────────

describe('lever group command', () => {
  it('mars lever (no subcommand) prints usage to stderr and exits with code 2', async () => {
    const daemon = await makeFake()
    const result = await run(['lever'], daemon)

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('usage: mars lever')
    expect(result.err.join('\n')).toMatch(/list|show|set/)
  })
})

// ── lever list wiring column ──────────────────────────────────────────────────

describe('lever list — wiring column', () => {
  it('header row includes a wiring column', async () => {
    const daemon = await makeFake()
    const result = await run(['lever', 'list'], daemon)

    expect(result.code).toBe(0)
    const header = result.out[0]
    expect(header).toContain('wiring')
  })

  it('caps.implement row shows wired state', async () => {
    const daemon = await makeFake()
    const result = await run(['lever', 'list'], daemon)

    const capsLine = result.out.find((l) => l.includes('caps.implement'))
    expect(capsLine).toBeDefined()
    expect(capsLine).toContain('wired')
  })

  it('self-evolve.drift-threshold-pct row shows no-consumer state', async () => {
    const daemon = await makeFake()
    const result = await run(['lever', 'list'], daemon)

    const driftLine = result.out.find((l) => l.includes('self-evolve.drift-threshold-pct'))
    expect(driftLine).toBeDefined()
    expect(driftLine).toContain('no-consumer')
  })

  it('footer reports consumer-gaps separately from gesture-gaps', async () => {
    const daemon = await makeFake()
    const result = await run(['lever', 'list'], daemon)

    const output = result.out.join('\n')
    // Consumer-gap footer line must appear (there is at least one no-consumer lever)
    expect(output).toContain('no runtime consumer')
    // Gesture-gap footer line must NOT appear (all levers have gestures)
    expect(output).not.toContain('lack a runtime gesture')
  })
})

// ── lever list drift rendering ────────────────────────────────────────────────

describe('lever list — drift rendering', () => {
  it('shows configured → effective ⚠ in the current column when caps.implement is autotuned', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 4 } }),
    )
    const daemon = await makeFake({
      implementCap: { configured: 4, effective: 8, reason: 'steward autotune raised implement 6 → 8 on sustained backlog' },
    })

    const result = await run(['lever', 'list'], daemon)

    expect(result.code).toBe(0)
    const capsLine = result.out.find((l) => l.includes('caps.implement'))
    expect(capsLine).toBeDefined()
    expect(capsLine).toContain('4 → 8 ⚠')
  })

  it('shows only the configured value when configured == effective (no drift marker)', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 4 } }),
    )
    const daemon = await makeFake({
      implementCap: { configured: 4, effective: 4, reason: null },
    })

    const result = await run(['lever', 'list'], daemon)

    expect(result.code).toBe(0)
    const capsLine = result.out.find((l) => l.includes('caps.implement'))
    expect(capsLine).toBeDefined()
    expect(capsLine).not.toContain('⚠')
    expect(capsLine).not.toContain('→')
  })

  it('list and show read the same effective value from the daemon', async () => {
    writeFileSync(
      resolve(repo, '.mars', 'daemon.json'),
      JSON.stringify({ caps: { implement: 4 } }),
    )
    const daemon = await makeFake({
      implementCap: { configured: 4, effective: 8, reason: 'steward autotune' },
    })

    const listResult = await run(['lever', 'list'], daemon)
    const showResult = await run(['lever', 'show', 'caps.implement'], daemon)

    const capsListLine = listResult.out.find((l) => l.includes('caps.implement'))
    const showCurrentLine = showResult.out.find((l) => l.startsWith('current:'))

    // Both surfaces report effective value of 8
    expect(capsListLine).toContain('8')
    expect(showCurrentLine).toContain('8')
  })
})
