/**
 * MARS_WORKER_PROVIDER env override — global Worker provider acceptance tests.
 *
 * The three acceptance criteria from slice 4 of PRD 3f05ebd9:
 *   (a) MARS_WORKER_PROVIDER unset AND no daemon.json → resolved provider is 'codex'
 *   (b) MARS_WORKER_PROVIDER=claude → every built-in Worker uses Claude
 *   (c) MARS_WORKER_PROVIDER=bogus → module load throws a clear error
 *
 * Because WORKER_PROVIDER is evaluated at module-load time (top-level code),
 * each case must reload the module in a fresh cache — hence vi.resetModules()
 * before every dynamic import.
 *
 * resolveProviderName now consults loadDaemonConfig() when the env var is absent,
 * so test (a) points MARS_REPO at a fresh temp dir with no daemon.json to ensure
 * the hard-coded 'codex' default is what's returned (not the real repo's daemon.json).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

// Capture the original env values so we can restore them after each test.
const _originalProvider = process.env['MARS_WORKER_PROVIDER']
const _originalMarsRepo = process.env['MARS_REPO']

let _tmpRepo: string | undefined

beforeEach(() => {
  _tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-provider-env-test-'))
})

afterEach(() => {
  vi.resetModules()
  if (_originalProvider === undefined) {
    delete process.env['MARS_WORKER_PROVIDER']
  } else {
    process.env['MARS_WORKER_PROVIDER'] = _originalProvider
  }
  if (_originalMarsRepo === undefined) {
    delete process.env['MARS_REPO']
  } else {
    process.env['MARS_REPO'] = _originalMarsRepo
  }
  if (_tmpRepo !== undefined) {
    rmSync(_tmpRepo, { recursive: true, force: true })
    _tmpRepo = undefined
  }
})

describe('MARS_WORKER_PROVIDER env override', () => {
  it("(a) resolves WORKER_PROVIDER to 'codex' when MARS_WORKER_PROVIDER is unset and no daemon.json exists", async () => {
    delete process.env['MARS_WORKER_PROVIDER']
    // Point MARS_REPO at a fresh temp dir with no daemon.json so loadDaemonConfig()
    // falls back to its hard-coded default ('codex') rather than picking up the
    // real repo's persisted defaultProvider.
    process.env['MARS_REPO'] = _tmpRepo!
    vi.resetModules()
    const { WORKER_PROVIDER } = await import('..')
    expect(WORKER_PROVIDER).toBe('codex')
  })

  it("(b) resolves WORKER_PROVIDER to 'claude' when MARS_WORKER_PROVIDER=claude", async () => {
    process.env['MARS_WORKER_PROVIDER'] = 'claude'
    vi.resetModules()
    const { WORKER_PROVIDER } = await import('..')
    expect(WORKER_PROVIDER).toBe('claude')
  })

  it("(c) throws a clear error when MARS_WORKER_PROVIDER is an unknown value", async () => {
    process.env['MARS_WORKER_PROVIDER'] = 'bogus'
    vi.resetModules()
    await expect(import('..')).rejects.toThrow(
      "Unknown MARS_WORKER_PROVIDER 'bogus' — known: claude, codex, gemini",
    )
  })
})

describe('WORKER_PROVIDER plumbed into every built-in Worker', () => {
  it('switches every Worker and translates semantic model tiers for Gemini', async () => {
    process.env['MARS_WORKER_PROVIDER'] = 'gemini'
    vi.resetModules()
    const { WORKER_PROVIDER, WORKER_CONFIGS } = await import('..')
    expect(WORKER_PROVIDER).toBe('gemini')
    for (const config of Object.values(WORKER_CONFIGS)) {
      expect(config.provider).toBe('gemini')
      expect(config.model).toMatch(/^gemini-/)
    }
  })

  it('uses Codex-native models for every role when Codex is selected', async () => {
    process.env['MARS_WORKER_PROVIDER'] = 'codex'
    vi.resetModules()
    const { WORKER_CONFIGS } = await import('..')
    for (const config of Object.values(WORKER_CONFIGS)) {
      expect(config.provider).toBe('codex')
      expect(config.model).toMatch(/^gpt-5\.6-/)
    }
  })
})
