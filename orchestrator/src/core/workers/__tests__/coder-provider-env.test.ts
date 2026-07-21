/**
 * MARS_WORKER_PROVIDER env override — CODER_PROVIDER acceptance tests.
 *
 * The three acceptance criteria from slice 4 of PRD 3f05ebd9:
 *   (a) MARS_WORKER_PROVIDER unset → resolved Coder provider is 'claude'
 *   (b) MARS_WORKER_PROVIDER=codex → resolved Coder provider is 'codex'
 *   (c) MARS_WORKER_PROVIDER=bogus → module load throws a clear error
 *
 * Because CODER_PROVIDER is evaluated at module-load time (top-level code),
 * each case must reload the module in a fresh cache — hence vi.resetModules()
 * before every dynamic import.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// Capture the original env value so we can restore it after each test.
const _originalProvider = process.env['MARS_WORKER_PROVIDER']

afterEach(() => {
  vi.resetModules()
  if (_originalProvider === undefined) {
    delete process.env['MARS_WORKER_PROVIDER']
  } else {
    process.env['MARS_WORKER_PROVIDER'] = _originalProvider
  }
})

describe('MARS_WORKER_PROVIDER env override', () => {
  it("(a) resolves CODER_PROVIDER to 'claude' when MARS_WORKER_PROVIDER is unset", async () => {
    delete process.env['MARS_WORKER_PROVIDER']
    vi.resetModules()
    const { CODER_PROVIDER } = await import('..')
    expect(CODER_PROVIDER).toBe('claude')
  })

  it("(b) resolves CODER_PROVIDER to 'codex' when MARS_WORKER_PROVIDER=codex", async () => {
    process.env['MARS_WORKER_PROVIDER'] = 'codex'
    vi.resetModules()
    const { CODER_PROVIDER } = await import('..')
    expect(CODER_PROVIDER).toBe('codex')
  })

  it("(c) throws a clear error when MARS_WORKER_PROVIDER is an unknown value", async () => {
    process.env['MARS_WORKER_PROVIDER'] = 'bogus'
    vi.resetModules()
    await expect(import('..')).rejects.toThrow(
      "Unknown MARS_WORKER_PROVIDER 'bogus' — known: claude, codex, gemini",
    )
  })
})

describe('CODER_PROVIDER plumbed into WORKER_CONFIGS.Coder', () => {
  it("WORKER_CONFIGS.Coder.provider reflects CODER_PROVIDER when MARS_WORKER_PROVIDER=gemini", async () => {
    process.env['MARS_WORKER_PROVIDER'] = 'gemini'
    vi.resetModules()
    const { CODER_PROVIDER, WORKER_CONFIGS } = await import('..')
    expect(CODER_PROVIDER).toBe('gemini')
    expect(WORKER_CONFIGS.Coder.provider).toBe('gemini')
  })

  it('non-Coder Workers keep their pinned provider regardless of MARS_WORKER_PROVIDER', async () => {
    process.env['MARS_WORKER_PROVIDER'] = 'codex'
    vi.resetModules()
    const { WORKER_CONFIGS } = await import('..')
    // Only Coder should change; all others must remain pinned to 'claude'.
    const pinned = ['Planner', 'Slicer', 'Triager', 'Fixer', 'BehaviourVerifier', 'Scorer'] as const
    for (const name of pinned) {
      expect(WORKER_CONFIGS[name].provider, `${name} must stay pinned to claude`).toBe('claude')
    }
  })
})
