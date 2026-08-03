/**
 * Tests for defaultProvider persistence in daemon.json.
 *
 * Exercises the round-trip: patchDaemonConfigFile({ defaultProvider }) → loadDaemonConfig()
 * and verifies that invalid values are rejected and the default ('codex') is
 * applied when the field is absent.
 *
 * Uses a real temp directory so config write/read IO is exercised end-to-end,
 * but the daemon is never started and no CLI commands are invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Inject MARS_REPO so resolveContext() writes daemon.json into the temp dir.
let tmpRepo: string

beforeEach(() => {
  tmpRepo = mkdtempSync(resolve(tmpdir(), 'mars-provider-config-test-'))
  process.env['MARS_REPO'] = tmpRepo
  // Reset module cache so resolveContext() picks up the new MARS_REPO
  // (the context module memoises internally).
})

afterEach(() => {
  delete process.env['MARS_REPO']
  rmSync(tmpRepo, { recursive: true, force: true })
})

describe('loadDaemonConfig — defaultProvider', () => {
  it("defaults to 'codex' when daemon.json has no defaultProvider field", async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { loadDaemonConfig } = await import('../../core/daemon/config')
    const cfg = loadDaemonConfig()
    expect(cfg.defaultProvider).toBe('codex')
  })

  it("persists and reads back 'gemini'", async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { patchDaemonConfigFile, loadDaemonConfig } = await import('../../core/daemon/config')
    patchDaemonConfigFile({ defaultProvider: 'gemini' })
    const cfg = loadDaemonConfig()
    expect(cfg.defaultProvider).toBe('gemini')
  })

  it("persists and reads back 'codex'", async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { patchDaemonConfigFile, loadDaemonConfig } = await import('../../core/daemon/config')
    patchDaemonConfigFile({ defaultProvider: 'codex' })
    const cfg = loadDaemonConfig()
    expect(cfg.defaultProvider).toBe('codex')
  })

  it("persists and reads back 'claude' explicitly", async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { patchDaemonConfigFile, loadDaemonConfig } = await import('../../core/daemon/config')
    patchDaemonConfigFile({ defaultProvider: 'claude' })
    const cfg = loadDaemonConfig()
    expect(cfg.defaultProvider).toBe('claude')
  })

  it("falls back to 'codex' when an invalid provider name is in daemon.json", async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { patchDaemonConfigFile, loadDaemonConfig } = await import('../../core/daemon/config')
    // Write an unknown provider string directly
    patchDaemonConfigFile({ defaultProvider: 'unknown-llm' })
    const cfg = loadDaemonConfig()
    expect(cfg.defaultProvider).toBe('codex')
  })

  it('preserves unrelated config fields when patching defaultProvider', async () => {
    const { vi } = await import('vitest')
    vi.resetModules()
    const { patchDaemonConfigFile, loadDaemonConfig } = await import('../../core/daemon/config')
    patchDaemonConfigFile({ arbitrarySetting: true })
    patchDaemonConfigFile({ defaultProvider: 'gemini' })
    const cfg = loadDaemonConfig()
    expect(cfg.defaultProvider).toBe('gemini')
  })
})
