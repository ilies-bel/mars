/**
 * Behaviour tests for `mars lever set <id> <value>`.
 *
 * Uses a real temporary repo dir so we can assert daemon.json was written and
 * read back correctly (the same approach as operator-budget.test.ts). Each test
 * calls `lever set` and asserts on the written file content, stdout/stderr, and
 * exit code — not on internal state.
 *
 * Separately: a cross-surface consistency test asserts that `mars operator status`
 * and `mars lever list` agree on the values they both render after a `lever set`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { InProcessOptions } from '../../test-adapter'

let repo: string

const setupRepo = (): string => {
  const dir = mkdtempSync(resolve(tmpdir(), 'mars-lever-set-test-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(resolve(dir, '.mars'), { recursive: true })
  return dir
}

const loadDeps = async (): Promise<Omit<InProcessOptions, 'daemon'>> => {
  const queueModule = await import('../../../core/queue')
  await queueModule.migrateQueueSchema()
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

const readConfig = (): Record<string, unknown> => {
  const raw = readFileSync(resolve(repo, '.mars', 'daemon.json'), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
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

// ── provider.default ──────────────────────────────────────────────────────────

describe('mars lever set provider.default', () => {
  it('persists the provider to daemon.json and echoes the transition', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'provider.default', 'claude'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    const config = readConfig()
    expect(config.defaultProvider).toBe('claude')
    expect(result.out.join('\n')).toContain('provider.default:')
    expect(result.out.join('\n')).toContain('claude')
  })

  it('rejects an unknown provider with a message naming allowed values', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'provider.default', 'openai'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('openai')
    expect(result.err.join('\n')).toMatch(/claude|codex|gemini/)
  })

  it('reports that a daemon restart is required', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'provider.default', 'gemini'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toMatch(/restart/i)
  })
})

// ── scoring.auto-trigger ──────────────────────────────────────────────────────

describe('mars lever set scoring.auto-trigger', () => {
  it('persists true as a boolean in daemon.json', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.auto-trigger', 'true'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    const config = readConfig()
    expect((config.scoring as Record<string, unknown>).autoTrigger).toBe(true)
  })

  it('persists false as a boolean in daemon.json', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.auto-trigger', 'false'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    const config = readConfig()
    expect((config.scoring as Record<string, unknown>).autoTrigger).toBe(false)
  })

  it('rejects a non-boolean value', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.auto-trigger', 'yes'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('yes')
    expect(result.err.join('\n')).toMatch(/true|false/)
  })
})

// ── scoring.low-trend-threshold ───────────────────────────────────────────────

describe('mars lever set scoring.low-trend-threshold', () => {
  it('persists a float in [0,1] to daemon.json', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.low-trend-threshold', '0.7'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    const config = readConfig()
    expect((config.scoring as Record<string, unknown>).lowTrendThreshold).toBe(0.7)
  })

  it('rejects a value > 1 with the allowed range', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.low-trend-threshold', '1.5'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('1.5')
    expect(result.err.join('\n')).toMatch(/0.{0,3}1/)  // mentions "0–1" or "0...1"
  })

  it('rejects a non-numeric value', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.low-trend-threshold', 'high'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('high')
  })
})

// ── scoring.low-trend-window ──────────────────────────────────────────────────

describe('mars lever set scoring.low-trend-window', () => {
  it('persists a positive integer to daemon.json', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.low-trend-window', '10'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    const config = readConfig()
    expect((config.scoring as Record<string, unknown>).lowTrendWindow).toBe(10)
  })

  it('rejects a non-integer float', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.low-trend-window', '2.5'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toMatch(/integer/)
  })

  it('rejects zero (min is 1)', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'scoring.low-trend-window', '0'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toMatch(/1/)
  })
})

// ── self-evolve.auto-trigger ──────────────────────────────────────────────────

describe('mars lever set self-evolve.auto-trigger', () => {
  it('persists true as a boolean in daemon.json', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'self-evolve.auto-trigger', 'true'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    const config = readConfig()
    expect((config.selfEvolve as Record<string, unknown>).autoTrigger).toBe(true)
  })

  it('rejects an invalid enum value', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'self-evolve.auto-trigger', 'on'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toMatch(/true|false/)
  })
})

// ── self-evolve.drift-threshold-pct ──────────────────────────────────────────

describe('mars lever set self-evolve.drift-threshold-pct', () => {
  it('persists a positive number to daemon.json', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'self-evolve.drift-threshold-pct', '15'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    const config = readConfig()
    expect((config.selfEvolve as Record<string, unknown>).driftThresholdPct).toBe(15)
  })

  it('rejects a negative value', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'self-evolve.drift-threshold-pct', '-5'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toMatch(/>= 0/)
  })
})

// ── self-evolve.task-confidence-threshold ────────────────────────────────────

describe('mars lever set self-evolve.task-confidence-threshold', () => {
  it('persists a [0,1] float to daemon.json', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'self-evolve.task-confidence-threshold', '0.9'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(0)
    const config = readConfig()
    expect((config.selfEvolve as Record<string, unknown>).taskConfidenceThreshold).toBe(0.9)
  })

  it('rejects a value above 1 with the allowed range named', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'self-evolve.task-confidence-threshold', '1.2'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('1.2')
    expect(result.err.join('\n')).toMatch(/0.{0,3}1/)
  })
})

// ── error paths ───────────────────────────────────────────────────────────────

describe('mars lever set — error paths', () => {
  it('rejects an unknown lever id', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set', 'nonexistent.lever', 'value'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).not.toBe(0)
    expect(result.err.join('\n')).toContain('nonexistent.lever')
  })

  it('redirects to the dedicated command for levers not settable via lever set', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    // caps.implement has a gesture (mars daemon set-cap) and is not settable via lever set
    const result = await run(['lever', 'set', 'caps.implement', '5'], {
      ...deps,
      daemon: fake,
    })

    expect(result.code).toBe(2)
    // Should mention the correct command to use
    expect(result.err.join('\n')).toMatch(/daemon set-cap|set-cap/)
  })

  it('returns code 2 with usage when no arguments given', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'set'], { ...deps, daemon: fake })

    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('usage')
  })
})

// ── persistence (survives daemon restart) ────────────────────────────────────

describe('lever set value survives daemon restart (persists to daemon.json)', () => {
  it('provider.default written in daemon.json is read back correctly by lever list', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    // Write the value
    await run(['lever', 'set', 'provider.default', 'gemini'], { ...deps, daemon: fake })

    // Simulate daemon restart by re-reading the config (vi.resetModules resets
    // any in-memory cache so the file on disk is the source of truth)
    vi.resetModules()

    const deps2 = await loadDeps()
    const fake2 = await makeFake()
    const listResult = await run(['lever', 'list'], { ...deps2, daemon: fake2 })

    expect(listResult.code).toBe(0)
    // provider.default line should show the persisted value
    const providerLine = listResult.out.find((l) => l.includes('provider.default'))
    expect(providerLine).toContain('gemini')
  })
})

// ── cross-surface consistency: operator status vs lever list ─────────────────

describe('operator status and lever list agree on self-evolve.auto-trigger', () => {
  it('both surfaces reflect the value written by lever set', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    // Set auto-trigger to true
    const setResult = await run(['lever', 'set', 'self-evolve.auto-trigger', 'true'], {
      ...deps,
      daemon: fake,
    })
    expect(setResult.code).toBe(0)

    // lever list must show 'true'
    const listResult = await run(['lever', 'list'], { ...deps, daemon: fake })
    const autoTriggerLine = listResult.out.find((l) => l.includes('self-evolve.auto-trigger'))
    expect(autoTriggerLine).toContain('true')

    // operator status must show 'auto-trigger: on'
    const statusResult = await run(['operator', 'status'], { ...deps, daemon: fake })
    expect(statusResult.out.join('\n')).toContain('auto-trigger: on')
  })

  it('both surfaces reflect off after setting to false', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    // First set to true, then back to false
    await run(['lever', 'set', 'self-evolve.auto-trigger', 'true'], { ...deps, daemon: fake })
    await run(['lever', 'set', 'self-evolve.auto-trigger', 'false'], { ...deps, daemon: fake })

    // lever list must show 'false'
    const listResult = await run(['lever', 'list'], { ...deps, daemon: fake })
    const autoTriggerLine = listResult.out.find((l) => l.includes('self-evolve.auto-trigger'))
    expect(autoTriggerLine).toContain('false')

    // operator status must show 'auto-trigger: off'
    const statusResult = await run(['operator', 'status'], { ...deps, daemon: fake })
    expect(statusResult.out.join('\n')).toContain('auto-trigger: off')
  })
})

// ── no remaining gesture gaps in the registry ────────────────────────────────

describe('lever registry — all entries have gestures', () => {
  it('noGestureEntries() returns empty — every lever has a runtime gesture', async () => {
    const { noGestureEntries } = await import('../../../core/lib/lever-registry')
    expect(noGestureEntries()).toHaveLength(0)
  })

  it('lever list shows no "no gesture" footer when all levers have gestures', async () => {
    const deps = await loadDeps()
    const fake = await makeFake()

    const result = await run(['lever', 'list'], { ...deps, daemon: fake })

    expect(result.code).toBe(0)
    expect(result.out.join('\n')).not.toContain('lack a runtime gesture')
  })
})
