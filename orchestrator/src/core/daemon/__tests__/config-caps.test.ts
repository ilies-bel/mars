/**
 * Tests for loadDaemonConfig() cap resolution.
 *
 * Hermetic isolation:
 *   MARS_REPO is set to an isolated per-fork temp dir by test/setup-env.ts.
 *   daemonConfigPath() therefore resolves to <MARS_REPO>/.mars/daemon.json —
 *   a path inside the throwaway temp dir, never the live .mars. Tests that
 *   exercise file-based caps write to that path freely; cleanup removes the
 *   file in beforeEach/afterEach so tests cannot pollute each other.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { __resetContextCacheForTests } from '../../context'
import { daemonConfigPath, loadDaemonConfig } from '../config'

/**
 * Write arbitrary JSON to the hermetic daemon.json so file-cap logic is
 * exercised without touching the live .mars.
 *
 * daemonConfigPath() already ensures the parent .mars dir exists (via
 * resolveContext()'s mkdirSync), so a plain writeFileSync is enough after
 * the first call.
 */
function writeDaemonJson(content: unknown): void {
  const configPath = daemonConfigPath()
  mkdirSync(resolve(configPath, '..'), { recursive: true })
  writeFileSync(configPath, JSON.stringify(content))
}

/** Remove daemon.json from the hermetic temp repo; silent if absent. */
function removeDaemonJson(): void {
  try {
    rmSync(daemonConfigPath())
  } catch {
    // ok — file may not exist
  }
}

describe('daemon concurrency caps', () => {
  beforeEach(() => {
    delete process.env.MARS_MAX_VERIFY
    // Remove any daemon.json left by a previous test before resetting the
    // context cache.  daemonConfigPath() resolves through the cached (or
    // freshly detected) MARS_REPO, which is always the hermetic temp dir.
    removeDaemonJson()
    __resetContextCacheForTests()
  })

  afterEach(() => {
    delete process.env.MARS_MAX_VERIFY
    removeDaemonJson()
    __resetContextCacheForTests()
  })

  // ── env-var caps (no daemon.json) ─────────────────────────────────────────

  it('reads the documented MARS_MAX_VERIFY environment cap when no daemon.json exists', () => {
    process.env.MARS_MAX_VERIFY = '1'

    expect(loadDaemonConfig().caps.verify).toBe(1)
  })

  // ── file caps (daemon.json present in hermetic temp repo) ─────────────────
  //
  // These tests exercise the file > env priority path.  They write to the
  // hermetic MARS_REPO/.mars/daemon.json, so they never touch the live .mars.
  // The file is removed in beforeEach/afterEach to prevent cross-test leakage.

  it('file cap overrides MARS_MAX_VERIFY env cap (file > env priority)', () => {
    process.env.MARS_MAX_VERIFY = '1'
    // Write a file cap of 5 to the hermetic temp repo.
    writeDaemonJson({ caps: { verify: 5 } })
    // loadDaemonConfig() reads the file fresh on every call — no cache reset
    // needed, and the context already points to the hermetic temp dir.
    expect(loadDaemonConfig().caps.verify).toBe(5)
  })

  it('falls back to env cap when daemon.json contains invalid JSON', () => {
    process.env.MARS_MAX_VERIFY = '1'
    const configPath = daemonConfigPath()
    mkdirSync(resolve(configPath, '..'), { recursive: true })
    writeFileSync(configPath, '{ not valid json')

    expect(loadDaemonConfig().caps.verify).toBe(1)
  })

  it('falls back to env cap when daemon.json omits the caps field', () => {
    process.env.MARS_MAX_VERIFY = '1'
    writeDaemonJson({ defaultProvider: 'claude' })

    expect(loadDaemonConfig().caps.verify).toBe(1)
  })
})
